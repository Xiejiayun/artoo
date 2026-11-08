import { z } from "zod";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Node-owned capture after the actual author/tools and final verifier have closed. */
export const ProductSourceExportV1Schema = z.object({
  version: z.literal(1), export_id: digest, node_id: id, run_id: id, task_id: id, project_id: id, goal_id: id, plan_id: id,
  verification_request_id: id, profile_id: id, profile_digest: digest, subject_digest: digest,
  context_digest: digest, verification_digest: digest,
  capsule_digest: digest, manifest_digest: digest, capsule_bytes: z.number().int().min(1).max(12 * 1024 * 1024),
  author_closure: z.literal("windows-job-and-tools-closed.v1"), execution_authorized: z.literal(false),
}).strict();
export type ProductSourceExportV1 = z.infer<typeof ProductSourceExportV1Schema>;
export const PRODUCT_SOURCE_EXPORT_EVENT_V1 = "run.product-source.export.v1" as const;

/** Durable byte import only. Semantic admission and a local verifier are separate. */
export const ProductSourceImportReadyV1Schema = z.object({
  version: z.literal(1), transfer_id: id, request_digest: digest, capsule_digest: digest, manifest_digest: digest,
  destination: z.object({ node_id: id, project_id: id, profile_id: id, profile_digest: digest,
    workspace_root: z.string().min(1).max(4096), subject_digest: digest }).strict(),
  git_metadata_digest: digest, git_processes_closed: z.literal(true), verification_passed: z.literal(false),
  execution_authorized: z.literal(false), semantic_mapping_accepted: z.literal(false),
}).strict();
export type ProductSourceImportReadyV1 = z.infer<typeof ProductSourceImportReadyV1Schema>;
