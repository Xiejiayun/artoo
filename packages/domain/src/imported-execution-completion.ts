import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ImportedCompletedExecutionV1Schema = z.object({
  version: z.literal(1), stage: z.literal("implementation"), execution_id: id, request_digest: digest,
  run_id: id, run_start_digest: digest, initial_subject_digest: digest, subject_digest: digest,
  author: z.object({ agent_id: id, instance_id: id }).strict(),
  destination: z.object({ node_id: id, workspace_root: z.string().min(1).max(4096), profile_id: id, profile_digest: digest }).strict(),
  h4_review_id: id, h4_result_digest: digest, acceptance_event_id: id,
  transfer_id: id, source_export_digest: digest, mapping_digest: digest, research_provenance_digest: digest,
  closure: z.literal("windows-job-and-tools-closed.v1"), scope: z.literal("all-declared-workspace-implementation-cases"),
  verification: RunVerificationPayloadSchema,
}).strict().superRefine((value, ctx) => {
  const measured = value.verification;
  if (measured.outcome !== "passed" || measured.subject_digest !== value.subject_digest
    || measured.profile_id !== value.destination.profile_id || measured.profile_digest !== value.destination.profile_digest
    || measured.measurement_plan?.version !== 2 || measured.measurement_plan.scope !== "final" || measured.product_design_revision
    || !measured.checks.length || measured.checks.some(check => check.exit_code !== 0 || check.observation?.version !== 3
      || check.observation.scope !== "final" || check.observation.stage !== "implementation" || !check.observation.cases.length)
    || ![".artoo/product/research.json", ".artoo/product/design.json", ".artoo/product/implementation.md"]
      .every(path => measured.required_files.some(file => file.path === path))) {
    ctx.addIssue({ code: "custom", message: "H5 completion requires its new passed native final implementation measurement" });
  }
});
export type ImportedCompletedExecutionV1 = z.infer<typeof ImportedCompletedExecutionV1Schema>;
