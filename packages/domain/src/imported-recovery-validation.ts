import { z } from "zod";
import { ContextPackSchema } from "./context-pack.js";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { RunVerificationPayloadSchema, VerificationRequirementSchema } from "./autonomy.js";
import { type ImportedImplementationRunStartV1 } from "./imported-implementation-source.js";
import { ImportedValidationOriginV1Schema, ImportedValidationBaselineV1Schema, ImportedValidationAuthorizationV1Schema,
  inspectImportedValidationOriginV1, inspectImportedValidationVerificationV1, importedValidationOriginDigestV1,
  type ImportedValidationOriginV1 } from "./imported-validation.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ImportedRecoveryValidationContextV1Schema } from "./source-recovery-context.js";
import { ProductSourceRecoveryCheckpointV1Schema, productSourceRecoveryCheckpointDigestV1, type ProductSourceRecoveryCheckpointV1 } from "./source-recovery.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(2147483647), reason = z.string().trim().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_RECOVERY_VALIDATION_FEATURE_V1 = "imported-recovery-validation.v1";
export type ImportedRecoveryRunStartV1 = ImportedImplementationRunStartV1;
export const ImportedRecoveryRunStartV1Schema: z.ZodType<ImportedRecoveryRunStartV1> = RunStartPayloadSchema.extend({
  context_pack: z.object({ id, payload: ContextPackSchema.extend({ imported_clean_validation: z.never().optional(), imported_clean_validation_review_subject: z.never().optional() }) }).strict(), verification: VerificationRequirementSchema,
});
export const ImportedRecoveryValidationSourceV1Schema = z.object({
  version: z.literal(1), kind: z.literal("recovery-validation"), outcome: z.enum(["verified", "closed-failure"]),
  recovery_id: id, checkpoint_digest: digest, validation_id: id, root_validation_id: id, generation: integer,
  request_digest: digest, result_digest: digest, origin_digest: digest, author: agent,
  run_start: ImportedRecoveryRunStartV1Schema, initial_subject_digest: digest, subject_digest: digest,
  baseline: ImportedValidationBaselineV1Schema, verification: RunVerificationPayloadSchema.optional(),
  failure_kind: z.enum(["author-failed", "verification-failed"]).optional(), failure_reason: reason.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "verified" ? !value.verification || value.verification.outcome !== "passed" || value.failure_kind !== undefined || value.failure_reason !== undefined
    : !value.failure_kind || !value.failure_reason || (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined))
    ctx.addIssue({ code: "custom", message: "Recovered validation source requires this new author's measured completion or typed closed failure" });
});
export type ImportedRecoveryValidationSourceV1 = z.infer<typeof ImportedRecoveryValidationSourceV1Schema>;
export function importedRecoveryValidationSourceDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedRecoveryValidationSourceV1Schema.parse(input))));
}
function otherDescriptors(start: ImportedRecoveryRunStartV1) {
  const context = start.context_pack.payload;
  return context.imported_validation || context.imported_validation_review_subject || context.imported_execution || context.imported_execution_repair
    || context.imported_execution_review_subject || context.imported_design_review_subject || context.imported_review_subject
    || context.review_subject || context.product_design_revision;
}
export function inspectImportedRecoveryValidationAuthorStartV1(origin: ImportedValidationOriginV1, checkpoint: ProductSourceRecoveryCheckpointV1,
  start: ImportedRecoveryRunStartV1, sha: SourceOperationSha): void {
  const context = start.context_pack.payload, original = origin.execution_request.run_start, prior = original.context_pack.payload;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const descriptor = context.imported_recovery_validation, comparableGoal = context.goal_context?.plan && prior.goal_context?.plan
    ? { ...context.goal_context, plan: { ...context.goal_context.plan, spec_ref: prior.goal_context.plan.spec_ref } } : context.goal_context;
  if (otherDescriptors(start) || context.imported_recovery_validation_review_subject || !descriptor || start.runtime === "mock"
    || start.workspace.branch != null || start.workspace_allocation || context.task.id !== start.task_id || context.product_development?.stage !== "validation"
    || context.policy.execution_mode !== undefined || start.workspace.root !== original.workspace.root || context.workspace.root !== original.workspace.root
    || checkpoint.binding.workspace_root !== original.workspace.root || checkpoint.binding.node_id !== destination.node_id || descriptor.recovery_id !== checkpoint.recovery_id
    || descriptor.checkpoint_digest !== productSourceRecoveryCheckpointDigestV1(checkpoint, sha) || descriptor.epoch_id !== checkpoint.new_epoch_id
    || canonical(context.project) !== canonical(prior.project) || canonical(comparableGoal) !== canonical(prior.goal_context)
    || canonical(context.transferred_product_input) !== canonical(prior.transferred_product_input)
    || canonical(context.product_development.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(origin.execution_request))
    || canonical(checkpoint.accepted_inputs) !== canonical(context.product_development.accepted_inputs)
    || canonical(context.verification_capabilities) !== canonical(prior.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(prior.release_capabilities)
    || canonical(context.policy) !== canonical(prior.policy) || canonical(start.policy_snapshot) !== canonical(original.policy_snapshot)
    || start.verification.expected_subject_digest !== undefined
    || canonical({ ...start.verification, request_id: original.verification!.request_id }) !== canonical(original.verification))
    throw Error("Recovery validation author changed its fresh checkpoint, fixed accepted inputs or original goal policy");
}
function inspectSource(origin: ImportedValidationOriginV1, checkpoint: ProductSourceRecoveryCheckpointV1,
  source: ImportedRecoveryValidationSourceV1, sha: SourceOperationSha): ImportedRecoveryValidationSourceV1 {
  const start = source.run_start;
  inspectImportedRecoveryValidationAuthorStartV1(origin, checkpoint, start, sha);
  const descriptor = start.context_pack.payload.imported_recovery_validation!;
  if (source.recovery_id !== checkpoint.recovery_id || source.checkpoint_digest !== productSourceRecoveryCheckpointDigestV1(checkpoint, sha)
    || source.origin_digest !== importedValidationOriginDigestV1(origin, sha) || source.origin_digest !== descriptor.origin_digest
    || source.validation_id !== descriptor.validation_id || source.root_validation_id !== descriptor.root_validation_id || source.generation !== descriptor.generation
    || start.agent_instance_id !== source.author.instance_id || source.initial_subject_digest !== descriptor.initial_subject_digest
    || source.baseline.subject_digest !== source.initial_subject_digest
    || source.baseline.manifest_digest !== sha(canonical({ directories: source.baseline.directories, files: source.baseline.files }))
    || source.verification && (source.verification.request_id !== start.verification.request_id || source.verification.subject_digest !== source.subject_digest
      || source.verification.profile_id !== start.verification.profile_id || source.verification.profile_digest !== start.verification.capability_binding?.profile_digest))
    throw Error("Recovery validation source lost its actual new author, baseline or final verifier binding");
  if (source.outcome === "verified") inspectImportedValidationVerificationV1(origin, source.verification);
  return source;
}
export function inspectImportedRecoveryValidationSourceV1(originInput: unknown, checkpointInput: unknown, input: unknown,
  researchBytes: Uint8Array, sha: SourceOperationSha): ImportedRecoveryValidationSourceV1 {
  const origin = inspectImportedValidationOriginV1(originInput, researchBytes, sha), checkpoint = ProductSourceRecoveryCheckpointV1Schema.parse(checkpointInput);
  return inspectSource(origin, checkpoint, ImportedRecoveryValidationSourceV1Schema.parse(input), sha);
}
export const ImportedRecoveryValidationRequestV1Schema = z.object({
  version: z.literal(1), validation_id: id, root_validation_id: id, generation: integer, kind: z.enum(["initial", "repair"]),
  recovery_id: id, origin: ImportedValidationOriginV1Schema, checkpoint: ProductSourceRecoveryCheckpointV1Schema,
  previous_source: ImportedRecoveryValidationSourceV1Schema.optional(),
  predecessor: ImportedRecoveryValidationContextV1Schema.shape.predecessor,
  authorization: ImportedValidationAuthorizationV1Schema, writer: agent, run_start: ImportedRecoveryRunStartV1Schema,
}).strict().superRefine((value, ctx) => {
  const prior = value.previous_source, start = value.run_start, previousStart = prior?.run_start ?? value.origin.implementation_source.run_start;
  if (value.recovery_id !== value.checkpoint.recovery_id || value.authorization.goal_id !== start.context_pack.payload.goal_context?.goal_id
    || start.agent_instance_id !== value.writer.instance_id
    || start.run_id === previousStart.run_id || start.context_pack.id === previousStart.context_pack.id || start.verification.request_id === previousStart.verification.request_id
    || start.task_id === value.origin.implementation_source.run_start.task_id || value.authorization.event_id === value.origin.acceptance_event_id
    || (value.kind === "initial" ? prior !== undefined || value.predecessor !== undefined || value.generation !== 0 || value.root_validation_id !== value.validation_id
      : !prior || !value.predecessor || prior.recovery_id !== value.recovery_id || value.generation !== prior.generation + 1
        || value.root_validation_id !== prior.root_validation_id || value.validation_id === prior.validation_id
        || start.run_id === prior.run_start.run_id || start.context_pack.id === prior.run_start.context_pack.id
        || start.verification.request_id === prior.run_start.verification.request_id || start.task_id !== prior.run_start.task_id
        || canonical(value.writer) !== canonical(prior.author) || canonical(start.context_pack.payload.task) !== canonical(prior.run_start.context_pack.payload.task)
        || canonical(start.context_pack.payload.goal_context) !== canonical(prior.run_start.context_pack.payload.goal_context)
        || value.authorization.event_id === prior.run_start.context_pack.payload.imported_recovery_validation?.authorization_event_id
        || value.authorization.attempt_index <= (prior.run_start.context_pack.payload.imported_recovery_validation?.attempt_index ?? -1)
        || (value.predecessor.kind === "failure" ? prior.outcome !== "closed-failure" || value.predecessor.validation_id !== prior.validation_id
          || value.predecessor.request_digest !== prior.request_digest || value.predecessor.result_digest !== prior.result_digest : prior.outcome !== "verified")))
    ctx.addIssue({ code: "custom", message: "Recovery validation requires a fresh original-goal attempt and an exact finite predecessor" });
});
export type ImportedRecoveryValidationRequestV1 = z.infer<typeof ImportedRecoveryValidationRequestV1Schema>;
export function importedRecoveryValidationContextV1(value: Omit<ImportedRecoveryValidationRequestV1, "version" | "writer" | "run_start">, sha: SourceOperationSha) {
  return ImportedRecoveryValidationContextV1Schema.parse({ version: 1, recovery_id: value.recovery_id,
    checkpoint_digest: productSourceRecoveryCheckpointDigestV1(value.checkpoint, sha), epoch_id: value.checkpoint.new_epoch_id,
    validation_id: value.validation_id, root_validation_id: value.root_validation_id, generation: value.generation, kind: value.kind,
    origin_digest: importedValidationOriginDigestV1(value.origin, sha), initial_subject_digest: value.previous_source?.subject_digest ?? value.checkpoint.subject_digest,
    authorization_event_id: value.authorization.event_id, attempt_index: value.authorization.attempt_index,
    ...(value.predecessor ? { predecessor: value.predecessor } : {}) });
}
export function importedRecoveryValidationRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedRecoveryValidationRequestV1Schema.parse(input))));
}
export function inspectImportedRecoveryValidationRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = ImportedRecoveryValidationRequestV1Schema.parse(input), origin = inspectImportedValidationOriginV1(request.origin, researchBytes, sha);
  inspectImportedRecoveryValidationAuthorStartV1(origin, request.checkpoint, request.run_start, sha);
  if (request.previous_source) inspectSource(origin, request.checkpoint, request.previous_source, sha);
  if (canonical(request.run_start.context_pack.payload.imported_recovery_validation) !== canonical(importedRecoveryValidationContextV1(request, sha)))
    throw Error("Recovery author context changed its exact checkpoint, predecessor or new authorization");
  return request;
}
export const ImportedRecoveryValidationControlV1Schema = z.object({ version: z.literal(1), validation_id: id, request_digest: digest, run_id: id }).strict();
export type ImportedRecoveryValidationControlV1 = z.infer<typeof ImportedRecoveryValidationControlV1Schema>;
const control = { version: z.literal(1), validation_id: id, request_digest: digest, run_id: id };
const completed = { ...control, recovery_id: id, checkpoint_digest: digest, root_validation_id: id, generation: integer,
  origin_digest: digest, author: agent, run_start_digest: digest, initial_subject_digest: digest, subject_digest: digest,
  authorization_event_id: id, attempt_index: integer, baseline: ImportedValidationBaselineV1Schema,
  closure: z.literal("windows-job-and-tools-closed.v1") };
