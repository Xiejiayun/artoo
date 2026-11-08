// Controlled controller seams only; no native closure or provider qualification is claimed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedValidationRequestDigestV1, importedValidationReviewRequestDigestV1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { ImportedValidationCommand, ImportedValidationReviewCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { importedValidationRequestFixture, controlledValidationResult, controlledValidationSource, validationReviewFixture, validationRepairFixture,
  controlledValidationReviewResult, validationFixtureSha as sha } from "./test-fixtures/imported-validation-request.js";
const mocks = vi.hoisted(() => ({ authorReserve: vi.fn(), authorRun: vi.fn(), authorPersist: vi.fn(), authorRead: vi.fn(), unstarted: vi.fn(),
  reviewReserve: vi.fn(), reviewRun: vi.fn(), reviewPersist: vi.fn(), reviewRead: vi.fn(), prepareRelease: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedValidation: mocks.authorReserve, runImportedValidation: mocks.authorRun,
  persistImportedValidationResult: mocks.authorPersist, readCompletedImportedValidation: mocks.authorRead, failUnstartedImportedValidation: mocks.unstarted,
  reserveImportedValidationReview: mocks.reviewReserve, runImportedValidationReview: mocks.reviewRun, persistImportedValidationReviewResult: mocks.reviewPersist,
  readCompletedImportedValidationReview: mocks.reviewRead, prepareImportedValidationRelease: mocks.prepareRelease }));
