// Controlled transport/controller seams only. Wire fixtures and mocked original
// owners do not establish native closure, checkpoint, review or release authority.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportedCleanValidationRequestV1Schema, ImportedCleanValidationReviewRequestV1Schema,
  importedCleanValidationContextV1, importedCleanValidationReviewSubjectV1,
  importedCleanValidationRequestDigestV1, importedCleanValidationReviewRequestDigestV1, importedCleanValidationSourceDigestV1,
  canonicalProductSourceTransferValueV1 as canonical,
  type ImportedCleanValidationRequestV1, type ImportedCleanValidationResultV1, type ImportedCleanValidationSourceV1,
  type ImportedCleanValidationReviewRequestV1, type ImportedCleanValidationReviewResultV1 } from "@artoo/domain";
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
const digest = (value: unknown) => sha(canonical(value));
function closedAuthorFailure(request: ImportedCleanValidationRequestV1): ImportedCleanValidationResultV1 {
  const completed = controlledCleanValidationResult(request);
  if (completed.outcome !== "finished") throw Error("Controlled completed fixture required");
  const { stage: _stage, scope: _scope, verification: _verification, ...binding } = completed.verified_validation;
  return { version: 1, validation_id: completed.validation_id, request_digest: completed.request_digest, run_id: completed.run_id,
    outcome: "failed", closed: true, reason: "Controlled closed author failure", closed_failure: {
      ...binding, failure_kind: "author-failed", reason: "Controlled closed author failure" } };
}
function repairRequest(previous: ImportedCleanValidationRequestV1, source: ImportedCleanValidationSourceV1,
  predecessor: NonNullable<ImportedCleanValidationRequestV1["predecessor"]>): ImportedCleanValidationRequestV1 {
  const request = structuredClone(previous);
  request.kind = "repair"; request.validation_id = previous.validation_id + "-repair"; request.generation = source.generation + 1;
  request.previous_source = source; request.predecessor = predecessor;
  request.authorization = { ...request.authorization, event_id: "clean-repair-authorization", attempt_index: previous.authorization.attempt_index + 1 };
  request.run_start.run_id += "-repair"; request.run_start.context_pack.id += "-repair"; request.run_start.verification.request_id += "-repair";
  request.run_start.context_pack.payload.imported_clean_validation = importedCleanValidationContextV1(request, sha);
  return ImportedCleanValidationRequestV1Schema.parse(request);
}
function reviewedResult(request: ImportedCleanValidationReviewRequestV1, outcome: "accepted" | "rejected" = "accepted"): ImportedCleanValidationReviewResultV1 {
  const measured = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: digest(start),
    closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-validation-cases" as const,
    verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
  return { version: 1, review_id: request.review_id, request_digest: importedCleanValidationReviewRequestDigestV1(request, sha),
    outcome: "reviewed", closed: true, execution_authorized: false, before: measured(request.before_start), after: measured(request.after_start),
    reviewer: { run_id: request.review_start.run_id, config_digest: digest(request.review_start), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: request.review_id, validation_id: request.source.validation_id,
      source_digest: importedCleanValidationSourceDigestV1(request.source, sha), subject_digest: request.source.subject_digest,
      outcome, summary: "Controlled verdict; no model or browser executed",
      findings: outcome === "rejected" ? [{ severity: "blocking", description: "Controlled unmet product criterion" }] : [] } };
}
function retryReview(request: ImportedCleanValidationReviewRequestV1, failure: ImportedCleanValidationReviewResultV1) {
  const retry = structuredClone(request); retry.review_id += "-retry";
  retry.retry_of = { review_id: failure.review_id, request_digest: failure.request_digest, result_digest: digest(failure) };
  retry.authorization = { ...retry.authorization, event_id: "clean-review-retry-authorization", attempt_index: request.authorization.attempt_index + 1 };
  const subject = importedCleanValidationReviewSubjectV1(retry, sha);
  for (const start of [retry.before_start, retry.review_start, retry.after_start]) {
    start.run_id += "-retry"; start.context_pack.id += "-retry"; start.verification.request_id += "-retry";
    start.context_pack.payload.imported_clean_validation_review_subject = subject;
  }
  return ImportedCleanValidationReviewRequestV1Schema.parse(retry);
}
function fixture(authorFailed = false, reviewOutcome: "accepted" | "rejected" | "failed" = "accepted") {
  const initial = importedCleanValidationRequestFixture(), request = initial.request;
  const result = authorFailed ? closedAuthorFailure(request) : controlledCleanValidationResult(request);
  const source = controlledCleanValidationSource(request, result), checkpoint = Object.freeze({}), sent: NodeToServerMessage[] = [];
  const results = new Map<string, ImportedCleanValidationResultV1>([[request.validation_id, result]]);
  const sources = new Map<ImportedCleanValidationResultV1, ImportedCleanValidationSourceV1>([[result, source]]);
  const reviewResults = new Map<string, ImportedCleanValidationReviewResultV1>(), reviewRequests = new Map<ImportedCleanValidationReviewResultV1, ImportedCleanValidationReviewRequestV1>();
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {}, send: vi.fn(async message => { sent.push(message); }) };
  const original = vi.fn(() => checkpoint), assertAccepted = vi.fn();
  const options = { nodeId: request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id,
    runtime: {} as never, clean: { readAccepted: original, assertAccepted } as never, transport,
    resolveAdapter: () => ({ runtimeId: request.run_start.runtime }) as never, isCurrent: () => true };
  mocks.authorReserve.mockImplementation(() => Object.freeze({})); mocks.reviewReserve.mockImplementation(() => Object.freeze({}));
  mocks.authorRun.mockImplementation(async (_runtime, _permit, _prior, input: ImportedCleanValidationRequestV1) => {
    const result = results.get(input.validation_id); if (!result) throw Error("Controlled author result absent"); return result;
  });
  mocks.authorRead.mockImplementation((_runtime, result: ImportedCleanValidationResultV1) => {
    const source = sources.get(result); if (!source) throw Error("Controlled original author object absent"); return source;
  });
  mocks.reviewRun.mockImplementation(async (_runtime, _permit, _prior, input: ImportedCleanValidationReviewRequestV1) => {
    const result = reviewResults.get(input.review_id); if (!result) throw Error("Controlled review result absent"); return result;
  });
  mocks.reviewRead.mockImplementation((_runtime, result: ImportedCleanValidationReviewResultV1) => {
    const request = reviewRequests.get(result); if (!request) throw Error("Controlled original review object absent"); return request;
  });
  mocks.unstarted.mockImplementation(() => { throw Error("Unexpected controlled unstarted path"); });
  function author(input: ImportedCleanValidationRequestV1, value = controlledCleanValidationResult(input)) {
    results.set(input.validation_id, value); sources.set(value, controlledCleanValidationSource(input, value));
    const control = { version: 1 as const, validation_id: input.validation_id, request_digest: importedCleanValidationRequestDigestV1(input, sha), run_id: input.run_start.run_id };
    const command: ImportedCleanValidationCommand = { kind: "command", id: "author-" + input.validation_id, idempotency_key: input.validation_id,
      type: "product.source.clean-validation.v1", payload: input };
    const receipt = { kind: "command" as const, id: "receipt-" + input.validation_id, idempotency_key: "receipt-" + input.validation_id,
      type: "product.source.clean-validation.receipt.v1" as const, payload: control, result_digest: digest(value), status: "accepted" as const };
    return { command, receipt, result: value, source: sources.get(value)! };
  }
  function review(input: ImportedCleanValidationReviewRequestV1, value: ImportedCleanValidationReviewResultV1 = reviewedResult(input)) {
    reviewResults.set(input.review_id, value); reviewRequests.set(value, input);
    const control = { version: 1 as const, review_id: input.review_id, request_digest: importedCleanValidationReviewRequestDigestV1(input, sha) };
    const command: ImportedCleanValidationReviewCommand = { kind: "command", id: "review-" + input.review_id, idempotency_key: input.review_id,
      type: "product.source.clean-validation-review.v1", payload: input };
    const receipt = { kind: "command" as const, id: "review-receipt-" + input.review_id, idempotency_key: "review-receipt-" + input.review_id,
      type: "product.source.clean-validation-review.receipt.v1" as const, payload: control, result_digest: digest(value), status: "accepted" as const };
    return { command, receipt, result: value };
  }
  const first = author(request, result), client = createImportedCleanValidationClient(options);
  const reviewRequest = authorFailed ? undefined : cleanValidationReviewFixture(request, source);
  const reviewResult: ImportedCleanValidationReviewResultV1 | undefined = !reviewRequest ? undefined : reviewOutcome === "failed"
    ? { version: 1, review_id: reviewRequest.review_id, request_digest: importedCleanValidationReviewRequestDigestV1(reviewRequest, sha),
      execution_authorized: false, outcome: "failed", closed: true, reason: "Controlled closed review failure" }
    : reviewedResult(reviewRequest, reviewOutcome);
  const firstReview = reviewRequest && reviewResult ? review(reviewRequest, reviewResult) : undefined;
  return { ...initial, client, transport, sent, original, first, firstReview, reviewRequest, author, review };
}

