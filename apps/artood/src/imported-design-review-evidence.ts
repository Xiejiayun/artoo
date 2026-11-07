import { RunVerificationPayloadSchema, type RunVerificationPayload } from "@artoo/domain";
import { readBrowserEvidence, type BrowserEvidenceGrant } from "./browser-evidence.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { WorkspaceToolEvidenceReader } from "./workspace-tools.js";
import type { WorkspaceReadOnlyEvidenceIndexV1 } from "./workspace-readonly.js";

/** Called only after the original H4 before-verifier binding and closure are checked. */
export function createImportedDesignReviewEvidence(profile: PreparedVerificationProfile, original: RunVerificationPayload,
  expected: { requestId: string; subjectDigest: string }, assertCurrent: () => void) {
  return createImportedStageReviewEvidence("design", profile, original, expected, assertCurrent);
}

/** The caller supplies only a fixed local stage after checking the original before-verifier binding. */
export function createImportedStageReviewEvidence(stage: "design" | "implementation" | "validation", profile: PreparedVerificationProfile, original: RunVerificationPayload,
  expected: { requestId: string; subjectDigest: string }, assertCurrent: () => void) {
  assertCurrent();
  const receipt = RunVerificationPayloadSchema.parse(original);
  if (receipt.outcome !== "passed" || receipt.request_id !== expected.requestId || receipt.subject_digest !== expected.subjectDigest
    || receipt.profile_id !== profile.id || receipt.profile_digest !== profile.digest || !receipt.checks.length
    || receipt.checks.length !== profile.commands.length || new Set(receipt.checks.map(check => check.id)).size !== receipt.checks.length) {
    throw Error("Imported review evidence differs from the admitted before verification");
  }
  const grants = new Map<string, BrowserEvidenceGrant>();
  const bundles: WorkspaceReadOnlyEvidenceIndexV1["bundles"][number][] = [];
  for (const check of receipt.checks) {
    const observation = check.observation, command = profile.commands.find(item => item.id === check.id);
    const evidenceRoot = command?.observation?.evidence_root;
    if (check.exit_code !== 0 || !evidenceRoot || command?.observation?.format !== "static-web-acceptance.v3"
      || observation?.version !== 3 || observation.stage !== stage || observation.scope !== "final" || !observation.evidence_bundle) {
      throw Error("Imported review evidence requires every protected final bundle for its exact stage");
    }
    const grant: BrowserEvidenceGrant = Object.freeze({ evidenceRoot, requestId: receipt.request_id, profileId: receipt.profile_id,
      profileDigest: receipt.profile_digest, subjectDigest: expected.subjectDigest, checkId: check.id, scope: "final", ...observation.evidence_bundle });
    // The manifest is node-sealed; data in a result or context cannot grant arbitrary paths.
    readBrowserEvidence(grant, grant.bundle_id);
    for (const reference of [grant.bundle_id, ...observation.cases.flatMap(item => [item.trace_ref, ...item.captures.map(capture => capture.screenshot_ref)])]) {
      if (grants.has(reference)) throw Error("Imported review evidence references are not distinct");
      grants.set(reference, grant);
    }
    bundles.push(Object.freeze({ reference: grant.bundle_id, request_id: grant.requestId, check_id: grant.checkId, scope: "final" }));
  }
  const index: WorkspaceReadOnlyEvidenceIndexV1 = Object.freeze({ version: 1, bundles: Object.freeze(bundles) });
  const read: WorkspaceToolEvidenceReader = async (reference, options) => {
    assertCurrent(); const grant = grants.get(reference);
    if (!grant) throw Error("Evidence reference is not granted to this imported review session");
    const evidence = readBrowserEvidence(grant, reference, options); assertCurrent(); return evidence;
  };
  return Object.freeze({ read, readEvidenceIndex: () => {
    assertCurrent();
    for (const bundle of bundles) readBrowserEvidence(grants.get(bundle.reference)!, bundle.reference);
    assertCurrent(); return index;
  } });
}
