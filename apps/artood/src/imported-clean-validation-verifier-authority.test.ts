// Negative authority boundaries only. No filesystem, native owner or provider is mocked.
import { describe, expect, it } from "vitest";
import { runVerification, runVerificationPreview } from "./verification.js";
import { readImportedCleanValidationVerificationAdmission, readImportedCleanValidationReviewVerificationAdmission,
  readPreparedCleanValidationRelease, type PreparedImportedCleanValidation, type PreparedImportedCleanValidationReview } from "./windows-clean-validation-runtime.js";
import { importedCleanValidationRequestFixture, controlledCleanValidationResult, controlledCleanValidationSource,
  cleanValidationReviewFixture } from "./test-fixtures/imported-clean-validation-request.js";

describe("clean validation descriptors cannot manufacture node verifier authority", () => {
  it("rejects author and reviewer metadata at ordinary preview/final ingress even without transferred input", async () => {
    const f = importedCleanValidationRequestFixture();
    const source = controlledCleanValidationSource(f.request, controlledCleanValidationResult(f.request));
    const review = cleanValidationReviewFixture(f.request, source);
    for (const context of [f.request.run_start.context_pack.payload, review.before_start.context_pack.payload]) {
      const isolated = structuredClone(context); delete isolated.transferred_product_input;
      await expect(runVerification({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
      await expect(runVerificationPreview({} as never, "unbound", new AbortController().signal, isolated)).rejects.toThrow("original dedicated");
    }
  });
  it("rejects serialized author/review descriptors before reading a workspace or starting a verifier", () => {
    const f = importedCleanValidationRequestFixture(), context = f.request.run_start.context_pack.payload;
    const copied = structuredClone(context.imported_clean_validation) as unknown as PreparedImportedCleanValidation;
    expect(() => readImportedCleanValidationVerificationAdmission(copied, {} as never, "unbound", context, "final")).toThrow("Original active");
    expect(() => readImportedCleanValidationReviewVerificationAdmission(copied as unknown as PreparedImportedCleanValidationReview,
      {} as never, "unbound", context, "before")).toThrow("Original active");
  });
  it("rejects unverified clean checkpoint provenance as a publication permit", () => {
    const f = importedCleanValidationRequestFixture();
    expect(() => readPreparedCleanValidationRelease(structuredClone(f.restart) as never)).toThrow("Original current");
  });
});
