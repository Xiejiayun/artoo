import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const PRODUCT_RESEARCH_REVISION_FEATURE_V1 = "product-research-revision.v1";

/** A write-before baseline, never the expected digest of the revised final subject.
 * Serialized context supplies no execution authority; the node checks its retained export. */
export const ProductResearchRevisionContextV1Schema = z.object({
  version: z.literal(1), revision_id: id, intent_digest: digest, author_run_id: id,
  original_research_task_id: id, goal_id: id, plan_id: id,
  parent_review: z.object({ review_id: id, request_digest: digest, result_digest: digest }).strict(),
  baseline: z.object({ version: z.literal(1), source_task_id: id, source_run_id: id, evidence_id: id,
    computer_id: id, workspace_root: z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$/u),
    profile_id: id, profile_digest: digest, subject_digest: digest, capsule_digest: digest,
    capsule_bytes: z.number().int().positive().max(12 * 1024 * 1024), export_digest: digest, provenance_digest: digest,
    research: z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest,
      size: z.number().int().positive().max(1024 * 1024) }).strict(),
  }).strict(),
}).strict();
export type ProductResearchRevisionContextV1 = z.infer<typeof ProductResearchRevisionContextV1Schema>;
