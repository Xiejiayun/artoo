import { z } from "zod";
import { ContextPackSchema } from "./context-pack.js";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { RunVerificationPayloadSchema, VerificationRequirementSchema } from "./autonomy.js";
import { type ImportedImplementationRunStartV1 } from "./imported-implementation-source.js";
import { ImportedValidationOriginV1Schema, ImportedValidationBaselineV1Schema, ImportedValidationAuthorizationV1Schema,
  inspectImportedValidationOriginV1, inspectImportedValidationVerificationV1, importedValidationOriginDigestV1,
  type ImportedValidationOriginV1 } from "./imported-validation.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ImportedCleanValidationContextV1Schema } from "./clean-validation-context.js";
import { SourceCleanValidationOriginV1Schema, sourceCleanValidationOriginDigestV1, inspectSourceCleanValidationOriginV1,
  type SourceCleanValidationOriginV1 } from "./source-clean-validation-origin.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(2147483647), reason = z.string().trim().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_CLEAN_VALIDATION_FEATURE_V1 = "imported-clean-validation.v1";
export type ImportedCleanRunStartV1 = ImportedImplementationRunStartV1;
export const ImportedCleanRunStartV1Schema: z.ZodType<ImportedCleanRunStartV1> = RunStartPayloadSchema.extend({
  context_pack: z.object({ id, payload: ContextPackSchema }).strict(), verification: VerificationRequirementSchema,
});
export const ImportedCleanValidationSourceV1Schema = z.object({
  version: z.literal(1), kind: z.literal("clean-validation"), outcome: z.enum(["verified", "closed-failure"]),
  clean_generation_id: id, restart_digest: digest, validation_id: id, root_validation_id: id, generation: integer,
  request_digest: digest, result_digest: digest, origin_digest: digest, author: agent,
  run_start: ImportedCleanRunStartV1Schema, initial_subject_digest: digest, subject_digest: digest,
  baseline: ImportedValidationBaselineV1Schema, verification: RunVerificationPayloadSchema.optional(),
  failure_kind: z.enum(["author-failed", "verification-failed"]).optional(), failure_reason: reason.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "verified" ? !value.verification || value.verification.outcome !== "passed" || value.failure_kind !== undefined || value.failure_reason !== undefined
    : !value.failure_kind || !value.failure_reason || (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined))
    ctx.addIssue({ code: "custom", message: "Clean restarted validation source requires this new author's measured completion or typed closed failure" });
});
export type ImportedCleanValidationSourceV1 = z.infer<typeof ImportedCleanValidationSourceV1Schema>;
export function importedCleanValidationSourceDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedCleanValidationSourceV1Schema.parse(input))));
}
function otherDescriptors(start: ImportedCleanRunStartV1) {
  const context = start.context_pack.payload;
  return context.imported_validation || context.imported_validation_review_subject || context.imported_execution || context.imported_execution_repair
    || context.imported_execution_review_subject || context.imported_design_review_subject || context.imported_review_subject
    || context.review_subject || context.product_design_revision || context.imported_recovery_validation || context.imported_recovery_validation_review_subject;
}
export function inspectImportedCleanValidationAuthorStartV1(origin: ImportedValidationOriginV1, restart: SourceCleanValidationOriginV1,
  start: ImportedCleanRunStartV1, sha: SourceOperationSha): void {
  inspectSourceCleanValidationOriginV1(restart, sha);
  if (canonical(restart.grant.origin) !== canonical(origin)) throw Error("Clean validation changed its Server-committed accepted product origin");
  const context = start.context_pack.payload, original = origin.execution_request.run_start, prior = original.context_pack.payload;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const descriptor = context.imported_clean_validation, comparableGoal = context.goal_context?.plan && prior.goal_context?.plan
    ? { ...context.goal_context, plan: { ...context.goal_context.plan, spec_ref: prior.goal_context.plan.spec_ref } } : context.goal_context;
  if (otherDescriptors(start) || context.imported_clean_validation_review_subject || !descriptor || start.runtime === "mock"
    || start.workspace.branch != null || start.workspace_allocation || context.task.id !== start.task_id || context.product_development?.stage !== "validation"
    || context.policy.execution_mode !== undefined || start.workspace.root !== original.workspace.root || context.workspace.root !== original.workspace.root
    || restart.checkpoint.lifecycle_registration.registration.binding.workspace_root !== original.workspace.root || restart.checkpoint.lifecycle_registration.registration.binding.node_id !== destination.node_id || descriptor.clean_generation_id !== restart.generation_id
    || descriptor.restart_digest !== sourceCleanValidationOriginDigestV1(restart, sha) || descriptor.epoch_id !== restart.checkpoint.lifecycle_registration.registration.epoch.epoch_id
    || canonical(context.project) !== canonical(prior.project) || canonical(comparableGoal) !== canonical(prior.goal_context)
    || canonical(context.transferred_product_input) !== canonical(prior.transferred_product_input)
    || canonical(context.product_development.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(origin.execution_request))
    || canonical(restart.checkpoint.accepted_inputs) !== canonical(context.product_development.accepted_inputs)
    || canonical(context.verification_capabilities) !== canonical(prior.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(prior.release_capabilities)
    || canonical(context.policy) !== canonical(prior.policy) || canonical(start.policy_snapshot) !== canonical(original.policy_snapshot)
    || start.verification.expected_subject_digest !== undefined
    || canonical({ ...start.verification, request_id: original.verification!.request_id }) !== canonical(original.verification))
    throw Error("Clean validation author changed its fresh restart, fixed accepted inputs or original goal policy");
}
function inspectSource(origin: ImportedValidationOriginV1, restart: SourceCleanValidationOriginV1,
  source: ImportedCleanValidationSourceV1, sha: SourceOperationSha): ImportedCleanValidationSourceV1 {
  const start = source.run_start;
  inspectImportedCleanValidationAuthorStartV1(origin, restart, start, sha);
  const descriptor = start.context_pack.payload.imported_clean_validation!;
  if (source.clean_generation_id !== restart.generation_id || source.restart_digest !== sourceCleanValidationOriginDigestV1(restart, sha)
    || source.origin_digest !== importedValidationOriginDigestV1(origin, sha) || source.origin_digest !== descriptor.origin_digest
    || source.validation_id !== descriptor.validation_id || source.root_validation_id !== descriptor.root_validation_id || source.generation !== descriptor.generation
    || start.agent_instance_id !== source.author.instance_id || source.initial_subject_digest !== descriptor.initial_subject_digest
    || source.baseline.subject_digest !== source.initial_subject_digest
    || source.baseline.manifest_digest !== sha(canonical({ directories: source.baseline.directories, files: source.baseline.files }))
    || source.verification && (source.verification.request_id !== start.verification.request_id || source.verification.subject_digest !== source.subject_digest
      || source.verification.profile_id !== start.verification.profile_id || source.verification.profile_digest !== start.verification.capability_binding?.profile_digest))
    throw Error("Clean validation source lost its actual new author, baseline or final verifier binding");
  if (source.outcome === "verified") inspectImportedValidationVerificationV1(origin, source.verification);
  return source;
}
export function inspectImportedCleanValidationSourceV1(originInput: unknown, checkpointInput: unknown, input: unknown,
  researchBytes: Uint8Array, sha: SourceOperationSha): ImportedCleanValidationSourceV1 {
  const origin = inspectImportedValidationOriginV1(originInput, researchBytes, sha), restart = SourceCleanValidationOriginV1Schema.parse(checkpointInput);
  return inspectSource(origin, restart, ImportedCleanValidationSourceV1Schema.parse(input), sha);
}
export const ImportedCleanValidationRequestV1Schema = z.object({
  version: z.literal(1), validation_id: id, root_validation_id: id, generation: integer, kind: z.enum(["initial", "repair"]),
  clean_generation_id: id, origin: ImportedValidationOriginV1Schema, restart: SourceCleanValidationOriginV1Schema,
  previous_source: ImportedCleanValidationSourceV1Schema.optional(),
  predecessor: ImportedCleanValidationContextV1Schema.shape.predecessor,
  authorization: ImportedValidationAuthorizationV1Schema, writer: agent, run_start: ImportedCleanRunStartV1Schema,
}).strict().superRefine((value, ctx) => {
  const prior = value.previous_source, start = value.run_start, previousStart = prior?.run_start ?? value.origin.implementation_source.run_start;
  if (value.clean_generation_id !== value.restart.generation_id || value.authorization.goal_id !== start.context_pack.payload.goal_context?.goal_id
    || start.agent_instance_id !== value.writer.instance_id
    || start.run_id === previousStart.run_id || start.context_pack.id === previousStart.context_pack.id || start.verification.request_id === previousStart.verification.request_id
    || start.task_id === value.origin.implementation_source.run_start.task_id || value.authorization.event_id === value.origin.acceptance_event_id
    || (value.kind === "initial" ? prior !== undefined || value.predecessor !== undefined || value.generation !== 0 || value.root_validation_id !== value.validation_id
      : !prior || !value.predecessor || prior.clean_generation_id !== value.clean_generation_id || value.generation !== prior.generation + 1
        || value.root_validation_id !== prior.root_validation_id || value.validation_id === prior.validation_id
        || start.run_id === prior.run_start.run_id || start.context_pack.id === prior.run_start.context_pack.id
        || start.verification.request_id === prior.run_start.verification.request_id || start.task_id !== prior.run_start.task_id
        || canonical(value.writer) !== canonical(prior.author) || canonical(start.context_pack.payload.task) !== canonical(prior.run_start.context_pack.payload.task)
        || canonical(start.context_pack.payload.goal_context) !== canonical(prior.run_start.context_pack.payload.goal_context)
        || value.authorization.event_id === prior.run_start.context_pack.payload.imported_clean_validation?.authorization_event_id
        || value.authorization.attempt_index <= (prior.run_start.context_pack.payload.imported_clean_validation?.attempt_index ?? -1)
        || (value.predecessor.kind === "failure" ? prior.outcome !== "closed-failure" || value.predecessor.validation_id !== prior.validation_id
          || value.predecessor.request_digest !== prior.request_digest || value.predecessor.result_digest !== prior.result_digest : prior.outcome !== "verified")))
    ctx.addIssue({ code: "custom", message: "Clean validation requires a fresh original-goal attempt and an exact finite predecessor" });
});
export type ImportedCleanValidationRequestV1 = z.infer<typeof ImportedCleanValidationRequestV1Schema>;
export function importedCleanValidationContextV1(value: Omit<ImportedCleanValidationRequestV1, "version" | "writer" | "run_start">, sha: SourceOperationSha) {
  return ImportedCleanValidationContextV1Schema.parse({ version: 1, clean_generation_id: value.clean_generation_id,
    restart_digest: sourceCleanValidationOriginDigestV1(value.restart, sha), epoch_id: value.restart.checkpoint.lifecycle_registration.registration.epoch.epoch_id,
    validation_id: value.validation_id, root_validation_id: value.root_validation_id, generation: value.generation, kind: value.kind,
    origin_digest: importedValidationOriginDigestV1(value.origin, sha), initial_subject_digest: value.previous_source?.subject_digest ?? value.restart.checkpoint.subject_digest,
    authorization_event_id: value.authorization.event_id, attempt_index: value.authorization.attempt_index,
    ...(value.predecessor ? { predecessor: value.predecessor } : {}) });
}
export function importedCleanValidationRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedCleanValidationRequestV1Schema.parse(input))));
}
export function inspectImportedCleanValidationRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = ImportedCleanValidationRequestV1Schema.parse(input), origin = inspectImportedValidationOriginV1(request.origin, researchBytes, sha);
  inspectImportedCleanValidationAuthorStartV1(origin, request.restart, request.run_start, sha);
  if (request.previous_source) inspectSource(origin, request.restart, request.previous_source, sha);
  if (canonical(request.run_start.context_pack.payload.imported_clean_validation) !== canonical(importedCleanValidationContextV1(request, sha)))
    throw Error("Clean author context changed its exact restart, predecessor or new authorization");
  return request;
}
export const ImportedCleanValidationControlV1Schema = z.object({ version: z.literal(1), validation_id: id, request_digest: digest, run_id: id }).strict();
export type ImportedCleanValidationControlV1 = z.infer<typeof ImportedCleanValidationControlV1Schema>;
const control = { version: z.literal(1), validation_id: id, request_digest: digest, run_id: id };
const completed = { ...control, clean_generation_id: id, restart_digest: digest, root_validation_id: id, generation: integer,
  origin_digest: digest, author: agent, run_start_digest: digest, initial_subject_digest: digest, subject_digest: digest,
  authorization_event_id: id, attempt_index: integer, baseline: ImportedValidationBaselineV1Schema,
  closure: z.literal("windows-job-and-tools-closed.v1") };
