import type { RunVerificationPayload } from "@artoo/domain";
import { createImportedStageReviewEvidence } from "./imported-design-review-evidence.js";
import { assertImportedValidationBaseline, readImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { WorkspaceToolEvidenceReader } from "./workspace-tools.js";

/** Reader capability combines complete measured product evidence with actual pre-author bytes. */
export function createImportedValidationReviewEvidence(profile: PreparedVerificationProfile, before: RunVerificationPayload,
  expected: { requestId: string; subjectDigest: string }, baseline: PreparedValidationBaseline, assertCurrent: () => void) {
  const measured = createImportedStageReviewEvidence("validation", profile, before, expected, assertCurrent);
  const descriptor = assertImportedValidationBaseline(baseline), references = new Set(descriptor.files.map(file => file.reference));
  if (measured.readEvidenceIndex().bundles.some(bundle => references.has(bundle.reference))) throw Error("Validation evidence reference collision");
  const read: WorkspaceToolEvidenceReader = async (reference, options) => {
    assertCurrent(); assertImportedValidationBaseline(baseline);
    const result = references.has(reference) ? readImportedValidationBaseline(baseline, reference, expected.requestId, options) : await measured.read(reference, options);
    assertCurrent(); assertImportedValidationBaseline(baseline); return result;
  };
  return Object.freeze({ read, readEvidenceIndex: () => {
    assertCurrent(); const descriptor = assertImportedValidationBaseline(baseline);
    return Object.freeze({ ...measured.readEvidenceIndex(), baseline: descriptor });
  } });
}
