// Controlled controller seams only; no native closure or provider qualification is claimed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedRecoveryValidationRequestDigestV1, importedRecoveryValidationReviewRequestDigestV1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { ImportedRecoveryValidationCommand, ImportedRecoveryValidationReviewCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { recoveryValidationRequestFixture, controlledRecoveryValidationResult, controlledRecoveryValidationSource, recoveryValidationReviewFixture, recoveryValidationRepairFixture,
  controlledRecoveryValidationReviewResult, recoveryFixtureSha as sha } from "./test-fixtures/source-recovery-request.js";
const mocks = vi.hoisted(() => ({ authorReserve: vi.fn(), authorRun: vi.fn(), authorPersist: vi.fn(), authorRead: vi.fn(), unstarted: vi.fn(),
  reviewReserve: vi.fn(), reviewRun: vi.fn(), reviewPersist: vi.fn(), reviewRead: vi.fn(), prepareRelease: vi.fn() }));
vi.mock("./windows-source-recovery.js", () => ({ reserveImportedRecoveryValidation: mocks.authorReserve, runImportedRecoveryValidation: mocks.authorRun,
  persistImportedRecoveryValidationResult: mocks.authorPersist, readCompletedImportedRecoveryValidation: mocks.authorRead, failUnstartedImportedRecoveryValidation: mocks.unstarted,
  reserveImportedRecoveryValidationReview: mocks.reviewReserve, runImportedRecoveryValidationReview: mocks.reviewRun, persistImportedRecoveryValidationReviewResult: mocks.reviewPersist,
  readCompletedImportedRecoveryValidationReview: mocks.reviewRead, prepareRecoveryValidationRelease: mocks.prepareRelease }));
