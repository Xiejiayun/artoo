import { z } from "zod";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Versioned read-only H4 subject; this descriptor never grants a writer. */
export const ImportedDesignReviewSubjectV1Schema = z.object({
  version: z.literal(1), review_id: id, continuation_id: id, completed_design_digest: digest,
  transfer_id: id, source_export_digest: digest, mapping_digest: digest, research_provenance_digest: digest,
  author_run_id: id, author_agent_id: id, reviewer_agent_id: id, reviewer_instance_id: id,
  subject_digest: digest, development_stage: z.literal("design"), scope: z.literal("all-declared-workspace-design-cases"),
}).strict();
export type ImportedDesignReviewSubjectV1 = z.infer<typeof ImportedDesignReviewSubjectV1Schema>;
