// Negative authority tests only. No fixture is represented as native or product acceptance.
import { describe, expect, it } from "vitest";
import { importedRecoveryValidationReviewRequestDigestV1, importedRecoveryValidationSourceDigestV1 } from "@artoo/domain";
import { readCompletedImportedRecoveryValidation, readCompletedImportedRecoveryValidationReview,
  readPreparedRecoveryValidationRelease, claimRecoveryValidationRelease, prepareRecoveredWorkspace,
  isPreparedRecoveryValidationRelease } from "./windows-source-recovery.js";
import { runVerification, runVerificationPreview } from "./verification.js";
import { importedRecoveryValidationRequestFixture, controlledRecoveryValidationResult, controlledRecoveryValidationSource,
  recoveryValidationReviewFixture, recoveryValidationFixtureSha as sha } from "./test-fixtures/imported-recovery-validation-request.js";

describe("recovery metadata cannot recreate original local execution authority", () => {
  it("cannot promote a recovery request, fence or cloned configuration into captured workspace", () => {
    const f = importedRecoveryValidationRequestFixture();
    expect(() => prepareRecoveredWorkspace({} as never, {} as never, {} as never, f.recovery)).toThrow("original prepared recovery configuration");
  });
  it("rejects serialized fresh completion without the original author and closed verifier", () => {
    const f = importedRecoveryValidationRequestFixture(), result = controlledRecoveryValidationResult(f.request);
    for (const projection of [result, structuredClone(result)]) expect(() => readCompletedImportedRecoveryValidation({} as never, projection)).toThrow("Original latest persisted");
  });
  it("rejects an accepted review projection and cloned publication token", () => {
    const f = importedRecoveryValidationRequestFixture(), source = controlledRecoveryValidationSource(f.request, controlledRecoveryValidationResult(f.request));
    const review = recoveryValidationReviewFixture(f.request, source);
    const fake = { version: 1, review_id: review.review_id, request_digest: importedRecoveryValidationReviewRequestDigestV1(review, sha),
      outcome: "reviewed", closed: true, execution_authorized: false, verdict: { version: 1, review_id: review.review_id, validation_id: source.validation_id,
        source_digest: importedRecoveryValidationSourceDigestV1(source, sha), subject_digest: source.subject_digest, outcome: "accepted", summary: "Controlled projection", findings: [] } };
    expect(() => readCompletedImportedRecoveryValidationReview({} as never, fake as never)).toThrow("Original persisted");
    expect(isPreparedRecoveryValidationRelease(Object.freeze({}))).toBe(false);
    expect(() => readPreparedRecoveryValidationRelease({} as never)).toThrow("Original current recovery publication");
    expect(() => claimRecoveryValidationRelease({} as never, {} as never, "product-release:projection")).toThrow("Original current recovery publication");
  });
  it("requires dedicated recovery admission even when transferred-input metadata is removed", async () => {
    const f = importedRecoveryValidationRequestFixture(), source = controlledRecoveryValidationSource(f.request, controlledRecoveryValidationResult(f.request));
    const review = recoveryValidationReviewFixture(f.request, source);
    for (const context of [f.request.run_start.context_pack.payload, review.before_start.context_pack.payload]) {
      const isolated = structuredClone(context); delete isolated.transferred_product_input;
      await expect(runVerification({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
      await expect(runVerificationPreview({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
    }
  });
});
