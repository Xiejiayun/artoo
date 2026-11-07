// Controlled controller seams only; original runtime closure is exercised separately.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { ImportedExecutionReviewCommand, ImportedExecutionRepairCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { importedExecutionReviewRequestFixture, controlledImplementationRepairResult, implementationFixtureSha as sha } from "./test-fixtures/imported-execution-review-request.js";
const mocks = vi.hoisted(() => ({ reviewReserve: vi.fn(() => ({})), reviewRun: vi.fn(), reviewPersist: vi.fn(), reviewRead: vi.fn(),
  repairReserve: vi.fn(() => ({})), repairRun: vi.fn(), repairPersist: vi.fn(), repairRead: vi.fn(), unstarted: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedExecutionReview: mocks.reviewReserve, runImportedExecutionReview: mocks.reviewRun,
  persistImportedExecutionReviewResult: mocks.reviewPersist, readCompletedImportedExecutionReview: mocks.reviewRead,
  reserveImportedExecutionRepair: mocks.repairReserve, runImportedExecutionRepair: mocks.repairRun,
  persistImportedExecutionRepairResult: mocks.repairPersist, readCompletedVerifiedImportedExecutionRepair: mocks.repairRead,
  failUnstartedImportedExecutionRepair: mocks.unstarted }));
