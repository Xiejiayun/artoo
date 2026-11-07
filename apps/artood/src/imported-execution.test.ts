// H5 controller tests use controlled original authority; no provider or native workload.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedExecutionRequestDigestV1 } from "@artoo/domain";
import type { ImportedExecutionCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { importedExecutionRequestFixture, executionFixtureSha as sha } from "./test-fixtures/imported-execution-request.js";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(() => ({})), run: vi.fn(), persist: vi.fn(), unstarted: vi.fn(), read: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedExecution: mocks.reserve, runImportedExecution: mocks.run,
  persistImportedExecutionResult: mocks.persist, failUnstartedImportedExecution: mocks.unstarted, readCompletedVerifiedImportedExecution: mocks.read }));
import { createImportedExecutionClient } from "./imported-execution.js";
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const { request } = importedExecutionRequestFixture(), sent: NodeToServerMessage[] = [];
  const original = vi.fn(() => request.review_result); let current = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, send: vi.fn(async message => { sent.push(message); }), subscribe: () => () => {} };
  const options = { nodeId: request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, reviews: { readCompletedAcceptedDesignReview: original } as never,
    resolveAdapter: () => ({ runtimeId: request.run_start.runtime }) as never, transport, isCurrent: () => current };
  const control = { version: 1 as const, execution_id: request.execution_id, request_digest: importedExecutionRequestDigestV1(request, sha), run_id: request.run_start.run_id };
  const command: ImportedExecutionCommand = { kind: "command", id: "h5-start", idempotency_key: "h5-start", type: "product.source.execution.v1", payload: request };
  const result = { ...control, outcome: "finished" as const, closed: true as const }; mocks.run.mockResolvedValue(result);
  return { request, result, options, transport, original, control, command, sent, invalidate: () => { current = false; } };
}
describe("H5 dedicated current-session controller", () => {
  it("consults the original accepted H4 once and only replays persisted H5 results", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options);
    await client.handle(f.command); f.original.mockImplementation(() => { throw Error("old subject changed during implementation"); });
    await client.handle({ ...f.command, id: "replay" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.run.mock.calls[0]![2]).toBe(f.request.review_result);
    expect(f.original).toHaveBeenCalledTimes(1); expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.execution.result.v1")).toHaveLength(2);
  });
  it("does not reserve when accepted H4 receipt authority is missing", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options); f.original.mockImplementation(() => { throw Error("H4 receipt unavailable"); });
    await expect(client.handle(f.command)).rejects.toThrow("H4 receipt unavailable");
    expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("does not reserve when supplied H4 differs from the original object facts", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options);
    f.original.mockReturnValue({ ...f.request.review_result, review_id: "changed" });
    await expect(client.handle(f.command)).rejects.toThrow("original accepted H4"); expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it("retains a stop-before-start tombstone without consulting H4", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.execution.stop.v1", payload: f.control });
    await client.handle(f.command);
    expect(mocks.run).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled(); expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(f.sent.at(-1)).toMatchObject({ payload: { outcome: "cancelled_before_start", closed: true } });
  });
  it("rejects changed control and status reconstruction after restart", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options); await client.handle(f.command);
    const status = { kind: "command" as const, id: "status", idempotency_key: "status", type: "product.source.execution.status.v1" as const, payload: f.control };
    await expect(client.handle({ ...status, payload: { ...f.control, run_id: "other" } })).rejects.toThrow("exact request or run");
    await expect(createImportedExecutionClient(f.options).handle(status)).rejects.toThrow("recovery required");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("accepts only exact persisted result receipts and exposes only the original qualified source accessor", async () => {
    const f = fixture(), client = createImportedExecutionClient(f.options); await client.handle(f.command);
    const receipt = { kind: "command" as const, id: "receipt", idempotency_key: "receipt", type: "product.source.execution.receipt.v1" as const,
      payload: f.control, result_digest: sha(canonical(f.result)), status: "accepted" as const };
    await expect(client.handle({ ...receipt, result_digest: sha("other") })).rejects.toThrow("persisted result");
    await client.handle(receipt); expect(Object.keys(client).sort()).toEqual(["assertCompletedExecutionReceipt", "handle", "invalidate", "readCompletedVerifiedExecution", "settled"]);
    await expect(createImportedExecutionClient(f.options).handle(receipt)).rejects.toThrow("Original H5 result");
  });
  it("retries result delivery without repeating author execution", async () => {
    const f = fixture(); let fail = true;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.execution.result.v1" && fail) { fail = false; throw Error("delivery failed"); } f.sent.push(message); });
    const client = createImportedExecutionClient(f.options);
    await expect(client.handle(f.command)).rejects.toThrow("delivery failed"); await client.handle({ ...f.command, id: "retry" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("invalidates the original running task and retains unresolved closure", async () => {
    const f = fixture(); mocks.run.mockImplementationOnce((_r, _p, _o, _q, _a, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("session invalidated")), { once: true });
    }));
    const client = createImportedExecutionClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled()); client.invalidate(); await pending;
    expect(mocks.persist).toHaveBeenCalledWith(f.options.runtime, expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
    await expect(client.handle(f.command)).rejects.toThrow("invalidated");
  });
});
