import { describe, expect, it } from "vitest";
import { ProductReleaseSchema, ProductReleaseRequestSchema, ProductReleaseReceiptSchema, ImportedRecoveryReleaseOriginV1Schema } from "@artoo/domain";

const digest = "sha256:" + "a".repeat(64);
const request = {
  version: 1, release_id: "fresh-release", goal_id: "goal", project_id: "project", run_id: "fresh-author",
  release_profile_id: "publisher", verification_request_id: "fresh-verifier", verification_profile_id: "verifier",
  verification_profile_digest: digest, subject_digest: digest,
  acceptance_binding: { version: 1, plan: { id: "plan", version: 1 },
    research: { path: ".artoo/product/research.json", checksum: digest, size: 100 }, measurement_plan_digest: digest,
    release_binding: { version: 1, release_profile_id: "publisher", release_profile_digest: digest, contract_digest: digest,
      project_id: "project", workspace_root: "C:\\product", verification_profile_id: "verifier", verification_profile_digest: digest },
    criteria: [{ requirement_id: "publish", criterion_index: 0, criterion_digest: digest, claim_id: "configured-static-publication" }] },
};
const origin = {
  version: 1, recovery_id: "recovery", checkpoint_digest: digest, validation_id: "fresh-validation",
  validation_request_digest: digest, validation_result_digest: digest, review_id: "independent-review",
  review_request_digest: digest, review_result_digest: digest, acceptance_event_id: "review-accepted", subject_digest: digest,
  recovery_of_release_id: "interrupted-release", authorization: { event_id: "publication-authorized", goal_id: "goal", actor_user_id: "user", attempt_index: 3 },
};
const interruption = { version: 1, recovery_id: "recovery", settlement_event_id: "settled", checkpoint_digest: digest };
const row = { id: request.release_id, goal_id: request.goal_id, project_id: request.project_id, computer_id: "computer",
  run_id: request.run_id, evidence_id: "evidence", status: "queued", request, receipt: null, created_at: "2026-11-06", updated_at: "2026-11-06" };

describe("fresh recovery publication contract", () => {
  it("retains ordinary publication bytes and receipt-less queue semantics", () => {
    expect(ProductReleaseRequestSchema.parse(request)).toEqual(request);
    expect(ProductReleaseSchema.parse(row)).toEqual(row);
  });
  it("binds a separate publication decision to the fresh accepted recovery source", () => {
    const parsed = ProductReleaseRequestSchema.parse({ ...request, imported_recovery: origin });
    expect(parsed.imported_recovery).toEqual(origin);
    expect(parsed.retry).toBeUndefined();
    expect(ProductReleaseRequestSchema.parse({ ...request, imported_recovery: { ...origin, recovery_of_release_id: null } }).imported_recovery?.recovery_of_release_id).toBeNull();
  });
  it("requires complete bounded recovery and current publication authorization fields", () => {
    const { authorization: _authorization, ...withoutAuthorization } = origin;
    expect(ImportedRecoveryReleaseOriginV1Schema.safeParse(withoutAuthorization).success).toBe(false);
    expect(ProductReleaseRequestSchema.safeParse({ ...request, imported_recovery: { ...origin, authorization: { ...origin.authorization, goal_id: "other" } } }).success).toBe(false);
    expect(ProductReleaseRequestSchema.safeParse({ ...request, imported_recovery: { ...origin, recovery_of_release_id: request.release_id } }).success).toBe(false);
    expect(ImportedRecoveryReleaseOriginV1Schema.safeParse({ ...origin, authorization: { ...origin.authorization, attempt_index: -1 } }).success).toBe(false);
  });
  it("cannot reinterpret an H9 publication as H7 or retry its old interrupted predecessor", () => {
    const h7 = { version: 1, validation_id: "old-validation", request_digest: digest, result_digest: digest, review_id: "old-review",
      review_request_digest: digest, review_result_digest: digest, acceptance_event_id: "old-acceptance", subject_digest: digest };
    const retry = { version: 1, root_release_id: "interrupted-release", previous_release_id: "interrupted-release", generation: 1,
      source_id: "old-source", previous_request_digest: digest, previous_receipt_digest: digest, authorization: origin.authorization };
    expect(ProductReleaseRequestSchema.safeParse({ ...request, imported_recovery: origin, imported_validation: h7 }).success).toBe(false);
    expect(ProductReleaseRequestSchema.safeParse({ ...request, imported_recovery: origin, retry }).success).toBe(false);
  });
  it("allows the fresh publication failure projection shape without granting executor authority", () => {
    expect(ProductReleaseReceiptSchema.safeParse({ request: { ...request, imported_recovery: origin }, release_profile_digest: digest,
      artifact_digest: null, outcome: "failed", endpoint: null, previous_release_id: null, health_checks: [],
      retry_source: { version: 1, source_id: "fresh-failed-source", closure: "local-release-settled.v1",
        recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } }).success).toBe(true);
  });
  it("preserves the complete recovery origin while separately authorizing exact-source retries", () => {
    const retry = { version: 1, root_release_id: request.release_id, previous_release_id: request.release_id, generation: 1,
      source_id: "fresh-failed-source", previous_request_digest: digest, previous_receipt_digest: digest,
      authorization: { ...origin.authorization, event_id: "retry-authorized", attempt_index: 4 } };
    const first = ProductReleaseRequestSchema.parse({ ...request, release_id: "fresh-retry-1", imported_recovery: origin, retry });
    expect(first.imported_recovery).toEqual(origin);
    const second = ProductReleaseRequestSchema.parse({ ...first, release_id: "fresh-retry-2",
      retry: { ...retry, previous_release_id: first.release_id, generation: 2,
        authorization: { ...retry.authorization, event_id: "retry-authorized-2", attempt_index: 5 } } });
    expect(second.imported_recovery).toEqual(origin);
    for (const authorization of [origin.authorization, { ...retry.authorization, actor_user_id: "other" },
      { ...retry.authorization, attempt_index: origin.authorization.attempt_index }]) {
      expect(ProductReleaseRequestSchema.safeParse({ ...first, retry: { ...retry, authorization } }).success).toBe(false);
    }
    expect(ProductReleaseRequestSchema.safeParse({ ...first, retry: { ...retry, root_release_id: origin.recovery_of_release_id } }).success).toBe(false);
    expect(ProductReleaseRequestSchema.parse({ ...first, imported_recovery: { ...origin, recovery_of_release_id: null } }).retry?.generation).toBe(1);
  });
  it("requires explicit complete interruption evidence and preserves the null receipt", () => {
    expect(ProductReleaseSchema.parse({ ...row, status: "interrupted", interruption })).toMatchObject({ status: "interrupted", receipt: null, interruption });
    expect(ProductReleaseSchema.safeParse({ ...row, status: "interrupted" }).success).toBe(false);
    expect(ProductReleaseSchema.safeParse({ ...row, status: "interrupted", interruption: { ...interruption, checkpoint_digest: "unknown" } }).success).toBe(false);
    expect(ProductReleaseSchema.safeParse({ ...row, interruption }).success).toBe(false);
  });
  it("cannot turn an interruption into a fabricated failed or successful publication receipt", () => {
    const receipt = { request, release_profile_digest: digest, artifact_digest: null, outcome: "failed", endpoint: null, previous_release_id: null, health_checks: [] };
    expect(ProductReleaseSchema.safeParse({ ...row, status: "interrupted", interruption, receipt }).success).toBe(false);
    expect(ProductReleaseSchema.safeParse({ ...row, status: "published", interruption, receipt }).success).toBe(false);
  });
});
