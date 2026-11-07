import { z } from "zod";
import { MAX_VERIFICATION_OBSERVATIONS_LENGTH, VerificationObservationSchema } from "./verification-observation.js";
import { VerificationCapabilitiesSchema, VerificationCapabilityBindingSchema } from "./verification-capabilities.js";
import { GoalPlanningCapabilitySnapshotSchema } from "./planning-capabilities.js";
import { MeasurementPlanSummarySchema } from "./measurement-plan.js";
import { ReleaseCapabilityBindingV1Schema } from "./release-capabilities.js";
import { AdditiveDesignRevisionRequestV1Schema, ProductDesignRevisionEvidenceV1Schema } from "./product-design-revision.js";

const identifier = z.string().min(1).max(128);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") && !value.includes(":")
  && !value.includes("\0") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Expected a normalized relative file path");

/** Selects a trusted node-local verifier; task content never supplies its argv. */
export const VerificationRequirementSchema = z.object({
  version: z.literal(1), request_id: identifier, profile_id: identifier,
  /** Read-only review must inspect the exact subject accepted by the writer's verifier. */
  expected_subject_digest: digest.optional(),
  capability_binding: VerificationCapabilityBindingSchema.optional(),
  release_capability_binding: ReleaseCapabilityBindingV1Schema.optional(),
}).superRefine((value, ctx) => {
  const binding = value.release_capability_binding;
  if (binding && (binding.verification_profile_id !== value.profile_id || binding.verification_profile_digest !== value.capability_binding?.profile_digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["release_capability_binding"], message: "Release capability requires the exact selected verifier binding" });
  }
});
export type VerificationRequirement = z.infer<typeof VerificationRequirementSchema>;

/** Public routing metadata only; verifier commands and credentials stay on the node. */
export const VerificationProfileAdvertisementSchema = z.object({
  profile_id: identifier,
  project_id: identifier,
  workspace_root: z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Invalid workspace root"),
  capabilities: VerificationCapabilitiesSchema.optional(),
}).strict();
export const VerificationProfileAdvertisementsSchema = z.array(VerificationProfileAdvertisementSchema).max(64)
  .refine((profiles) => new Set(profiles.map((profile) => profile.profile_id)).size === profiles.length, "Profile IDs must be unique");
export type VerificationProfileAdvertisement = z.infer<typeof VerificationProfileAdvertisementSchema>;

/** Measured by the execution node, never parsed from an agent's prose/artifact. */
export const RunVerificationPayloadSchema = z.object({
  version: z.literal(1),
  request_id: identifier,
  profile_id: identifier,
  profile_digest: digest,
  subject_digest: digest.nullable(),
  outcome: z.enum(["passed", "failed", "timed_out", "cancelled"]),
  checks: z.array(z.object({
    id: identifier,
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().finite().nonnegative(),
    output_digest: digest,
    observation: VerificationObservationSchema.optional(),
  })).max(64),
  required_files: z.array(z.object({ path: relativePath, checksum: digest, size: z.number().int().nonnegative() })).max(1000),
  measurement_plan: MeasurementPlanSummarySchema.optional(),
  product_design_revision: ProductDesignRevisionEvidenceV1Schema.optional(),
  reason: z.string().max(2000).optional(),
}).superRefine((value, ctx) => {
  const revision = value.product_design_revision;
  if (revision && (value.outcome !== "passed" || value.subject_digest === null || !value.required_files.some(file =>
    file.path === revision.revised_design.path && file.checksum === revision.revised_design.checksum && file.size === revision.revised_design.size))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["product_design_revision"], message: "Design revision requires successful verification and its measured design file" });
  }
  if (new Set(value.checks.map((check) => check.id)).size !== value.checks.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "Check IDs must be unique" });
  }
  if (new Set(value.required_files.map((file) => file.path)).size !== value.required_files.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["required_files"], message: "Required file paths must be unique" });
  }
  value.checks.forEach((check, index) => {
    const binding = check.observation?.capability_binding;
    if (binding && (binding.command_id !== check.id || binding.profile_digest !== value.profile_digest)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks", index, "observation", "capability_binding"],
        message: "Configured capability observation must match its measured command and profile" });
    }
  });
  if (value.outcome === "passed" && (value.subject_digest === null || value.checks.length === 0 || value.checks.some((check) => check.exit_code !== 0))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Passing verification requires measured successful checks" });
  }
  const summary = value.measurement_plan;
  if (summary?.version === 2 && summary.pending_release.some(ref => ref.release_binding.verification_profile_id !== value.profile_id
    || ref.release_binding.verification_profile_digest !== value.profile_digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement_plan"], message: "Pending release criteria must bind the measured verifier" });
  }
  if (summary && (value.outcome !== "passed" || value.subject_digest === null
    || !value.required_files.some(file => file.path === summary.research.path && file.checksum === summary.research.checksum && file.size === summary.research.size)
    || value.checks.some(check => check.observation && check.observation.scope !== summary.scope)
    || summary.used_checks.some(used => {
      const check = value.checks.find(item => item.id === used.command_id), binding = check?.observation?.capability_binding;
      return check?.exit_code !== 0 || !binding || binding.config_digest !== used.config_digest || binding.contract_digest !== used.contract_digest;
    }))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["measurement_plan"],
      message: "Declared feasibility requires successful measured checks, matching scope and the measured research file" });
  const observations = value.checks.flatMap((check) => check.observation ? [check.observation] : []);
  if (observations.length && (value.outcome !== "passed" || value.subject_digest === null
    || JSON.stringify(observations).length > MAX_VERIFICATION_OBSERVATIONS_LENGTH)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["checks"], message: "Observations require a complete successful measurement and bounded output" });
  }
});
export type RunVerificationPayload = z.infer<typeof RunVerificationPayloadSchema>;

