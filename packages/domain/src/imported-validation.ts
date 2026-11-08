import { z } from "zod";
import { RunVerificationPayloadSchema, type RunVerificationPayload } from "./autonomy.js";
import { ImportedExecutionRequestV1Schema, importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ImportedImplementationSourceV1Schema, ImportedImplementationRunStartV1Schema, inspectImportedImplementationSourceV1,
  type ImportedImplementationRunStartV1 } from "./imported-implementation-source.js";
import { ImportedValidationContextV1Schema, ImportedValidationPredecessorV1Schema } from "./imported-validation-context.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), reason = z.string().trim().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_VALIDATION_FEATURE_V1 = "imported-validation.v1";
export const ImportedValidationAuthorizationV1Schema = z.object({ event_id: id, goal_id: id, attempt_index: z.number().int().nonnegative() }).strict();
export const ImportedValidationOriginV1Schema = z.object({ version: z.literal(1), review_id: id, request_digest: digest, result_digest: digest,
  acceptance_event_id: id, execution_request: ImportedExecutionRequestV1Schema, implementation_source: ImportedImplementationSourceV1Schema }).strict();
export type ImportedValidationOriginV1 = z.infer<typeof ImportedValidationOriginV1Schema>;
export function importedValidationOriginDigestV1(input: unknown, sha: SourceOperationSha) { return digest.parse(sha(canonical(ImportedValidationOriginV1Schema.parse(input)))); }
const relativeFile = z.string().min(1).max(4096).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.includes(":")
  && value.split("/").every(part => part && part !== "." && part !== ".."));
