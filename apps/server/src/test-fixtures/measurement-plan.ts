import { ContextPackSchema, productDevelopmentContext, productStageHandoffPaths, RunVerificationPayloadSchema,
  VerificationRequirementSchema, type DevelopmentStage } from "@artoo/domain";
import { verificationCapabilityBinding } from "../services/verification-capabilities.js";
import { verificationCapabilitiesFixture } from "./verification-capabilities.js";

/** Controlled node attestation only; no research, browser, model or publication is executed. */
export function measurementPlanEvidenceFixture(stage: DevelopmentStage = "research") {
  const capabilities = verificationCapabilitiesFixture();
  capabilities.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
  const requirement = VerificationRequirementSchema.parse({ version: 1, request_id: "measurement_request", profile_id: "default",
    capability_binding: verificationCapabilityBinding(capabilities) });
  const checksum = `sha256:${"d".repeat(64)}`, subject = `sha256:${"f".repeat(64)}`;
  const research = { path: ".artoo/product/research.json" as const, checksum, size: 100 };
  const payload = RunVerificationPayloadSchema.parse({ version: 1, request_id: requirement.request_id, profile_id: "default",
    profile_digest: capabilities.profile_digest, subject_digest: subject, outcome: "passed",
    checks: [{ id: "acceptance", exit_code: 0, duration_ms: 10, output_digest: checksum,
      observation: { version: 1, format: "static-web-acceptance.v1", scope: "final", stage, cases: [],
        capability_binding: { version: 1, profile_digest: capabilities.profile_digest, ...requirement.capability_binding!.checks[0] } } }],
    required_files: productStageHandoffPaths(stage).map((path) => ({ path, checksum, size: 100 })),
    measurement_plan: { version: 1, claim: "declared-mapping-feasibility", scope: "final", policy: capabilities.measurement_plan_policy,
      research, measurement_plan_digest: `sha256:${"e".repeat(64)}`, must_criterion_count: 2, mapped_criterion_count: 2,
      used_checks: requirement.capability_binding!.checks },
  });
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Declared feasibility", description: "Controlled fixture", acceptance_criteria: [] },
    project: { id: "proj_artoo", name: "Fixture", default_workspace: "/workspace/product" }, workspace: { root: "/workspace/product", file_scope: [] },
    policy: { filesystem_write_scope: ["/workspace/product"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    verification_capabilities: { ...capabilities, profile_id: "default" },
    product_development: { ...productDevelopmentContext(stage), accepted_inputs: { version: 1,
      files: stage === "research" ? [] : [{ ...research, source_task_id: "research_task", source_run_id: "research_run", evidence_id: "research_evidence" }] } },
  });
  return { capabilities, requirement, payload, context };
}
