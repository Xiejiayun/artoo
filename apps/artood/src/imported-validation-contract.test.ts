import { describe, it, expect } from "vitest";
import { inspectImportedValidationRequestV1, inspectImportedValidationResultV1, inspectImportedValidationSourceV1,
  inspectImportedValidationReviewRequestV1, inspectImportedValidationReviewResultV1, inspectImportedExecutionRequestV1,
  inspectImportedValidationCompletionV1, inspectImportedValidationOriginV1, importedValidationOriginDigestV1,
  importedValidationRequestDigestV1, importedValidationSourceDigestV1, canonicalProductSourceTransferValueV1 as canonical,
  importedValidationContextV1, type ImportedValidationResultV1 } from "@artoo/domain";
import { importedValidationRequestFixture, controlledValidationResult, controlledValidationSource, validationRepairFixture,
  validationReviewFixture, controlledValidationReviewResult, validationFixtureSha as sha } from "./test-fixtures/imported-validation-request.js";

describe("H7 validation contract projections (no native or provider evidence)", () => {
  it("binds the validation task's accepted spec and the complete measured final product", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request);
    expect(inspectImportedValidationRequestV1(request, bytes, sha)).toEqual(request);
    expect(inspectImportedValidationResultV1(request, result, bytes, sha)).toEqual(result);
    const source = controlledValidationSource(request, result), review = validationReviewFixture(request, source), reviewed = controlledValidationReviewResult(review);
    expect(inspectImportedValidationReviewRequestV1(review, bytes, sha)).toEqual(review);
    expect(inspectImportedValidationReviewResultV1(review, reviewed, bytes, sha)).toEqual(reviewed);
  });
  it.each(["profile_id", "profile_digest"] as const)("rejects wrong %s in typed verifier failure source and completion", field => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request, "verification-failed");
    expect(inspectImportedValidationResultV1(request, result, bytes, sha)).toEqual(result);
    if (result.outcome !== "failed" || !result.closed_failure?.verification) throw Error("Expected controlled typed failure");
    result.closed_failure.verification[field] = field === "profile_id" ? "foreign-profile" : sha("foreign-profile");
    expect(() => inspectImportedValidationResultV1(request, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationSourceV1(request.origin, controlledValidationSource(request, result), bytes, sha)).toThrow();
  });
  it.each(["author-failed", "verification-failed"] as const)("allows only a fresh authorized repair after %s", kind => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request, kind), source = controlledValidationSource(request, result);
    const next = validationRepairFixture(request, source, { kind: "failure", validation: { validation_id: source.validation_id, request_digest: source.request_digest, result_digest: source.result_digest } });
    expect(inspectImportedValidationRequestV1(next, bytes, sha)).toEqual(next);
    next.authorization.attempt_index = 0; next.run_start.context_pack.payload.imported_validation = importedValidationContextV1(next, sha);
    expect(() => inspectImportedValidationRequestV1(next, bytes, sha)).toThrow();
  });
  it("freezes the initial validation task's goal/spec during repair", () => {
    const { request, bytes } = importedValidationRequestFixture(), source = controlledValidationSource(request, controlledValidationResult(request, "author-failed"));
    const next = validationRepairFixture(request, source, { kind: "failure", validation: { validation_id: source.validation_id, request_digest: source.request_digest, result_digest: source.result_digest } });
    next.run_start.context_pack.payload.goal_context!.plan!.spec_ref = "replacement-task-spec";
    expect(() => inspectImportedValidationRequestV1(next, bytes, sha)).toThrow();
    request.run_start.context_pack.payload.goal_context!.plan!.rationale = "Changed original requirement";
    expect(() => inspectImportedValidationRequestV1(request, bytes, sha)).toThrow();
  });
  it("includes empty directories in the retained baseline and rejects manifest drift", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request), source = controlledValidationSource(request, result);
    source.baseline.directories.pop();
    expect(() => inspectImportedValidationSourceV1(request.origin, source, bytes, sha)).toThrow();
  });
  it("does not accept a report-only final check, changed accepted case or same reviewer", () => {
    const { request, bytes } = importedValidationRequestFixture(), source = controlledValidationSource(request, controlledValidationResult(request));
    const review = validationReviewFixture(request, source), result = controlledValidationReviewResult(review);
    if (result.outcome !== "reviewed") throw Error("Expected controlled review");
    result.after.verification.checks = [];
    expect(() => inspectImportedValidationReviewResultV1(review, result, bytes, sha)).toThrow();
    review.reviewer = request.writer; review.review_start.agent_instance_id = request.writer.instance_id;
    expect(() => inspectImportedValidationReviewRequestV1(review, bytes, sha)).toThrow();
    const check = source.verification!.checks.find(item => item.observation?.version === 3)!;
    if (check.observation?.version !== 3) throw Error("Expected controlled browser program");
    check.observation.cases[0]!.program_digest = sha("changed program");
    expect(() => inspectImportedValidationSourceV1(request.origin, source, bytes, sha)).toThrow();
  });
  it("does not route an H7 descriptor through the older implementation contract", () => {
    const { request, bytes } = importedValidationRequestFixture(), old = structuredClone(request.origin.execution_request);
    old.run_start.context_pack.payload.imported_validation = request.run_start.context_pack.payload.imported_validation;
    expect(() => inspectImportedExecutionRequestV1(old, bytes, sha)).toThrow();
  });
});

