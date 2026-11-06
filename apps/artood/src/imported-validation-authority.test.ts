// Negative local authority boundaries only. No fake native success is accepted by this suite.
import { describe, expect, it } from "vitest";
import { ProductReleaseRequestSchema, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { readCompletedImportedValidation, readCompletedImportedValidationReview, prepareImportedValidationRelease,
  readPreparedImportedValidationRelease, claimImportedValidationRelease } from "./product-source-runtime.js";
import { runVerification, runVerificationPreview } from "./verification.js";
import { createProductReleaseExecutor } from "./product-release.js";
import { importedValidationRequestFixture, controlledValidationResult, controlledValidationSource, validationReviewFixture,
  controlledValidationReviewResult, validationFixtureSha as sha } from "./test-fixtures/imported-validation-request.js";

describe("H7 serialized projections cannot manufacture local owners", () => {
  it.each([undefined, "author-failed", "verification-failed"] as const)("rejects a controlled %s completion without its original author process", failure => {
    const f = importedValidationRequestFixture(), result = controlledValidationResult(f.request, failure);
    expect(() => readCompletedImportedValidation({} as never, result)).toThrow("Original latest persisted");
    expect(() => readCompletedImportedValidation({} as never, structuredClone(result))).toThrow("Original latest persisted");
  });
  it("rejects an accepted review projection or cloned token as publication authority", () => {
    const f = importedValidationRequestFixture(), source = controlledValidationSource(f.request, controlledValidationResult(f.request));
    const review = validationReviewFixture(f.request, source), result = controlledValidationReviewResult(review);
    expect(() => readCompletedImportedValidationReview({} as never, result)).toThrow("Original persisted");
    const start = f.request.run_start, plan = start.context_pack.payload.goal_context?.plan, summary = source.verification?.measurement_plan;
    if (!plan || summary?.version !== 2 || !summary.pending_release.length) throw Error("Expected controlled publication binding");
    const binding = summary.pending_release[0]!.release_binding;
    // Pass request validation so this assertion reaches the original-review authority boundary.
    const releaseRequest = ProductReleaseRequestSchema.parse({ version: 1, release_id: "h7-release", goal_id: f.request.authorization.goal_id,
      project_id: start.context_pack.payload.project.id, run_id: start.run_id, release_profile_id: binding.release_profile_id,
      verification_request_id: start.verification.request_id, verification_profile_id: start.verification.profile_id,
      verification_profile_digest: binding.verification_profile_digest, subject_digest: source.subject_digest,
      acceptance_binding: { version: 1, plan: { id: plan.id, version: plan.version }, research: summary.research,
        measurement_plan_digest: summary.measurement_plan_digest, release_binding: binding,
        criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) => ({ requirement_id, criterion_index, criterion_digest, claim_id })) },
      imported_validation: { version: 1, validation_id: source.validation_id, request_digest: source.request_digest, result_digest: source.result_digest,
        review_id: review.review_id, review_request_digest: result.request_digest, review_result_digest: sha(canonical(result)),
        acceptance_event_id: "h7-acceptance-event", subject_digest: source.subject_digest } });
    expect(() => prepareImportedValidationRelease({} as never, result, releaseRequest, () => {})).toThrow("Original persisted");
    expect(() => readPreparedImportedValidationRelease({} as never)).toThrow("Original exact");
    expect(() => claimImportedValidationRelease({} as never, {} as never, "product-release:fake")).toThrow("Original exact");
  });
  it("rejects both new descriptors at ordinary final and preview verification boundaries", async () => {
    const f = importedValidationRequestFixture(), source = controlledValidationSource(f.request, controlledValidationResult(f.request)), review = validationReviewFixture(f.request, source);
    for (const context of [f.request.run_start.context_pack.payload, review.before_start.context_pack.payload]) {
      const isolated = structuredClone(context); delete isolated.transferred_product_input;
      await expect(runVerification({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
      await expect(runVerificationPreview({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
    }
  });
  it("does not record a cloned H7 passed verifier as a publisher attestation", () => {
    const f = importedValidationRequestFixture(), result = controlledValidationResult(f.request);
    if (result.outcome !== "finished") throw Error("Expected controlled success");
    const executor = createProductReleaseExecutor([]);
    expect(() => executor.recordVerification(f.request.run_start.run_id, f.request.run_start.context_pack.payload.project.id,
      f.request.run_start.workspace.root, result.verified_validation.verification,
      { context: f.request.run_start.context_pack.payload, readCapabilities: (() => { throw Error("Unbound reader must not run"); }) as never })).toThrow("Only the original H7 author");
  });
});
