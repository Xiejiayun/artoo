import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { ImportedExecutionRequestV1Schema, type ImportedExecutionRequestV1 } from "./imported-execution.js";
import { ImportedImplementationSourceV1Schema, importedImplementationSourceDigestV1, inspectImportedImplementationSourceV1,
  inspectImportedImplementationVerificationV1, ImportedImplementationRunStartV1Schema, type ImportedImplementationRunStartV1,
  type ImportedImplementationSourceV1 } from "./imported-implementation-source.js";
import { ImportedExecutionReviewSubjectV1Schema } from "./imported-implementation-context.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), reason = z.string().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_EXECUTION_REVIEW_FEATURE_V1 = "imported-execution-review.v1";
export interface ImportedExecutionReviewRequestV1 { version: 1; review_id: string; execution_request: ImportedExecutionRequestV1;
  source: ImportedImplementationSourceV1; reviewer: z.infer<typeof agent>; before_start: ImportedImplementationRunStartV1;
  review_start: ImportedImplementationRunStartV1; after_start: ImportedImplementationRunStartV1 }
export const ImportedExecutionReviewControlV1Schema = z.object({ version: z.literal(1), review_id: id, request_digest: digest }).strict();
export type ImportedExecutionReviewControlV1 = z.infer<typeof ImportedExecutionReviewControlV1Schema>;
function authorContext(start: ImportedImplementationRunStartV1) {
  const { imported_execution: _h5, imported_execution_repair: _repair, imported_execution_review_subject: _review, ...context } = start.context_pack.payload;
  return context;
}
function sameVerifier(source: ImportedImplementationRunStartV1, start: ImportedImplementationRunStartV1) {
  const context = authorContext(start), original = authorContext(source);
  return canonical({ ...start, run_id: source.run_id, verification: source.verification,
    policy_snapshot: { ...start.policy_snapshot, filesystem_write_scope: source.policy_snapshot.filesystem_write_scope },
    context_pack: { id: source.context_pack.id, payload: { ...context, policy: { ...context.policy,
      filesystem_write_scope: original.policy.filesystem_write_scope } } } }) === canonical({ ...source, context_pack: { ...source.context_pack, payload: original } })
    && !!start.verification && canonical({ ...start.verification, request_id: source.verification!.request_id, expected_subject_digest: undefined }) === canonical(source.verification)
    && context.policy.execution_mode === undefined && !context.policy.filesystem_write_scope.length && !start.policy_snapshot.filesystem_write_scope.length;
}
export const ImportedExecutionReviewRequestV1Schema: z.ZodType<ImportedExecutionReviewRequestV1> = z.object({ version: z.literal(1), review_id: id,
  execution_request: ImportedExecutionRequestV1Schema, source: ImportedImplementationSourceV1Schema, reviewer: agent,
  before_start: ImportedImplementationRunStartV1Schema, review_start: ImportedImplementationRunStartV1Schema,
  after_start: ImportedImplementationRunStartV1Schema }).strict().superRefine((value, ctx) => {
  const source = value.source.run_start, starts = [value.before_start, value.review_start, value.after_start], start = value.review_start, context = start.context_pack.payload;
  const original = value.execution_request, h4 = original.review_request;
  const oldRuns = new Set([source.run_id, original.run_start.run_id, h4.before_start.run_id, h4.review_start.run_id, h4.after_start.run_id]);
  const oldRequests = new Set([source.verification?.request_id, original.run_start.verification?.request_id,
    h4.before_start.verification?.request_id, h4.review_start.verification?.request_id, h4.after_start.verification?.request_id]);
  if (value.reviewer.agent_id === value.source.author.agent_id || value.reviewer.instance_id === value.source.author.instance_id
    || new Set(starts.map(item => item.run_id)).size !== 3 || new Set(starts.map(item => item.verification?.request_id)).size !== 3
    || starts.some(item => oldRuns.has(item.run_id) || !item.verification || oldRequests.has(item.verification.request_id)
      || item.verification.expected_subject_digest !== value.source.subject_digest || item.workspace.root !== source.workspace.root || item.workspace.branch != null
      || item.context_pack.payload.imported_validation || item.context_pack.payload.imported_validation_review_subject || item.workspace_allocation || item.runtime === "mock" || item.context_pack.payload.imported_execution || item.context_pack.payload.imported_execution_repair
      || item.context_pack.payload.imported_design_review_subject || item.context_pack.payload.imported_review_subject || item.context_pack.payload.review_subject || item.context_pack.payload.product_design_revision)
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
    || canonical({ ...start.verification, request_id: source.verification!.request_id, expected_subject_digest: undefined }) !== canonical(source.verification)) {
    ctx.addIssue({ code: "custom", message: "H6 requires exact independent read-only phases over its actual implementation author and subject" });
  }
});
export function importedExecutionReviewSubjectV1(input: Pick<ImportedExecutionReviewRequestV1, "review_id" | "execution_request" | "source">, sha: SourceOperationSha) {
  return ImportedExecutionReviewSubjectV1Schema.parse({ version: 1, review_id: input.review_id, base_execution_id: input.execution_request.execution_id,
    source_digest: importedImplementationSourceDigestV1(input.source, sha), subject_digest: input.source.subject_digest });
}
export function inspectImportedExecutionReviewRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionReviewRequestV1 {
  const request = ImportedExecutionReviewRequestV1Schema.parse(input);
  inspectImportedImplementationSourceV1(request.execution_request, request.source, researchBytes, sha);
  const subject = importedExecutionReviewSubjectV1(request, sha);
  for (const start of [request.before_start, request.review_start, request.after_start])
    if (canonical(start.context_pack.payload.imported_execution_review_subject) !== canonical(subject)) throw Error("H6 phase source descriptor changed");
  return request;
}
export function importedExecutionReviewRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedExecutionReviewRequestV1Schema.parse(input))));
}
export const ImportedExecutionReviewVerdictV1Schema = z.object({ version: z.literal(1), review_id: id, source_digest: digest, subject_digest: digest,
  outcome: z.enum(["accepted", "rejected"]), summary: z.string().trim().min(1).max(12000), findings: z.array(z.object({
    severity: z.enum(["blocking", "nonblocking"]), description: z.string().trim().min(1).max(4000), file: z.string().max(4096).optional() }).strict()).max(100)
}).strict().superRefine((value, ctx) => {
  if ((value.outcome === "rejected") !== value.findings.some(item => item.severity === "blocking"))
    ctx.addIssue({ code: "custom", message: "Rejected implementation review requires a blocking finding; accepted review cannot retain one" });
});
export type ImportedExecutionReviewVerdictV1 = z.infer<typeof ImportedExecutionReviewVerdictV1Schema>;
const measurement = z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1"),
  scope: z.literal("all-declared-workspace-implementation-cases"), verification: RunVerificationPayloadSchema }).strict();
