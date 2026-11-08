import { z } from "zod";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const ImportedValidationReferenceV1Schema = z.object({ validation_id: id, request_digest: digest, result_digest: digest }).strict();
export type ImportedValidationReferenceV1 = z.infer<typeof ImportedValidationReferenceV1Schema>;
export const ImportedValidationReviewReferenceV1Schema = z.object({ review_id: id, request_digest: digest, result_digest: digest }).strict();
export type ImportedValidationReviewReferenceV1 = z.infer<typeof ImportedValidationReviewReferenceV1Schema>;
export const ImportedValidationPredecessorV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("review"), review: ImportedValidationReviewReferenceV1Schema }).strict(),
  z.object({ kind: z.literal("failure"), validation: ImportedValidationReferenceV1Schema }).strict(),
]);
export type ImportedValidationPredecessorV1 = z.infer<typeof ImportedValidationPredecessorV1Schema>;
/** Small descriptors carry bindings, never local process, baseline or writer authority. */
export const ImportedValidationContextV1Schema = z.object({ version: z.literal(1), validation_id: id, root_validation_id: id,
  generation: z.number().int().nonnegative(), kind: z.enum(["initial", "repair"]), origin_digest: digest,
  initial_subject_digest: digest, authorization_event_id: id, attempt_index: z.number().int().nonnegative(),
  predecessor: ImportedValidationPredecessorV1Schema.optional() }).strict();
export type ImportedValidationContextV1 = z.infer<typeof ImportedValidationContextV1Schema>;
export const ImportedValidationReviewSubjectV1Schema = z.object({ version: z.literal(1), review_id: id, validation_id: id,
  root_validation_id: id, source_digest: digest, subject_digest: digest, baseline_digest: digest,
  authorization_event_id: id, attempt_index: z.number().int().nonnegative() }).strict();
export type ImportedValidationReviewSubjectV1 = z.infer<typeof ImportedValidationReviewSubjectV1Schema>;
export const ImportedValidationReleaseOriginV1Schema = z.object({ version: z.literal(1), validation_id: id, request_digest: digest,
  result_digest: digest, review_id: id, review_request_digest: digest, review_result_digest: digest,
  acceptance_event_id: id, subject_digest: digest }).strict();
export type ImportedValidationReleaseOriginV1 = z.infer<typeof ImportedValidationReleaseOriginV1Schema>;
