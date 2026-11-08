import { describe, expect, it, vi } from "vitest";
import type { ApplicationQuickJSSession, ApplicationQuickJSSessionStatus } from "./application-quickjs-session.js";
import { APPLICATION_RUNTIME_CHANNEL_LIMITS as limits, ApplicationRuntimeChannelError,
  createApplicationRuntimeChannel } from "./application-runtime-channel.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireDecoder, ApplicationWireEncoder } from "./application-wire-v1.js";

// Controlled session methods only. This suite uses the actual wire codecs; it
// never loads QuickJS/Wasm, evaluates application text or creates a native child.
function fixture(initial: "initializing" | "ready" = "ready") {
  let state: ApplicationQuickJSSessionStatus["state"] = initial, disposed = false, statusThrows = false;
  let nextDrain: readonly string[] | undefined;
  const output: string[] = [], input: unknown[] = [];
  const observed = (): ApplicationQuickJSSessionStatus => {
    if (statusThrows) throw Error("controlled status failure");
    return { state, failure: state === "failed" ? "guest" : null, jobs: 0, operations: 0,
      guestDisposed: disposed, qualifiedForProduct: false };
  };
  const session: ApplicationQuickJSSession = {
    receive: vi.fn((text: string) => {
      const message = JSON.parse(text); input.push(message);
      if (message.kind === "shutdown") { state = "closed"; disposed = true; }
    }),
    pump: vi.fn(observed),
    drain: vi.fn(() => { const result = nextDrain ?? output.splice(0, 64); nextDrain = undefined; return result; }),
    close: vi.fn(() => { state = "closed"; disposed = true; }),
    get status() { return observed(); },
  };
  const original = { receive: session.receive, pump: session.pump, drain: session.drain, close: session.close };
  const channel = createApplicationRuntimeChannel(session);
  return { session, original, channel, output, input,
    setState(value: ApplicationQuickJSSessionStatus["state"], clean = false) { state = value; disposed = clean; },
    setDrain(value: readonly string[]) { nextDrain = value; },
    setStatusThrows(value: boolean) { statusThrows = value; },
  };
}
const invoke = (callId = "call-1") => ({ kind: "invoke", call_id: callId,
  request: { request_id: "request-1", method: "GET", path: "/items", query: { q: "中文" }, body: null } });
const response = (callId = "call-1", body: unknown = { ok: true }) =>
  JSON.stringify({ kind: "response", call_id: callId, response: { status: 200, body } });