describe("clean repair and review retry receipt continuity", () => {
  it("routes a typed closed author failure only after its accepted receipt and revokes its retained repair callback", async () => {
    const f = fixture(true); await f.client.handle(f.first.command);
    const request = repairRequest(f.request, f.first.source, { kind: "failure", validation_id: f.first.result.validation_id,
      request_digest: f.first.result.request_digest, result_digest: digest(f.first.result) });
    const repair = f.author(request);
    await expect(f.client.handle(repair.command)).rejects.toThrow("accepted author receipt"); expect(mocks.authorRun).toHaveBeenCalledOnce();
    await f.client.handle(f.first.receipt); await f.client.handle(repair.command);
    expect(mocks.authorRun.mock.calls[1]![2]).toBe(f.first.result); expect(mocks.authorRun.mock.calls[1]![3]).toEqual(request);
    const current = mocks.authorRun.mock.calls[1]![6] as () => void; expect(current).not.toThrow();
    await f.client.handle({ ...f.first.receipt, status: "rejected" }); expect(current).toThrow("no longer accepted");
    await f.client.handle({ ...repair.command, id: "repair-delivery-replay" }); expect(mocks.authorRun).toHaveBeenCalledTimes(2);
    expect(f.original).toHaveBeenCalledTimes(2); // Initial pre-ACK/after-ACK only; repair never reconstructs a checkpoint.
  });
  it("routes a rejected final review as the original repair predecessor and revokes its callback on receipt rejection", async () => {
    const f = fixture(false, "rejected"), reviewed = f.firstReview!;
    await f.client.handle(f.first.command); await f.client.handle(f.first.receipt); await f.client.handle(reviewed.command);
    const request = repairRequest(f.request, f.first.source, { kind: "review", review_id: reviewed.result.review_id,
      request_digest: reviewed.result.request_digest, result_digest: digest(reviewed.result) }), repair = f.author(request);
    await expect(f.client.handle(repair.command)).rejects.toThrow("accepted review result receipt");
    await f.client.handle(reviewed.receipt); await f.client.handle(repair.command);
    expect(mocks.authorRun.mock.calls[1]![2]).toBe(reviewed.result);
    const current = mocks.authorRun.mock.calls[1]![6] as () => void; expect(current).not.toThrow();
    await f.client.handle({ ...reviewed.receipt, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it("binds review retry to both the accepted author and its exact original closed review failure", async () => {
    const f = fixture(false, "failed"), previous = f.firstReview!;
    await f.client.handle(f.first.command); await f.client.handle(f.first.receipt); await f.client.handle(previous.command);
    const retry = f.review(retryReview(f.reviewRequest!, previous.result));
    await expect(f.client.handle(retry.command)).rejects.toThrow("accepted review result receipt"); expect(mocks.reviewRun).toHaveBeenCalledOnce();
    await f.client.handle(previous.receipt); await f.client.handle(retry.command);
    expect(mocks.reviewRun.mock.calls[1]![2]).toBe(f.first.result); expect(mocks.reviewRun.mock.calls[1]![7]).toBe(previous.result);
    const current = mocks.reviewRun.mock.calls[1]![6] as () => void; expect(current).not.toThrow();
    await f.client.handle({ ...previous.receipt, status: "rejected" }); expect(current).toThrow("no longer accepted");
    await f.client.handle(previous.receipt); await f.client.handle({ ...f.first.receipt, status: "rejected" }); expect(current).toThrow("no longer accepted");
  });
  it("rejects a changed rejected-review reference before reserving another repair", async () => {
    const f = fixture(false, "rejected"), previous = f.firstReview!;
    await f.client.handle(f.first.command); await f.client.handle(f.first.receipt); await f.client.handle(previous.command); await f.client.handle(previous.receipt);
    const request = repairRequest(f.request, f.first.source, { kind: "review", review_id: previous.result.review_id,
      request_digest: previous.result.request_digest, result_digest: sha("different rejected result") });
    await expect(f.client.handle(f.author(request).command)).rejects.toThrow("accepted review result receipt");
    expect(mocks.authorReserve).toHaveBeenCalledOnce(); expect(mocks.authorRun).toHaveBeenCalledOnce();
  });
  it("rechecks the typed failure receipt after a delayed repair ACK before entering the author", async () => {
    const f = fixture(true); await f.client.handle(f.first.command); await f.client.handle(f.first.receipt);
    const request = repairRequest(f.request, f.first.source, { kind: "failure", validation_id: f.first.result.validation_id,
      request_digest: f.first.result.request_digest, result_digest: digest(f.first.result) }), repair = f.author(request); let release!: () => void;
    mocks.unstarted.mockResolvedValue({ ...repair.receipt.payload, outcome: "failed", closed: true, reason: "Controlled prestart failure" });
    f.transport.send = vi.fn(message => message.kind === "product.source.clean-validation.ack.v1" && message.command_id === repair.command.id
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const pending = f.client.handle(repair.command); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.client.handle({ ...f.first.receipt, status: "rejected" }); release(); await pending;
    expect(mocks.authorRun).toHaveBeenCalledOnce(); expect(mocks.unstarted).toHaveBeenCalledOnce(); expect(mocks.authorPersist).toHaveBeenCalledTimes(2);
  });
  it("rechecks the closed failed-review receipt after a delayed retry ACK before entering another reviewer", async () => {
    const f = fixture(false, "failed"), previous = f.firstReview!;
    await f.client.handle(f.first.command); await f.client.handle(f.first.receipt); await f.client.handle(previous.command); await f.client.handle(previous.receipt);
    const retry = f.review(retryReview(f.reviewRequest!, previous.result)); let release!: () => void;
    f.transport.send = vi.fn(message => message.kind === "product.source.clean-validation-review.ack.v1" && message.command_id === retry.command.id
      ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const pending = f.client.handle(retry.command); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.client.handle({ ...previous.receipt, status: "rejected" }); release(); await pending;
    expect(mocks.reviewRun).toHaveBeenCalledOnce(); expect(mocks.reviewPersist).toHaveBeenCalledTimes(2);
    expect(mocks.reviewPersist.mock.calls[1]![2]).toMatchObject({ outcome: "uncertain", closed: false });
  });
});