const base = { version: z.literal(1), review_id: id, request_digest: digest, execution_authorized: z.literal(false) };
export const ImportedExecutionReviewResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("reviewed"), closed: z.literal(true), before: measurement, after: measurement,
    reviewer: z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1") }).strict(), verdict: ImportedExecutionReviewVerdictV1Schema }).strict(),
  z.object({ ...base, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...base, outcome: z.literal("cancelled_before_start"), closed: z.literal(true), reason }).strict(),
  z.object({ ...base, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
]);
export type ImportedExecutionReviewResultV1 = z.infer<typeof ImportedExecutionReviewResultV1Schema>;
export function inspectImportedExecutionReviewResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionReviewResultV1 {
  const request = inspectImportedExecutionReviewRequestV1(requestInput, researchBytes, sha), result = ImportedExecutionReviewResultV1Schema.parse(input);
  if (result.review_id !== request.review_id || result.request_digest !== importedExecutionReviewRequestDigestV1(request, sha)) throw Error("H6 result identity changed");
  if (result.outcome !== "reviewed") return result;
  for (const [start, measured] of [[request.before_start, result.before], [request.after_start, result.after]] as const) {
    const evidence = inspectImportedImplementationVerificationV1(request.execution_request, measured.verification);
    if (measured.run_id !== start.run_id || measured.config_digest !== sha(canonical(start)) || evidence.request_id !== start.verification!.request_id
      || evidence.subject_digest !== request.source.subject_digest || canonical(evidence.required_files) !== canonical(request.source.verification.required_files))
      throw Error("H6 verification differs from its exact unchanged implementation phase");
  }
  if (result.reviewer.run_id !== request.review_start.run_id || result.reviewer.config_digest !== sha(canonical(request.review_start))
    || result.verdict.review_id !== request.review_id || result.verdict.source_digest !== importedImplementationSourceDigestV1(request.source, sha)
    || result.verdict.subject_digest !== request.source.subject_digest) throw Error("H6 reviewer or verdict source binding changed");
  return result;
}