export const ImportedRecoveryCompletedValidationV1Schema = z.object({ ...completed, stage: z.literal("validation"),
  scope: z.literal("all-declared-workspace-validation-cases"), verification: RunVerificationPayloadSchema }).strict();
export type ImportedRecoveryCompletedValidationV1 = z.infer<typeof ImportedRecoveryCompletedValidationV1Schema>;
export const ImportedRecoveryClosedValidationFailureV1Schema = z.object({ ...completed,
  failure_kind: z.enum(["author-failed", "verification-failed"]), reason, verification: RunVerificationPayloadSchema.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined)
      ctx.addIssue({ code: "custom", message: "Recovery failure cannot borrow an unbound or passed verifier" });
  });
export const ImportedRecoveryValidationResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("finished"), closed: z.literal(true), verified_validation: ImportedRecoveryCompletedValidationV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("failed"), closed: z.literal(true), reason, closed_failure: ImportedRecoveryClosedValidationFailureV1Schema.optional() }).strict(),
  z.object({ ...control, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...control, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
]);
export type ImportedRecoveryClosedValidationFailureV1 = z.infer<typeof ImportedRecoveryClosedValidationFailureV1Schema>;
export type ImportedRecoveryValidationResultV1 = z.infer<typeof ImportedRecoveryValidationResultV1Schema>;
export function inspectImportedRecoveryValidationCompletionV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = inspectImportedRecoveryValidationRequestV1(requestInput, researchBytes, sha), result = ImportedRecoveryValidationResultV1Schema.parse(input);
  const requestDigest = digest.parse(sha(canonical(request))), resultDigest = digest.parse(sha(canonical(result)));
  if (result.validation_id !== request.validation_id || result.request_digest !== requestDigest || result.run_id !== request.run_start.run_id)
    throw Error("Recovery validation result changed its exact new request");
  const completion = result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined;
  if (!completion) return { request, result, requestDigest, resultDigest, completion: undefined, source: undefined, sourceDigest: undefined };
  if (completion.validation_id !== result.validation_id || completion.request_digest !== requestDigest || completion.run_id !== result.run_id
    || completion.recovery_id !== request.recovery_id || completion.checkpoint_digest !== productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha)
    || completion.root_validation_id !== request.root_validation_id || completion.generation !== request.generation
    || completion.origin_digest !== importedValidationOriginDigestV1(request.origin, sha) || canonical(completion.author) !== canonical(request.writer)
    || completion.run_start_digest !== sha(canonical(request.run_start)) || completion.initial_subject_digest !== (request.previous_source?.subject_digest ?? request.checkpoint.subject_digest)
    || completion.authorization_event_id !== request.authorization.event_id || completion.attempt_index !== request.authorization.attempt_index)
    throw Error("Recovery completion changed its current checkpoint, new author or original goal authorization");
  const source = inspectSource(request.origin, request.checkpoint, ImportedRecoveryValidationSourceV1Schema.parse({
    version: 1, kind: "recovery-validation", outcome: result.outcome === "finished" ? "verified" : "closed-failure",
    recovery_id: request.recovery_id, checkpoint_digest: completion.checkpoint_digest, validation_id: request.validation_id,
    root_validation_id: request.root_validation_id, generation: request.generation, request_digest: requestDigest, result_digest: resultDigest,
    origin_digest: completion.origin_digest, author: request.writer, run_start: request.run_start,
    initial_subject_digest: completion.initial_subject_digest, subject_digest: completion.subject_digest, baseline: completion.baseline,
    ...(completion.verification ? { verification: completion.verification } : {}),
    ...("failure_kind" in completion ? { failure_kind: completion.failure_kind, failure_reason: completion.reason } : {}),
  }), sha);
  return { request, result, requestDigest, resultDigest, completion, source, sourceDigest: importedRecoveryValidationSourceDigestV1(source, sha) };
}
export function inspectImportedRecoveryValidationResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectImportedRecoveryValidationCompletionV1(requestInput, input, researchBytes, sha).result;
}
