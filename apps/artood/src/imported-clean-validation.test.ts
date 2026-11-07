// Controlled controller seams only. These tests do not create native checkpoint,
// process-closure, independent model-review or publication authority.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedCleanValidationRequestDigestV1, importedCleanValidationReviewRequestDigestV1,
  importedCleanValidationSourceDigestV1, canonicalProductSourceTransferValueV1 as canonical,
  type ImportedCleanValidationReviewResultV1 } from "@artoo/domain";
import type { ImportedCleanValidationCommand, ImportedCleanValidationReviewCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { importedCleanValidationRequestFixture, controlledCleanValidationResult, controlledCleanValidationSource,
  cleanValidationReviewFixture, cleanValidationFixtureSha as sha } from "./test-fixtures/imported-clean-validation-request.js";
const mocks = vi.hoisted(() => ({ authorReserve: vi.fn(), authorRun: vi.fn(), authorPersist: vi.fn(), authorRead: vi.fn(), unstarted: vi.fn(),
  reviewReserve: vi.fn(), reviewRun: vi.fn(), reviewPersist: vi.fn(), reviewRead: vi.fn(), prepareRelease: vi.fn() }));
vi.mock("./windows-clean-validation-runtime.js", () => ({ reserveImportedCleanValidation: mocks.authorReserve, runImportedCleanValidation: mocks.authorRun,
  persistImportedCleanValidationResult: mocks.authorPersist, readCompletedImportedCleanValidation: mocks.authorRead, failUnstartedImportedCleanValidation: mocks.unstarted,
  reserveImportedCleanValidationReview: mocks.reviewReserve, runImportedCleanValidationReview: mocks.reviewRun, persistImportedCleanValidationReviewResult: mocks.reviewPersist,
  readCompletedImportedCleanValidationReview: mocks.reviewRead, prepareCleanValidationRelease: mocks.prepareRelease }));
import { createImportedCleanValidationClient } from "./imported-clean-validation.js";
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const f = importedCleanValidationRequestFixture(), result = controlledCleanValidationResult(f.request), source = controlledCleanValidationSource(f.request, result);
  const review = cleanValidationReviewFixture(f.request, source);
  const measured = (start: typeof review.before_start) => ({ run_id: start.run_id, config_digest: sha(canonical(start)),
    closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-validation-cases" as const,
    verification: { ...structuredClone(source.verification!), request_id: start.verification.request_id } });
  const reviewed: ImportedCleanValidationReviewResultV1 = { version: 1, review_id: review.review_id,
    request_digest: importedCleanValidationReviewRequestDigestV1(review, sha), outcome: "reviewed", closed: true,
    execution_authorized: false, before: measured(review.before_start), after: measured(review.after_start), reviewer: {
      run_id: review.review_start.run_id, config_digest: sha(canonical(review.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: review.review_id, validation_id: source.validation_id, source_digest: importedCleanValidationSourceDigestV1(source, sha),
      subject_digest: source.subject_digest, outcome: "accepted", summary: "Controlled complete product verdict; no browser or model executed", findings: [] } };
  const checkpoint = Object.freeze({}), sent: NodeToServerMessage[] = [];
  const original = vi.fn(() => checkpoint), assertAccepted = vi.fn(); let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {}, send: vi.fn(async message => { sent.push(message); }) };
  const options = { nodeId: f.request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, clean: { readAccepted: original, assertAccepted } as never, transport,
    resolveAdapter: () => ({ runtimeId: f.request.run_start.runtime }) as never, isCurrent: () => live };
  const control = { version: 1 as const, validation_id: f.request.validation_id, request_digest: importedCleanValidationRequestDigestV1(f.request, sha), run_id: f.request.run_start.run_id };
  const reviewControl = { version: 1 as const, review_id: review.review_id, request_digest: importedCleanValidationReviewRequestDigestV1(review, sha) };
  const command: ImportedCleanValidationCommand = { kind: "command", id: "author", idempotency_key: "author", type: "product.source.clean-validation.v1", payload: f.request };
  const accepted = { kind: "command" as const, id: "author-receipt", idempotency_key: "author-receipt", type: "product.source.clean-validation.receipt.v1" as const,
    payload: control, result_digest: sha(canonical(result)), status: "accepted" as const };
  const reviewCommand: ImportedCleanValidationReviewCommand = { kind: "command", id: "review", idempotency_key: "review", type: "product.source.clean-validation-review.v1", payload: review };
  const reviewAccepted = { kind: "command" as const, id: "review-receipt", idempotency_key: "review-receipt", type: "product.source.clean-validation-review.receipt.v1" as const,
    payload: reviewControl, result_digest: sha(canonical(reviewed)), status: "accepted" as const };
  mocks.authorReserve.mockReturnValue({}); mocks.reviewReserve.mockReturnValue({}); mocks.authorRun.mockResolvedValue(result); mocks.authorRead.mockReturnValue(source);
  mocks.reviewRun.mockResolvedValue(reviewed); mocks.reviewRead.mockReturnValue(review);
  mocks.unstarted.mockResolvedValue({ ...control, outcome: "failed", closed: true, reason: "Controlled prestart rejection" });
  return { ...f, result, source, review, reviewed, options, sent, original, assertAccepted, transport, control, reviewControl,
    command, accepted, reviewCommand, reviewAccepted, checkpoint, invalidate: () => { live = false; } };
}

describe("clean original-session receipts and replay", () => {
  it("requires committed run-event receipts before constructing a controller", () => {
    const f = fixture();
    expect(() => createImportedCleanValidationClient({ ...f.options,
      transport: { ...f.transport, acknowledgesRunEvents: false } })).toThrow("committed run-event receipts");
    expect(mocks.authorReserve).not.toHaveBeenCalled();
  });
  it("requires the exact author receipt and replays original results without executing again", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command);
    await expect(client.handle(f.reviewCommand)).rejects.toThrow("accepted author receipt"); expect(mocks.reviewReserve).not.toHaveBeenCalled();
    await client.handle(f.accepted); await client.handle(f.reviewCommand);
    f.original.mockImplementation(() => { throw Error("Initial checkpoint subject changed"); });
    await client.handle({ ...f.command, id: "author-replay" }); await client.handle({ ...f.reviewCommand, id: "review-replay" });
    expect(mocks.authorRun).toHaveBeenCalledTimes(1); expect(mocks.reviewRun).toHaveBeenCalledTimes(1);
    const current = mocks.authorRun.mock.calls[0]![6] as () => void; expect(current).not.toThrow();
    expect(f.assertAccepted).toHaveBeenCalledWith(f.request, f.checkpoint);
  });
  it("rechecks the original checkpoint after awaited command ACK before author entry", async () => {
    const f = fixture(); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.clean-validation.ack.v1"
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const client = createImportedCleanValidationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.original.mockImplementation(() => { throw Error("Checkpoint revoked"); }); release(); await pending;
    expect(mocks.authorRun).not.toHaveBeenCalled(); expect(mocks.unstarted).toHaveBeenCalledOnce(); expect(mocks.authorPersist).toHaveBeenCalledOnce();
  });
  it("retains prestart failure when the current session expires during the command ACK", async () => {
    const f = fixture(); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.clean-validation.ack.v1"
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const client = createImportedCleanValidationClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.invalidate(); release(); await pending;
    expect(mocks.authorRun).not.toHaveBeenCalled(); expect(mocks.authorPersist).toHaveBeenCalledOnce();
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    await expect(client.handle(f.accepted)).rejects.toThrow("session invalidated");
  });
  it("rejects a receipt for different result bytes before granting a review source", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command);
    await expect(client.handle({ ...f.accepted, result_digest: sha("different result") })).rejects.toThrow("persisted result");
    await expect(client.handle(f.reviewCommand)).rejects.toThrow("accepted author receipt"); expect(mocks.reviewRun).not.toHaveBeenCalled();
  });
  it("rejects a receipt that substitutes the original author run", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command);
    await expect(client.handle({ ...f.accepted, payload: { ...f.control, run_id: "different-run" } })).rejects.toThrow("exact request or run");
    await expect(client.handle(f.reviewCommand)).rejects.toThrow("accepted author receipt");
  });
  it("revokes the original review source callback when its author receipt is rejected", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand);
    const current = mocks.reviewRun.mock.calls[0]![6] as () => void; expect(current).not.toThrow();
    await client.handle({ ...f.accepted, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it("replays a persisted result after delivery failure without starting a second author", async () => {
    const f = fixture(); let failDelivery = true;
    f.transport.send = vi.fn(async message => {
      if (message.kind === "product.source.clean-validation.result.v1" && failDelivery) { failDelivery = false; throw Error("Controlled disconnected send"); }
      f.sent.push(message);
    });
    const client = createImportedCleanValidationClient(f.options); await expect(client.handle(f.command)).rejects.toThrow("disconnected send");
    expect(mocks.authorPersist).toHaveBeenCalledOnce(); expect(mocks.authorRun).toHaveBeenCalledOnce();
    await client.handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.clean-validation.status.v1", payload: f.control });
    await client.handle(f.accepted); await client.handle(f.reviewCommand);
    expect(mocks.authorRun).toHaveBeenCalledOnce(); expect(mocks.authorPersist).toHaveBeenCalledOnce(); expect(mocks.reviewRun).toHaveBeenCalledOnce();
  });
  it("rechecks the original source after result delivery and before accepting its receipt", async () => {
    const f = fixture(); let changed = false;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.clean-validation.result.v1") changed = true; });
    mocks.authorRead.mockImplementation(() => { if (changed) throw Error("Subject drift after result delivery"); return f.source; });
    const client = createImportedCleanValidationClient(f.options); await expect(client.handle(f.command)).rejects.toThrow("Subject drift");
    await expect(client.handle(f.accepted)).rejects.toThrow("Subject drift"); await expect(client.handle(f.reviewCommand)).rejects.toThrow("accepted author receipt");
  });
  it("retains an author stop tombstone and cannot restore receipt authority in a new client", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.clean-validation.stop.v1", payload: f.control });
    await client.handle(f.command); expect(mocks.authorRun).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled();
    expect(mocks.authorPersist).toHaveBeenCalledOnce(); expect(mocks.authorReserve).toHaveBeenCalledWith(f.options.runtime, f.control, "stop");
    await expect(createImportedCleanValidationClient(f.options).handle(f.accepted)).rejects.toThrow("unavailable");
    await expect(createImportedCleanValidationClient(f.options).handle({ kind: "command", id: "status", idempotency_key: "status",
      type: "product.source.clean-validation.status.v1", payload: f.control })).rejects.toThrow("recovery required");
  });
  it("retains a review stop tombstone without fabricating a completed author or review", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options);
    await client.handle({ kind: "command", id: "review-stop", idempotency_key: "review-stop", type: "product.source.clean-validation-review.stop.v1", payload: f.reviewControl });
    await client.handle(f.reviewCommand); expect(mocks.reviewRun).not.toHaveBeenCalled(); expect(mocks.authorRead).not.toHaveBeenCalled();
    expect(mocks.reviewPersist).toHaveBeenCalledOnce(); expect(mocks.reviewReserve).toHaveBeenCalledWith(f.options.runtime, f.reviewControl, "stop");
  });
  it("requires the accepted original review receipt for publication and rechecks revocation", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted); await client.handle(f.reviewCommand);
    const request = { imported_clean: { review_id: f.review.review_id, review_request_digest: f.reviewControl.request_digest,
      review_result_digest: sha(canonical(f.reviewed)) } } as never, permit = Object.freeze({});
    mocks.prepareRelease.mockReturnValue(permit);
    expect(() => client.prepareRelease(request)).toThrow("accepted review result receipt"); expect(mocks.prepareRelease).not.toHaveBeenCalled();
    await client.handle(f.reviewAccepted); expect(client.prepareRelease(request)).toBe(permit);
    expect(mocks.prepareRelease.mock.calls[0]![1]).toBe(f.reviewed);
    const current = mocks.prepareRelease.mock.calls[0]![3] as () => void; expect(current).not.toThrow();
    await client.handle({ ...f.reviewAccepted, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it("refuses an older client after invalidation even if an accepted receipt is replayed", async () => {
    const f = fixture(), client = createImportedCleanValidationClient(f.options); await client.handle(f.command); await client.handle(f.accepted);
    client.invalidate(); await client.settled();
    await expect(client.handle(f.accepted)).rejects.toThrow("session invalidated"); await expect(client.handle(f.reviewCommand)).rejects.toThrow("session invalidated");
    expect(mocks.reviewRun).not.toHaveBeenCalled();
  });
});
