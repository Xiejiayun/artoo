import { describe, expect, it, vi } from "vitest";
import { APPLICATION_RUNTIME_GUEST_LIMITS as limits, createApplicationRuntimeGuest,
  type ApplicationRuntimeGuestContext, type ApplicationRuntimeGuestHandler } from "./application-runtime-guest.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireDecoder, ApplicationWireEncoder, type ApplicationChildMessage, type ApplicationWireRequest } from "./application-wire-v1.js";
import { APPLICATION_DATA_LIMITS } from "./application-data-contract.js";
import { APPLICATION_INVOCATION_LIMITS } from "./application-invocation-bridge.js";

// These are developer-authored portable behavior fixtures in Node, not isolated
// generated-product execution, original native lifetime or publication evidence.
const request = { request_id: "request", method: "POST", path: "/items", query: {}, body: { title: "笔记 📚" } };
const read = { version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id"], limit: 1 } };
const reply = { version: 1, request_digest: `sha256:${"a".repeat(64)}`, replayed: false,
  result: { kind: "read", rows: [{ id: "one" }], scope: { product_id: "p", data_generation: "d", service_generation: 1, artifact_digest: `sha256:${"b".repeat(64)}` } } };
const invoke = (call_id = "call-1") => JSON.stringify({ kind: "invoke", call_id, request });
const result = (call_id = "call-1", data_call_id = "d1") => JSON.stringify({ kind: "data-result", call_id, data_call_id, reply_json: JSON.stringify(reply) });
const tick = async () => { for (let turn = 0; turn < 32; turn++) await Promise.resolve(); };
function output(guest: ReturnType<typeof createApplicationRuntimeGuest>): ApplicationChildMessage[] {
  return guest.drain().map(text => {
    // Validate every portable outgoing fixture through the actual existing wire.
    const bytes = new ApplicationWireEncoder("application-to-host").encode(text);
    const decoder = new ApplicationWireDecoder("application-to-host");
    const messages = [];
    for (let index = 0; index < bytes.length; index += APPLICATION_WIRE_LIMITS.chunkBytes)
      messages.push(...decoder.push(bytes.subarray(index, index + APPLICATION_WIRE_LIMITS.chunkBytes)));
    expect(messages).toHaveLength(1); decoder.finish();
    const { version: _version, sequence: _sequence, ...message } = messages[0]!;
    return message as ApplicationChildMessage;
  });
}
const held: ApplicationRuntimeGuestHandler = () => new Promise(() => {});

describe("portable application handler bootstrap (controlled Node fixtures)", () => {
  it("invokes the supplied handler and returns a wire-compatible Unicode response", async () => {
    const handler = vi.fn(async (value: ApplicationWireRequest, context: ApplicationRuntimeGuestContext) => {
      expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(context.data)).toBe(true);
      expect(Object.keys(context)).toEqual(["data"]);
      return { status: 201 as const, body: value.body };
    });
    const guest = createApplicationRuntimeGuest(handler);
    guest.receive(invoke()); expect(handler).not.toHaveBeenCalled(); await tick();
    expect(handler).toHaveBeenCalledOnce();
    expect(output(guest)).toEqual([{ kind: "response", call_id: "call-1", response: { status: 201, body: request.body } }]);
    expect(guest.status).toBe("open"); expect(output(guest)).toEqual([]);
  });

  it("correlates concurrent data promises and separate invocations even when replies are reordered", async () => {
    const guest = createApplicationRuntimeGuest(async (value, context) => {
      const results = await Promise.all([context.data.execute(read), context.data.execute(read)]);
      return { status: 200, body: { request: value.request_id, count: results.length } };
    });
    guest.receive(invoke("first")); guest.receive(invoke("second")); await tick();
    expect(output(guest).map(item => item.kind === "data-call" && [item.call_id, item.data_call_id])).toEqual([
      ["first", "d1"], ["first", "d2"], ["second", "d1"], ["second", "d2"],
    ]);
    guest.receive(result("second", "d2")); guest.receive(result("first", "d1")); await tick(); expect(output(guest)).toEqual([]);
    guest.receive(result("second", "d1")); guest.receive(result("first", "d2")); await tick();
    expect(output(guest).map(item => item.call_id)).toEqual(["second", "first"]);
  });

  it("preserves ordinary array methods and iteration for request bodies and awaited broker rows", async () => {
    const guest = createApplicationRuntimeGuest(async (value, context) => {
      const input = value.body as string[], received = await context.data.execute(read);
      if (received.result.kind !== "read") throw Error("Expected read reply");
      const mapped = input.map(item => item + "!");
      const rows = received.result.rows.map(row => String(row.id));
      const iterated: string[] = [];
      for (const item of input) iterated.push(item);
      for (const row of received.result.rows) iterated.push(String(row.id));
      expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(received.result.rows)).toBe(true);
      return { status: 200, body: { mapped, rows, iterated } };
    });
    guest.receive(JSON.stringify({ kind: "invoke", call_id: "call-1", request: { ...request, body: ["甲", "乙"] } }));
    await tick(); output(guest); guest.receive(result()); await tick();
    expect(output(guest)).toEqual([{ kind: "response", call_id: "call-1", response: { status: 200,
      body: { mapped: ["甲!", "乙!"], rows: ["one"], iterated: ["甲", "乙", "one"] } } }]);
  });

  it("delivers only the broker's fixed error code to the awaiting handler", async () => {
    const guest = createApplicationRuntimeGuest(async (_value, context) => {
      try { await context.data.execute(read); return { status: 200, body: null }; }
      catch (error) { return { status: 409, body: { code: (error as { code: string }).code } }; }
    });
    guest.receive(invoke()); await tick(); output(guest);
    guest.receive(JSON.stringify({ kind: "data-error", call_id: "call-1", data_call_id: "d1", code: "unauthorized" })); await tick();
    expect(output(guest)).toEqual([{ kind: "response", call_id: "call-1", response: { status: 409, body: { code: "unauthorized" } } }]);
  });

  it.each(["sync", "rejection", "thenable", "getter", "nonfinite", "surrogate", "sparse", "depth", "size", "extra", "204"])(
    "turns %s handler failures into one fixed 500 without private exception text", async kind => {
      const handler = (() => {
        if (kind === "sync") throw Error("private stack/path");
        if (kind === "rejection") return Promise.reject(Error("private stack/path"));
        if (kind === "thenable") return { get then() { throw Error("private stack/path"); } };
        if (kind === "getter") return { status: 200, get body() { throw Error("private stack/path"); } };
        let body: unknown = null;
        if (kind === "nonfinite") body = { count: NaN };
        if (kind === "surrogate") body = "\ud800";
        if (kind === "sparse") body = new Array(100_000);
        if (kind === "depth") for (let index = 0; index < 33; index++) body = [body];
        if (kind === "size") body = "中".repeat(limits.bodyBytes / 3 + 1);
        if (kind === "extra") return { status: 200, body: null, private: "private stack/path" };
        return { status: kind === "204" ? 204 : 200, body: kind === "204" ? "not null" : body };
      }) as ApplicationRuntimeGuestHandler;
      const guest = createApplicationRuntimeGuest(handler); guest.receive(invoke()); await tick();
      expect(output(guest)).toEqual([{ kind: "response", call_id: "call-1", response: { status: 500, body: { error: "application_handler_failed" } } }]);
    });

  it("does not run generated toJSON hooks or coerce cyclic/undefined values", async () => {
    const toJSON = vi.fn(() => ({ leaked: "private" }));
    for (const body of [{ toJSON }, { missing: undefined }, (() => { const cyclic: { self?: unknown } = {}; cyclic.self = cyclic; return cyclic; })()]) {
      const guest = createApplicationRuntimeGuest((() => ({ status: 200, body })) as ApplicationRuntimeGuestHandler);
      guest.receive(invoke()); await tick(); expect(output(guest)[0]).toMatchObject({ response: { status: 500 } });
    }
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("includes the message wrapper in exact wire depth and entry boundaries", async () => {
    const nested = (count: number) => { let value: unknown = null; for (let index = 0; index < count; index++) value = [value]; return value; };
    // Full envelope: 1 + 6 message entries + 4 response entries + 4 version/sequence
    // entries + 16 outer-array values + 15*1024 + 993 inner values = 16384.
    for (const [body, status] of [[nested(30), 200], [nested(31), 500],
      [[...Array.from({ length: 15 }, () => Array(1024).fill(0)), Array(993).fill(0)], 200],
      [[...Array.from({ length: 15 }, () => Array(1024).fill(0)), Array(994).fill(0)], 500]] as const) {
      const guest = createApplicationRuntimeGuest((() => ({ status: 200, body })) as ApplicationRuntimeGuestHandler);
      guest.receive(invoke()); await tick(); expect(output(guest)[0]).toMatchObject({ response: { status } });
      expect(guest.status).toBe("open");
    }
  });

  it.each(["unknown-call", "unknown-data", "not-handed-off", "duplicate"])("fails closed on a %s data reply", async kind => {
    const guest = createApplicationRuntimeGuest(async (_request, context) => { await context.data.execute(read); return { status: 200, body: null }; });
    guest.receive(invoke()); await tick(); if (kind !== "not-handed-off") output(guest);
    if (kind === "duplicate") guest.receive(result());
    expect(() => guest.receive(result(kind === "unknown-call" ? "other" : "call-1", kind === "unknown-data" ? "d2" : "d1"))).toThrow("Application guest failed: protocol");
    expect(guest.status).toBe("failed"); expect(() => guest.drain()).toThrow("Application guest failed: protocol");
    await tick();
  });

  it("does not reuse a completed call ID", async () => {
    const guest = createApplicationRuntimeGuest(() => ({ status: 200, body: null }));
    guest.receive(invoke()); await tick(); output(guest);
    expect(() => guest.receive(invoke())).toThrow("Application guest failed: protocol");
  });

  it("cancels before invocation starts and drops a queued response before handoff", async () => {
    const handler = vi.fn(() => ({ status: 200 as const, body: null }));
    const guest = createApplicationRuntimeGuest(handler); guest.receive(invoke());
    guest.receive('{"kind":"cancel","call_id":"call-1"}'); await tick(); expect(handler).not.toHaveBeenCalled();
    guest.receive(invoke("second")); await tick(); guest.receive('{"kind":"cancel","call_id":"second"}');
    expect(output(guest)).toEqual([]);
  });

  it("cancels queued data, revokes retained SDK calls, and never resumes handed-off late replies", async () => {
    let context!: ApplicationRuntimeGuestContext, resumed = 0;
    const guest = createApplicationRuntimeGuest(async (_request, current) => {
      context = current; await current.data.execute(read); resumed++; return { status: 200, body: null };
    });
    guest.receive(invoke()); await tick(); output(guest);
    guest.receive('{"kind":"cancel","call_id":"call-1"}'); guest.receive(result()); await tick();
    expect(resumed).toBe(0); expect(output(guest)).toEqual([]);
    await expect(context.data.execute(read)).rejects.toMatchObject({ code: "aborted" });
    guest.receive(invoke("queued")); await tick(); guest.receive('{"kind":"cancel","call_id":"queued"}');
    expect(output(guest)).toEqual([]); await tick(); expect(guest.status).toBe("open");
  });

  it("shuts down every pending call without later handler output or system unhandled rejections", async () => {
    const guest = createApplicationRuntimeGuest(async (_request, context) => { await context.data.execute(read); return { status: 200, body: null }; });
    guest.receive(invoke()); await tick(); guest.receive('{"kind":"shutdown"}'); await tick();
    expect(guest.status).toBe("shutdown"); expect(output(guest)).toEqual([]);
    expect(() => guest.receive(result())).toThrow("Application guest failed: closed");
  });

  it("fails a handler that completes with unresolved data instead of reporting success", async () => {
    const guest = createApplicationRuntimeGuest((_request, context) => { void context.data.execute(read); return { status: 201, body: null }; });
    guest.receive(invoke()); await tick(); expect(guest.status).toBe("failed");
    expect(() => guest.drain()).toThrow("Application guest failed: pending-data");
  });

  it("rechecks pending state after generated response getters reenter data.execute", async () => {
    const guest = createApplicationRuntimeGuest((_request, context) => ({ status: 200,
      get body() { void context.data.execute(read); return null; } }));
    guest.receive(invoke()); await tick(); expect(() => guest.drain()).toThrow("Application guest failed: pending-data");
  });

  it("bounds active invocations and preserves FIFO across bounded drain batches", async () => {
    const full = createApplicationRuntimeGuest(held);
    for (let index = 0; index < limits.active; index++) full.receive(invoke("call-" + index));
    expect(() => full.receive(invoke("excess"))).toThrow("Application guest failed: limit");
    const guest = createApplicationRuntimeGuest(async (_request, context) => {
      await Promise.all(Array.from({ length: 32 }, () => context.data.execute(read))); return { status: 200, body: null };
    });
    for (const name of ["a", "b", "c"]) guest.receive(invoke(name)); await tick();
    const first = output(guest), second = output(guest);
    expect(first).toHaveLength(64); expect(second).toHaveLength(32);
    expect(first.map(item => item.call_id)).toEqual([...Array(32).fill("a"), ...Array(32).fill("b")]);
    expect(second.every(item => item.call_id === "c")).toBe(true);
    guest.receive('{"kind":"shutdown"}'); await tick();
  });

  it("does not refund the per-invocation data quota after its replies settle", async () => {
    let context!: ApplicationRuntimeGuestContext, finish!: () => void;
    const guest = createApplicationRuntimeGuest(async (_request, current) => {
      context = current;
      await Promise.all(Array.from({ length: limits.dataCallsPerInvocation }, () => current.data.execute(read)));
      await new Promise<void>(resolve => { finish = resolve; }); return { status: 200, body: null };
    });
    guest.receive(invoke()); await tick(); expect(output(guest)).toHaveLength(32);
    for (let index = 1; index <= 32; index++) guest.receive(result("call-1", "d" + index)); await tick();
    await expect(context.data.execute(read)).rejects.toMatchObject({ code: "limit" }); expect(output(guest)).toEqual([]);
    finish(); await tick(); expect(output(guest)[0]).toMatchObject({ response: { status: 200 } });
  });

  it("does not refund lifetime invocation IDs after cancellation", async () => {
    const handler = vi.fn(held), guest = createApplicationRuntimeGuest(handler);
    for (let index = 0; index < limits.invocations; index++) {
      const callId = "call-" + index; guest.receive(invoke(callId)); guest.receive(JSON.stringify({ kind: "cancel", call_id: callId }));
    }
    expect(() => guest.receive(invoke("new-call"))).toThrow("Application guest failed: limit");
    await tick(); expect(handler).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized data locally without asking the broker for authority", async () => {
    const guest = createApplicationRuntimeGuest(async (_request, context) => {
      for (const invalid of [{ text: "x".repeat(limits.dataRequestBytes) }, { value: Infinity }, { value: "\udfff" }])
        await expect(context.data.execute(invalid)).rejects.toMatchObject({ code: "invalid-request" });
      return { status: 200, body: null };
    });
    guest.receive(invoke()); await tick(); expect(output(guest)).toEqual([{ kind: "response", call_id: "call-1", response: { status: 200, body: null } }]);
  });

  it.each(["null", '{"kind":"shutdown","scope":"secret"}', '{"kind":"response","call_id":"x","response":{}}',
    '{"kind":"invoke","version":1,"sequence":1}', '{"kind":"cancel","call_id":"unknown"}',
    JSON.stringify({ kind: "data-error", call_id: "call-1", data_call_id: "d1", code: "closed\n" }),
    "[".repeat(33) + "0" + "]".repeat(33), " ".repeat(limits.messageBytes + 1),
  ])("rejects malformed host input with a sticky fixed diagnostic (%#)", text => {
    const guest = createApplicationRuntimeGuest(held);
    expect(() => guest.receive(text)).toThrow(/^Application guest failed: protocol$/u);
    expect(() => guest.receive(invoke())).toThrow(/^Application guest failed: protocol$/u);
  });

  it("keeps portable ceilings bound to existing wire/data/invocation contracts", () => {
    expect(limits.messageBytes).toBe(APPLICATION_WIRE_LIMITS.frameBytes);
    expect(limits.bodyBytes).toBe(APPLICATION_WIRE_LIMITS.bodyBytes);
    expect(limits.jsonEntries).toBe(APPLICATION_WIRE_LIMITS.jsonEntries);
    expect(limits.dataRequestBytes).toBe(APPLICATION_DATA_LIMITS.requestBytes);
    expect(limits.dataReplyBytes).toBe(APPLICATION_DATA_LIMITS.replyBytes);
    for (const field of ["active", "invocations", "dataCallsPerInvocation", "dataCalls"] as const)
      expect(limits[field]).toBe(APPLICATION_INVOCATION_LIMITS[field]);
  });
});
