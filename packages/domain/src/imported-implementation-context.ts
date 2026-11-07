import { z } from "zod";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Descriptive context only; neither projection is a local execution permit. */
export const ImportedExecutionReviewSubjectV1Schema = z.object({ version: z.literal(1), review_id: id,
  base_execution_id: id, source_digest: digest, subject_digest: digest }).strict();
export type ImportedExecutionReviewSubjectV1 = z.infer<typeof ImportedExecutionReviewSubjectV1Schema>;
export const ImportedExecutionRepairContextV1Schema = z.object({ version: z.literal(1), repair_id: id,
  base_execution_id: id, review_id: id, review_request_digest: digest, review_result_digest: digest,
  authorization_event_id: id, attempt_index: z.number().int().positive(), initial_subject_digest: digest }).strict();
export type ImportedExecutionRepairContextV1 = z.infer<typeof ImportedExecutionRepairContextV1Schema>;
