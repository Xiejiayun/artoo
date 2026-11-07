import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationDataBroker } from "./application-data-broker.js";
import { ApplicationDataError, type ApplicationDataScope } from "./application-data-contract.js";
import {
  APPLICATION_INVOCATION_LIMITS as limits, ApplicationInvocationBridge, ApplicationInvocationError,
  type ApplicationInvocationErrorCode, type ApplicationInvocationEvent, type ApplicationInvocationHandle,
  type ApplicationInvocationPolicy,
} from "./application-invocation-bridge.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireDecoder, ApplicationWireEncoder, type ApplicationWireEnvelope } from "./application-wire-v1.js";

const schema = { version: 1, tables: [{ name: "items", columns: [
  { name: "text", type: "text", nullable: false, max_bytes: 4096 },
] }] };
const scope: ApplicationDataScope = { product_id: "notes", data_generation: "original",
  service_generation: 1, artifact_digest: `sha256:${"a".repeat(64)}` };
const policy: ApplicationInvocationPolicy = { purpose: "application", access: "write", lifetime_ms: 30_000 };
const request = JSON.stringify({ request_id: "request", method: "POST", path: "/notes", query: {}, body: { title: "笔记 📝" } });
const read = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id", "text"], limit: 100 } });
const insert = (key = "write-1", id = "note-1", text = "value") => JSON.stringify({ version: 1, kind: "transaction",
  idempotency_key: key, operations: [{ kind: "insert", table: "items", id, values: { text } }] });
const brokers = new Set<ApplicationDataBroker>(), directories = new Set<string>();
afterEach(context => {
  const originals = [...brokers], stores = [...directories], failures: unknown[] = [];
  brokers.clear(); directories.clear();
  for (const broker of originals) { try { broker.close(); } catch (error) { failures.push(error); } }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, "Original broker closure failed; stores retained");
  // Test bodies and SQLite closure here are synchronous. Failed stores remain for diagnosis.
  if (context.task.result?.state !== "pass" || context.signal.aborted) return;
  for (const directory of stores) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^artoo-invocation-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture(clock?: () => number, schemaValue: unknown = schema) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-invocation-")); directories.add(directory);
  const options = { databasePath: join(directory, "store.sqlite"), schemaJson: JSON.stringify(schemaValue), scope };
  function track(broker: ApplicationDataBroker) { brokers.add(broker); return broker; }
  const broker = track(new ApplicationDataBroker({ ...options, mode: "create" }, clock));
  return { broker, reopen: () => track(new ApplicationDataBroker({ ...options, mode: "open" }, clock)) };
}
function direct(broker: ApplicationDataBroker, json: string) {
  const permit = broker.grantInvocation({ scope: broker.getScope(), request_digest: broker.describeRequest(json).request_digest,
    access: "write", lifetime_ms: 30_000 });
  try { return broker.execute(permit, json); } finally { broker.revoke(permit); }
}
function harness(broker: ApplicationDataBroker, maximum: "read" | "write" = "write", clock?: () => number) {
  const bridge = new ApplicationInvocationBridge(broker, broker.getScope(), maximum, clock);
  const encoder = new ApplicationWireEncoder("application-to-host"), decoder = new ApplicationWireDecoder("host-to-application");
  function decode(frame: Buffer): ApplicationWireEnvelope {
    const messages: ApplicationWireEnvelope[] = [];
    for (let start = 0; start < frame.length; start += APPLICATION_WIRE_LIMITS.chunkBytes)
      messages.push(...decoder.push(frame.subarray(start, start + APPLICATION_WIRE_LIMITS.chunkBytes)));
    expect(messages).toHaveLength(1);
    return messages[0]!;
  }
  function receive(frame: Buffer, width: number = APPLICATION_WIRE_LIMITS.chunkBytes) {
    const events: ApplicationInvocationEvent[] = [];
    for (let start = 0; start < frame.length; start += width) events.push(...bridge.receive(frame.subarray(start, start + width)));
    return events;
  }
  function begin(grant: ApplicationInvocationPolicy = policy, json = request) {
    const result = bridge.begin(json, grant), message = decode(result.frame);
    if (message.kind !== "invoke") throw new Error("Expected host invocation");
    return { ...result, callId: message.call_id, message };
  }
  function send(message: unknown, width?: number) { return receive(encoder.encode(JSON.stringify(message)), width); }
  function data(callId: string, id: string, json = read) {
    const events = send({ kind: "data-call", call_id: callId, data_call_id: id, request_json: json });
    expect(events).toHaveLength(1);
    if (events[0]?.kind !== "send") throw new Error("Expected data reply");
    return { frame: events[0].frame, message: decode(events[0].frame) };
  }
  return { bridge, encoder, decode, begin, data, send, receive };
}
function rejected(fn: () => unknown, code: ApplicationInvocationErrorCode): ApplicationInvocationError {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ApplicationInvocationError);
    expect((error as ApplicationInvocationError).code).toBe(code);
    return error as ApplicationInvocationError;
  }
  throw new Error("Expected rejected invocation");
}
function rawFrame(value: unknown, sequence: number, whitespace = 0): Buffer {
  const json = Buffer.from(JSON.stringify({ version: 1, sequence, ...(value as object) }) + " ".repeat(whitespace));
  const header = Buffer.alloc(4); header.writeUInt32BE(json.length);
  return Buffer.concat([header, json]);
}

