import { describe, expect, it } from "vitest";
import { ProductReleaseReceiptSchema, ReleaseAcceptanceBindingV1Schema, type ProductReleaseHealthReport } from "@artoo/domain";
import { releaseAcceptanceFixture } from "../test-fixtures/release-acceptance.js";
import { assertReleaseAcceptanceReceipt, releaseAcceptanceBindingDigest, releaseAcceptanceSettlement, type AcceptedReleaseSource } from "./release-acceptance.js";
import { measurementPlanQualificationError } from "./measurement-plan-qualification.js";

const changed = `sha256:${"9".repeat(64)}`;
function fixture() {
  const f = releaseAcceptanceFixture(), summary = f.payload.measurement_plan!;
  if (summary.version !== 2) throw new Error("Expected a v2 controlled fixture");
  const binding = ReleaseAcceptanceBindingV1Schema.parse({ version: 1, plan: { id: "plan_release", version: 1 },
    research: summary.research, measurement_plan_digest: summary.measurement_plan_digest, release_binding: f.release.binding,
    criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) =>
      ({ requirement_id, criterion_index, criterion_digest, claim_id })) });
  const source = { run: { id: "author_validation" }, evidence: { id: "evidence_validation", requestId: f.requirement.request_id, payload: f.payload },
    binding, capabilities: f.release } as AcceptedReleaseSource;
  const receipt = ProductReleaseReceiptSchema.parse({ request: { version: 1, release_id: "release", goal_id: "goal_release", project_id: "proj_artoo",
    run_id: source.run.id, release_profile_id: "site", verification_request_id: f.requirement.request_id, verification_profile_id: "default",
    verification_profile_digest: f.payload.profile_digest, subject_digest: f.payload.subject_digest, acceptance_binding: binding },
    release_profile_digest: f.release.binding.release_profile_digest, artifact_digest: f.payload.subject_digest, outcome: "published",
    endpoint: "http://127.0.0.1:12345", previous_release_id: null,
    health_checks: [{ path: "/", status_code: 200, body_digest: changed, passed: true, checked_at: "2026-11-05T00:00:00Z" }],
    acceptance: { version: 1, binding_digest: releaseAcceptanceBindingDigest(binding), scope: "node-http-point-in-time", settled_criteria: binding.criteria } });
  return { ...f, source, receipt };
}

describe("publication criteria remain pending until an exact node receipt", () => {
  it.each(["research", "design", "implementation", "validation"] as const)("qualifies %s stage feasibility without settling publication", stage => {
    const f = releaseAcceptanceFixture(stage);
    expect(measurementPlanQualificationError(f.payload, f.requirement, f.context)).toBeUndefined();
    expect(f.payload.measurement_plan).toMatchObject({ version: 2, claim: "declared-mapping-feasibility", release_criterion_count: 1 });
    expect(f.payload).not.toHaveProperty("acceptance");
  });
  it.each(["request", "context", "claim", "profile", "missing-criteria", "legacy-policy"])("rejects downgraded or changed release qualification: %s", change => {
    const f = releaseAcceptanceFixture(), summary = f.payload.measurement_plan!;
    if (summary.version !== 2) throw new Error("Expected v2");
    if (change === "request") delete f.requirement.release_capability_binding;
    if (change === "context") delete f.context.release_capabilities;
    if (change === "claim") Object.assign(summary.pending_release[0]!, { claim_id: "workflow-verification" });
    if (change === "profile") summary.pending_release[0]!.release_binding.release_profile_digest = changed;
    if (change === "missing-criteria") { summary.pending_release = []; summary.release_criterion_count = 0; summary.workspace_criterion_count = 2; }
    if (change === "legacy-policy") f.context.verification_capabilities!.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    expect(measurementPlanQualificationError(f.payload, f.requirement, f.context)).toBeDefined();
  });
  it("settles exact refs after independently parsed JSON round trips", () => {
    const f = fixture(), receipt = ProductReleaseReceiptSchema.parse(JSON.parse(JSON.stringify(f.receipt)));
    expect(() => assertReleaseAcceptanceReceipt(receipt, f.source)).not.toThrow();
    expect(releaseAcceptanceSettlement(f.source, receipt, null)).toMatchObject({ release_id: "release", run_id: "author_validation",
      evidence_id: "evidence_validation", criteria: f.source.binding.criteria, health_event_id: null, scope: "node-http-point-in-time" });
    const reordered = JSON.parse(JSON.stringify(f.source.binding), (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse()) : value);
    expect(releaseAcceptanceBindingDigest(reordered)).toBe(releaseAcceptanceBindingDigest(f.source.binding));
  });
  it.each(["run", "request", "source", "research", "plan", "criterion", "binding-digest", "profile", "paths", "missing-settlement"])("refuses substituted success evidence: %s", change => {
    const f = fixture(), receipt = structuredClone(f.receipt);
    if (change === "run") receipt.request.run_id = "reviewer_run";
    if (change === "request") receipt.request.verification_request_id = "preview";
    if (change === "source") receipt.request.subject_digest = changed;
    if (change === "research") receipt.request.acceptance_binding!.research.checksum = changed;
    if (change === "plan") receipt.request.acceptance_binding!.plan.version++;
    if (change === "criterion") receipt.acceptance!.settled_criteria[0]!.criterion_index++;
    if (change === "binding-digest") receipt.acceptance!.binding_digest = changed;
    if (change === "profile") receipt.release_profile_digest = changed;
    if (change === "paths") receipt.health_checks[0]!.path = "/unmeasured";
    if (change === "missing-settlement") delete receipt.acceptance;
    expect(() => assertReleaseAcceptanceReceipt(receipt, f.source)).toThrow();
  });
  it("does not settle failed, rolled-back or currently degraded publication", () => {
    const f = fixture();
    for (const outcome of ["failed", "rolled_back"] as const) {
      const failed = { ...f.receipt, outcome }; delete failed.acceptance;
      expect(() => assertReleaseAcceptanceReceipt(failed, f.source)).not.toThrow();
      expect(() => releaseAcceptanceSettlement(f.source, failed, null)).toThrow("not healthy");
    }
    const degraded: ProductReleaseHealthReport = { version: 1, event_id: "degraded", sequence: 1, request: f.receipt.request,
      release_profile_digest: f.receipt.release_profile_digest, artifact_digest: f.receipt.artifact_digest!, state: "degraded",
      active_release_id: "release", active_artifact_digest: f.receipt.artifact_digest, consecutive_failures: 1,
      health_checks: f.receipt.health_checks.map(check => ({ ...check, status_code: 503, passed: false })), recovery_checks: [], checked_at: "2026-11-05T00:01:00Z" };
    expect(() => releaseAcceptanceSettlement(f.source, f.receipt, degraded)).toThrow("not healthy");
  });
});
