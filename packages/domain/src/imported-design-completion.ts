import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Public audit facts only. Original completed execution authority is held by the node. */
export const ImportedCompletedDesignV1Schema = z.object({
  version: z.literal(1), continuation_id: id, request_digest: digest, run_id: id,
  run_start_digest: digest, subject_digest: digest,
  author: z.object({ agent_id: id, instance_id: id }).strict(),
  destination: z.object({ node_id: id, workspace_root: z.string().min(1).max(4096), profile_id: id, profile_digest: digest }).strict(),
  transfer_id: id, source_export_digest: digest, mapping_digest: digest, research_provenance_digest: digest,
  scope: z.enum(["prototype-only", "all-declared-workspace-design-cases"]),
  closure: z.literal("windows-job-and-tools-closed.v1"), verification: RunVerificationPayloadSchema,
}).strict().superRefine((value, ctx) => {
  const measured = value.verification;
  if (measured.outcome !== "passed" || measured.subject_digest !== value.subject_digest
    || measured.profile_id !== value.destination.profile_id || measured.profile_digest !== value.destination.profile_digest
    || measured.measurement_plan?.version !== 2 || measured.measurement_plan.scope !== "final"
    || measured.product_design_revision || measured.checks.some(check => check.exit_code !== 0
      || check.observation?.version !== 3 || check.observation.scope !== "final" || check.observation.stage !== "design")
    || ![".artoo/product/research.json", ".artoo/product/design.json"].every(path => measured.required_files.some(file => file.path === path))) {
    ctx.addIssue({ code: "custom", message: "Completed imported design requires exact passed native v3 final design evidence and retained research" });
  }
});
export type ImportedCompletedDesignV1 = z.infer<typeof ImportedCompletedDesignV1Schema>;