import { createImportedValidationClient } from "./imported-validation.js";
beforeEach(() => vi.resetAllMocks());
function fixture(failure?: "author-failed" | "verification-failed") {
  const f = importedValidationRequestFixture(), result = controlledValidationResult(f.request, failure), source = controlledValidationSource(f.request, result);
  const review = failure ? undefined : validationReviewFixture(f.request, source), reviewed = review ? controlledValidationReviewResult(review) : undefined;
  const sent: NodeToServerMessage[] = [], original = vi.fn(() => f.accepted), receipt = vi.fn(); let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {}, send: vi.fn(async message => { sent.push(message); }) };
  const options = { nodeId: f.request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, implementations: { readCompletedAcceptedReview: original, assertCompletedAcceptedReviewReceipt: receipt } as never,
    transport, resolveAdapter: () => ({ runtimeId: f.request.run_start.runtime }) as never, isCurrent: () => live };
  const control = { version: 1 as const, validation_id: f.request.validation_id, request_digest: importedValidationRequestDigestV1(f.request, sha), run_id: f.request.run_start.run_id };
  const command: ImportedValidationCommand = { kind: "command", id: "author", idempotency_key: "author", type: "product.source.validation.v1", payload: f.request };
  const accepted = { kind: "command" as const, id: "author-receipt", idempotency_key: "author-receipt", type: "product.source.validation.receipt.v1" as const,
    payload: control, result_digest: sha(canonical(result)), status: "accepted" as const };
  const reviewCommand: ImportedValidationReviewCommand | undefined = review ? { kind: "command", id: "review", idempotency_key: "review", type: "product.source.validation-review.v1", payload: review } : undefined;
  mocks.authorReserve.mockReturnValue({}); mocks.reviewReserve.mockReturnValue({}); mocks.authorRun.mockResolvedValue(result); mocks.authorRead.mockReturnValue(source);
  mocks.reviewRun.mockResolvedValue(reviewed); mocks.reviewRead.mockReturnValue(review);
  mocks.unstarted.mockResolvedValue({ ...control, outcome: "failed", closed: true, reason: "Controlled prestart rejection" });
  return { ...f, result, source, review, reviewed, options, sent, original, receipt, transport, control, command, accepted, reviewCommand, invalidate: () => { live = false; } };
}
describe("H7 original-session receipts and replay", () => {
  it("requires the exact author receipt, runs once and replays after the H6 live subject has changed", async () => {
    const f = fixture(), client = createImportedValidationClient(f.options); await client.handle(f.command);
    await expect(client.handle(f.reviewCommand!)).rejects.toThrow("accepted author receipt"); expect(mocks.reviewReserve).not.toHaveBeenCalled();
    await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    f.original.mockImplementation(() => { throw Error("Old S0 subject changed"); });
    await client.handle({ ...f.command, id: "author-replay" }); await client.handle({ ...f.reviewCommand!, id: "review-replay" });
    expect(mocks.authorRun).toHaveBeenCalledTimes(1); expect(mocks.reviewRun).toHaveBeenCalledTimes(1);
    const authorCurrent = mocks.authorRun.mock.calls[0]![6] as () => void; expect(authorCurrent).not.toThrow();
    expect(f.receipt).toHaveBeenCalledWith(f.request.origin.review_id, f.request.origin.request_digest, f.request.origin.result_digest, f.original.mock.results[0]!.value);
  });
  it("rejects receipt loss across the awaited command ACK before native author entry", async () => {
    const f = fixture(); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.validation.ack.v1" ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const client = createImportedValidationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.original.mockImplementation(() => { throw Error("H6 revoked"); }); release(); await pending;
    expect(mocks.authorRun).not.toHaveBeenCalled(); expect(mocks.unstarted).toHaveBeenCalledOnce();
  });
  it("revokes a running review when its exact source receipt is rejected", async () => {
    const f = fixture(), client = createImportedValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    const current = mocks.reviewRun.mock.calls[0]![6] as () => void; expect(current).not.toThrow();
    await client.handle({ ...f.accepted, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it.each(["author-failed", "verification-failed"] as const)("accepts only the original receipt-qualified %s source for repair", async failure => {
    const f = fixture(failure), client = createImportedValidationClient(f.options); await client.handle(f.command);
    const request = validationRepairFixture(f.request, f.source, { kind: "failure", validation: { validation_id: f.source.validation_id, request_digest: f.source.request_digest, result_digest: f.source.result_digest } });
    const command: ImportedValidationCommand = { ...f.command, id: "repair", idempotency_key: "repair", payload: request };
    await expect(client.handle(command)).rejects.toThrow("accepted author receipt"); await client.handle(f.accepted);
    mocks.authorRun.mockResolvedValueOnce(controlledValidationResult(request, failure)); mocks.authorRead.mockReturnValueOnce(f.source).mockReturnValueOnce(f.source)
      .mockReturnValue(controlledValidationSource(request, controlledValidationResult(request, failure)));
    await client.handle(command); expect(mocks.authorRun.mock.calls[1]![2]).toBe(f.result);
  });
  it("rechecks source after terminal delivery and before accepting its receipt", async () => {
    const f = fixture(); let changed = false;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.validation.result.v1") changed = true; });
    mocks.authorRead.mockImplementation(() => { if (changed) throw Error("Subject drift after result delivery"); return f.source; });
    const client = createImportedValidationClient(f.options); await expect(client.handle(f.command)).rejects.toThrow("Subject drift");
    await expect(client.handle(f.accepted)).rejects.toThrow("Subject drift"); await expect(client.handle(f.reviewCommand!)).rejects.toThrow("accepted author receipt");
  });
  it("retains stop tombstones and cannot restore original receipt authority from another client", async () => {
    const f = fixture(), client = createImportedValidationClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.validation.stop.v1", payload: f.control });
    await client.handle(f.command); expect(mocks.authorRun).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled();
    await expect(createImportedValidationClient(f.options).handle(f.accepted)).rejects.toThrow("unavailable");
    await expect(createImportedValidationClient(f.options).handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.validation.status.v1", payload: f.control })).rejects.toThrow("recovery required");
  });
  it("will not prepare publication without an accepted final review receipt", async () => {
    const f = fixture(), client = createImportedValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand!);
    const origin = { version: 1 as const, validation_id: f.source.validation_id, request_digest: f.source.request_digest, result_digest: f.source.result_digest,
      review_id: f.review!.review_id, review_request_digest: importedValidationReviewRequestDigestV1(f.review!, sha), review_result_digest: sha(canonical(f.reviewed)), acceptance_event_id: "acceptance", subject_digest: f.source.subject_digest };
    expect(() => client.prepareRelease({ imported_validation: origin } as never)).toThrow("accepted review result receipt"); expect(mocks.prepareRelease).not.toHaveBeenCalled();
  });
});