describe("H7 complete inspection preserves unknown-input validation (no execution authority)", () => {
  it.each([undefined, "author-failed", "verification-failed"] as const)("returns unchanged canonical completion projections for %s", failure => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request, failure);
    const expectedSource = controlledValidationSource(request, result), inspected = inspectImportedValidationCompletionV1(request, result, bytes, sha);
    expect(inspected).toEqual({ request, result, requestDigest: importedValidationRequestDigestV1(request, sha),
      resultDigest: sha(canonical(result)), originDigest: importedValidationOriginDigestV1(request.origin, sha),
      completion: result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined,
      source: expectedSource, sourceDigest: importedValidationSourceDigestV1(expectedSource, sha) });
    expect(inspectImportedValidationResultV1(request, result, bytes, sha)).toEqual(result);
    expect(inspectImportedValidationCompletionV1(structuredClone(request), structuredClone(result), bytes.slice(), sha)).toEqual(inspected);
  });
  it.each(["cancelled_before_start", "uncertain", "failed"] as const)("checks the request binding without inventing a completion source for %s", outcome => {
    const { request, bytes } = importedValidationRequestFixture();
    const control = { version: 1 as const, validation_id: request.validation_id, request_digest: importedValidationRequestDigestV1(request, sha), run_id: request.run_start.run_id };
    const result: ImportedValidationResultV1 = outcome === "cancelled_before_start" ? { ...control, outcome, closed: true }
      : outcome === "uncertain" ? { ...control, outcome, closed: false, reason: "Controlled uncertain closure" }
      : { ...control, outcome, closed: true, reason: "Controlled untyped failure" };
    expect(inspectImportedValidationCompletionV1(request, result, bytes, sha)).toEqual({ request, result,
      requestDigest: control.request_digest, resultDigest: sha(canonical(result)), originDigest: importedValidationOriginDigestV1(request.origin, sha),
      completion: undefined, source: undefined, sourceDigest: undefined });
    result.run_id = "foreign-run";
    expect(() => inspectImportedValidationCompletionV1(request, result, bytes, sha)).toThrow("Validation result changed its exact request");
    expect(() => inspectImportedValidationResultV1(request, result, bytes, sha)).toThrow("Validation result changed its exact request");
  });
  it("retains strict request and result boundaries in both public inspectors", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request);
    const extraRequest = { ...request, unchecked: true }, extraResult = { ...result, unchecked: true };
    expect(() => inspectImportedValidationRequestV1(extraRequest, bytes, sha)).toThrow();
    expect(() => importedValidationRequestDigestV1(extraRequest, sha)).toThrow();
    expect(() => inspectImportedValidationCompletionV1(extraRequest, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationResultV1(extraRequest, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationCompletionV1(request, extraResult, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationResultV1(request, extraResult, bytes, sha)).toThrow();
  });
  it("retains strict origin and source boundaries, including their digest entry points", () => {
    const { request, bytes } = importedValidationRequestFixture(), source = controlledValidationSource(request, controlledValidationResult(request));
    const extraOrigin = { ...request.origin, unchecked: true }, extraSource = { ...source, unchecked: true };
    expect(() => inspectImportedValidationOriginV1(extraOrigin, bytes, sha)).toThrow();
    expect(() => importedValidationOriginDigestV1(extraOrigin, sha)).toThrow();
    expect(() => inspectImportedValidationSourceV1(extraOrigin, source, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationSourceV1(request.origin, extraSource, bytes, sha)).toThrow();
    expect(() => importedValidationSourceDigestV1(extraSource, sha)).toThrow();
  });
  it.each(["baseline", "verification"] as const)("independently rejects prior and new completion %s drift during repair", field => {
    const { request, bytes } = importedValidationRequestFixture(), prior = controlledValidationSource(request, controlledValidationResult(request, "verification-failed"));
    const repair = validationRepairFixture(request, prior, { kind: "failure", validation: { validation_id: prior.validation_id,
      request_digest: prior.request_digest, result_digest: prior.result_digest } });
    const result = controlledValidationResult(repair);
    expect(inspectImportedValidationCompletionV1(repair, result, bytes, sha).source).toEqual(controlledValidationSource(repair, result));
    const badPrior = structuredClone(repair);
    if (badPrior.source.kind !== "validation" || !badPrior.source.verification) throw Error("Expected controlled prior validation failure");
    if (field === "baseline") badPrior.source.baseline.directories.pop();
    else badPrior.source.verification.request_id = "foreign-final-verifier";
    // Rebind the new result to the changed request so only the independently inspected prior source can reject it.
    const rebound = controlledValidationResult(badPrior);
    expect(() => inspectImportedValidationCompletionV1(badPrior, rebound, bytes, sha)).toThrow("Validation source differs from its exact author, original baseline, origin or final verification");
    if (result.outcome !== "finished") throw Error("Expected controlled completed repair");
    if (field === "baseline") result.verified_validation.baseline.directories.pop();
    else result.verified_validation.verification.request_id = "foreign-final-verifier";
    expect(() => inspectImportedValidationCompletionV1(repair, result, bytes, sha)).toThrow("Validation source differs from its exact author, original baseline, origin or final verification");
  });
  it("revalidates the same request and result objects after mutation", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request);
    const inspected = inspectImportedValidationCompletionV1(request, result, bytes, sha);
    request.run_start.context_pack.payload.goal_context!.plan!.rationale = "Changed original requirement";
    expect(() => inspectImportedValidationCompletionV1(request, result, bytes, sha)).toThrow();
    if (result.outcome !== "finished") throw Error("Expected controlled validation result");
    result.verified_validation.baseline.directories.pop();
    expect(() => inspectImportedValidationCompletionV1(inspected.request, result, bytes, sha)).toThrow("Validation source differs from its exact author, original baseline, origin or final verification");
  });
  it("does not retain the last returned projections as trusted inputs", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request);
    const inspected = inspectImportedValidationCompletionV1(request, result, bytes, sha);
    inspected.request.run_start.context_pack.payload.goal_context!.plan!.rationale = "Mutated returned request";
    if (inspected.result.outcome !== "finished" || !inspected.source) throw Error("Expected controlled completion projections");
    inspected.result.verified_validation.verification.profile_id = "foreign-profile";
    inspected.source.baseline.directories.pop();
    expect(() => inspectImportedValidationCompletionV1(inspected.request, result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationCompletionV1(request, inspected.result, bytes, sha)).toThrow();
    expect(() => inspectImportedValidationSourceV1(request.origin, inspected.source, bytes, sha)).toThrow();
    expect(inspectImportedValidationCompletionV1(request, result, bytes, sha).source).toEqual(controlledValidationSource(request, result));
  });
  it("rehashes the same research byte buffer on the next inspection", () => {
    const { request, bytes } = importedValidationRequestFixture(), result = controlledValidationResult(request);
    expect(inspectImportedValidationCompletionV1(request, result, bytes, sha).result).toEqual(result);
    expect(bytes.length).toBeGreaterThan(0);
    bytes[0] = bytes[0]! ^ 1;
    expect(() => inspectImportedValidationCompletionV1(request, result, bytes, sha)).toThrow();
  });
});
