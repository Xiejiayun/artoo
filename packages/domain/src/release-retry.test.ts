import { describe, expect, it } from "vitest";
import { ProductReleaseRequestSchema, ProductReleaseReceiptSchema, ProductReleaseRetryV1Schema,
  canonicalProductReleaseRequest, type ProductReleaseRequest, type ProductReleaseReceipt } from "./release.js";
import { canonicalReleaseJson } from "./release-capabilities.js";

const digest = `sha256:${"a".repeat(64)}`;
const original: ProductReleaseRequest = { version: 1, release_id: "release0", goal_id: "goal", project_id: "project", run_id: "run",
  release_profile_id: "site", verification_request_id: "verification", verification_profile_id: "profile", verification_profile_digest: digest, subject_digest: digest };
const retry = { version: 1 as const, root_release_id: "release0", previous_release_id: "release0", generation: 1, source_id: "source0",
  previous_request_digest: digest, previous_receipt_digest: digest,
  authorization: { event_id: "decision", goal_id: "goal", actor_user_id: "initiator", attempt_index: 4 } };
const failed: ProductReleaseReceipt = { request: original, release_profile_digest: digest, artifact_digest: digest, outcome: "failed",
  endpoint: null, previous_release_id: null, health_checks: [], retry_source: { version: 1, source_id: "source0", closure: "local-release-settled.v1",
    recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } };

describe("versioned publication retry contracts", () => {
  it("preserves legacy request and receipt canonical bytes without injecting retry fields", () => {
    expect(ProductReleaseRequestSchema.parse(original)).toEqual(original);
    expect(canonicalProductReleaseRequest(original)).toBe(canonicalReleaseJson(original));
    const { retry_source: _source, ...legacy } = failed;
    expect(ProductReleaseReceiptSchema.parse(legacy)).toEqual(legacy);
    expect(Object.hasOwn(ProductReleaseReceiptSchema.parse(legacy), "retry_source")).toBe(false);
  });
  it("separates a new publication generation from cumulative goal retry authorization", () => {
    const next = ProductReleaseRequestSchema.parse({ ...original, release_id: "release1", retry });
    expect(next.retry).toEqual(retry);
    expect(next.retry!.generation).toBe(1); expect(next.retry!.authorization.attempt_index).toBe(4);
    expect(ProductReleaseReceiptSchema.parse(failed).retry_source).toEqual(failed.retry_source);
  });
  it.each([
    { release_id: "release0", retry },
    { release_id: "release1", retry: { ...retry, root_release_id: "wrong-root" } },
    { release_id: "release1", retry: { ...retry, generation: 0 } },
    { release_id: "release1", retry: { ...retry, authorization: { ...retry.authorization, goal_id: "other" } } },
    { release_id: "release1", retry: { ...retry, previous_receipt_digest: "unverified" } },
  ])("rejects inconsistent retry identity %#", patch => {
    expect(ProductReleaseRequestSchema.safeParse({ ...original, ...patch }).success).toBe(false);
  });
  it("rejects remote additions and unversioned retry authority", () => {
    expect(ProductReleaseRetryV1Schema.safeParse({ ...retry, command: "remote argv" }).success).toBe(false);
    expect(ProductReleaseReceiptSchema.safeParse({ ...failed, retry_source: { ...failed.retry_source, closed: true } }).success).toBe(false);
    expect(ProductReleaseReceiptSchema.safeParse({ ...failed, retry_source: { ...failed.retry_source, closure: "model-said-closed" } }).success).toBe(false);
  });
  it("only accepts restored retry projections matching the actual previous-version receipt checks", () => {
    const recovered = { ...failed, outcome: "rolled_back", previous_release_id: "published-before",
      recovery_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: "2026-11-06T00:00:00Z" }],
      retry_source: { ...failed.retry_source!, recovery: { kind: "previous-restored", active_release_id: "published-before", active_artifact_digest: digest } } };
    expect(ProductReleaseReceiptSchema.safeParse(recovered).success).toBe(true);
    expect(ProductReleaseReceiptSchema.safeParse({ ...recovered, previous_release_id: "different" }).success).toBe(false);
    expect(ProductReleaseReceiptSchema.safeParse({ ...recovered, recovery_checks: [] }).success).toBe(false);
    expect(ProductReleaseReceiptSchema.safeParse({ ...failed, outcome: "published", endpoint: "http://127.0.0.1/",
      health_checks: recovered.recovery_checks }).success).toBe(false);
  });
});
