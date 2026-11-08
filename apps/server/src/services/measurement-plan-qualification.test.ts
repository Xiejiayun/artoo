import { describe, expect, it } from "vitest";
import { ContextPackSchema, type RunVerificationPayload } from "@artoo/domain";
import { measurementPlanEvidenceFixture } from "../test-fixtures/measurement-plan.js";
import { measurementPlanQualificationError as qualify } from "./measurement-plan-qualification.js";

const other = `sha256:${"9".repeat(64)}`;
describe("persisted measurement-plan attestation qualification", () => {
  it.each(["research", "design", "implementation", "validation"] as const)("qualifies %s without claiming semantic coverage", stage => {
    const f = measurementPlanEvidenceFixture(stage);
    expect(qualify(f.payload, f.requirement, f.context)).toBeUndefined();
    expect(f.payload.measurement_plan!.claim).toBe("declared-mapping-feasibility");
  });

  it("keeps no-policy history and failed diagnostics compatible without upgrading their evidence", () => {
    const f = measurementPlanEvidenceFixture();
    delete f.context.verification_capabilities!.measurement_plan_policy;
    delete f.payload.measurement_plan;
    expect(qualify(f.payload, f.requirement, f.context)).toBeUndefined();
    expect(qualify(f.payload, f.requirement, undefined)).toContain("lacks its persisted context");
    const legacyRequirement = { ...f.requirement }; delete legacyRequirement.capability_binding;
    const legacyPayload = structuredClone(f.payload); delete legacyPayload.checks[0]!.observation;
    expect(qualify(legacyPayload, legacyRequirement, undefined)).toBeUndefined();
    const failed: RunVerificationPayload = { ...f.payload, outcome: "failed", checks: [], reason: "Node stopped before measurement" };
    expect(qualify(failed, f.requirement, measurementPlanEvidenceFixture().context)).toBeUndefined();
    expect(qualify({ ...failed, measurement_plan: measurementPlanEvidenceFixture().payload.measurement_plan }, f.requirement, f.context))
      .toContain("Failed verification");
  });

  it("rejects unsolicited or missing summaries, malformed stored context and absent stages", () => {
    const f = measurementPlanEvidenceFixture();
    const without = structuredClone(f.payload); delete without.measurement_plan;
    expect(qualify(without, f.requirement, f.context)).toContain("lacks");
    expect(qualify(f.payload, f.requirement, undefined)).toContain("lacks its persisted context");
    const noPolicy = structuredClone(f.context); delete noPolicy.verification_capabilities!.measurement_plan_policy;
    expect(qualify(f.payload, f.requirement, noPolicy)).toContain("no persisted policy");
    for (const context of [null, {}, { ...f.context, verification_capabilities: { ...f.context.verification_capabilities, measurement_plan_policy: { version: 2 } } }]) {
      expect(qualify(f.payload, f.requirement, context)).toContain("malformed");
    }
    const noStage = structuredClone(f.context); delete noStage.product_development;
    expect(qualify(f.payload, f.requirement, noStage)).toContain("stage");
  });

  it.each(["preview", "claim", "policy", "counts", "plan-digest"])("rejects invalid summary scope and claims: %s", mode => {
    const f = measurementPlanEvidenceFixture(), summary = f.payload.measurement_plan!;
    if (mode === "preview") summary.scope = "preview";
    if (mode === "claim") Object.assign(summary, { claim: "complete-requirement-coverage" });
    if (mode === "policy") Object.assign(summary.policy, { coverage: "some-criteria" });
    if (mode === "counts") summary.mapped_criterion_count--;
    if (mode === "plan-digest") summary.measurement_plan_digest = "invented";
    expect(qualify(f.payload, f.requirement, f.context)).toContain("final persisted policy");
  });

  it.each(["profile-id", "profile-digest", "requirement-binding", "context-binding", "source-digest"])("binds configured policy to the persisted request: %s", mode => {
    const f = measurementPlanEvidenceFixture();
    if (mode === "profile-id") f.context.verification_capabilities!.profile_id = "other";
    if (mode === "profile-digest") f.payload.profile_digest = other;
    if (mode === "requirement-binding") delete f.requirement.capability_binding;
    if (mode === "context-binding") f.context.verification_capabilities!.checks[0]!.config_digest = other;
    if (mode === "source-digest") f.requirement.expected_subject_digest = other;
    expect(qualify(f.payload, f.requirement, f.context)).toMatch(/persisted verification binding|required source digest/);
  });

  it("rejects observations for another persisted product stage", () => {
    const f = measurementPlanEvidenceFixture("validation");
    f.payload.checks[0]!.observation!.stage = "research";
    expect(qualify(f.payload, f.requirement, f.context)).toContain("persisted product stage");
  });

  it.each(["missing-fact", "hash", "size", "missing-pin", "pin-hash", "pin-size"])("binds the measured research to its accepted input: %s", mode => {
    const f = measurementPlanEvidenceFixture("design");
    if (mode === "missing-fact") f.payload.required_files.shift();
    if (mode === "hash") f.payload.measurement_plan!.research.checksum = other;
    if (mode === "size") f.payload.measurement_plan!.research.size++;
    if (mode === "missing-pin") f.context.product_development!.accepted_inputs!.files = [];
    if (mode === "pin-hash") f.context.product_development!.accepted_inputs!.files[0]!.checksum = other;
    if (mode === "pin-size") f.context.product_development!.accepted_inputs!.files[0]!.size++;
    expect(qualify(f.payload, f.requirement, f.context)).toMatch(/handoff file|node-measured file|accepted research pin|Accepted product input changed/);
  });

  it.each(["command", "config", "contract", "missing-observation", "failed-check", "duplicate"])("requires exact used check bindings: %s", mode => {
    const f = measurementPlanEvidenceFixture(), used = f.payload.measurement_plan!.used_checks[0]!;
    if (mode === "command") used.command_id = "unconfigured";
    if (mode === "config") used.config_digest = other;
    if (mode === "contract") used.contract_digest = other;
    if (mode === "missing-observation") delete f.payload.checks[0]!.observation;
    if (mode === "failed-check") f.payload.checks[0]!.exit_code = 1;
    if (mode === "duplicate") f.payload.measurement_plan!.used_checks.push(structuredClone(used));
    expect(qualify(f.payload, f.requirement, f.context)).toBeDefined();
  });

  it("requires a peer to independently match the source summary and exact source digest", () => {
    const f = measurementPlanEvidenceFixture();
    delete f.context.product_development;
    f.context.policy.execution_mode = "discussion"; f.context.policy.filesystem_write_scope = [];
    f.requirement.expected_subject_digest = f.payload.subject_digest!;
    f.context.review_subject = { version: 1, task_id: "author_task", run_id: "author_run", evidence_id: "author_evidence",
      subject_digest: f.payload.subject_digest!, development_stage: "research", verification: { version: 1,
        request_id: "author_request", profile_id: f.payload.profile_id, profile_digest: f.payload.profile_digest,
        measurement_plan: structuredClone(f.payload.measurement_plan),
        checks: f.payload.checks.map(({ id, output_digest, observation }) => ({ id, output_digest, observation })) } };
    f.context = ContextPackSchema.parse(f.context);
    expect(qualify(f.payload, f.requirement, f.context)).toBeUndefined();
    for (const mode of ["missing-source", "different-plan", "different-source", "different-count"] as const) {
      const context = structuredClone(f.context), source = context.review_subject!.verification!;
      if (mode === "missing-source") delete source.measurement_plan;
      if (mode === "different-plan") source.measurement_plan!.measurement_plan_digest = other;
      if (mode === "different-source") context.review_subject!.subject_digest = other;
      if (mode === "different-count") { source.measurement_plan!.must_criterion_count++; source.measurement_plan!.mapped_criterion_count++; }
      expect(qualify(f.payload, f.requirement, context)).toContain("persisted reviewed source");
    }
  });
});