import { createImportedRecoveryValidationClient } from "./imported-recovery-validation.js";
beforeEach(() => vi.resetAllMocks());
function fixture(failure?: "author-failed" | "verification-failed") {
  const f = recoveryValidationRequestFixture(), result = controlledRecoveryValidationResult(f.request, failure), source = controlledRecoveryValidationSource(f.request, result);
  const review = failure ? undefined : recoveryValidationReviewFixture(f.request, source), reviewed = review ? controlledRecoveryValidationReviewResult(review) : undefined;
  const retainedWorkspace = Object.freeze({});
  const sent: NodeToServerMessage[] = [], original = vi.fn(() => retainedWorkspace), receipt = vi.fn(); let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {}, send: vi.fn(async message => { sent.push(message); }) };
  const options = { nodeId: f.request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, recovery: { readAccepted: original, assertAccepted: receipt } as never,
    transport, resolveAdapter: () => ({ runtimeId: f.request.run_start.runtime }) as never, isCurrent: () => live };
  const control = { version: 1 as const, validation_id: f.request.validation_id, request_digest: importedRecoveryValidationRequestDigestV1(f.request, sha), run_id: f.request.run_start.run_id };
  const command: ImportedRecoveryValidationCommand = { kind: "command", id: "author", idempotency_key: "author", type: "product.source.recovery-validation.v1", payload: f.request };
  const accepted = { kind: "command" as const, id: "author-receipt", idempotency_key: "author-receipt", type: "product.source.recovery-validation.receipt.v1" as const,
    payload: control, result_digest: sha(canonical(result)), status: "accepted" as const };
  const reviewCommand: ImportedRecoveryValidationReviewCommand | undefined = review ? { kind: "command", id: "review", idempotency_key: "review", type: "product.source.recovery-validation-review.v1", payload: review } : undefined;
  mocks.authorReserve.mockReturnValue({}); mocks.reviewReserve.mockReturnValue({}); mocks.authorRun.mockResolvedValue(result); mocks.authorRead.mockReturnValue(source);
  mocks.reviewRun.mockResolvedValue(reviewed); mocks.reviewRead.mockReturnValue(review);
  mocks.unstarted.mockResolvedValue({ ...control, outcome: "failed", closed: true, reason: "Controlled prestart rejection" });
  return { ...f, result, source, review, reviewed, options, sent, original, receipt, transport, control, command, accepted, reviewCommand, invalidate: () => { live = false; } };
}
describe("H9 original-session recovery receipts and replay", () => {
  it("requires the exact author receipt, runs once and replays after the H6 live subject has changed", async () => {
    const f = fixture(), client = createImportedRecoveryValidationClient(f.options); await client.handle(f.command);
    await expect(client.handle(f.reviewCommand!)).rejects.toThrow("accepted author receipt"); expect(mocks.reviewReserve).not.toHaveBeenCalled();
    await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    f.original.mockImplementation(() => { throw Error("Old S0 subject changed"); });
    await client.handle({ ...f.command, id: "author-replay" }); await client.handle({ ...f.reviewCommand!, id: "review-replay" });
    expect(mocks.authorRun).toHaveBeenCalledTimes(1); expect(mocks.reviewRun).toHaveBeenCalledTimes(1);
    const authorCurrent = mocks.authorRun.mock.calls[0]![6] as () => void; expect(authorCurrent).not.toThrow();
    expect(f.receipt).toHaveBeenCalledWith(f.request, f.original.mock.results[0]!.value);
  });
  it("rejects receipt loss across the awaited command ACK before native author entry", async () => {
    const f = fixture(); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.recovery-validation.ack.v1" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const client = createImportedRecoveryValidationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.original.mockImplementation(() => { throw Error("H6 revoked"); }); release(); await pending;
    expect(mocks.authorRun).not.toHaveBeenCalled(); expect(mocks.unstarted).toHaveBeenCalledOnce();
  });
  it("revokes a running review when its exact source receipt is rejected", async () => {
    const f = fixture(), client = createImportedRecoveryValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    const current = mocks.reviewRun.mock.calls[0]![6] as () => void; expect(current).not.toThrow();
    await client.handle({ ...f.accepted, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it.each(["author-failed", "verification-failed"] as const)("accepts only the original receipt-qualified %s source for repair", async failure => {
    const f = fixture(failure), client = createImportedRecoveryValidationClient(f.options); await client.handle(f.command);
    const request = recoveryValidationRepairFixture(f.request, f.source, { kind: "failure", validation_id: f.source.validation_id, request_digest: f.source.request_digest, result_digest: f.source.result_digest });
    const command: ImportedRecoveryValidationCommand = { ...f.command, id: "repair", idempotency_key: "repair", payload: request };
    await expect(client.handle(command)).rejects.toThrow("accepted author receipt"); await client.handle(f.accepted);
    mocks.authorRun.mockResolvedValueOnce(controlledRecoveryValidationResult(request, failure)); mocks.authorRead.mockReturnValueOnce(f.source).mockReturnValueOnce(f.source)
      .mockReturnValue(controlledRecoveryValidationSource(request, controlledRecoveryValidationResult(request, failure)));
    await client.handle(command); expect(mocks.authorRun.mock.calls[1]![2]).toBe(f.result);
  });
  it("rechecks source after terminal delivery and before accepting its receipt", async () => {
    const f = fixture(); let changed = false;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.recovery-validation.result.v1") changed = true; });
    mocks.authorRead.mockImplementation(() => { if (changed) throw Error("Subject drift after result delivery"); return f.source; });
    const client = createImportedRecoveryValidationClient(f.options); await expect(client.handle(f.command)).rejects.toThrow("Subject drift");
    await expect(client.handle(f.accepted)).rejects.toThrow("Subject drift"); await expect(client.handle(f.reviewCommand!)).rejects.toThrow("accepted author receipt");
  });
  it("retains stop tombstones and cannot restore original receipt authority from another client", async () => {
    const f = fixture(), client = createImportedRecoveryValidationClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.recovery-validation.stop.v1", payload: f.control });
    await client.handle(f.command); expect(mocks.authorRun).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled();
    await expect(createImportedRecoveryValidationClient(f.options).handle(f.accepted)).rejects.toThrow("unavailable");
    await expect(createImportedRecoveryValidationClient(f.options).handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.recovery-validation.status.v1", payload: f.control })).rejects.toThrow("recovery required");
  });
  it("will not prepare publication without an accepted final review receipt", async () => {
    const f = fixture(), client = createImportedRecoveryValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    const origin = { version: 1 as const, validation_id: f.source.validation_id, request_digest: f.source.request_digest, result_digest: f.source.result_digest,
      review_id: f.review!.review_id, review_request_digest: importedRecoveryValidationReviewRequestDigestV1(f.review!, sha), review_result_digest: sha(canonical(f.reviewed)), acceptance_event_id: "acceptance", subject_digest: f.source.subject_digest };
    expect(() => client.prepareRelease({ imported_recovery: origin } as never)).toThrow("accepted review result receipt"); expect(mocks.prepareRelease).not.toHaveBeenCalled();
  });
});