export const AutonomousTeamSchema = z.object({
  version: z.literal(1),
  members: z.array(z.object({
    stage: z.enum(["research", "design", "implementation", "validation"]),
    agent_instance_id: identifier,
  }).strict()).length(4),
  reviewer_instance_ids: z.array(identifier).min(2).max(16),
}).strict().superRefine((team, ctx) => {
  if (new Set(team.members.map((member) => member.stage)).size !== 4
    || new Set(team.members.map((member) => member.agent_instance_id)).size < 2
    || new Set(team.reviewer_instance_ids).size !== team.reviewer_instance_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A team needs unique stage assignments and at least two distinct contributors and reviewers" });
  }
});
export type AutonomousTeam = z.infer<typeof AutonomousTeamSchema>;

export const IndependentReviewVerdictSchema = z.object({
  version: z.literal(1),
  reviewed_run_id: identifier,
  verification_evidence_id: identifier,
  subject_digest: digest,
  outcome: z.enum(["accepted", "changes_requested"]),
  design_revision_request: AdditiveDesignRevisionRequestV1Schema.optional(),
  summary: z.string().trim().min(1).max(4000),
  findings: z.array(z.object({
    severity: z.enum(["blocking", "nonblocking"]),
    description: z.string().trim().min(1).max(2000),
    file: z.string().max(1024).optional(),
  }).strict()).max(50),
}).strict().superRefine((verdict, ctx) => {
  if (verdict.design_revision_request && verdict.outcome !== "changes_requested") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["design_revision_request"], message: "Only a changes-requested verdict may request an additive design revision" });
  }
  if (verdict.outcome === "accepted" && verdict.findings.some((finding) => finding.severity === "blocking")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A blocking finding cannot be accepted" });
  }
});

export const GoalAutomationSchema = z.object({
  goal_id: z.string().min(1),
  organization_id: z.string().min(1),
  actor_user_id: z.string().min(1),
  consent_id: z.string().nullable(),
  policy_version: z.string().min(1),
  status: z.enum(["planning", "executing", "waiting", "completed", "failed", "cancelled"]),
  discussion_id: z.string().nullable(),
  plan_id: z.string().nullable(),
  agent_instance_id: z.string().nullable(),
  computer_id: z.string().nullable(),
  workspace_root: z.string().nullable(),
  verification_profile_id: identifier,
  execution_mode: z.enum(["single_agent", "agent_team"]).default("single_agent"),
  planning_capability_snapshot: GoalPlanningCapabilitySnapshotSchema.nullable().default(null),
  team: AutonomousTeamSchema.nullable().default(null),
  release_profile_id: identifier.nullable().default(null),
  delivery: z.enum(["verified_workspace", "published_product"]).default("verified_workspace"),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type GoalAutomation = z.infer<typeof GoalAutomationSchema>;

export const CreateAutonomousGoalRequestSchema = z.object({
  project_id: z.string().min(1),
  objective: z.string().trim().min(1).max(10000),
  verification_profile_id: identifier.default("default"),
  execution_mode: z.enum(["single_agent", "agent_team"]).optional(),
  release_profile_id: identifier.optional(),
  max_retries: z.number().int().min(0).max(10).default(3),
});
export type CreateAutonomousGoalRequest = z.infer<typeof CreateAutonomousGoalRequestSchema>;
