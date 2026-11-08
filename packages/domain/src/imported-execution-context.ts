import { z } from "zod";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Public H5 provenance only. JSON never grants imported workspace write authority. */
export const ImportedExecutionContextV1Schema = z.object({
  version: z.literal(1), execution_id: id, h4_review_id: id, h4_request_digest: digest,
  h4_result_digest: digest, acceptance_event_id: id, initial_subject_digest: digest,
}).strict();
export type ImportedExecutionContextV1 = z.infer<typeof ImportedExecutionContextV1Schema>;