export const ImportedValidationBaselineV1Schema = z.object({ version: z.literal(1), snapshot_id: id, subject_digest: digest, manifest_digest: digest,
  directories: z.array(relativeFile).min(2).max(10000),
  files: z.array(z.object({ path: relativeFile, checksum: digest, size: z.number().int().nonnegative().max(16 * 1024 * 1024),
    reference: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/) }).strict()).min(1).max(10000) }).strict().superRefine((value, ctx) => {
  if (new Set(value.directories).size !== value.directories.length || new Set([...value.directories, ...value.files.map(file => file.path)]).size !== value.directories.length + value.files.length
    || new Set(value.files.map(file => file.reference)).size !== value.files.length
    || value.files.reduce((total, file) => total + file.size, 0) > 64 * 1024 * 1024)
    ctx.addIssue({ code: "custom", message: "Validation baseline must be a bounded unique real source manifest" });
});
export type ImportedValidationBaselineV1 = z.infer<typeof ImportedValidationBaselineV1Schema>;
export const ImportedValidationSourceV1Schema = z.object({ version: z.literal(1), kind: z.literal("validation"), outcome: z.enum(["verified", "closed-failure"]),
  validation_id: id, root_validation_id: id, generation: z.number().int().nonnegative(), request_digest: digest, result_digest: digest, origin_digest: digest,
  author: agent, run_start: ImportedImplementationRunStartV1Schema, initial_subject_digest: digest, subject_digest: digest,
  baseline: ImportedValidationBaselineV1Schema, verification: RunVerificationPayloadSchema.optional(),
  failure_kind: z.enum(["author-failed", "verification-failed"]).optional(), failure_reason: reason.optional() }).strict().superRefine((value, ctx) => {
  if (value.outcome === "verified" ? !value.verification || value.verification.outcome !== "passed" || value.failure_kind !== undefined || value.failure_reason !== undefined
    : !value.failure_kind || !value.failure_reason || (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined))
    ctx.addIssue({ code: "custom", message: "Validation source must distinguish independently verified completion from typed closed failure" });
});
export type ImportedValidationSourceV1 = z.infer<typeof ImportedValidationSourceV1Schema>;
export function importedValidationSourceDigestV1(input: unknown, sha: SourceOperationSha) { return digest.parse(sha(canonical(ImportedValidationSourceV1Schema.parse(input)))); }
export function inspectImportedValidationOriginV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectParsedValidationOrigin(ImportedValidationOriginV1Schema.parse(input), researchBytes, sha);
}
// Private parsed helpers are used only within the caller's synchronous inspection. They never cache authorization or input bytes.
function inspectParsedValidationOrigin(origin: ImportedValidationOriginV1, researchBytes: Uint8Array, sha: SourceOperationSha) {
  inspectImportedImplementationSourceV1(origin.execution_request, origin.implementation_source, researchBytes, sha); return origin;
}
export function inspectImportedValidationVerificationV1(origin: ImportedValidationOriginV1, input: unknown): RunVerificationPayload {
  return inspectParsedValidationVerification(origin, RunVerificationPayloadSchema.parse(input));
}
function inspectParsedValidationVerification(origin: ImportedValidationOriginV1, value: RunVerificationPayload): RunVerificationPayload {
  const prior = origin.implementation_source.verification;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const cases = (check: RunVerificationPayload["checks"][number]) => check.observation?.version === 3
    ? check.observation.cases.map(item => canonical({ case_id: item.case_id, viewport: item.viewport, program_digest: item.program_digest })).sort() : [];
  if (value.outcome !== "passed" || !value.subject_digest || value.profile_id !== destination.profile_id || value.profile_digest !== destination.capabilities.profile_digest
    || value.product_design_revision || value.measurement_plan?.version !== 2 || value.measurement_plan.scope !== "final"
    || canonical(value.measurement_plan) !== canonical(prior.measurement_plan)
    || canonical(value.checks.map(check => check.id).sort()) !== canonical(prior.checks.map(check => check.id).sort())
    || new Set(value.checks.map(check => check.id)).size !== value.checks.length || !value.checks.length
    || value.checks.some(check => { const old = prior.checks.find(item => item.id === check.id), bound = destination.capabilities.checks.find(item => item.command_id === check.id), actual = cases(check);
      return !old || !bound || !actual.length || new Set(actual).size !== actual.length || canonical(actual) !== canonical(cases(old))
        || check.exit_code !== 0 || check.observation?.version !== 3 || check.observation.stage !== "validation" || check.observation.scope !== "final"
        || !check.observation.evidence_bundle || check.observation.capability_binding?.config_digest !== bound.config_digest
        || check.observation.capability_binding?.contract_digest !== bound.contract_digest; })
    || importedExecutionAcceptedInputsV1(origin.execution_request).files.some(pin => !value.required_files.some(file => file.path === pin.path && file.checksum === pin.checksum && file.size === pin.size))
    || [".artoo/product/implementation.md", ".artoo/product/validation.json"].some(path => !value.required_files.some(file => file.path === path && file.size > 0)))
    throw Error("Validation final evidence must cover the complete unchanged accepted programs and pinned inputs over the final product");
  return value;
}
function ordinaryDescriptors(start: ImportedImplementationRunStartV1) {
  const context = start.context_pack.payload;
  return context.imported_clean_validation || context.imported_clean_validation_review_subject || context.imported_recovery_validation || context.imported_recovery_validation_review_subject
    || context.imported_execution || context.imported_execution_repair || context.imported_execution_review_subject || context.imported_design_review_subject
    || context.imported_review_subject || context.review_subject || context.product_design_revision;
}
export function inspectImportedValidationAuthorStartV1(origin: ImportedValidationOriginV1, start: ImportedImplementationRunStartV1) {
  const context = start.context_pack.payload, original = origin.execution_request.run_start;
  // The first validation task owns a different accepted spec reference. Server binds that
  // reference to its immutable task record; every other goal/plan field stays fixed here.
  const originalGoal = original.context_pack.payload.goal_context;
  const comparableGoal = context.goal_context?.plan && originalGoal?.plan
    ? { ...context.goal_context, plan: { ...context.goal_context.plan, spec_ref: originalGoal.plan.spec_ref } } : context.goal_context;
  if (ordinaryDescriptors(start) || context.imported_validation_review_subject || !context.imported_validation || start.runtime === "mock"
    || start.workspace.branch != null || start.workspace_allocation || context.task.id !== start.task_id || context.product_development?.stage !== "validation"
    || context.policy.execution_mode !== undefined || start.workspace.root !== original.workspace.root || context.workspace.root !== original.workspace.root
    || canonical(context.project) !== canonical(original.context_pack.payload.project) || canonical(comparableGoal) !== canonical(originalGoal)
    || canonical(context.transferred_product_input) !== canonical(original.context_pack.payload.transferred_product_input)
    || canonical(context.product_development.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(origin.execution_request))
    || canonical(context.verification_capabilities) !== canonical(original.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(original.context_pack.payload.release_capabilities)
    || canonical(context.policy) !== canonical(original.context_pack.payload.policy) || canonical(start.policy_snapshot) !== canonical(original.policy_snapshot)
    || start.verification.expected_subject_digest !== undefined
    || canonical({ ...start.verification, request_id: original.verification!.request_id }) !== canonical(original.verification))
    throw Error("Validation author requires its exclusive stage, fixed imported inputs, original policy and exact destination configuration");
}
export function inspectImportedValidationSourceV1(originInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const origin = inspectImportedValidationOriginV1(originInput, researchBytes, sha), originDigest = digest.parse(sha(canonical(origin)));
  return inspectParsedValidationSource(origin, originDigest, ImportedValidationSourceV1Schema.parse(input), sha);
}
function inspectParsedValidationSource(origin: ImportedValidationOriginV1, originDigest: string, source: ImportedValidationSourceV1, sha: SourceOperationSha) {
  const start = source.run_start;
  inspectImportedValidationAuthorStartV1(origin, start); const descriptor = start.context_pack.payload.imported_validation!;
  if (source.origin_digest !== originDigest || source.origin_digest !== descriptor.origin_digest
    || source.validation_id !== descriptor.validation_id || source.root_validation_id !== descriptor.root_validation_id || source.generation !== descriptor.generation
    || start.agent_instance_id !== source.author.instance_id || source.initial_subject_digest !== descriptor.initial_subject_digest
    || source.baseline.subject_digest !== source.initial_subject_digest
    || source.baseline.manifest_digest !== sha(canonical({ directories: source.baseline.directories, files: source.baseline.files }))
    || source.verification && (source.verification.request_id !== start.verification.request_id || source.verification.subject_digest !== source.subject_digest
      || source.verification.profile_id !== start.verification.profile_id || source.verification.profile_digest !== start.verification.capability_binding?.profile_digest))
    throw Error("Validation source differs from its exact author, original baseline, origin or final verification");
  if (source.outcome === "verified") inspectParsedValidationVerification(origin, source.verification!);
  return source;
}
export const ImportedValidationRequestV1Schema = z.object({ version: z.literal(1), validation_id: id, root_validation_id: id,
  generation: z.number().int().nonnegative(), kind: z.enum(["initial", "repair"]), origin: ImportedValidationOriginV1Schema,
  source: z.union([ImportedImplementationSourceV1Schema, ImportedValidationSourceV1Schema]), predecessor: ImportedValidationPredecessorV1Schema.optional(),
  authorization: ImportedValidationAuthorizationV1Schema, writer: agent, run_start: ImportedImplementationRunStartV1Schema }).strict().superRefine((value, ctx) => {
  const start = value.run_start, prior = value.source.run_start;
  if (value.kind === "initial" ? value.root_validation_id !== value.validation_id || value.generation !== 0 || value.predecessor !== undefined
    || value.source.kind === "validation" || canonical(value.source) !== canonical(value.origin.implementation_source)
    : value.source.kind !== "validation" || !value.predecessor || value.root_validation_id !== value.source.root_validation_id
      || value.generation !== value.source.generation + 1 || value.validation_id === value.source.validation_id
      || (value.predecessor.kind === "review" ? value.source.outcome !== "verified" : value.source.outcome !== "closed-failure"
        || canonical(value.predecessor.validation) !== canonical({ validation_id: value.source.validation_id, request_digest: value.source.request_digest, result_digest: value.source.result_digest }))
      || value.authorization.attempt_index <= (prior.context_pack.payload.imported_validation?.attempt_index ?? -1)
      || canonical(value.writer) !== canonical(value.source.author) || start.task_id !== prior.task_id
      || canonical(start.context_pack.payload.goal_context) !== canonical(prior.context_pack.payload.goal_context)
      || canonical(start.context_pack.payload.task) !== canonical(prior.context_pack.payload.task))
    ctx.addIssue({ code: "custom", message: "Validation requires one initial claim or an exact typed predecessor with a new original-goal repair authorization" });
  if (start.run_id === prior.run_id || start.context_pack.id === prior.context_pack.id || start.verification.request_id === prior.verification.request_id
    || value.authorization.event_id === value.origin.acceptance_event_id || value.authorization.event_id === prior.context_pack.payload.imported_validation?.authorization_event_id
    || start.agent_instance_id !== value.writer.instance_id || start.context_pack.payload.goal_context?.goal_id !== value.authorization.goal_id)
    ctx.addIssue({ code: "custom", message: "Validation run, context and final verifier must be fresh and bound to the authorized writer and original goal" });
});
export type ImportedValidationRequestV1 = z.infer<typeof ImportedValidationRequestV1Schema>;
export function importedValidationContextV1(value: Pick<ImportedValidationRequestV1, "validation_id" | "root_validation_id" | "generation" | "kind" | "origin" | "source" | "authorization" | "predecessor">, sha: SourceOperationSha) {
  return validationContextWithOriginDigest(value, importedValidationOriginDigestV1(value.origin, sha));
}
function validationContextWithOriginDigest(value: Pick<ImportedValidationRequestV1, "validation_id" | "root_validation_id" | "generation" | "kind" | "origin" | "source" | "authorization" | "predecessor">, originDigest: string) {
  return ImportedValidationContextV1Schema.parse({ version: 1, validation_id: value.validation_id, root_validation_id: value.root_validation_id,
    generation: value.generation, kind: value.kind, origin_digest: originDigest, initial_subject_digest: value.source.subject_digest,
    authorization_event_id: value.authorization.event_id, attempt_index: value.authorization.attempt_index, ...(value.predecessor ? { predecessor: value.predecessor } : {}) });
}
export function importedValidationRequestDigestV1(input: unknown, sha: SourceOperationSha) { return digest.parse(sha(canonical(ImportedValidationRequestV1Schema.parse(input)))); }
export function inspectImportedValidationRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectValidationRequestFrame(input, researchBytes, sha).request;
}
function inspectValidationRequestFrame(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = ImportedValidationRequestV1Schema.parse(input), origin = inspectParsedValidationOrigin(request.origin, researchBytes, sha);
  const originDigest = digest.parse(sha(canonical(origin)));
  if (request.source.kind === "validation") inspectParsedValidationSource(origin, originDigest, request.source, sha);
  inspectImportedValidationAuthorStartV1(origin, request.run_start);
  if (canonical(request.run_start.context_pack.payload.imported_validation) !== canonical(validationContextWithOriginDigest(request, originDigest))) throw Error("Validation context differs from its exact one-use authorization and initial source");
  return { request, origin, originDigest };
}
export const ImportedValidationControlV1Schema = z.object({ version: z.literal(1), validation_id: id, request_digest: digest, run_id: id }).strict();
export type ImportedValidationControlV1 = z.infer<typeof ImportedValidationControlV1Schema>;
const completed = { version: z.literal(1), validation_id: id, request_digest: digest, run_id: id, root_validation_id: id,
  generation: z.number().int().nonnegative(), origin_digest: digest, author: agent, run_start_digest: digest,
  destination: z.object({ node_id: id, workspace_root: z.string().min(1).max(4096), profile_id: id, profile_digest: digest }).strict(),
  initial_subject_digest: digest, subject_digest: digest, authorization_event_id: id, attempt_index: z.number().int().nonnegative(),
  baseline: ImportedValidationBaselineV1Schema, closure: z.literal("windows-job-and-tools-closed.v1") };
