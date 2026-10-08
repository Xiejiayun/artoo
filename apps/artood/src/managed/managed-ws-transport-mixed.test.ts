import { createHash, randomUUID } from "node:crypto";
import { MANAGED_RECEIPT_CONTRACT, type NodeHello, type NodeToServerMessage, type RunEventMessage } from "@artoo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monotonicMs, type ManagedExposureContext } from "./managed-delivery.js";
import { createManagedWebSocketTransport, type ManagedWebSocketOptions, type ManagedWebSocketTransport } from "./managed-ws-transport.js";

// These are local transport-state tests. The injected peer does not prove a
// committed PostgreSQL receipt, a journal-authorized claim or physical closure.
const hello: NodeHello = { kind: "node.hello", node_id: "mixed-node", protocol_version: "2026-06-11", artood_version: "test",
  machine: { hostname: "mixed-fixture", os: "darwin", arch: "x64" } };
const namespace = "mixed-transport-fixture";
const sockets: FakeSocket[] = [], links: ManagedWebSocketTransport[] = [];

function command(type: string, payload: unknown) {
  return { kind: "command", id: randomUUID(), idempotency_key: randomUUID(), type, payload };
}
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly sent: string[] = [];
  autoPong = false;
  onSend?: (message: NodeToServerMessage) => void;
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  constructor(_url: string) { sockets.push(this); }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.handlers.get(type) ?? []; list.push(handler); this.handlers.set(type, list);
  }
  send(encoded: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("injected socket is not open");
    this.sent.push(encoded);
    const message = JSON.parse(encoded) as NodeToServerMessage;
    this.onSend?.(message);
    if (this.autoPong && message.kind === "node.session.probe") this.server(command("node.session.pong", message));
  }
  emit(type: string, event: unknown): void { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  server(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open", {}); }
  close(): void { this.readyState = 3; this.emit("close", { code: 1000 }); }
  drop(code = 1012): void { this.readyState = 3; this.emit("close", { code }); }
  frames(): NodeToServerMessage[] { return this.sent.map((encoded) => JSON.parse(encoded) as NodeToServerMessage); }
  events(): RunEventMessage[] { return this.frames().filter((message): message is RunEventMessage => message.kind === "run.event"); }
  ready(overrides: Record<string, unknown> = {}): void {
    const observed = this.frames().find((message) => message.kind === "node.hello");
    if (!observed || observed.kind !== "node.hello") throw new Error("fixture has no hello");
    this.server(command("node.session.ready", { version: 1, node_id: hello.node_id,
      hello_nonce: observed.managed_receipts!.nonce, session_id: randomUUID(), receipt_contract: MANAGED_RECEIPT_CONTRACT,
      sequence_max: 2147483647, liveness: { probe_interval_ms: 10000, probe_timeout_ms: 10000 }, ...overrides }));
  }
  pong(): void {
    const probe = this.frames().findLast((message) => message.kind === "node.session.probe");
    if (!probe) throw new Error("fixture has no probe");
    this.server(command("node.session.pong", probe));
  }
  qualify(): void { this.open(); this.ready(); this.pong(); this.autoPong = true; }
  receipt(runId: string, sequence: number, status = "accepted", message?: string): void {
    this.server(command("run.event.ack", { run_id: runId, sequence, status, ...(message ? { message } : {}) }));
  }
}
function harness(options: Partial<ManagedWebSocketOptions> = {}, qualify = true) {
  const link = createManagedWebSocketTransport({ url: "ws://127.0.0.1/mixed-fixture", hello, namespace,
    allowLegacyRuns: true, reconnectDelayMs: 5, WebSocketImpl: FakeSocket as unknown as typeof WebSocket, ...options });
  links.push(link); link.start(); const socket = sockets.at(-1)!;
  if (qualify) socket.qualify();
  return { link, socket };
}
function frame(runId: string, sequence = 0, text = "ordinary output"): RunEventMessage {
  return { kind: "run.event", node_id: hello.node_id, run_id: runId, sequence,
    event: { type: "run.output", payload: { stream: "stdout", text } } };
}
function retained(runId: string, sequence = 0): RunEventMessage {
  return { ...frame(runId, sequence), event: { type: "run.workspace.retained",
    payload: { version: 1, workspace_root: "/fixture/run", workspace_branch: "artoo/run", outcome: "completed" } } };
}
function context(message: RunEventMessage, deadlineTickMs = monotonicMs() + 30000): ManagedExposureContext {
  return { namespace, nodeId: hello.node_id, runId: message.run_id, sequence: message.sequence,
    eventId: randomUUID(), attemptId: randomUUID(), clockId: "mixed-fixture-clock", deadlineTickMs,
    contentSha256: createHash("sha256").update(JSON.stringify(message.event)).digest("hex"), signal: new AbortController().signal };
}
function observe<T>(promise: Promise<T>) {
  let state: "pending" | "accepted" | "rejected" = "pending";
  const result = promise.then((value) => { state = "accepted"; return value; }, (error: Error) => { state = "rejected"; return error; });
  return { result, get state() { return state; } };
}
async function replacement(): Promise<FakeSocket> { await vi.advanceTimersByTimeAsync(5); return sockets.at(-1)!; }

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "hrtime"] }); });
afterEach(async () => {
  for (const link of links.splice(0)) await link.close();
  sockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers();
});

