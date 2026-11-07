import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationBrokerControl, parseApplicationBrokerCommand, decodeBrokerBytes, type ApplicationBrokerConfiguration } from "./application-broker-control.js";
import { ApplicationWireDecoder, ApplicationWireEncoder } from "./application-wire-v1.js";
import { ApplicationDataBroker } from "./application-data-broker.js";
const directories: string[] = [], controls: ApplicationBrokerControl[] = [];
afterEach(() => { for (const control of controls.splice(0)) { try { control.dispose(); } catch { /* Failed sessions remain failed; stores close in finally. */ } }
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(access: "read" | "write" = "write", maxBytes = 64) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-broker-control-")); directories.push(directory);
  const config: ApplicationBrokerConfiguration = { version: 1, protocol: "artoo.application-broker.v1", databasePath: join(directory, "data.sqlite"), mode: "create",
    schemaJson: JSON.stringify({ version: 1, tables: [{ name: "items", columns: [{ name: "title", type: "text", nullable: false, max_bytes: maxBytes }] }] }),
    scope: { product_id: "p", data_generation: "d", service_generation: 1, artifact_digest: `sha256:${"a".repeat(64)}` }, maximumAccess: access };
  const control = new ApplicationBrokerControl(config); controls.push(control);
  const input = new ApplicationWireEncoder("application-to-host"), output = new ApplicationWireDecoder("host-to-application"); let sequence = 0;
  const run = (action: object) => control.accept({ version: 1, sequence: sequence++, ...action });
  const begin = (overrides = {}) => {
    const result = run({ kind: "begin", invocation: "host-1", purpose: "application", access, lifetimeMs: 30000,
      requestJson: JSON.stringify({ request_id: "req", method: "POST", path: "/items", query: {}, body: null }), ...overrides });
    const message = output.push(Buffer.from(result.frames[0]!, "base64"))[0]!;
    if (message.kind !== "invoke") throw Error("No invocation"); return message.call_id;
  };
  const receiveBytes = (bytes: Buffer) => {
    let result;
    for (let offset = 0; offset < bytes.length; offset += 65_536) result = run({ kind: "receive", data: bytes.subarray(offset, offset + 65_536).toString("base64") });
    return result!;
  };
  const receive = (message: object) => receiveBytes(input.encode(JSON.stringify(message)));
  const decodeOutput = (encoded: string) => {
    const bytes = Buffer.from(encoded, "base64"); const messages = [];
    for (let offset = 0; offset < bytes.length; offset += 65_536) messages.push(...output.push(bytes.subarray(offset, offset + 65_536)));
    return messages;
  };
  return { control, config, run, begin, receive, receiveBytes, input, output, decodeOutput };
}
const transaction = JSON.stringify({ version: 1, kind: "transaction", idempotency_key: "op-1",
  operations: [{ kind: "insert", table: "items", id: "one", values: { title: "persisted" } }] });
function seededLargeReplies() {
  const f = fixture("write", 4096), call = f.begin();
  for (let start = 0; start < 30; start += 7) {
    const result = f.receive({ kind: "data-call", call_id: call, data_call_id: `seed-${start}`, request_json: JSON.stringify({ version: 1,
      kind: "transaction", idempotency_key: `seed-${start}`, operations: Array.from({ length: Math.min(7, 30 - start) }, (_, index) => ({
        kind: "insert", table: "items", id: `row-${start + index}`, values: { title: "\\".repeat(4000) } })) }) });
    expect(f.output.push(Buffer.from(result.frames[0]!, "base64"))[0]?.kind).toBe("data-result");
  }
  f.receive({ kind: "response", call_id: call, response: { status: 200, body: null } });
  const read = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id", "title"], limit: 30 } });
  const marker = JSON.stringify({ version: 1, kind: "transaction", idempotency_key: "marker", operations: [{ kind: "insert", table: "items", id: "marker", values: { title: "x" } }] });
  const absentMarker = () => {
    const broker = new ApplicationDataBroker({ ...f.config, mode: "open" });
    const query = JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id"], id: "marker", limit: 1 } });
    const permit = broker.grantInvocation({ scope: f.config.scope, access: "read", lifetime_ms: 30000, request_digest: broker.describeRequest(query).request_digest });
    try { expect(broker.execute(permit, query).result).toMatchObject({ kind: "read", rows: [] }); }
    finally { broker.revoke(permit); broker.close(); }
  };
  return { ...f, read, marker, absentMarker };
}
describe("trusted broker control boundary", () => {
  it("round-trips an actual SQLite commit and returns the original host correlation", () => {
    const f = fixture(), call = f.begin();
    const result = f.receive({ kind: "data-call", call_id: call, data_call_id: "data-1", request_json: transaction });
    const reply = f.output.push(Buffer.from(result.frames[0]!, "base64"))[0]!;
    expect(reply.kind).toBe("data-result");
    if (reply.kind === "data-result") expect(JSON.parse(reply.reply_json).result.kind).toBe("committed");
    expect(f.receive({ kind: "response", call_id: call, response: { status: 201, body: { saved: true } } }).responses)
      .toEqual([{ invocation: "host-1", response: { status: 201, body: { saved: true } } }]);
    expect(f.run({ kind: "shutdown" }).stopped).toBe(true);
    const reopened = new ApplicationDataBroker({ ...f.config, mode: "open" }); expect(reopened.getScope()).toEqual(f.config.scope); reopened.close();
  });
  it("does not reinterpret generated bytes as trusted begin/configuration", () => {
    const f = fixture(); f.begin();
    expect(() => f.run({ kind: "receive", data: Buffer.from('{"kind":"begin","access":"write"}\n').toString("base64") })).toThrow();
    expect(() => f.run({ kind: "poll" })).toThrow();
  });
  it("returns 33 committed data frames across two invocations without dropping the batch", () => {
    const f = fixture(), first = f.begin(), second = f.begin({ invocation: "host-2" });
    const encoder = new ApplicationWireEncoder("application-to-host"), frames: Buffer[] = [];
    for (let index = 0; index < 33; index++) frames.push(encoder.encode(JSON.stringify({ kind: "data-call", call_id: index < 32 ? first : second,
      data_call_id: `data-${index}`, request_json: JSON.stringify({ version: 1, kind: "transaction", idempotency_key: `op-${index}`,
        operations: [{ kind: "insert", table: "items", id: `row-${index}`, values: { title: "persisted" } }] }) })));
    const input = Buffer.concat(frames); expect(input.length).toBeLessThan(65_536);
    const result = f.run({ kind: "receive", data: input.toString("base64") }); expect(result.frames).toHaveLength(33);
    for (const encoded of result.frames) {
      const message = f.output.push(Buffer.from(encoded, "base64"))[0]!; expect(message.kind).toBe("data-result");
      if (message.kind === "data-result") expect(JSON.parse(message.reply_json).result.kind).toBe("committed");
    }
  });
  it("denies policy fields on receive and scope/path changes on control", () => {
    for (const extra of [{ access: "write" }, { databasePath: "C:\\another.sqlite" }, { scope: {} }]) {
      expect(() => parseApplicationBrokerCommand({ version: 1, sequence: 0, kind: "receive", data: "AAAA", ...extra })).toThrow();
    }
  });
  it("rejects duplicate or skipped sequence and permanently fails the session", () => {
    for (const sequence of [0, 2]) {
      const f = fixture(); f.run({ kind: "poll" });
      expect(() => f.control.accept({ version: 1, sequence, kind: "poll" })).toThrow();
      expect(() => f.run({ kind: "poll" })).toThrow();
    }
  });
  it("cannot reuse a completed host invocation ID", () => {
    const f = fixture(), call = f.begin(); f.receive({ kind: "response", call_id: call, response: { status: 200, body: null } });
    expect(() => f.begin()).toThrow();
  });
  it("keeps health and peer on separate read-only sessions", () => {
    for (const purpose of ["health", "peer"]) {
      const writable = fixture(); expect(() => writable.begin({ purpose, access: "read" })).toThrow();
      const readonly = fixture("read"), call = readonly.begin({ purpose });
      const result = readonly.receive({ kind: "data-call", call_id: call, data_call_id: "data-1", request_json: transaction });
      expect(readonly.output.push(Buffer.from(result.frames[0]!, "base64"))[0]).toMatchObject({ kind: "data-error", code: "unauthorized" });
    }
  });
  it("cancels the actual opaque invocation and rejects later data", () => {
    const f = fixture(), call = f.begin();
    expect(f.run({ kind: "cancel", invocation: "host-1" }).terminated).toEqual([{ invocation: "host-1", reason: "cancelled" }]);
    expect(() => f.receive({ kind: "data-call", call_id: call, data_call_id: "data-1", request_json: transaction })).toThrow();
  });
  it("rejects noncanonical or oversized base64 before bridge admission", () => {
    for (const value of ["YQ", "YQ==\n", "YR==", "", Buffer.alloc(65537).toString("base64")]) expect(() => decodeBrokerBytes(value)).toThrow();
  });
  it("retires an active invocation during shutdown and never reopens control", () => {
    const f = fixture(); f.begin(); expect(f.run({ kind: "shutdown" }).stopped).toBe(true);
    expect(() => f.run({ kind: "poll" })).toThrow();
  });
  it("rejects a reply exceeding the control line budget before the batch's first COMMIT", () => {
    const f = seededLargeReplies(), call = f.begin({ invocation: "large-batch" });
    const frames = [f.marker, f.read, f.read, f.read].map((request_json, index) => f.input.encode(JSON.stringify({ kind: "data-call",
      call_id: call, data_call_id: `large-${index}`, request_json })));
    const grants = vi.spyOn(ApplicationDataBroker.prototype, "grantInvocation");
    let reply, rejected = false; try { reply = f.receiveBytes(Buffer.concat(frames)); } catch { rejected = true; }
    if (!rejected) expect(Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(1_500_000);
    expect(rejected).toBe(true); expect(grants).not.toHaveBeenCalled(); grants.mockRestore(); f.absentMarker();
  });
  it("delivers a bounded mixed mutation/query reply and its durable replay", () => {
    const f = seededLargeReplies(), call = f.begin({ invocation: "mixed" });
    const request = JSON.stringify({ version: 1, kind: "transaction", idempotency_key: "mixed", operations: [
      { kind: "insert", table: "items", id: "mixed-marker", values: { title: "x" } },
      { kind: "query", table: "items", columns: ["id", "title"], limit: 30 },
    ] });
    for (const [index, replayed] of [false, true].entries()) {
      const result = f.receive({ kind: "data-call", call_id: call, data_call_id: `mixed-${index}`, request_json: request });
      const message = f.decodeOutput(result.frames[0]!)[0]!; expect(message.kind).toBe("data-result");
      if (message.kind === "data-result") expect(JSON.parse(message.reply_json)).toMatchObject({ replayed, result: { kind: "committed" } });
    }
  });
  it("reserves the remaining cumulative output before granting any request in a batch", () => {
    const f = seededLargeReplies(), call = f.begin({ invocation: "remaining-batch" }); let measured = 0;
    for (let invocation = 0; invocation < 2; invocation++) {
      const call = f.begin({ invocation: `read-batch-${invocation}` });
      for (let index = 0; index < 6; index++) {
        const reply = f.receive({ kind: "data-call", call_id: call, data_call_id: `read-${index}`, request_json: f.read });
        measured += Buffer.byteLength(JSON.stringify(reply)) + 1;
        expect(f.decodeOutput(reply.frames[0]!)[0]?.kind).toBe("data-result");
      }
      f.receive({ kind: "response", call_id: call, response: { status: 200, body: null } });
    }
    const frames = [f.marker, f.read, f.read].map((request_json, index) => f.input.encode(JSON.stringify({ kind: "data-call",
      call_id: call, data_call_id: `remaining-${index}`, request_json })));
    const grants = vi.spyOn(ApplicationDataBroker.prototype, "grantInvocation");
    let reply, rejected = false; try { reply = f.receiveBytes(Buffer.concat(frames)); } catch { rejected = true; }
    if (!rejected) expect(measured + Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(8_388_608);
    expect(rejected).toBe(true); expect(grants).not.toHaveBeenCalled(); grants.mockRestore(); f.absentMarker();
  });
});
