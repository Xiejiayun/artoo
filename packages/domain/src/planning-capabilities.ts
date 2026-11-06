import { z } from "zod";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { ReleaseCapabilitiesV1Schema } from "./release-capabilities.js";

const identifier = z.string().min(1).max(128);
const workspace = z.string().min(1).max(4096)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Invalid workspace root");

/** Fixed routing and configured scope for the product worker, never planning execution authority. */
export const GoalPlanningCapabilitySnapshotSchema = z.object({
  version: z.literal(1),
  computer_id: identifier,
  project_id: identifier,
  workspace_root: workspace,
  verification_profile_id: identifier,
  // Required null means explicitly captured unknown; an absent historical DB value is separate.
  capabilities: VerificationCapabilitiesSchema.nullable(),
  release: z.object({ version: z.literal(1), capabilities: ReleaseCapabilitiesV1Schema }).strict().optional(),
}).strict().superRefine((snapshot, ctx) => {
  const binding = snapshot.release?.capabilities.binding;
  if (binding && (binding.project_id !== snapshot.project_id || binding.workspace_root !== snapshot.workspace_root
    || binding.verification_profile_id !== snapshot.verification_profile_id
    || binding.verification_profile_digest !== snapshot.capabilities?.profile_digest)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["release"], message: "Planning release capability must match the captured workspace and verifier" });
  }
});
export type GoalPlanningCapabilitySnapshot = z.infer<typeof GoalPlanningCapabilitySnapshotSchema>;

/** Preserve the original request verbatim while sharing one durable planning snapshot. */
export const AutonomousPlanningRequestV1Schema = z.object({
  version: z.literal(1),
  kind: z.literal("autonomous-planning"),
  request: z.string(),
  planning_capability_snapshot: GoalPlanningCapabilitySnapshotSchema.nullable(),
}).strict();
export type AutonomousPlanningRequestV1 = z.infer<typeof AutonomousPlanningRequestV1Schema>;