import { createImportedExecutionReviewClient } from "./imported-execution-review.js";
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const f = importedExecutionReviewRequestFixture(), sent: NodeToServerMessage[] = [];
  const original = vi.fn(() => f.original), receipt = vi.fn(); let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {},
    send: vi.fn(async message => { sent.push(message); }) };
  const options = { nodeId: f.request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, executions: { readCompletedVerifiedExecution: original, assertCompletedExecutionReceipt: receipt } as never,
    transport, resolveAdapter: () => ({ runtimeId: f.request.review_start.runtime }) as never, isCurrent: () => live };
  const control = { version: 1 as const, review_id: f.request.review_id, request_digest: importedExecutionReviewRequestDigestV1(f.request, sha) };
  const repairControl = { version: 1 as const, repair_id: f.repair.repair_id, request_digest: importedExecutionRepairRequestDigestV1(f.repair, sha), run_id: f.repair.run_start.run_id };
  const command: ImportedExecutionReviewCommand = { kind: "command", id: "review", idempotency_key: "review", type: "product.source.execution-review.v1", payload: f.request };
  const repairCommand: ImportedExecutionRepairCommand = { kind: "command", id: "repair", idempotency_key: "repair", type: "product.source.execution-repair.v1", payload: f.repair };
  const accepted = { kind: "command" as const, id: "receipt", idempotency_key: "receipt", type: "product.source.execution-review.receipt.v1" as const,
    payload: control, result_digest: sha(canonical(f.result)), status: "accepted" as const };
  mocks.reviewReserve.mockReturnValue({}); mocks.repairReserve.mockReturnValue({});
  mocks.reviewRun.mockResolvedValue(f.result); mocks.reviewRead.mockReturnValue(f.request);
  mocks.repairRun.mockResolvedValue(controlledImplementationRepairResult(f.repair));
  mocks.unstarted.mockResolvedValue({ ...repairControl, outcome: "failed", closed: true, reason: "Controlled prestart rejection" });
  return { ...f, options, command, repairCommand, control, repairControl, accepted, sent, original, receipt, transport, invalidate: () => { live = false; } };
}
describe("H6/repair current-session receipt and replay control", () => {
  it("runs each operation once, requires the exact H6 receipt, and replays without consulting a changed prior source", async () => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options);
    await client.handle(f.command);
    await expect(client.handle(f.repairCommand)).rejects.toThrow("accepted receipt");
    expect(mocks.repairReserve).not.toHaveBeenCalled();
    await client.handle(f.accepted); await client.handle(f.repairCommand);
    f.original.mockImplementation(() => { throw Error("Old subject changed"); });
    await client.handle({ ...f.command, id: "replay-review" }); await client.handle({ ...f.repairCommand, id: "replay-repair" });
    expect(mocks.reviewRun).toHaveBeenCalledTimes(1); expect(mocks.repairRun).toHaveBeenCalledTimes(1);
    expect(mocks.reviewPersist).toHaveBeenCalledTimes(1); expect(mocks.repairPersist).toHaveBeenCalledTimes(1);
    expect(mocks.reviewRun.mock.calls[0]![2]).toBe(f.original.mock.results[0]!.value);
    expect(mocks.repairRun.mock.calls[0]![2]).toBe(f.result);
  });
  it.each(["unavailable", "wrong-digest"])("does not reserve an H6 when its original H5 is %s", change => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options);
    if (change === "unavailable") f.original.mockImplementation(() => { throw Error("H5 receipt unavailable"); });
    else f.request.source.result_digest = sha("other result");
    return expect(client.handle(f.command)).rejects.toThrow().then(() => {
      expect(mocks.reviewReserve).not.toHaveBeenCalled(); expect(mocks.reviewRun).not.toHaveBeenCalled();
    });
  });
  it("checks the original source again after an awaited command ACK", async () => {
    const f = fixture(); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.execution-review.ack.v1"
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const client = createImportedExecutionReviewClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.original.mockImplementation(() => { throw Error("H5 receipt revoked during ACK"); }); release(); await pending;
    expect(mocks.reviewRun).not.toHaveBeenCalled();
    expect(mocks.reviewPersist).toHaveBeenCalledWith(f.options.runtime, expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
  });
  it("cannot begin repair when the H6 accepted receipt is revoked during its ACK", async () => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options);
    await client.handle(f.command); await client.handle(f.accepted);
    let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.execution-repair.ack.v1"
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const pending = client.handle(f.repairCommand); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await client.handle({ ...f.accepted, id: "revoke", status: "rejected" }); release(); await pending;
    expect(mocks.repairRun).not.toHaveBeenCalled(); expect(mocks.unstarted).toHaveBeenCalledTimes(1);
  });
  it("keeps exact receipt liveness available to each running operation without re-reading an obsolete subject", async () => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options);
    await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.repairCommand);
    const reviewCurrent = mocks.reviewRun.mock.calls[0]![6] as () => void, repairCurrent = mocks.repairRun.mock.calls[0]![6] as () => void;
    reviewCurrent(); expect(f.receipt).toHaveBeenCalledWith(f.original.mock.results[0]!.value.execution_id, f.request.source.request_digest, f.original.mock.results[0]!.value);
    repairCurrent(); await client.handle({ ...f.accepted, status: "rejected" });
    expect(repairCurrent).toThrow("no longer accepted");
    f.receipt.mockImplementation(() => { throw Error("H5 receipt revoked"); }); expect(reviewCurrent).toThrow("revoked");
  });
  it("rechecks source after terminal result delivery and before accepting its explicit receipt", async () => {
    const f = fixture(); let changed = false;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.execution-review.result.v1") changed = true; });
    mocks.reviewRead.mockImplementation(() => { if (changed) throw Error("Source drift after terminal ACK"); return f.request; });
    const client = createImportedExecutionReviewClient(f.options);
    await expect(client.handle(f.command)).rejects.toThrow("Source drift");
    await expect(client.handle(f.accepted)).rejects.toThrow("Source drift");
    await expect(client.handle(f.repairCommand)).rejects.toThrow("accepted receipt");
    expect(mocks.repairReserve).not.toHaveBeenCalled();
  });
  it("keeps stop-before-start tombstones and never reconstructs receipt authority after restart", async () => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.execution-review.stop.v1", payload: f.control });
    await client.handle(f.command); expect(mocks.reviewRun).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled();
    await expect(createImportedExecutionReviewClient(f.options).handle({ kind: "command", id: "status", idempotency_key: "status",
      type: "product.source.execution-review.status.v1", payload: f.control })).rejects.toThrow("recovery required");
    await expect(createImportedExecutionReviewClient(f.options).handle(f.accepted)).rejects.toThrow("unavailable");
  });
  it("does not accept a mismatching result digest and invalidation fences further controls", async () => {
    const f = fixture(), client = createImportedExecutionReviewClient(f.options); await client.handle(f.command);
    await expect(client.handle({ ...f.accepted, result_digest: sha("wrong") })).rejects.toThrow("persisted result");
    client.invalidate(); await expect(client.handle(f.command)).rejects.toThrow("invalidated");
  });
});
