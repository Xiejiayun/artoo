import type { RunVerificationPayload } from "@artoo/domain";
import { createImportedStageReviewEvidence } from "./imported-design-review-evidence.js";
import type { PreparedVerificationProfile } from "./verification.js";

/** Implementation review gets only its sealed before evidence, after original closure checks. */
export function createImportedImplementationReviewEvidence(profile: PreparedVerificationProfile, original: RunVerificationPayload,
  expected: { requestId: string; subjectDigest: string }, assertCurrent: () => void) {
  return createImportedStageReviewEvidence("implementation", profile, original, expected, assertCurrent);
}
