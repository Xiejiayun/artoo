import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { ImportedImplementationRunStartV1Schema, type ImportedImplementationRunStartV1 } from "./imported-implementation-source.js";
import { ImportedValidationOriginV1Schema, ImportedValidationSourceV1Schema, ImportedValidationAuthorizationV1Schema,
  inspectImportedValidationSourceV1, inspectImportedValidationVerificationV1, importedValidationSourceDigestV1 } from "./imported-validation.js";
import { ImportedValidationReviewReferenceV1Schema, ImportedValidationReviewSubjectV1Schema } from "./imported-validation-context.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), reason = z.string().trim().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
function authorContext(start: ImportedImplementationRunStartV1) {
  const { imported_validation: _author, imported_validation_review_subject: _review, ...context } = start.context_pack.payload; return context;
}
function sameVerifier(source: ImportedImplementationRunStartV1, start: ImportedImplementationRunStartV1) {
  const context = authorContext(start), original = authorContext(source);
  return canonical({ ...start, run_id: source.run_id, verification: source.verification,
    policy_snapshot: { ...start.policy_snapshot, filesystem_write_scope: source.policy_snapshot.filesystem_write_scope },
    context_pack: { id: source.context_pack.id, payload: { ...context, policy: { ...context.policy, filesystem_write_scope: original.policy.filesystem_write_scope } } } })
      === canonical({ ...source, context_pack: { ...source.context_pack, payload: original } })
    && canonical({ ...start.verification, request_id: source.verification.request_id, expected_subject_digest: undefined }) === canonical(source.verification)
    && !context.policy.filesystem_write_scope.length && !start.policy_snapshot.filesystem_write_scope.length && context.policy.execution_mode === undefined;
}
export const ImportedValidationReviewRequestV1Schema = z.object({ version: z.literal(1), review_id: id,
  origin: ImportedValidationOriginV1Schema, source: ImportedValidationSourceV1Schema, authorization: ImportedValidationAuthorizationV1Schema,
  reviewer: agent, before_start: ImportedImplementationRunStartV1Schema, review_start: ImportedImplementationRunStartV1Schema,
  after_start: ImportedImplementationRunStartV1Schema, retry_of: ImportedValidationReviewReferenceV1Schema.optional() }).strict().superRefine((value, ctx) => {
  const source = value.source.run_start, starts = [value.before_start, value.review_start, value.after_start], start = value.review_start, context = start.context_pack.payload;
  if (value.source.outcome !== "verified" || value.reviewer.agent_id === value.source.author.agent_id || value.reviewer.instance_id === value.source.author.instance_id
    || value.authorization.goal_id !== source.context_pack.payload.goal_context?.goal_id
    || value.authorization.event_id === source.context_pack.payload.imported_validation?.authorization_event_id
    || value.authorization.attempt_index < (source.context_pack.payload.imported_validation?.attempt_index ?? 0)
    || value.retry_of?.review_id === value.review_id
    || new Set(starts.map(item => item.run_id)).size !== 3 || new Set(starts.map(item => item.context_pack.id)).size !== 3
    || new Set(starts.map(item => item.verification.request_id)).size !== 3
    || starts.some(item => item.run_id === source.run_id || item.context_pack.id === source.context_pack.id
      || item.verification.request_id === source.verification.request_id || item.verification.expected_subject_digest !== value.source.subject_digest
      || item.workspace.root !== source.workspace.root || item.workspace.branch != null || item.workspace_allocation || item.runtime === "mock"
      || item.context_pack.payload.imported_validation || item.context_pack.payload.imported_execution || item.context_pack.payload.imported_execution_repair
      || item.context_pack.payload.imported_execution_review_subject || item.context_pack.payload.imported_design_review_subject || item.context_pack.payload.imported_review_subject
      || item.context_pack.payload.review_subject || item.context_pack.payload.product_design_revision
      || item.context_pack.payload.imported_clean_validation || item.context_pack.payload.imported_clean_validation_review_subject || item.context_pack.payload.imported_recovery_validation || item.context_pack.payload.imported_recovery_validation_review_subject)
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
    ctx.addIssue({ code: "custom", message: "Validation review requires complete independent read-only phases over the actual final product and retained baseline" });
});
export type ImportedValidationReviewRequestV1 = z.infer<typeof ImportedValidationReviewRequestV1Schema>;
function reviewSubjectFromParsed(value: Pick<ImportedValidationReviewRequestV1, "review_id" | "source" | "authorization">, sourceDigest: string) {
  return ImportedValidationReviewSubjectV1Schema.parse({ version: 1, review_id: value.review_id, validation_id: value.source.validation_id,
    root_validation_id: value.source.root_validation_id, source_digest: sourceDigest, subject_digest: value.source.subject_digest,
    baseline_digest: value.source.baseline.manifest_digest, authorization_event_id: value.authorization.event_id, attempt_index: value.authorization.attempt_index });
}
export function importedValidationReviewSubjectV1(value: Pick<ImportedValidationReviewRequestV1, "review_id" | "source" | "authorization">, sha: SourceOperationSha) {
  return reviewSubjectFromParsed(value, importedValidationSourceDigestV1(value.source, sha));
}
export function importedValidationReviewRequestDigestV1(input: unknown, sha: SourceOperationSha) { return digest.parse(sha(canonical(ImportedValidationReviewRequestV1Schema.parse(input)))); }
// Every entry fully validates unknown inputs. Parsed values and their hashes live only within this synchronous invocation.
function inspectReviewRequestWithDigests(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha):
  { request: ImportedValidationReviewRequestV1; requestDigest: string; sourceDigest: string } {
  const request = ImportedValidationReviewRequestV1Schema.parse(input);
  const source = inspectImportedValidationSourceV1(request.origin, request.source, researchBytes, sha);
  const sourceDigest = digest.parse(sha(canonical(source))), requestDigest = digest.parse(sha(canonical(request)));
  const expected = reviewSubjectFromParsed(request, sourceDigest);
  for (const start of [request.before_start, request.review_start, request.after_start])
    if (canonical(start.context_pack.payload.imported_validation_review_subject) !== canonical(expected)) throw Error("Validation review phase descriptor changed its source, baseline or authorization");
  return { request, requestDigest, sourceDigest };
}
export function inspectImportedValidationReviewRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedValidationReviewRequestV1 {
  return inspectReviewRequestWithDigests(input, researchBytes, sha).request;
}
export const ImportedValidationReviewControlV1Schema = z.object({ version: z.literal(1), review_id: id, request_digest: digest }).strict();
export type ImportedValidationReviewControlV1 = z.infer<typeof ImportedValidationReviewControlV1Schema>;
export const ImportedValidationReviewVerdictV1Schema = z.object({ version: z.literal(1), review_id: id, validation_id: id,
  source_digest: digest, subject_digest: digest, outcome: z.enum(["accepted", "rejected"]), summary: z.string().trim().min(1).max(12000),
  findings: z.array(z.object({ severity: z.enum(["blocking", "nonblocking"]), description: z.string().trim().min(1).max(4000), file: z.string().max(4096).optional() }).strict()).max(100)
}).strict().superRefine((value, ctx) => {
  if ((value.outcome === "rejected") !== value.findings.some(item => item.severity === "blocking"))
    ctx.addIssue({ code: "custom", message: "Rejected product validation review requires a blocking finding; accepted review cannot retain one" });
});
export type ImportedValidationReviewVerdictV1 = z.infer<typeof ImportedValidationReviewVerdictV1Schema>;
const control = { version: z.literal(1), review_id: id, request_digest: digest, execution_authorized: z.literal(false) };
const measurement = z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1"),
  scope: z.literal("all-declared-workspace-validation-cases"), verification: RunVerificationPayloadSchema }).strict();