describe("unintegrated trusted application invocation bridge", () => {
  it("round-trips real SQLite and fragmented wire input while keeping the original invocation opaque", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    expect(Object.keys(call.invocation)).toEqual([]);
    expect(Object.isFrozen(call.invocation)).toBe(true);
    const events = h.send({ kind: "data-call", call_id: call.callId, data_call_id: "create", request_json: insert() }, 1);
    if (events[0]?.kind !== "send") throw new Error("Expected reply");
    const result = h.decode(events[0].frame);
    expect(result.kind).toBe("data-result");
    if (result.kind !== "data-result") throw new Error("Expected data result");
    expect(JSON.parse(result.reply_json)).toMatchObject({ result: { kind: "committed", scope } });
    const finished = h.send({ kind: "response", call_id: call.callId, response: { status: 201, body: { title: "笔记 📝" } } }, 1);
    expect(finished).toEqual([{ kind: "response", invocation: call.invocation, response: { status: 201, body: { title: "笔记 📝" } } }]);
    expect((finished[0] as { invocation: ApplicationInvocationHandle }).invocation).toBe(call.invocation);
    h.bridge.finishInput();
    rejected(() => h.bridge.begin(request, policy), "closed");
  });

  it("revokes each original exact-request permit after successful execution", () => {
    const { broker } = fixture(), issued = vi.spyOn(broker, "grantInvocation"), h = harness(broker), call = h.begin();
    h.data(call.callId, "write", insert());
    expect(issued).toHaveBeenCalledOnce();
    const permit = issued.mock.results[0]!.value;
    expect(() => broker.execute(permit, insert())).toThrow(new ApplicationDataError("revoked"));
    expect(issued.mock.calls[0]![0]).toMatchObject({ scope, access: "write", request_digest: broker.describeRequest(insert()).request_digest });
  });

  it("rejects request text that would overwrite the host's call ID through duplicate envelope keys", () => {
    const { broker } = fixture(), h = harness(broker), writer = h.begin();
    const injected = `${request},"call_id":${JSON.stringify(writer.callId)},"request":${request}`;
    // Keep this an application read grant: rejecting mixed health sessions must not mask parsing.
    rejected(() => h.begin({ ...policy, access: "read" }, injected), "protocol");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
    rejected(() => h.data(writer.callId, "write", insert()), "protocol");
  });

  it.each(["oversized", "deep"] as const)("bounds %s standalone request text before invoking the encoder", kind => {
    const { broker } = fixture(), h = harness(broker), encode = vi.spyOn(ApplicationWireEncoder.prototype, "encode");
    const json = kind === "oversized" ? " ".repeat(APPLICATION_WIRE_LIMITS.frameBytes + 1)
      : `${"[".repeat(APPLICATION_WIRE_LIMITS.jsonDepth + 1)}0${"]".repeat(APPLICATION_WIRE_LIMITS.jsonDepth + 1)}`;
    rejected(() => h.bridge.begin(json, policy), "protocol");
    expect(encode.mock.calls.length).toBe(0);
  });

  it.each(["health", "peer"] as const)("keeps %s reads independent of method and never grants its writes", purpose => {
    const { broker } = fixture(), issued = vi.spyOn(broker, "grantInvocation"), h = harness(broker, "read");
    const call = h.begin({ ...policy, purpose, access: "read" }); // POST is not write authority.
    expect(h.data(call.callId, "read").message.kind).toBe("data-result");
    expect(h.data(call.callId, "write", insert()).message).toMatchObject({ kind: "data-error", code: "unauthorized" });
    expect(issued).toHaveBeenCalledOnce();
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it.each(["health", "peer"] as const)("rejects a host write grant for %s", purpose => {
    const { broker } = fixture(), h = harness(broker);
    rejected(() => h.begin({ ...policy, purpose }), "unauthorized");
  });

  it.each(["health", "peer"] as const)("rejects mixing %s with a write-capable session even when that invocation requests read", purpose => {
    const { broker } = fixture(), h = harness(broker); h.begin();
    rejected(() => h.begin({ ...policy, purpose, access: "read" }), "unauthorized");
  });

  it("enforces the host's read-only service ceiling even for application invocations", () => {
    const { broker } = fixture(), h = harness(broker, "read");
    rejected(() => h.begin(), "unauthorized");
  });

  it.each([0, -1, 30_001, Number.NaN])("rejects invalid local invocation lifetime %s", lifetime_ms => {
    const { broker } = fixture(), h = harness(broker);
    rejected(() => h.begin({ ...policy, lifetime_ms }), "unauthorized");
  });

  it("rejects already-aborted admission and abortion before a data transaction", () => {
    const { broker } = fixture(), first = harness(broker), controller = new AbortController(); controller.abort();
    rejected(() => first.begin({ ...policy, signal: controller.signal }), "aborted");
    const second = harness(broker), later = new AbortController(), call = second.begin({ ...policy, signal: later.signal });
    later.abort();
    rejected(() => second.data(call.callId, "write", insert()), "aborted");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("polls expiration and external cancellation without claiming a native deadline", () => {
    const { broker } = fixture(); let now = 100;
    const h = harness(broker, "write", () => now), controller = new AbortController();
    const expiry = h.begin({ ...policy, lifetime_ms: 5 }), abort = h.begin({ ...policy, signal: controller.signal });
    now = 105; controller.abort();
    const events = h.bridge.poll();
    expect(events.filter(event => event.kind === "terminated")).toEqual([
      { kind: "terminated", invocation: expiry.invocation, reason: "expired" },
      { kind: "terminated", invocation: abort.invocation, reason: "aborted" },
    ]);
    for (const event of events) if (event.kind === "send") expect(h.decode(event.frame).kind).toBe("cancel");
    rejected(() => h.data(expiry.callId, "late-write", insert()), "inactive");
  });

  it("rejects expired calls before polling and closes on backwards/nonfinite clocks", () => {
    const { broker } = fixture(); let now = 10;
    const h = harness(broker, "write", () => now), call = h.begin({ ...policy, lifetime_ms: 5 });
    now = 15; rejected(() => h.data(call.callId, "write", insert()), "expired");
    const backwards = harness(broker, "write", () => now); backwards.begin(); now = 14;
    const failure = rejected(() => backwards.bridge.poll(), "clock");
    now = 20; expect(() => backwards.bridge.poll()).toThrow(failure);
    const nonfinite = harness(broker, "write", () => now); now = Number.NaN;
    rejected(() => nonfinite.bridge.poll(), "clock");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("revokes the session if its trusted clock throws", () => {
    const { broker } = fixture(); let throws = false;
    const h = harness(broker, "write", () => { if (throws) throw new Error("private clock detail"); return 0; });
    h.begin(); throws = true;
    const failure = rejected(() => h.bridge.poll(), "clock");
    expect(failure.message).not.toContain("private");
  });

  it("does not accept copied, foreign or already-completed host handles", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    rejected(() => h.bridge.cancel({ ...call.invocation }), "inactive");
    const other = harness(broker), foreign = harness(broker).begin();
    rejected(() => other.bridge.cancel(foreign.invocation), "inactive");
    const finished = harness(broker), completed = finished.begin();
    finished.send({ kind: "response", call_id: completed.callId, response: { status: 204, body: null } });
    rejected(() => finished.bridge.cancel(completed.invocation), "inactive");
  });

  it("cancels the original invocation and rejects later data and response frames", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    const events = h.bridge.cancel(call.invocation);
    expect(events[1]).toEqual({ kind: "terminated", invocation: call.invocation, reason: "cancelled" });
    if (events[0]?.kind !== "send") throw new Error("Expected cancellation");
    expect(h.decode(events[0].frame)).toMatchObject({ kind: "cancel", call_id: call.callId });
    rejected(() => h.data(call.callId, "write", insert()), "inactive");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("does not let app fields, nested scope or SQL become host authority", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    const poisoned = JSON.stringify({ ...JSON.parse(insert()), scope, permit: "write", sql: "DELETE FROM items" });
    expect(h.data(call.callId, "poisoned", poisoned).message).toMatchObject({ kind: "data-error", code: "invalid-request" });
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
    const frame = rawFrame({ kind: "data-call", call_id: call.callId, data_call_id: "forged", request_json: insert(), scope }, 2);
    rejected(() => h.receive(frame), "protocol");
  });

  it("binds every child frame to a live invocation, independent of sequence validity", () => {
    const { broker } = fixture(), h = harness(broker); h.begin();
    rejected(() => h.data("made-up", "write", insert()), "inactive");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("retains a real committed transaction if a later semantic error rejects the same receive", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    const frame = () => h.encoder.encode(JSON.stringify({ kind: "data-call", call_id: call.callId, data_call_id: "same", request_json: insert() }));
    const batch = Buffer.concat([frame(), frame()]);
    const failure = rejected(() => h.bridge.receive(batch), "protocol");
    expect(direct(broker, read).result).toMatchObject({ rows: [{ id: "note-1", text: "value" }] });
    expect(() => h.bridge.receive(Buffer.alloc(0))).toThrow(failure);
  });

  it("permits durable replay with a fresh data-call ID while retaining the original committed scope", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    h.data(call.callId, "first", insert());
    expect(h.data(call.callId, "replay", insert()).message.kind).toBe("data-result");
    h.bridge.close();
    broker.rotateService({ service_generation: 2, artifact_digest: `sha256:${"b".repeat(64)}` });
    const next = harness(broker), nextCall = next.begin(), message = next.data(nextCall.callId, "after-rotation", insert()).message;
    if (message.kind !== "data-result") throw new Error("Expected replay");
    expect(JSON.parse(message.reply_json)).toMatchObject({ replayed: true, result: { scope } });
  });

  it("closes on local rotation, and rejects persisted rotation by another real connection before data work", () => {
    const first = fixture(), h = harness(first.broker); h.begin();
    first.broker.rotateService({ service_generation: 2, artifact_digest: `sha256:${"b".repeat(64)}` });
    rejected(() => h.bridge.poll(), "scope-mismatch");
    const second = fixture(), other = second.reopen(), live = harness(second.broker), call = live.begin();
    other.rotateService({ service_generation: 2, artifact_digest: `sha256:${"b".repeat(64)}` });
    rejected(() => live.data(call.callId, "write", insert()), "scope-mismatch");
    expect(direct(other, read).result).toMatchObject({ rows: [] });
  });

  it("does not adopt a mutated caller scope object or mismatch at construction", () => {
    const { broker } = fixture(), callerScope = { ...scope };
    const bridge = new ApplicationInvocationBridge(broker, callerScope, "write");
    callerScope.service_generation = 2;
    expect(() => bridge.begin(request, policy)).not.toThrow();
    rejected(() => new ApplicationInvocationBridge(broker, callerScope, "write"), "scope-mismatch");
  });

  it("counts rejected data requests against the per-invocation quota", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    for (let i = 0; i < limits.dataCallsPerInvocation; i++)
      expect(h.data(call.callId, `invalid-${i}`, "{}").message).toMatchObject({ kind: "data-error", code: "invalid-request" });
    rejected(() => h.data(call.callId, "exhausted", insert()), "limit");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("bounds active invocations and the full session's non-reusable host IDs", () => {
    const { broker } = fixture(), concurrent = harness(broker);
    for (let i = 0; i < limits.active; i++) concurrent.begin();
    rejected(() => concurrent.begin(), "limit");
    const serial = harness(broker), ids = new Set<string>();
    for (let i = 0; i < limits.invocations; i++) {
      const call = serial.begin(); expect(ids.has(call.callId)).toBe(false); ids.add(call.callId);
      serial.send({ kind: "response", call_id: call.callId, response: { status: 204, body: null } });
    }
    rejected(() => serial.begin(), "limit");
  });

  it("charges exact fragmented frame bytes including outer JSON whitespace", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    for (let i = 0; i < 2; i++) {
      const frame = rawFrame({ kind: "data-call", call_id: call.callId, data_call_id: `padding-${i}`, request_json: "{}" }, i + 1, 500_000);
      const events = h.receive(frame);
      if (events[0]?.kind !== "send") throw new Error("Expected data rejection");
      expect(h.decode(events[0].frame)).toMatchObject({ kind: "data-error", code: "invalid-request" });
    }
    const last = rawFrame({ kind: "data-call", call_id: call.callId, data_call_id: "write", request_json: insert() }, 3, 60_000);
    rejected(() => h.receive(last), "limit");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("bounds total data calls across completed invocations, including schema rejections", () => {
    const { broker } = fixture(), h = harness(broker);
    for (let callIndex = 0; callIndex < limits.dataCalls / limits.dataCallsPerInvocation; callIndex++) {
      const call = h.begin();
      for (let i = 0; i < limits.dataCallsPerInvocation; i++) h.data(call.callId, `invalid-${i}`, "{}");
      h.send({ kind: "response", call_id: call.callId, response: { status: 204, body: null } });
    }
    const last = h.begin(); rejected(() => h.data(last.callId, "write", insert()), "limit");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("counts raw bytes across completed invocations and rejects an over-budget partial frame before executing it", () => {
    const { broker } = fixture(), h = harness(broker); let sequence = 0;
    for (let i = 0; i < 16; i++) {
      const call = h.begin();
      const events = h.receive(rawFrame({ kind: "data-call", call_id: call.callId, data_call_id: "padding", request_json: "{}" }, ++sequence, 990_000));
      if (events[0]?.kind !== "send") throw new Error("Expected invalid request reply");
      h.decode(events[0].frame);
      h.receive(rawFrame({ kind: "response", call_id: call.callId, response: { status: 204, body: null } }, ++sequence));
    }
    const last = h.begin();
    rejected(() => h.receive(rawFrame({ kind: "data-call", call_id: last.callId, data_call_id: "write", request_json: insert() }, ++sequence, 990_000)), "limit");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });

  it("reserves output capacity before authorizing a write", () => {
    const { broker } = fixture();
    for (let i = 0; i < 60; i++) direct(broker, insert(`seed-${i}`, `seed-${i}`, "x".repeat(4096)));
    const h = harness(broker), call = h.begin();
    const largeRead = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["text"], limit: 60 } });
    let bytes = call.frame.length;
    for (let i = 0; i < 13; i++) bytes += h.data(call.callId, `large-${i}`, largeRead).frame.length;
    expect(bytes + APPLICATION_WIRE_LIMITS.frameBytes + 4).toBeGreaterThan(limits.invocationOutputBytes);
    rejected(() => h.data(call.callId, "write", insert()), "limit");
    const result = direct(broker, read).result;
    if (result.kind !== "read") throw new Error("Expected read result");
    expect(result.rows.some(row => row.id === "note-1")).toBe(false);
  });

  it("retains the session output quota across completed invocations", () => {
    const { broker } = fixture();
    for (let i = 0; i < 60; i++) direct(broker, insert(`seed-${i}`, `seed-${i}`, "x".repeat(4096)));
    const h = harness(broker), largeRead = JSON.stringify({ version: 1, kind: "read",
      query: { kind: "query", table: "items", columns: ["text"], limit: 60 } });
    let bytes = 0, reached = false;
    for (let i = 0; i < 11 && !reached; i++) {
      const call = h.begin(); bytes += call.frame.length;
      for (let j = 0; j < 13; j++) {
        if (bytes + APPLICATION_WIRE_LIMITS.frameBytes + 4 > limits.outputBytes) {
          rejected(() => h.data(call.callId, "write", insert()), "limit"); reached = true; break;
        }
        bytes += h.data(call.callId, `large-${j}`, largeRead).frame.length;
      }
      if (!reached) h.send({ kind: "response", call_id: call.callId, response: { status: 204, body: null } });
    }
    expect(reached).toBe(true);
    const result = direct(broker, read).result;
    if (result.kind !== "read") throw new Error("Expected read result");
    expect(result.rows.some(row => row.id === "note-1")).toBe(false);
  });

  it("rejects a transaction's oversized possible reply graph before granting or committing it", () => {
    const fields = Array.from({ length: 15 }, (_, i) => `flag_${i}`);
    const largerSchema = { version: 1, tables: [{ name: "items", columns: [schema.tables[0]!.columns[0]!,
      ...fields.map(name => ({ name, type: "boolean", nullable: false })),
    ] }] };
    const { broker } = fixture(undefined, largerSchema);
    const values = { text: "value", ...Object.fromEntries(fields.map(name => [name, true])) };
    for (let i = 0; i < 100; i++) direct(broker, JSON.stringify({ version: 1, kind: "transaction", idempotency_key: `seed-${i}`,
      operations: [{ kind: "insert", table: "items", id: `seed-${i}`, values }] }));
    const h = harness(broker), call = h.begin(), issued = vi.spyOn(broker, "grantInvocation");
    const json = JSON.stringify({ version: 1, kind: "transaction", idempotency_key: "too-wide",
      operations: [{ kind: "insert", table: "items", id: "must-not-commit", values },
        ...Array.from({ length: 5 }, () => ({ kind: "query", table: "items", columns: ["id", "revision", "text", ...fields], limit: 100 })),
      ] });
    expect(h.data(call.callId, "wide", json).message).toMatchObject({ kind: "data-error", code: "limit" });
    expect(issued).not.toHaveBeenCalled();
    const check = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id"], id: "must-not-commit", limit: 1 } });
    expect(direct(broker, check).result).toMatchObject({ rows: [] });
  });

  it("round-trips an actual 16,384-entry reply and refuses the 16,385-entry variant before the write", () => {
    const fields = Array.from({ length: 15 }, (_, i) => `flag_${i}`);
    const largerSchema = { version: 1, tables: [{ name: "items", columns: [schema.tables[0]!.columns[0]!,
      ...fields.map(name => ({ name, type: "boolean", nullable: false })),
    ] }] };
    const { broker } = fixture(undefined, largerSchema);
    const values = { text: "value", ...Object.fromEntries(fields.map(name => [name, true])) };
    for (let i = 0; i < 100; i++) direct(broker, JSON.stringify({ version: 1, kind: "transaction", idempotency_key: `seed-${i}`,
      operations: [{ kind: "insert", table: "items", id: `seed-${i}`, values }] }));
    const columns = ["id", "revision", "text", ...fields];
    function transaction(id: string, a: number, b: number) {
      return JSON.stringify({ version: 1, kind: "transaction", idempotency_key: id,
        operations: [{ kind: "insert", table: "items", id, values },
          ...Array.from({ length: 4 }, () => ({ kind: "query", table: "items", columns, limit: 100 })),
          { kind: "query", table: "items", columns: columns.slice(0, 8), limit: a },
          { kind: "query", table: "items", columns: columns.slice(0, 9), limit: b },
        ] });
    }
    const h = harness(broker), call = h.begin();
    // 23 + 7 + 6*5 + 4*100*37 + 74*17 + 14*19 = 16,384 actual entries.
    const message = h.data(call.callId, "exact", transaction("exact-limit", 74, 14)).message;
    if (message.kind !== "data-result") throw new Error("Expected encodable exact-boundary reply");
    expect(JSON.parse(message.reply_json)).toMatchObject({ result: { kind: "committed" } });
    const issued = vi.spyOn(broker, "grantInvocation");
    // Moving the two limits by +9/-8 adds 9*17 - 8*19 = one entry.
    expect(h.data(call.callId, "above", transaction("above-limit", 83, 6)).message).toMatchObject({ kind: "data-error", code: "limit" });
    expect(issued).not.toHaveBeenCalled();
    const check = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id"], id: "above-limit", limit: 1 } });
    expect(direct(broker, check).result).toMatchObject({ rows: [] });
  });

  it("preserves a committed transaction when a synthetic clock crosses the invocation deadline before reply", () => {
    let now = 0, advance = false;
    // Controlled clock seam only: a grant moves host time after its pre-admission check.
    const { broker } = fixture(() => { if (advance) now = 10; return 0; });
    const h = harness(broker, "write", () => now), call = h.begin({ ...policy, lifetime_ms: 5 });
    const issued = vi.spyOn(broker, "grantInvocation"); advance = true;
    rejected(() => h.data(call.callId, "write", insert()), "expired");
    expect(direct(broker, read).result).toMatchObject({ rows: [{ id: "note-1" }] });
    expect(() => broker.execute(issued.mock.results[0]!.value, insert())).toThrow(new ApplicationDataError("revoked"));
  });

  it("uses fixed errors and revokes the session on a broker failure", () => {
    const { broker } = fixture(), h = harness(broker), call = h.begin();
    vi.spyOn(broker, "describeRequest").mockImplementationOnce(() => { throw new Error("C:/private/secret.sqlite"); });
    const failure = rejected(() => h.data(call.callId, "write", insert()), "broker-failed");
    expect(failure.message).not.toContain("private");
    expect(() => h.bridge.poll()).toThrow(failure);
  });

  it("keeps framing EOF, host shutdown and process closure distinct", () => {
    const { broker } = fixture(), open = harness(broker); open.begin();
    rejected(() => open.bridge.finishInput(), "protocol");
    const truncated = harness(broker); truncated.bridge.receive(Buffer.from([0]));
    rejected(() => truncated.bridge.finishInput(), "protocol");
    const closing = harness(broker), call = closing.begin();
    expect(closing.decode(closing.bridge.close()).kind).toBe("shutdown");
    rejected(() => closing.data(call.callId, "write", insert()), "closed");
    expect(direct(broker, read).result).toMatchObject({ rows: [] });
  });
});