export const ImportedCleanCompletedValidationV1Schema = z.object({ ...completed, stage: z.literal("validation"),
  scope: z.literal("all-declared-workspace-validation-cases"), verification: RunVerificationPayloadSchema }).strict();
export type ImportedCleanCompletedValidationV1 = z.infer<typeof ImportedCleanCompletedValidationV1Schema>;
export const ImportedCleanClosedValidationFailureV1Schema = z.object({ ...completed,
  failure_kind: z.enum(["author-failed", "verification-failed"]), reason, verification: RunVerificationPayloadSchema.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined)
      ctx.addIssue({ code: "custom", message: "Clean failure cannot borrow an unbound or passed verifier" });
  });
export const ImportedCleanValidationResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("finished"), closed: z.literal(true), verified_validation: ImportedCleanCompletedValidationV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("failed"), closed: z.literal(true), reason, closed_failure: ImportedCleanClosedValidationFailureV1Schema.optional() }).strict(),
  z.object({ ...control, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...control, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
]);
export type ImportedCleanClosedValidationFailureV1 = z.infer<typeof ImportedCleanClosedValidationFailureV1Schema>;
export type ImportedCleanValidationResultV1 = z.infer<typeof ImportedCleanValidationResultV1Schema>;
export function inspectImportedCleanValidationCompletionV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = inspectImportedCleanValidationRequestV1(requestInput, researchBytes, sha), result = ImportedCleanValidationResultV1Schema.parse(input);
  const requestDigest = digest.parse(sha(canonical(request))), resultDigest = digest.parse(sha(canonical(result)));
  if (result.validation_id !== request.validation_id || result.request_digest !== requestDigest || result.run_id !== request.run_start.run_id)
    throw Error("Clean validation result changed its exact new request");
  const completion = result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined;
  if (!completion) return { request, result, requestDigest, resultDigest, completion: undefined, source: undefined, sourceDigest: undefined };
  if (completion.validation_id !== result.validation_id || completion.request_digest !== requestDigest || completion.run_id !== result.run_id
    || completion.clean_generation_id !== request.clean_generation_id || completion.restart_digest !== sourceCleanValidationOriginDigestV1(request.restart, sha)
    || completion.root_validation_id !== request.root_validation_id || completion.generation !== request.generation
    || completion.origin_digest !== importedValidationOriginDigestV1(request.origin, sha) || canonical(completion.author) !== canonical(request.writer)
    || completion.run_start_digest !== sha(canonical(request.run_start)) || completion.initial_subject_digest !== (request.previous_source?.subject_digest ?? request.restart.checkpoint.subject_digest)
    || completion.authorization_event_id !== request.authorization.event_id || completion.attempt_index !== request.authorization.attempt_index)
    throw Error("Clean completion changed its current restart, new author or original goal authorization");
  const source = inspectSource(request.origin, request.restart, ImportedCleanValidationSourceV1Schema.parse({
    version: 1, kind: "clean-validation", outcome: result.outcome === "finished" ? "verified" : "closed-failure",
    clean_generation_id: request.clean_generation_id, restart_digest: completion.restart_digest, validation_id: request.validation_id,
    root_validation_id: request.root_validation_id, generation: request.generation, request_digest: requestDigest, result_digest: resultDigest,
    origin_digest: completion.origin_digest, author: request.writer, run_start: request.run_start,
    initial_subject_digest: completion.initial_subject_digest, subject_digest: completion.subject_digest, baseline: completion.baseline,
    ...(completion.verification ? { verification: completion.verification } : {}),
    ...("failure_kind" in completion ? { failure_kind: completion.failure_kind, failure_reason: completion.reason } : {}),
  }), sha);
  return { request, result, requestDigest, resultDigest, completion, source, sourceDigest: importedCleanValidationSourceDigestV1(source, sha) };
}
export function inspectImportedCleanValidationResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectImportedCleanValidationCompletionV1(requestInput, input, researchBytes, sha).result;
}
