import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { ImportedValidationOriginV1Schema, ImportedValidationAuthorizationV1Schema, inspectImportedValidationVerificationV1 } from "./imported-validation.js";
import { ImportedValidationReviewVerdictV1Schema } from "./imported-validation-review.js";
import { ImportedValidationReviewReferenceV1Schema } from "./imported-validation-context.js";
import { ImportedRecoveryValidationReviewSubjectV1Schema } from "./source-recovery-context.js";
import { ProductSourceRecoveryCheckpointV1Schema, productSourceRecoveryCheckpointDigestV1 } from "./source-recovery.js";
import { ImportedRecoveryRunStartV1Schema, ImportedRecoveryValidationSourceV1Schema, importedRecoveryValidationSourceDigestV1,
  inspectImportedRecoveryValidationSourceV1, type ImportedRecoveryRunStartV1 } from "./imported-recovery-validation.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), reason = z.string().trim().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1 = "imported-recovery-validation-review.v1";
function authorContext(start: ImportedRecoveryRunStartV1) {
  const { imported_recovery_validation: _author, imported_recovery_validation_review_subject: _review, ...context } = start.context_pack.payload;
  return context;
}
function sameVerifier(source: ImportedRecoveryRunStartV1, start: ImportedRecoveryRunStartV1) {
  const context = authorContext(start), original = authorContext(source);
  return canonical({ ...start, run_id: source.run_id, verification: source.verification,
    policy_snapshot: { ...start.policy_snapshot, filesystem_write_scope: source.policy_snapshot.filesystem_write_scope },
    context_pack: { id: source.context_pack.id, payload: { ...context, policy: { ...context.policy, filesystem_write_scope: original.policy.filesystem_write_scope } } } })
      === canonical({ ...source, context_pack: { ...source.context_pack, payload: original } })
    && canonical({ ...start.verification, request_id: source.verification.request_id, expected_subject_digest: undefined }) === canonical(source.verification)
    && !context.policy.filesystem_write_scope.length && !start.policy_snapshot.filesystem_write_scope.length && context.policy.execution_mode === undefined;
}
export const ImportedRecoveryValidationReviewRequestV1Schema = z.object({
  version: z.literal(1), review_id: id, recovery_id: id, origin: ImportedValidationOriginV1Schema,
  checkpoint: ProductSourceRecoveryCheckpointV1Schema, source: ImportedRecoveryValidationSourceV1Schema,
  authorization: ImportedValidationAuthorizationV1Schema, reviewer: agent,
  before_start: ImportedRecoveryRunStartV1Schema, review_start: ImportedRecoveryRunStartV1Schema, after_start: ImportedRecoveryRunStartV1Schema,
  retry_of: ImportedValidationReviewReferenceV1Schema.optional(),
}).strict().superRefine((value, ctx) => {
  const source = value.source.run_start, starts = [value.before_start, value.review_start, value.after_start], start = value.review_start, context = start.context_pack.payload;
  if (value.recovery_id !== value.checkpoint.recovery_id || value.recovery_id !== value.source.recovery_id || value.source.outcome !== "verified"
    || value.reviewer.agent_id === value.source.author.agent_id || value.reviewer.instance_id === value.source.author.instance_id
    || value.authorization.goal_id !== source.context_pack.payload.goal_context?.goal_id
    || value.authorization.event_id === source.context_pack.payload.imported_recovery_validation?.authorization_event_id
    || value.authorization.attempt_index < (source.context_pack.payload.imported_recovery_validation?.attempt_index ?? 0)
    || value.retry_of?.review_id === value.review_id
    || new Set(starts.map(item => item.run_id)).size !== 3 || new Set(starts.map(item => item.context_pack.id)).size !== 3
    || new Set(starts.map(item => item.verification.request_id)).size !== 3
    || starts.some(item => item.run_id === source.run_id || item.context_pack.id === source.context_pack.id
      || item.verification.request_id === source.verification.request_id || item.verification.expected_subject_digest !== value.source.subject_digest
      || item.workspace.root !== source.workspace.root || item.workspace.branch != null || item.workspace_allocation || item.runtime === "mock"
      || item.context_pack.payload.imported_clean_validation || item.context_pack.payload.imported_clean_validation_review_subject
      || item.context_pack.payload.imported_recovery_validation || item.context_pack.payload.imported_validation || item.context_pack.payload.imported_validation_review_subject
      || item.context_pack.payload.imported_execution || item.context_pack.payload.imported_execution_repair || item.context_pack.payload.imported_execution_review_subject
      || item.context_pack.payload.imported_design_review_subject || item.context_pack.payload.imported_review_subject
      || item.context_pack.payload.review_subject || item.context_pack.payload.product_design_revision)
    || !sameVerifier(source, value.before_start) || !sameVerifier(source, value.after_start)
    || start.agent_instance_id !== value.reviewer.instance_id || start.task_id === source.task_id || context.task.id !== start.task_id
    || context.workspace.root !== source.workspace.root || context.policy.execution_mode !== "discussion" || context.policy.filesystem_write_scope.length
    || start.policy_snapshot.filesystem_write_scope.length || context.product_development
    || canonical(context.project) !== canonical(source.context_pack.payload.project) || canonical(context.goal_context) !== canonical(source.context_pack.payload.goal_context)
    || canonical(context.policy.requires_approval) !== canonical(source.policy_snapshot.requires_approval)
    || canonical(start.policy_snapshot.requires_approval) !== canonical(source.policy_snapshot.requires_approval)
    || canonical(context.transferred_product_input) !== canonical(source.context_pack.payload.transferred_product_input)
    || canonical(context.verification_capabilities) !== canonical(source.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(source.context_pack.payload.release_capabilities)
    || canonical({ ...start.verification, request_id: source.verification.request_id, expected_subject_digest: undefined }) !== canonical(source.verification))
    ctx.addIssue({ code: "custom", message: "Recovery final review requires a new independent reviewer and complete unchanged final-source measurements" });
});
export type ImportedRecoveryValidationReviewRequestV1 = z.infer<typeof ImportedRecoveryValidationReviewRequestV1Schema>;
export function importedRecoveryValidationReviewSubjectV1(value: Pick<ImportedRecoveryValidationReviewRequestV1, "review_id" | "source" | "authorization">, sha: SourceOperationSha) {
  return ImportedRecoveryValidationReviewSubjectV1Schema.parse({ version: 1, recovery_id: value.source.recovery_id,
    checkpoint_digest: value.source.checkpoint_digest, epoch_id: value.source.run_start.context_pack.payload.imported_recovery_validation?.epoch_id,
    review_id: value.review_id, validation_id: value.source.validation_id, root_validation_id: value.source.root_validation_id,
    source_digest: importedRecoveryValidationSourceDigestV1(value.source, sha), subject_digest: value.source.subject_digest,
    baseline_digest: value.source.baseline.manifest_digest, authorization_event_id: value.authorization.event_id, attempt_index: value.authorization.attempt_index });
}
export function importedRecoveryValidationReviewRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedRecoveryValidationReviewRequestV1Schema.parse(input))));
}
export function inspectImportedRecoveryValidationReviewRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = ImportedRecoveryValidationReviewRequestV1Schema.parse(input);
  inspectImportedRecoveryValidationSourceV1(request.origin, request.checkpoint, request.source, researchBytes, sha);
  if (request.source.checkpoint_digest !== productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha)) throw Error("Recovery review checkpoint changed");
  const expected = importedRecoveryValidationReviewSubjectV1(request, sha);
  for (const start of [request.before_start, request.review_start, request.after_start])
    if (canonical(start.context_pack.payload.imported_recovery_validation_review_subject) !== canonical(expected)) throw Error("Recovery review descriptor changed its current source or authorization");
  return request;
}
export const ImportedRecoveryValidationReviewControlV1Schema = z.object({ version: z.literal(1), review_id: id, request_digest: digest }).strict();
export type ImportedRecoveryValidationReviewControlV1 = z.infer<typeof ImportedRecoveryValidationReviewControlV1Schema>;
const control = { version: z.literal(1), review_id: id, request_digest: digest, execution_authorized: z.literal(false) };
const measurement = z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1"),
  scope: z.literal("all-declared-workspace-validation-cases"), verification: RunVerificationPayloadSchema }).strict();
export const ImportedRecoveryValidationReviewResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("reviewed"), closed: z.literal(true), before: measurement, after: measurement,
    reviewer: z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1") }).strict(), verdict: ImportedValidationReviewVerdictV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...control, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...control, outcome: z.literal("cancelled_before_start"), closed: z.literal(true), reason }).strict(),
]);
export type ImportedRecoveryValidationReviewResultV1 = z.infer<typeof ImportedRecoveryValidationReviewResultV1Schema>;
export function inspectImportedRecoveryValidationReviewCompletionV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = inspectImportedRecoveryValidationReviewRequestV1(requestInput, researchBytes, sha), result = ImportedRecoveryValidationReviewResultV1Schema.parse(input);
  const requestDigest = digest.parse(sha(canonical(request))), resultDigest = digest.parse(sha(canonical(result))), sourceDigest = digest.parse(sha(canonical(request.source)));
  if (result.review_id !== request.review_id || result.request_digest !== requestDigest) throw Error("Recovery review result changed its exact new request");
  const inspected = { request, result, requestDigest, resultDigest, sourceDigest };
  if (result.outcome !== "reviewed") return inspected;
  for (const [start, measured] of [[request.before_start, result.before], [request.after_start, result.after]] as const) {
    const verification = inspectImportedValidationVerificationV1(request.origin, measured.verification);
    if (measured.run_id !== start.run_id || measured.config_digest !== sha(canonical(start)) || verification.request_id !== start.verification.request_id
      || verification.subject_digest !== request.source.subject_digest || canonical(verification.required_files) !== canonical(request.source.verification!.required_files))
      throw Error("Recovery review lost its fresh measured final subject, accepted inputs or phase binding");
  }
  if (result.reviewer.run_id !== request.review_start.run_id || result.reviewer.config_digest !== sha(canonical(request.review_start))
    || result.verdict.review_id !== request.review_id || result.verdict.validation_id !== request.source.validation_id
    || result.verdict.source_digest !== sourceDigest || result.verdict.subject_digest !== request.source.subject_digest)
    throw Error("Recovery final verdict changed its source or independent reviewer binding");
  return inspected;
}
export function inspectImportedRecoveryValidationReviewResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectImportedRecoveryValidationReviewCompletionV1(requestInput, input, researchBytes, sha).result;
}
