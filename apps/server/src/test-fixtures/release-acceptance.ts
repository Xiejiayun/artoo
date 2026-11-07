import { ContextPackSchema, ReleaseCapabilitiesV1Schema, RunVerificationPayloadSchema, VerificationRequirementSchema,
  CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseCapabilityContract, type DevelopmentStage, type ReleaseCapabilityContractV1 } from "@artoo/domain";
import { createHash } from "node:crypto";
import { measurementPlanEvidenceFixture } from "./measurement-plan.js";

/** Controlled node contracts/receipts only: no model, browser or HTTP publication is executed. */
export function releaseAcceptanceFixture(stage: DevelopmentStage = "validation") {
  const f = measurementPlanEvidenceFixture(stage);
  const policy = { version: 2 as const, coverage: "every-must-criterion" as const,
    methods: ["workspace-check", "configured-static-release"] as ["workspace-check", "configured-static-release"] };
  f.capabilities.measurement_plan_policy = policy;
  const contract: ReleaseCapabilityContractV1 = { version: 1 as const, kind: "configured-static-release" as const, claim: "configured" as const,
    execution_phase: "after-stage-acceptance" as const, endpoint_scope: "configured-origin" as const,
    measurement_scope: "node-http-point-in-time" as const, lifecycle: "while-configured-node-service-running" as const,
    health_checks: [{ path: "/", expected_status: 200 as const, body: "immutable-artifact-equality" as const,
      identity: "release-id-and-artifact-digest-headers" as const }],
    criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
      statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } };
  const release = ReleaseCapabilitiesV1Schema.parse({ version: 1, contract,
    binding: { version: 1, release_profile_id: "site", release_profile_digest: `sha256:${"8".repeat(64)}`,
      contract_digest: `sha256:${createHash("sha256").update(canonicalReleaseCapabilityContract(contract)).digest("hex")}`,
      project_id: "proj_artoo", workspace_root: "/workspace/product", verification_profile_id: "default",
      verification_profile_digest: f.capabilities.profile_digest } });
  f.requirement = VerificationRequirementSchema.parse({ ...f.requirement, release_capability_binding: release.binding });
  f.context = ContextPackSchema.parse({ ...f.context, verification_capabilities: { ...f.capabilities, profile_id: "default" },
    release_capabilities: release, goal_context: { version: 1, goal_id: "goal_release", objective: "Publish the configured product",
      acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT], plan: { id: "plan_release", version: 1, rationale: "Controlled fixture", spec_ref: "3" } } });
  f.payload = RunVerificationPayloadSchema.parse({ ...f.payload, measurement_plan: { ...f.payload.measurement_plan,
    version: 2, policy, must_criterion_count: 2, mapped_criterion_count: 2, workspace_criterion_count: 1, release_criterion_count: 1,
    pending_release: [{ requirement_id: "publication", criterion_index: 0, criterion_digest: `sha256:${"7".repeat(64)}`,
      claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, release_binding: release.binding }] } });
  return { ...f, release };
}
