// Contract regressions only; these fixtures do not create native execution or review authority.
import { describe, expect, it } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedValidationReviewRequestDigestV1,
  importedValidationSourceDigestV1, inspectImportedValidationReviewCompletionV1,
  inspectImportedValidationReviewResultV1, type ImportedValidationReviewResultV1 } from "@artoo/domain";
import { importedValidationRequestFixture, controlledValidationResult, controlledValidationSource,
  validationReviewFixture, controlledValidationReviewResult, validationFixtureSha as sha } from "./test-fixtures/imported-validation-request.js";

function fixture() {
  const author = importedValidationRequestFixture();
  const source = controlledValidationSource(author.request, controlledValidationResult(author.request));
  const request = validationReviewFixture(author.request, source), result = controlledValidationReviewResult(request);
  return { request, result, bytes: author.bytes };
}

describe("complete final-review inspection retains every unknown-input boundary", () => {
  it("preserves canonical checked projections and the original result API", () => {
    const { request, result, bytes } = fixture();
    const checked = inspectImportedValidationReviewCompletionV1(request, result, bytes, sha);
    expect(checked).toEqual({ request, result, requestDigest: importedValidationReviewRequestDigestV1(request, sha),
      sourceDigest: importedValidationSourceDigestV1(request.source, sha), resultDigest: sha(canonical(result)) });
    expect(inspectImportedValidationReviewResultV1(request, result, bytes, sha)).toEqual(result);
    expect(inspectImportedValidationReviewCompletionV1(structuredClone(request), structuredClone(result), bytes.slice(), sha)).toEqual(checked);
  });

  it.each(["failed", "uncertain", "cancelled_before_start"] as const)("keeps %s closed-state and exact request binding", outcome => {
    const { request, bytes } = fixture();
    const control = { version: 1 as const, review_id: request.review_id, request_digest: importedValidationReviewRequestDigestV1(request, sha),
      execution_authorized: false as const, reason: "Controlled incomplete final review" };
    const result: ImportedValidationReviewResultV1 = outcome === "uncertain" ? { ...control, outcome, closed: false }
      : { ...control, outcome, closed: true };
    const inspected = inspectImportedValidationReviewCompletionV1(request, result, bytes, sha);
    expect(inspected.result).toEqual(result); expect(inspected.requestDigest).toBe(control.request_digest);
    expect(inspected.resultDigest).toBe(sha(canonical(result)));
    expect(inspectImportedValidationReviewResultV1(request, result, bytes, sha)).toEqual(result);
    result.review_id = "another-review";
    expect(() => inspectImportedValidationReviewCompletionV1(request, result, bytes, sha)).toThrow("exact request");
    expect(() => inspectImportedValidationReviewResultV1(request, result, bytes, sha)).toThrow("exact request");
  });

  it("rejects unknown request, nested origin, source and result fields through both entry points", () => {
    const { request, result, bytes } = fixture();
    const malformed = [{ ...request, unchecked: true }, { ...request, origin: { ...request.origin, unchecked: true } },
      { ...request, source: { ...request.source, unchecked: true } }];
    for (const input of malformed) {
      expect(() => inspectImportedValidationReviewCompletionV1(input, result, bytes, sha)).toThrow();
      expect(() => inspectImportedValidationReviewResultV1(input, result, bytes, sha)).toThrow();
    }
    expect(() => inspectImportedValidationReviewCompletionV1(request, { ...result, unchecked: true }, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationReviewResultV1(request, { ...result, unchecked: true }, bytes, sha)).toThrow();
  });

  it.each(["before", "after"] as const)("rechecks all %s phase measurements and their original run binding", phase => {
    const { request, result, bytes } = fixture();
    if (result.outcome !== "reviewed") throw Error("Expected the controlled complete review");
    const incomplete = structuredClone(result); incomplete[phase].verification.checks = [];
    expect(() => inspectImportedValidationReviewCompletionV1(request, incomplete, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationReviewResultV1(request, incomplete, bytes, sha)).toThrow();
    const changedProgram = structuredClone(result);
    const check = changedProgram[phase].verification.checks.find(item => item.observation?.version === 3);
    if (check?.observation?.version !== 3) throw Error("Expected the controlled complete browser program");
    check.observation.cases[0]!.program_digest = sha("changed accepted program");
    expect(() => inspectImportedValidationReviewCompletionV1(request, changedProgram, bytes, sha)).toThrow("complete unchanged accepted programs");
    expect(() => inspectImportedValidationReviewResultV1(request, changedProgram, bytes, sha)).toThrow("complete unchanged accepted programs");
    const wrongRun = structuredClone(result); wrongRun[phase].run_id = "unrelated-run";
    expect(() => inspectImportedValidationReviewCompletionV1(request, wrongRun, bytes, sha)).toThrow("phase binding");
  });

  it("requires the original independent reviewer and the exact verdict source", () => {
    const { request, result, bytes } = fixture();
    if (result.outcome !== "reviewed") throw Error("Expected the controlled complete review");
    const wrongReviewer = structuredClone(result); wrongReviewer.reviewer.run_id = request.source.run_start.run_id;
    expect(() => inspectImportedValidationReviewCompletionV1(request, wrongReviewer, bytes, sha)).toThrow("independent reviewer binding");
    const wrongVerdict = structuredClone(result); wrongVerdict.verdict.source_digest = sha("another final source");
    expect(() => inspectImportedValidationReviewCompletionV1(request, wrongVerdict, bytes, sha)).toThrow("independent reviewer binding");
  });

  it("revalidates reused objects and does not trust a previously returned projection", () => {
    const { request, result, bytes } = fixture();
    const checked = inspectImportedValidationReviewCompletionV1(request, result, bytes, sha);
    checked.request.after_start.context_pack.payload.imported_validation_review_subject!.source_digest = sha("changed projection");
    // Returned copies cannot mutate the original input or gain trust on a subsequent call.
    expect(inspectImportedValidationReviewCompletionV1(request, result, bytes, sha).result).toEqual(result);
    expect(() => inspectImportedValidationReviewCompletionV1(checked.request, checked.result, bytes, sha)).toThrow();
    request.source.baseline.manifest_digest = sha("changed same object");
    expect(() => inspectImportedValidationReviewCompletionV1(request, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationReviewResultV1(request, result, bytes, sha)).toThrow();
  });

  it("reads the original research bytes again on a later reception", () => {
    const { request, result, bytes } = fixture();
    expect(inspectImportedValidationReviewCompletionV1(request, result, bytes, sha).result).toEqual(result);
    bytes[0] = bytes[0]! ^ 1;
    expect(() => inspectImportedValidationReviewCompletionV1(request, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationReviewResultV1(request, result, bytes, sha)).toThrow();
  });
});
