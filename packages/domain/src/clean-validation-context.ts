import { z } from "zod";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const generation = z.number().int().nonnegative().max(2147483647);

/** Clean descriptors describe a new attempt; they never restore an old local execution owner. */
export const ImportedCleanValidationContextV1Schema = z.object({
  version: z.literal(1), clean_generation_id: id, restart_digest: digest, epoch_id: z.string().uuid(),
  validation_id: id, root_validation_id: id, generation, kind: z.enum(["initial", "repair"]),
  origin_digest: digest, initial_subject_digest: digest, authorization_event_id: id, attempt_index: generation,
  predecessor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("failure"), validation_id: id, request_digest: digest, result_digest: digest }).strict(),
    z.object({ kind: z.literal("review"), review_id: id, request_digest: digest, result_digest: digest }).strict(),
  ]).optional(),
}).strict();
export type ImportedCleanValidationContextV1 = z.infer<typeof ImportedCleanValidationContextV1Schema>;

export const ImportedCleanValidationReviewSubjectV1Schema = z.object({
  version: z.literal(1), clean_generation_id: id, restart_digest: digest, epoch_id: z.string().uuid(),
  review_id: id, validation_id: id, root_validation_id: id, source_digest: digest,
  subject_digest: digest, baseline_digest: digest, authorization_event_id: id, attempt_index: generation,
}).strict();
export type ImportedCleanValidationReviewSubjectV1 = z.infer<typeof ImportedCleanValidationReviewSubjectV1Schema>;

export const ImportedCleanReleaseOriginV1Schema = z.object({
  version: z.literal(1), clean_generation_id: id, restart_digest: digest,
  validation_id: id, validation_request_digest: digest, validation_result_digest: digest,
  review_id: id, review_request_digest: digest, review_result_digest: digest,
  acceptance_event_id: id, subject_digest: digest,
  interrupted_release_id: id.nullable(),
  authorization: z.object({ event_id: id, goal_id: id, actor_user_id: id, attempt_index: generation }).strict(),
}).strict();
export type ImportedCleanReleaseOriginV1 = z.infer<typeof ImportedCleanReleaseOriginV1Schema>;
