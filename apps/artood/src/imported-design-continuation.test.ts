import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignContinuationRequestDigestV1 } from "@artoo/domain";
import type { ImportedDesignContinuationCommand, NodeToServerMessage, NodeSideTransport } from "@artoo/protocol";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";

const mocks = vi.hoisted(() => ({ reserve: vi.fn(() => ({})), run: vi.fn(), persist: vi.fn(), fail: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedDesignContinuation: mocks.reserve,
  runImportedDesignContinuation: mocks.run, persistImportedDesignContinuationResult: mocks.persist, failUnstartedImportedDesignContinuation: mocks.fail }));
import { createImportedDesignContinuationClient } from "./imported-design-continuation.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
beforeEach(() => vi.clearAllMocks());
function fixture(receipts = true) {
  const { request } = importedDesignRequestFixture(), sent: NodeToServerMessage[] = [];
  let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: receipts, send: vi.fn(async message => { sent.push(message); }), subscribe: () => () => {} };
  const original = vi.fn(() => request.review_result), adapter = { runtimeId: request.run_start.runtime } as never;
  const options = { nodeId: request.review_request.operation.intent.request.byte_request.destination.node_id, runtime: {} as never,
    reviews: { readCompletedAccepted: original } as never, resolveAdapter: () => adapter, transport, isCurrent: () => live };
  const control = { version: 1 as const, continuation_id: request.continuation_id,
    request_digest: importedDesignContinuationRequestDigestV1(request, sha), run_id: request.run_start.run_id };
  const command: ImportedDesignContinuationCommand = { kind: "command", id: "start", idempotency_key: "start", type: "product.source.design.v1", payload: request };
  const result = { ...control, outcome: "finished" as const, closed: true as const };
  mocks.run.mockImplementation(async (_runtime, _permit, _original, _request, _adapter, _signal, _current, emit) => {
    await emit({ type: "run.lifecycle", payload: { phase: "completed", reason: null } }); return result;
  });
  mocks.fail.mockImplementation(async (_runtime, _permit, error, emit) => {
    await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: error.message } });
    return { ...control, outcome: "failed", closed: true, reason: error.message };
  });
  return { options, control, command, result, original, adapter, sent, transport, setLive: (value: boolean) => { live = value; } };
}
describe("dedicated imported-design controller (native/runtime are explicitly mocked)", () => {
  it("requires committed ordinary run-event receipts", () => { const f = fixture(false); expect(() => createImportedDesignContinuationClient(f.options)).toThrow("committed"); });
  it("preserves original review identity, starts once and replays persisted closure", async () => {
    const f = fixture(), client = createImportedDesignContinuationClient(f.options);
    await client.handle(f.command); await client.handle({ ...f.command, id: "replay" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.run.mock.calls[0]![2]).toBe(f.command.payload.review_result);
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(f.sent.filter(event => event.kind === "product.source.design.result.v1")).toHaveLength(2);
    expect(f.sent.find(event => event.kind === "run.event")).toMatchObject({ sequence: 0, run_id: f.control.run_id });
  });
  it("waits for event commit before persisting and emitting closure", async () => {
    const f = fixture(); let release!: () => void;
    const receipt = new Promise<void>(resolve => { release = resolve; });
    f.transport.send = vi.fn(async message => { f.sent.push(message); if (message.kind === "run.event") await receipt; });
    const client = createImportedDesignContinuationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(f.sent.some(event => event.kind === "run.event")).toBe(true));
    expect(mocks.persist).not.toHaveBeenCalled(); expect(f.sent.some(event => event.kind === "product.source.design.result.v1")).toBe(false);
    release(); await pending; expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("persists stop-before-start immediately and replays status/start without execution", async () => {
    const f = fixture(), client = createImportedDesignContinuationClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.design.stop.v1", payload: f.control });
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(f.sent.at(-1)).toMatchObject({ payload: { outcome: "cancelled_before_start", run_id: f.control.run_id, closed: true } });
    await client.handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.design.status.v1", payload: f.control });
    await client.handle(f.command); expect(mocks.run).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled(); expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  for (const field of ["request_digest", "run_id"] as const) it(`rejects stop/start controls with substituted ${field}`, async () => {
    const f = fixture(), client = createImportedDesignContinuationClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.design.stop.v1", payload: f.control });
    await expect(client.handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.design.status.v1",
      payload: { ...f.control, [field]: field === "request_digest" ? sha("different") : "other-run" } })).rejects.toThrow("exact continuation/request/run");
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not reconstruct a missing owner from status", async () => {
    const f = fixture(), client = createImportedDesignContinuationClient(f.options);
    await expect(client.handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.design.status.v1", payload: f.control })).rejects.toThrow("recovery required");
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("records failed precondition before starting when the accepted review differs", async () => {
    const f = fixture(), client = createImportedDesignContinuationClient(f.options); f.original.mockReturnValue({ ...f.command.payload.review_result, closed: false } as never);
    await client.handle(f.command); expect(mocks.run).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({ kind: "product.source.design.result.v1", payload: { outcome: "failed", closed: true } });
    expect(f.sent.find(event => event.kind === "run.event")).toMatchObject({ event: { type: "run.lifecycle", payload: { phase: "failed" } } });
  });
  it("does not rerun after result delivery fails", async () => {
    const f = fixture(); let rejected = false;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.design.result.v1" && !rejected) { rejected = true; throw Error("lost closure delivery"); } f.sent.push(message); });
    const client = createImportedDesignContinuationClient(f.options);
    await expect(client.handle(f.command)).rejects.toThrow("lost closure delivery"); await client.handle({ ...f.command, id: "replay" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("aborts the exact active execution on invalidation and persists only uncertainty", async () => {
    const f = fixture(); mocks.run.mockImplementationOnce((_runtime, _permit, _review, _request, _adapter, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("session invalidated")), { once: true });
    }));
    const client = createImportedDesignContinuationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled()); client.invalidate(); await pending;
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
    await expect(client.handle(f.command)).rejects.toThrow("invalidated");
  });
});