describe("ordinary and managed lanes on one qualified socket", () => {
  it("keeps the unbound managed-only default and refuses ordinary routing", async () => {
    const { link, socket } = harness({ allowLegacyRuns: undefined }); await link.ready;
    const event = frame("managed-default");
    await expect(link.transport.send(event)).rejects.toThrow("durable one-shot");
    expect(() => link.bindRun("ordinary", "legacy")).toThrow("mixed routing");
    const sent = observe(link.channel.exposeOnce(event, context(event)));
    socket.receipt(event.run_id, event.sequence); expect(await sent.result).toBe("accepted");
    expect(socket.events()).toEqual([event]); expect(sockets).toHaveLength(1);
  });

  it("rejects unbound and wrong-lane events before writing, with immutable bindings across reconnect", async () => {
    const { link, socket } = harness(); const ordinary = frame("ordinary"), managed = frame("managed");
    await expect(link.transport.send(ordinary)).rejects.toThrow("not bound to legacy");
    await expect(link.channel.exposeOnce(managed, context(managed))).rejects.toThrow("not bound to managed");
    link.bindRun(ordinary.run_id, "legacy"); link.bindRun(ordinary.run_id, "legacy");
    link.bindRun(managed.run_id, "managed"); link.bindRun(managed.run_id, "managed");
    expect(() => link.bindRun(ordinary.run_id, "managed")).toThrow("cannot change");
    expect(() => link.bindRun(managed.run_id, "legacy")).toThrow("cannot change");
    await expect(link.channel.exposeOnce(ordinary, context(ordinary))).rejects.toThrow("not bound to managed");
    await expect(link.transport.send(managed)).rejects.toThrow("not bound to legacy");
    expect(socket.events()).toEqual([]); socket.drop(); const next = await replacement(); next.qualify();
    expect(() => link.bindRun(ordinary.run_id, "managed")).toThrow("cannot change");
    expect(() => link.bindRun(managed.run_id, "legacy")).toThrow("cannot change");
    expect(next.events()).toEqual([]);
  });

  it.each(["accepted", "rejected"] as const)("routes interleaved sequence-zero receipts exactly once (ordinary %s)", async (status) => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy"); link.bindRun("managed", "managed");
    const ordinary = frame("ordinary"), managed = frame("managed");
    const legacyResult = observe(link.transport.send(ordinary)), managedResult = observe(link.channel.exposeOnce(managed, context(managed)));
    expect(socket.events()).toEqual([ordinary, managed]);
    socket.receipt("wrong-run", 0); socket.receipt("ordinary", 1); socket.receipt("managed", 1);
    socket.receipt("ordinary", -1); socket.receipt("ordinary", 2147483648); socket.receipt("ordinary", 0, "invalid");
    await vi.advanceTimersByTimeAsync(0); expect(legacyResult.state).toBe("pending"); expect(managedResult.state).toBe("pending");
    socket.receipt("ordinary", 0, status, "ordinary receipt rejected");
    if (status === "accepted") expect(await legacyResult.result).toBeUndefined();
    else expect(await legacyResult.result).toEqual(new Error("ordinary receipt rejected"));
    socket.receipt("ordinary", 0); await vi.advanceTimersByTimeAsync(0); expect(managedResult.state).toBe("pending");
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0, receiptObservers: 1 });
    socket.receipt("managed", 0); expect(await managedResult.result).toBe("accepted");
    socket.receipt("managed", 0); expect(link.diagnostics).toMatchObject({ receiptObservers: 0, receiptBytes: 0 });
    expect(sockets).toHaveLength(1);
  });

  it("replays only ordinary bytes after ready plus first pong, and leaves managed retry to its caller", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy"); link.bindRun("managed", "managed");
    const ordinary = frame("ordinary"), managed = frame("managed"), originalClaim = context(managed);
    const legacyResult = observe(link.transport.send(ordinary)), firstManaged = observe(link.channel.exposeOnce(managed, originalClaim));
    socket.drop(); expect(await firstManaged.result).toBeInstanceOf(Error);
    const next = await replacement(); next.open();
    next.receipt("ordinary", 0); socket.receipt("ordinary", 0); expect(next.events()).toEqual([]);
    next.ready(); next.receipt("ordinary", 0); await vi.advanceTimersByTimeAsync(0); expect(legacyResult.state).toBe("pending");
    expect(next.events()).toEqual([]); next.pong(); next.autoPong = true;
    expect(next.events()).toEqual([ordinary]);
    expect(link.diagnostics).toMatchObject({ receiptObservers: 0, legacyPendingEvents: 1 });
    socket.receipt("ordinary", 0); await vi.advanceTimersByTimeAsync(0); expect(legacyResult.state).toBe("pending");
    // The caller supplies another claim; the transport itself never invents it.
    const retryClaim = { ...originalClaim, attemptId: randomUUID() };
    expect(retryClaim.deadlineTickMs).toBe(originalClaim.deadlineTickMs);
    const secondManaged = observe(link.channel.exposeOnce(managed, retryClaim));
    expect(next.events()).toEqual([ordinary, managed]);
    socket.receipt("managed", 0); await vi.advanceTimersByTimeAsync(0); expect(secondManaged.state).toBe("pending");
    next.receipt("managed", 0); expect(await secondManaged.result).toBe("accepted");
    expect(legacyResult.state).toBe("pending"); next.receipt("ordinary", 0); expect(await legacyResult.result).toBeUndefined();
  });

  it("ignores a current-generation ACK for a queued entry that has not actually been sent", async () => {
    const { link, socket } = harness({}, false); link.bindRun("ordinary", "legacy");
    const first = observe(link.transport.send(frame("ordinary", 0))), second = observe(link.transport.send(frame("ordinary", 1)));
    socket.onSend = (message) => {
      if (message.kind === "run.event" && message.sequence === 0) {
        socket.receipt("ordinary", 1); socket.receipt("ordinary", 0);
      }
    };
    socket.qualify(); expect(await first.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0); expect(second.state).toBe("pending"); expect(socket.events().map((message) => message.sequence)).toEqual([0, 1]);
    socket.receipt("ordinary", 1); expect(await second.result).toBeUndefined();
  });

  it("retains validated immutable bytes when the caller mutates its original before initial send and replay", async () => {
    const { link, socket } = harness({}, false); link.bindRun("ordinary", "legacy");
    const original = frame("ordinary"), snapshot = structuredClone(original), sent = observe(link.transport.send(original));
    original.run_id = "unbound"; original.sequence = 7; original.event = frame("unbound", 7, "mutated").event;
    socket.qualify(); expect(socket.events()).toEqual([snapshot]); socket.drop();
    const next = await replacement(); next.qualify(); expect(next.events()).toEqual([snapshot]);
    expect(next.sent.filter((encoded) => JSON.parse(encoded).kind === "run.event")).toEqual([JSON.stringify(snapshot)]);
    next.receipt("unbound", 7); await vi.advanceTimersByTimeAsync(0); expect(sent.state).toBe("pending");
    next.receipt("ordinary", 0); expect(await sent.result).toBeUndefined();
  });

  it("rejects malformed, wrong-node, oversized-body and oversized-frame input without consuming capacity", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const hugeRun = "r".repeat(4 * 1024 * 1024); link.bindRun(hugeRun, "legacy");
    for (const invalid of [{ ...frame("ordinary"), sequence: -1 }, { ...frame("ordinary"), node_id: "wrong" },
      { ...frame("ordinary"), event: { type: "run.output", payload: { stream: "other", text: "invalid" } } },
      frame("ordinary", 0, "界".repeat(400000)), frame(hugeRun)]) {
      await expect(link.transport.send(invalid as RunEventMessage)).rejects.toThrow();
    }
    expect(socket.events()).toEqual([]); expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    const valid = observe(link.transport.send(frame("ordinary", 0)));
    socket.receipt("ordinary", 0); expect(await valid.result).toBeUndefined();
  });

  it("does not replace a pending promise or its bytes with a duplicate or changed tuple", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy"); const event = frame("ordinary");
    const sent = observe(link.transport.send(event)), bytes = link.diagnostics.legacyPendingBytes;
    await expect(link.transport.send(event)).rejects.toThrow("already pending");
    await expect(link.transport.send(frame("ordinary", 0, "changed"))).rejects.toThrow("already pending");
    await expect(link.transport.send(retained("ordinary"))).rejects.toThrow("workspace retention event is already pending");
    await expect(link.transport.send(event, { delivery: "best-effort" })).rejects.toThrow("cannot reuse a pending");
    expect(link.diagnostics.legacyPendingBytes).toBe(bytes); expect(socket.events()).toEqual([event]);
    expect(sent.state).toBe("pending"); socket.receipt("ordinary", 0); expect(await sent.result).toBeUndefined();
  });

  it("drops optional output before usable and offline, without receipts, replay or required capacity", async () => {
    const { link, socket } = harness({}, false); link.bindRun("ordinary", "legacy");
    await link.transport.send(frame("ordinary", 0), { delivery: "best-effort" });
    socket.open(); socket.ready(); await link.transport.send(frame("ordinary", 1), { delivery: "best-effort" });
    expect(socket.events()).toEqual([]); socket.pong(); socket.autoPong = true;
    for (let sequence = 2; sequence < 1007; sequence++) await link.transport.send(frame("ordinary", sequence), { delivery: "best-effort" });
    expect(socket.events()).toHaveLength(1005); expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    const event = retained("ordinary", 1007), sent = observe(link.transport.send(event));
    socket.receipt("ordinary", 10); await vi.advanceTimersByTimeAsync(0); expect(sent.state).toBe("pending");
    socket.drop(); await link.transport.send(frame("ordinary", 1008), { delivery: "best-effort" });
    const next = await replacement(); next.qualify(); expect(next.events()).toEqual([event]);
    next.receipt("ordinary", 10); await vi.advanceTimersByTimeAsync(0); expect(sent.state).toBe("pending");
    next.receipt("ordinary", 1007); expect(await sent.result).toBeUndefined();
    await link.close(); await expect(link.transport.send(frame("ordinary"), { delivery: "best-effort" })).rejects.toThrow("closed");
  });

  it("forbids optional and settled sequence reuse without allowing their late receipts to settle another entry", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    await link.transport.send(frame("ordinary", 0), { delivery: "best-effort" });
    await expect(link.transport.send(frame("ordinary", 0))).rejects.toThrow("strictly increase");
    const first = observe(link.transport.send(frame("ordinary", 1)));
    socket.receipt("ordinary", 0); await vi.advanceTimersByTimeAsync(0); expect(first.state).toBe("pending");
    socket.receipt("ordinary", 1); expect(await first.result).toBeUndefined();
    await expect(link.transport.send(frame("ordinary", 1, "reused"))).rejects.toThrow("strictly increase");
    await expect(link.transport.send(frame("ordinary", 1), { delivery: "best-effort" })).rejects.toThrow("strictly increase");
    const second = observe(link.transport.send(frame("ordinary", 2)));
    socket.receipt("ordinary", 0); socket.receipt("ordinary", 1); await vi.advanceTimersByTimeAsync(0); expect(second.state).toBe("pending");
    expect(socket.events().map((event) => event.sequence)).toEqual([0, 1, 2]);
    socket.receipt("ordinary", 2); expect(await second.result).toBeUndefined();
    socket.drop(); await link.transport.send(frame("ordinary", 3), { delivery: "best-effort" });
    await expect(link.transport.send(frame("ordinary", 3))).rejects.toThrow("strictly increase");
    const next = await replacement(); next.qualify(); expect(next.events()).toEqual([]);
    await expect(link.transport.send(frame("ordinary", 2))).rejects.toThrow("strictly increase");
  });

  it.each(["run.workspace.retained", "run.lifecycle", "artifact.created"] as const)("rejects best-effort misuse for %s", async (type) => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const event: RunEventMessage = type === "run.workspace.retained" ? retained("ordinary")
      : { ...frame("ordinary"), event: type === "run.lifecycle" ? { type, payload: { phase: "completed" } }
        : { type, payload: { type: "patch", uri: "fix.patch", metadata: {} } } };
    await expect(link.transport.send(event, { delivery: "best-effort" })).rejects.toThrow("only supported for run.output");
    expect(socket.events()).toEqual([]); expect(link.diagnostics.legacyPendingEvents).toBe(0);
  });

  it("keeps a required write failure for replay while an optional write failure never enters replay", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    socket.onSend = (message) => { if (message.kind === "run.event") throw new Error("injected required write failure"); };
    const event = frame("ordinary"), sent = observe(link.transport.send(event));
    expect(link.connected).toBe(false); expect(sent.state).toBe("pending");
    const next = await replacement(); next.qualify(); expect(next.events()).toEqual([event]);
    next.receipt("ordinary", 0); expect(await sent.result).toBeUndefined();
    next.onSend = (message) => { if (message.kind === "run.event") throw new Error("injected optional write failure"); };
    await expect(link.transport.send(frame("ordinary", 1), { delivery: "best-effort" })).rejects.toThrow("injected optional write failure");
    const last = await replacement(); last.qualify(); expect(last.events()).toEqual([]);
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
  });

  it("keeps the original 30-second retention enqueue deadline across duplicate send and replay", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const event = retained("ordinary"), sent = observe(link.transport.send(event));
    await vi.advanceTimersByTimeAsync(9995); socket.drop(); const next = await replacement(); next.qualify();
    expect(next.events()).toEqual([event]); await vi.advanceTimersByTimeAsync(10000);
    await expect(link.transport.send(event)).rejects.toThrow("workspace retention event is already pending");
    await vi.advanceTimersByTimeAsync(9999); expect(sent.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); expect(await sent.result).toEqual(new Error("workspace retention receipt timed out after 30000ms"));
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    next.receipt("ordinary", 0); next.drop(); const last = await replacement(); last.qualify();
    expect(last.events()).toEqual([]); expect(sent.state).toBe("rejected");
  });

  it.each([30000, 30001])("rejects a retention replay at monotonic %sms before its overdue timer callback runs", async (tick) => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const enqueuedTickMs = monotonicMs(), event = retained("ordinary"), sent = observe(link.transport.send(event)), enqueuedAt = Date.now();
    socket.drop(); const next = await replacement();
    // Advance only the existing monotonic clock. The fake timer scheduler has
    // advanced 5 ms, so the original 30-second callback has not executed.
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(BigInt(enqueuedTickMs + tick) * 1_000_000n);
    expect(Date.now() - enqueuedAt).toBe(5); expect(sent.state).toBe("pending");
    expect(link.diagnostics.legacyPendingEvents).toBe(1);
    next.qualify(); expect(link.connected).toBe(true); expect(next.events()).toEqual([]);
    await vi.advanceTimersByTimeAsync(0); expect(sent.state).toBe("rejected");
    expect(await sent.result).toEqual(new Error("workspace retention receipt timed out after 30000ms"));
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    expect(socket.events()).toEqual([event]); next.receipt("ordinary", 0); expect(sent.state).toBe("rejected");
  });

  it.each([30000, 30001])("rejects a retention ACK at monotonic %sms before its overdue timer callback runs", async (tick) => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const enqueuedTickMs = monotonicMs(), event = retained("ordinary"), sent = observe(link.transport.send(event)), enqueuedAt = Date.now();
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(BigInt(enqueuedTickMs + tick) * 1_000_000n);
    expect(Date.now()).toBe(enqueuedAt); expect(sent.state).toBe("pending");
    expect(link.diagnostics.legacyPendingEvents).toBe(1);
    socket.receipt("ordinary", 0); await vi.advanceTimersByTimeAsync(0);
    expect(sent.state).toBe("rejected");
    expect(await sent.result).toEqual(new Error("workspace retention receipt timed out after 30000ms"));
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    expect(socket.events()).toEqual([event]); expect(link.connected).toBe(true);
  });

  it("rejects retention before its first write if the event loop stalls after enqueue", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const enqueuedTickMs = monotonicMs(), enqueuedAt = Date.now();
    vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(BigInt(enqueuedTickMs) * 1_000_000n)
      .mockReturnValue(BigInt(enqueuedTickMs + 30000) * 1_000_000n);
    const sent = observe(link.transport.send(retained("ordinary")));
    expect(Date.now()).toBe(enqueuedAt); expect(socket.events()).toEqual([]);
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    expect(await sent.result).toEqual(new Error("workspace retention receipt timed out after 30000ms"));
    expect(link.connected).toBe(true);
  });

  it("accepts a retention receipt just before its first-enqueue monotonic deadline", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const enqueuedTickMs = monotonicMs(), sent = observe(link.transport.send(retained("ordinary")));
    vi.spyOn(process.hrtime, "bigint").mockReturnValue(BigInt(enqueuedTickMs + 29999) * 1_000_000n);
    socket.receipt("ordinary", 0); expect(await sent.result).toBeUndefined();
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    expect(link.connected).toBe(true);
  });

  it("does not give ordinary lifecycle events the typed retention timeout", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const event: RunEventMessage = { ...frame("ordinary"), event: { type: "run.lifecycle", payload: { phase: "completed" } } };
    const sent = observe(link.transport.send(event)); await vi.advanceTimersByTimeAsync(31000);
    expect(sent.state).toBe("pending"); expect(link.connected).toBe(true);
    socket.receipt("ordinary", 0); expect(await sent.result).toBeUndefined();
  });

  it("starts the retention deadline while offline and removes expired bytes before any reconnect exposure", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy"); socket.drop();
    const sent = observe(link.transport.send(retained("ordinary")));
    await vi.advanceTimersByTimeAsync(29999); expect(sent.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); expect(await sent.result).toEqual(new Error("workspace retention receipt timed out after 30000ms"));
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    const next = sockets.at(-1)!; next.qualify(); expect(next.events()).toEqual([]);
    next.receipt("ordinary", 0); expect(sent.state).toBe("rejected");
  });

  it("keeps control writes and buffered commands behind the same qualified session", async () => {
    const { link, socket } = harness({}, false), received: unknown[] = [];
    link.transport.subscribe((message) => received.push(message));
    const ack = { kind: "command.ack", node_id: hello.node_id, command_id: "control", status: "accepted" } as const;
    await expect(link.transport.send(ack)).rejects.toThrow("not usable");
    socket.open(); socket.ready(); socket.server(command("run.resume", { run_id: "ordinary" }));
    await expect(link.transport.send(ack)).rejects.toThrow("not usable"); expect(received).toEqual([]);
    socket.pong(); await link.ready; await link.transport.send(ack);
    expect(received).toHaveLength(1); expect(received[0]).toMatchObject({ type: "run.resume", payload: { run_id: "ordinary" } });
    expect(socket.frames().at(-1)).toEqual(ack); expect(sockets).toHaveLength(1);
  });

  it("bounds ordinary entry count independently from managed observers without reclassifying either lane", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy"); link.bindRun("managed", "managed");
    const ordinary = Array.from({ length: 1000 }, (_, sequence) => observe(link.transport.send(frame("ordinary", sequence))));
    await expect(link.transport.send(frame("ordinary", 1000))).rejects.toThrow("buffer is full");
    const managed = Array.from({ length: 64 }, (_, sequence) => {
      const event = frame("managed", sequence); return observe(link.channel.exposeOnce(event, context(event)));
    });
    const extra = frame("managed", 64);
    await expect(link.channel.exposeOnce(extra, context(extra))).rejects.toThrow("capacity is full");
    await expect(link.transport.send(extra)).rejects.toThrow("not bound to legacy");
    const bypass = frame("ordinary", 1000);
    await expect(link.channel.exposeOnce(bypass, context(bypass))).rejects.toThrow("not bound to managed");
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 1000, receiptObservers: 64 });
    expect(socket.events()).toHaveLength(1064); socket.receipt("ordinary", 0);
    expect(await ordinary[0]!.result).toBeUndefined(); expect(link.diagnostics.receiptObservers).toBe(64);
    const retry = observe(link.transport.send(frame("ordinary", 1000)));
    expect(link.diagnostics.legacyPendingEvents).toBe(1000); expect(socket.events().at(-1)).toMatchObject({ run_id: "ordinary", sequence: 1000 });
    await link.close(); await Promise.all([...ordinary, ...managed, retry].map((sent) => sent.result));
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0, receiptObservers: 0, receiptBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds encoded ordinary bytes and releases the exact UTF-8 count on accepted or rejected receipts", async () => {
    const { link, socket } = harness(); link.bindRun("ordinary", "legacy");
    const text = "界".repeat(Math.floor((1024 * 1024 - 1000) / 3));
    const messages = Array.from({ length: 8 }, (_, sequence) => frame("ordinary", sequence, text));
    const pending = messages.map((event) => observe(link.transport.send(event)));
    const originalBytes = messages.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
    expect(link.diagnostics.legacyPendingBytes).toBe(originalBytes); expect(originalBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    await expect(link.transport.send(frame("ordinary", 8, "x".repeat(10000)))).rejects.toThrow("buffer is full");
    expect(socket.events()).toHaveLength(8); socket.receipt("ordinary", 0, "rejected");
    expect(await pending[0]!.result).toEqual(new Error("run event rejected"));
    expect(link.diagnostics.legacyPendingBytes).toBe(originalBytes - Buffer.byteLength(JSON.stringify(messages[0])));
    const small = frame("ordinary", 8, "x".repeat(10000)), last = observe(link.transport.send(small));
    expect(link.diagnostics.legacyPendingBytes).toBe(originalBytes - Buffer.byteLength(JSON.stringify(messages[0])) + Buffer.byteLength(JSON.stringify(small)));
    socket.receipt("ordinary", 8); expect(await last.result).toBeUndefined();
    await link.close(); await Promise.all(pending.map((sent) => sent.result)); expect(link.diagnostics.legacyPendingBytes).toBe(0);
  });

  it.each(["close", "fatal", "incompatible-ready"] as const)("rejects all pending ordinary sends on %s without fallback", async (ending) => {
    const fatal = vi.fn(); const { link, socket } = harness({ onFatal: fatal }); link.bindRun("ordinary", "legacy");
    const sent = observe(link.transport.send(retained("ordinary"))), output = observe(link.transport.send(frame("ordinary", 1)));
    if (ending === "close") await link.close();
    else if (ending === "fatal") socket.drop(1008);
    else { socket.drop(); const next = await replacement(); next.open(); next.ready({ receipt_contract: "incompatible" }); }
    expect(await sent.result).toBeInstanceOf(Error); expect(await output.result).toBeInstanceOf(Error);
    expect(link.diagnostics).toMatchObject({ legacyPendingEvents: 0, legacyPendingBytes: 0 });
    expect(link.connected).toBe(false); expect(fatal).toHaveBeenCalledTimes(ending === "close" ? 0 : 1);
    const connections = sockets.length; await vi.advanceTimersByTimeAsync(60000); expect(sockets).toHaveLength(connections);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains managed expiry, hash and pending-tuple checks in mixed mode", async () => {
    const { link, socket } = harness(); link.bindRun("managed", "managed"); const event = frame("managed"), claim = context(event);
    await expect(link.channel.exposeOnce(event, { ...claim, contentSha256: "0".repeat(64) })).rejects.toThrow("durable event bytes");
    await expect(link.channel.exposeOnce(event, { ...claim, deadlineTickMs: monotonicMs() })).rejects.toThrow("expired");
    const sent = observe(link.channel.exposeOnce(event, claim));
    await expect(link.channel.exposeOnce(event, { ...claim, attemptId: randomUUID() })).rejects.toThrow("exposed observer");
    const changed = frame("managed", 0, "changed");
    await expect(link.channel.exposeOnce(changed, context(changed))).rejects.toThrow("body changed");
    expect(socket.events()).toEqual([event]); socket.receipt("managed", 0, "rejected"); expect(await sent.result).toBe("rejected");
  });
});