export const ImportedValidationReviewResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("reviewed"), closed: z.literal(true), before: measurement, after: measurement,
    reviewer: z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1") }).strict(), verdict: ImportedValidationReviewVerdictV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...control, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...control, outcome: z.literal("cancelled_before_start"), closed: z.literal(true), reason }).strict(),
]);
export type ImportedValidationReviewResultV1 = z.infer<typeof ImportedValidationReviewResultV1Schema>;
export interface ImportedValidationReviewCompletionInspectionV1 {
  request: ImportedValidationReviewRequestV1;
  result: ImportedValidationReviewResultV1;
  requestDigest: string;
  resultDigest: string;
  sourceDigest: string;
}
/** Complete checked projections, not execution authority. Call again for every new reception or transaction. */
export function inspectImportedValidationReviewCompletionV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedValidationReviewCompletionInspectionV1 {
  const inspected = inspectReviewRequestWithDigests(requestInput, researchBytes, sha), { request, requestDigest, sourceDigest } = inspected;
  const result = ImportedValidationReviewResultV1Schema.parse(input);
  const completion = { ...inspected, result, resultDigest: digest.parse(sha(canonical(result))) };
  if (result.review_id !== request.review_id || result.request_digest !== requestDigest) throw Error("Validation review result changed its exact request");
  if (result.outcome !== "reviewed") return completion;
  for (const [start, measured] of [[request.before_start, result.before], [request.after_start, result.after]] as const) {
    const verification = inspectImportedValidationVerificationV1(request.origin, measured.verification);
    if (measured.run_id !== start.run_id || measured.config_digest !== sha(canonical(start)) || verification.request_id !== start.verification.request_id
      || verification.subject_digest !== request.source.subject_digest || canonical(verification.required_files) !== canonical(request.source.verification!.required_files))
      throw Error("Validation review changed its full final subject, immutable inputs or phase binding");
  }
  if (result.reviewer.run_id !== request.review_start.run_id || result.reviewer.config_digest !== sha(canonical(request.review_start))
    || result.verdict.review_id !== request.review_id || result.verdict.validation_id !== request.source.validation_id
    || result.verdict.source_digest !== sourceDigest || result.verdict.subject_digest !== request.source.subject_digest)
    throw Error("Final product verdict changed its actual source or independent reviewer binding");
  return completion;
}
export function inspectImportedValidationReviewResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedValidationReviewResultV1 {
  return inspectImportedValidationReviewCompletionV1(requestInput, input, researchBytes, sha).result;
}