export const ImportedCompletedValidationV1Schema = z.object({ ...completed, stage: z.literal("validation"),
  scope: z.literal("all-declared-workspace-validation-cases"), verification: RunVerificationPayloadSchema }).strict();
export type ImportedCompletedValidationV1 = z.infer<typeof ImportedCompletedValidationV1Schema>;
export const ImportedClosedValidationFailureV1Schema = z.object({ ...completed, failure_kind: z.enum(["author-failed", "verification-failed"]),
  reason, verification: RunVerificationPayloadSchema.optional() }).strict().superRefine((value, ctx) => {
  if (value.failure_kind === "verification-failed" ? value.verification?.outcome !== "failed" : value.verification !== undefined)
    ctx.addIssue({ code: "custom", message: "Closed validation failure cannot borrow a passed or unbound verifier" });
});
export type ImportedClosedValidationFailureV1 = z.infer<typeof ImportedClosedValidationFailureV1Schema>;
const control = { version: z.literal(1), validation_id: id, request_digest: digest, run_id: id };
export const ImportedValidationResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("finished"), closed: z.literal(true), verified_validation: ImportedCompletedValidationV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("failed"), closed: z.literal(true), reason, closed_failure: ImportedClosedValidationFailureV1Schema.optional() }).strict(),
  z.object({ ...control, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...control, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
]);
export type ImportedValidationResultV1 = z.infer<typeof ImportedValidationResultV1Schema>;
export interface ImportedValidationCompletionInspectionV1 {
  request: ImportedValidationRequestV1;
  result: ImportedValidationResultV1;
  requestDigest: string;
  resultDigest: string;
  originDigest: string;
  completion: ImportedCompletedValidationV1 | ImportedClosedValidationFailureV1 | undefined;
  source: ImportedValidationSourceV1 | undefined;
  sourceDigest: string | undefined;
}
export function inspectImportedValidationResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  return inspectImportedValidationCompletionV1(requestInput, input, researchBytes, sha).result;
}
/** Complete public consistency inspection only; live authorization, source ownership and committed execution evidence remain Server/Node checks. */
export function inspectImportedValidationCompletionV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedValidationCompletionInspectionV1 {
  const { request, origin, originDigest } = inspectValidationRequestFrame(requestInput, researchBytes, sha);
  const result = ImportedValidationResultV1Schema.parse(input), start = request.run_start, requestDigest = digest.parse(sha(canonical(request)));
  if (result.validation_id !== request.validation_id || result.request_digest !== requestDigest || result.run_id !== start.run_id) throw Error("Validation result changed its exact request");
  const value = result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined;
  const resultDigest = digest.parse(sha(canonical(result)));
  if (!value) return { request, result, requestDigest, resultDigest, originDigest, completion: undefined, source: undefined, sourceDigest: undefined };
  const destination = request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (value.validation_id !== result.validation_id || value.request_digest !== result.request_digest || value.run_id !== result.run_id
    || value.root_validation_id !== request.root_validation_id || value.generation !== request.generation || value.origin_digest !== originDigest
    || canonical(value.author) !== canonical(request.writer) || value.run_start_digest !== sha(canonical(start))
    || canonical(value.destination) !== canonical({ node_id: destination.node_id, workspace_root: destination.workspace_root, profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest })
    || value.initial_subject_digest !== request.source.subject_digest || value.authorization_event_id !== request.authorization.event_id || value.attempt_index !== request.authorization.attempt_index)
    throw Error("Validation completion changed its author, original authorization, destination or initial subject");
  const source = inspectParsedValidationSource(origin, originDigest, ImportedValidationSourceV1Schema.parse({ version: 1, kind: "validation", outcome: result.outcome === "finished" ? "verified" : "closed-failure",
    validation_id: result.validation_id, root_validation_id: request.root_validation_id, generation: request.generation, request_digest: result.request_digest,
    result_digest: resultDigest, origin_digest: value.origin_digest, author: request.writer, run_start: start,
    initial_subject_digest: value.initial_subject_digest, subject_digest: value.subject_digest, baseline: value.baseline,
    ...(value.verification ? { verification: value.verification } : {}),
    ...("failure_kind" in value ? { failure_kind: value.failure_kind, failure_reason: value.reason } : {}) }), sha);
  return { request, result, requestDigest, resultDigest, originDigest, completion: value, source, sourceDigest: digest.parse(sha(canonical(source))) };
}