function rawFrame(message: unknown, sequence: number, padding = 0): Buffer {
  const payload = Buffer.from(" ".repeat(padding) + JSON.stringify({ version: 1, sequence, ...(message as object) }));
  const bytes = Buffer.alloc(payload.length + 4); bytes.writeUInt32BE(payload.length); payload.copy(bytes, 4); return bytes;
}
function feed(channel: ReturnType<typeof createApplicationRuntimeChannel>, bytes: Uint8Array, size = 65_536) {
  for (let offset = 0; offset < bytes.byteLength; offset += size) channel.receive(bytes.subarray(offset, offset + size));
}
function drain(channel: ReturnType<typeof createApplicationRuntimeChannel>): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let value = channel.readOutput(); value; value = channel.readOutput()) result.push(value);
  return result;
}
function expectFailure(work: () => unknown, code: string): ApplicationRuntimeChannelError {
  let thrown: unknown;
  try { work(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(ApplicationRuntimeChannelError);
  expect((thrown as ApplicationRuntimeChannelError).code).toBe(code);
  return thrown as ApplicationRuntimeChannelError;
}

describe("fixed application runtime channel", () => {
  it("preserves fragmented real wire sequence and delivers message fields only", () => {
    const item = fixture(), encoder = new ApplicationWireEncoder("host-to-application");
    const first = encoder.encode(JSON.stringify(invoke())), second = encoder.encode(JSON.stringify({ kind: "cancel", call_id: "call-1" }));
    feed(item.channel, first, 1); feed(item.channel, second, 3);
    expect(item.input).toEqual([invoke(), { kind: "cancel", call_id: "call-1" }]);
    expect(item.channel.status).toMatchObject({ state: "ready", inputMessages: 2,
      inputWireBytes: first.length + second.length, qualifiedForProduct: false, guestDisposed: false });
    item.channel.close();
  });

  it("retains copied partial input rather than the caller's mutable bytes", () => {
    const item = fixture(), bytes = rawFrame(invoke(), 1), prefix = Buffer.from(bytes.subarray(0, 12));
    item.channel.receive(prefix); prefix.fill(0); item.channel.receive(bytes.subarray(12));
    expect(item.input).toEqual([invoke()]); item.channel.close();
  });

  it("validates a complete batch before delivering a valid prefix", () => {
    const item = fixture(), bytes = Buffer.concat([rawFrame(invoke(), 1), rawFrame(invoke("other"), 1)]);
    expectFailure(() => item.channel.receive(bytes), "input");
    expect(item.input).toEqual([]); expect(item.original.close).toHaveBeenCalledTimes(1);
    expect(item.channel.status).toMatchObject({ state: "failed", inputMessages: 0, guestDisposed: true });
  });

  it.each(["wrong direction", "extra fields", "wrong version"])("rejects %s at the actual decoder", variant => {
    const item = fixture();
    const message = variant === "wrong direction" ? JSON.parse(response())
      : variant === "extra fields" ? { ...invoke(), authority: "write" } : { ...invoke(), version: 2 };
    expectFailure(() => item.channel.receive(rawFrame(message, 1)), "input");
    expect(item.input).toEqual([]);
  });

  it("rejects malformed UTF-8 before invoking the session", () => {
    const item = fixture(), bytes = rawFrame(invoke(), 1), position = bytes.indexOf(Buffer.from("中"));
    expect(position).toBeGreaterThan(4); bytes[position] = 0xff;
    expectFailure(() => item.channel.receive(bytes), "input"); expect(item.input).toEqual([]);
  });

  it.each([2, 8])("retains a truncated frame failure at EOF after %i bytes", amount => {
    const item = fixture(); item.channel.receive(rawFrame(invoke(), 1).subarray(0, amount));
    const error = expectFailure(() => item.channel.endInput(), "input");
    expect(item.channel.status).toMatchObject({ inputEnded: true, state: "failed", guestDisposed: true });
    expect(item.channel.close().failure).toBe("input");
    expect(() => item.channel.advance()).toThrow(error); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it("rejects input before module readiness without pumping or buffering work", () => {
    const item = fixture("initializing");
    expectFailure(() => item.channel.receive(rawFrame(invoke(), 1)), "input");
    expect(item.input).toEqual([]); expect(item.original.pump).not.toHaveBeenCalled();
  });

  it("pumps initialization without draining until the original session becomes ready", () => {
    const item = fixture("initializing");
    expect(item.channel.advance().state).toBe("initializing"); expect(item.original.drain).not.toHaveBeenCalled();
    item.setState("ready"); item.output.push(response());
    expect(item.channel.advance().state).toBe("ready"); expect(item.original.drain).toHaveBeenCalledTimes(1);
    expect(item.channel.readOutput()).toBeInstanceOf(Uint8Array); item.channel.close();
  });

  it("does not reinterpret an empty initialization input EOF as readiness", () => {
    const item = fixture("initializing");
    expect(item.channel.endInput()).toMatchObject({ state: "closed", closeReason: "input-eof", inputEnded: true, guestDisposed: true });
    expect(item.original.pump).not.toHaveBeenCalled();
  });

  it("accepts terminal shutdown only after its complete valid prefix", () => {
    const item = fixture();
    item.channel.receive(Buffer.concat([rawFrame(invoke(), 1), rawFrame({ kind: "shutdown" }, 2)]));
    expect(item.input).toEqual([invoke(), { kind: "shutdown" }]);
    expect(item.channel.status).toMatchObject({ state: "closed", closeReason: "shutdown", inputEnded: false, guestDisposed: true });
    expect(item.channel.endInput()).toMatchObject({ state: "closed", inputEnded: true, closeReason: "shutdown" });
    expect(item.original.close).toHaveBeenCalledTimes(1);
    expectFailure(() => item.channel.receive(rawFrame(invoke(), 3)), "closed");
  });

  it.each(["complete frame", "partial byte"])("rejects shutdown followed by %s before delivering shutdown", suffix => {
    const item = fixture(), after = suffix === "complete frame" ? rawFrame(invoke(), 2) : Buffer.from([0]);
    expectFailure(() => item.channel.receive(Buffer.concat([rawFrame({ kind: "shutdown" }, 1), after])), "input");
    expect(item.input).toEqual([]);
  });

  it("refuses to discard queued output as a successful shutdown or input EOF", () => {
    for (const ending of ["shutdown", "eof"] as const) {
      const item = fixture(); item.output.push(response()); item.channel.advance();
      const pending = item.channel.status.pendingOutputBytes;
      expectFailure(() => ending === "shutdown" ? item.channel.receive(rawFrame({ kind: "shutdown" }, 1)) : item.channel.endInput(), "output");
      expect(item.channel.status).toMatchObject({ state: "failed", pendingOutputBytes: 0, discardedOutputBytes: pending, handedOffBytes: 0 });
      expect(item.input).toEqual([]);
    }
  });

  it("encodes FIFO frames with one persistent sequence across advances", () => {
    const item = fixture(), decoder = new ApplicationWireDecoder("application-to-host");
    item.output.push(response("a"), response("b")); item.channel.advance();
    const first = drain(item.channel).flatMap(bytes => decoder.push(bytes));
    item.output.push(response("c")); item.channel.advance();
    const second = drain(item.channel).flatMap(bytes => decoder.push(bytes));
    expect([...first, ...second].map(value => [value.sequence, "call_id" in value ? value.call_id : null])).toEqual([[1, "a"], [2, "b"], [3, "c"]]);
    decoder.finish();
    expect(item.channel.status).toMatchObject({ outputMessages: 3, pendingOutputBytes: 0 });
    expect(item.channel.status.handedOffBytes).toBe(item.channel.status.outputWireBytes); item.channel.close();
  });

  it("pauses pumping under backpressure and hands off copied chunks no larger than 64 KiB", () => {
    const item = fixture(), text = response("large", "x".repeat(180_000)); item.output.push(text); item.channel.advance();
    const pending = item.channel.status.pendingOutputBytes;
    item.channel.advance(); expect(item.original.pump).toHaveBeenCalledTimes(1);
    const first = item.channel.readOutput()!, saved = Uint8Array.from(first); first.fill(0);
    expect(first.byteLength).toBe(65_536); item.channel.advance(); expect(item.original.pump).toHaveBeenCalledTimes(1);
    const remaining = drain(item.channel); expect(remaining.every(bytes => bytes.byteLength <= 65_536)).toBe(true);
    const decoder = new ApplicationWireDecoder("application-to-host"), messages = [saved, ...remaining].flatMap(bytes => decoder.push(bytes));
    expect(messages).toEqual([{ version: 1, sequence: 1, ...JSON.parse(text) }]); decoder.finish();
    expect(item.channel.status).toMatchObject({ pendingOutputBytes: 0, handedOffBytes: pending, guestDisposed: false });
    item.channel.advance(); expect(item.original.pump).toHaveBeenCalledTimes(2); item.channel.close();
  });

  it("never hands off a valid output prefix when a later message is invalid", () => {
    const item = fixture(); item.output.push(response(), JSON.stringify({ kind: "begin" }));
    const error = expectFailure(() => item.channel.advance(), "output");
    expect(item.channel.status).toMatchObject({ pendingOutputBytes: 0, handedOffBytes: 0, outputMessages: 0, state: "failed" });
    expect(() => item.channel.readOutput()).toThrow(error);
  });

  it("rejects output accessors without invoking them", () => {
    const item = fixture(), getter = vi.fn(() => response()), values: string[] = [];
    Object.defineProperty(values, "0", { get: getter }); item.setDrain(values);
    expectFailure(() => item.channel.advance(), "output"); expect(getter).not.toHaveBeenCalled();
  });

  it.each(["sparse", "over-batch"])("rejects a %s output batch", variant => {
    const item = fixture(); item.setDrain(variant === "sparse" ? Array(1) : Array(65).fill(response()));
    expectFailure(() => item.channel.advance(), "output"); expect(item.channel.status.handedOffBytes).toBe(0);
  });

  it("captures the original session methods and status getter before later replacement", () => {
    const item = fixture(), replacement = vi.fn(() => { throw Error("replacement must not run"); });
    item.session.receive = replacement; item.session.pump = replacement; item.session.drain = replacement; item.session.close = replacement;
    Object.defineProperty(item.session, "status", { get: replacement });
    item.channel.receive(rawFrame(invoke(), 1)); item.output.push(response()); item.channel.advance(); drain(item.channel); item.channel.close();
    expect(item.input).toEqual([invoke()]); expect(item.original.close).toHaveBeenCalledTimes(1); expect(replacement).not.toHaveBeenCalled();
  });

  it("does not attach a second channel to the same original session", () => {
    const item = fixture(); expectFailure(() => createApplicationRuntimeChannel(item.session), "owner");
    expect(item.original.close).not.toHaveBeenCalled(); item.channel.close();
  });

  it.each(["initializing", "closed", "failed"] as const)("fails closed on an unexpected original session transition to %s", next => {
    const item = fixture(); item.setState(next, next === "closed");
    expectFailure(() => item.channel.advance(), next === "failed" ? "session" : "owner");
    expect(item.original.pump).not.toHaveBeenCalled(); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it.each(["receive", "pump", "drain"] as const)("retains an original %s failure and closes once", method => {
    const item = fixture(); vi.mocked(item.original[method]).mockImplementation(() => { throw Error("private controlled failure"); });
    const error = expectFailure(() => method === "receive" ? item.channel.receive(rawFrame(invoke(), 1)) : item.channel.advance(), "session");
    expect(error.message).not.toContain("private");
    expect(item.channel.close().failure).toBe("session"); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it("never upgrades uncertain disposal after a throwing original close", () => {
    const item = fixture(); vi.mocked(item.original.close).mockImplementationOnce(() => { throw Error("controlled close failure"); });
    expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    item.setState("closed", true);
    expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    expect(item.channel.endInput().guestDisposed).toBe(false); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it("never upgrades disposal after an unavailable original status read", () => {
    const item = fixture(); item.setStatusThrows(true);
    expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    item.setStatusThrows(false); expect(item.channel.close().guestDisposed).toBe(false); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it.each(["receive", "pump", "drain", "close"] as const)("observes but never accepts an unexpected rejected native Promise from %s", async method => {
    const item = fixture();
    vi.mocked(item.original[method]).mockImplementation(() => Promise.reject(Error("controlled rejected return")) as never);
    if (method === "close") expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    else expectFailure(() => method === "receive" ? item.channel.receive(rawFrame(invoke(), 1)) : item.channel.advance(),
      method === "receive" ? "owner" : method === "drain" ? "output" : "session");
    // No external catch is attached: the adapter must observe the original
    // rejection in this turn, while refusing it as synchronous completion.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(item.channel.status.state).toBe("failed"); expect(item.original.close).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexpected thenable without reading or invoking its then property", () => {
    const item = fixture(), then = vi.fn(() => { throw Error("thenable must not run"); });
    const value = Object.defineProperty({}, "then", { get: then });
    vi.mocked(item.original.close).mockImplementation(() => value as never);
    expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    expect(then).not.toHaveBeenCalled();
  });

  it("rejects a rejected pump Promise decorated with valid status fields", async () => {
    const item = fixture(), status = item.session.status;
    vi.mocked(item.original.pump).mockImplementation(() => Object.assign(Promise.reject(Error("controlled tagged rejection")), status));
    expectFailure(() => item.channel.advance(), "session");
    expect(item.original.drain).not.toHaveBeenCalled(); await new Promise<void>(resolve => setImmediate(resolve));
  });

  it("observes a rejected Promise subclass while still rejecting its return", async () => {
    class ControlledPromise<T> extends Promise<T> {}
    const item = fixture();
    vi.mocked(item.original.close).mockImplementation(() => ControlledPromise.reject(Error("controlled subclass rejection")) as never);
    expect(item.channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  it("cannot convert a re-prototyped native Promise into a synchronous status", async () => {
    const item = fixture(), status = item.session.status;
    vi.mocked(item.original.pump).mockImplementation(() => {
      const value = Object.assign(Promise.reject(Error("controlled re-prototype rejection")), status);
      Object.setPrototypeOf(value, Object.prototype); return value;
    });
    expectFailure(() => item.channel.advance(), "session"); await new Promise<void>(resolve => setImmediate(resolve));
  });

  it("rejects getter fields in a status snapshot without invoking them", () => {
    const item = fixture(), getter = vi.fn(() => "ready"), status = { ...item.session.status };
    Object.defineProperty(status, "state", { get: getter });
    vi.mocked(item.original.pump).mockReturnValue(status);
    expectFailure(() => item.channel.advance(), "session"); expect(getter).not.toHaveBeenCalled();
  });

  it("latches an invalid shutdown status and attempts original cleanup before throwing", () => {
    let invalid = false, closeCalls = 0;
    const ready = () => ({ state: "ready", failure: null, jobs: 0, operations: 0, guestDisposed: false, qualifiedForProduct: false });
    const session = { receive() { invalid = true; }, pump: ready, drain() { return []; }, close() { closeCalls++; },
      get status() { return invalid ? null : ready(); } };
    const channel = createApplicationRuntimeChannel(session as never);
    expectFailure(() => channel.receive(rawFrame({ kind: "shutdown" }, 1)), "owner");
    expect(channel.status).toMatchObject({ state: "failed", failure: "owner", guestDisposed: false });
    expect(closeCalls).toBe(1); channel.close(); expect(closeCalls).toBe(1);
  });

  it("does not upgrade cleanup from disposal-shaped rejected status Promises", async () => {
    let closed = false;
    const ready = () => ({ state: "ready", failure: null, jobs: 0, operations: 0, guestDisposed: false, qualifiedForProduct: false });
    const session = { receive() {}, pump: ready, drain() { return []; }, close() { closed = true; },
      get status() { return closed ? Object.assign(Promise.reject(Error("controlled disposal rejection")),
        { ...ready(), state: "closed", guestDisposed: true }) : ready(); } };
    const channel = createApplicationRuntimeChannel(session as never);
    expect(channel.close()).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(channel.close().guestDisposed).toBe(false);
  });

  it("accounts for output discarded by explicit host close without claiming delivery", () => {
    const item = fixture(); item.output.push(response()); item.channel.advance(); const pending = item.channel.status.pendingOutputBytes;
    expect(item.channel.close()).toMatchObject({ state: "closed", closeReason: "owner-close", inputEnded: false,
      handedOffBytes: 0, discardedOutputBytes: pending, guestDisposed: true, qualifiedForProduct: false });
  });

  it("bounds every input chunk and counts repeated empty chunks", () => {
    const oversized = fixture(); expectFailure(() => oversized.channel.receive(new Uint8Array(65_537)), "input");
    const item = fixture(); for (let count = 0; count < limits.inputChunks; count++) item.channel.receive(new Uint8Array());
    expectFailure(() => item.channel.receive(new Uint8Array()), "limit"); expect(item.input).toEqual([]);
  });

  it("bounds cumulative raw input bytes including discarded JSON whitespace", () => {
    const item = fixture(), ordinary = rawFrame(invoke(), 1), padding = APPLICATION_WIRE_LIMITS.frameBytes - (ordinary.length - 4);
    let failed = false;
    for (let sequence = 1; sequence <= 33; sequence++) {
      const bytes = rawFrame(invoke(), sequence, padding - (String(sequence).length - 1));
      try { feed(item.channel, bytes); } catch (error) { expect((error as ApplicationRuntimeChannelError).code).toBe("limit"); failed = true; break; }
    }
    expect(failed).toBe(true); expect(item.input).toHaveLength(32);
    expect(item.channel.status.inputWireBytes).toBeGreaterThan(limits.inputWireBytes);
  });

  it("bounds lifetime input messages without delivering an over-budget batch prefix", () => {
    const item = fixture();
    for (let first = 1; first <= limits.inputMessages; first += 64)
      item.channel.receive(Buffer.concat(Array.from({ length: 64 }, (_, offset) => rawFrame(invoke(), first + offset))));
    expect(item.input).toHaveLength(limits.inputMessages);
    expectFailure(() => item.channel.receive(rawFrame(invoke(), limits.inputMessages + 1)), "limit");
    expect(item.input).toHaveLength(limits.inputMessages);
  });

  it("bounds cumulative encoded output including its envelope and framing bytes", () => {
    const item = fixture(), text = response("large", "x".repeat(262_142));
    item.output.push(...Array(64).fill(text)); item.channel.advance(); drain(item.channel);
    const prior = item.channel.status.outputWireBytes; expect(prior).toBeLessThan(limits.outputWireBytes);
    item.output.push(text); expectFailure(() => item.channel.advance(), "limit");
    expect(item.channel.status).toMatchObject({ outputWireBytes: prior, outputMessages: 64, pendingOutputBytes: 0 });
  });

  it("bounds lifetime output messages even when prior bytes were handed off", () => {
    const item = fixture();
    for (let first = 0; first < limits.outputMessages; first += 64) { item.output.push(...Array(64).fill(response())); item.channel.advance(); drain(item.channel); }
    expect(item.channel.status.outputMessages).toBe(limits.outputMessages);
    item.output.push(response()); expectFailure(() => item.channel.advance(), "limit");
    expect(item.channel.status.outputMessages).toBe(limits.outputMessages);
  });
});
