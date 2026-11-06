import { z } from "zod";
import { RunStartPayloadSchema, type RunStartPayload } from "./node-payloads.js";
import { RunVerificationPayloadSchema, type RunVerificationPayload } from "./autonomy.js";
import { ImportedCompletedDesignV1Schema, type ImportedCompletedDesignV1 } from "./imported-design-completion.js";
import { ImportedDesignContinuationRequestV1Schema, ImportedDesignContinuationResultV1Schema,
  importedDesignContinuationRequestDigestV1, inspectImportedDesignContinuationRequestV1, inspectImportedDesignContinuationResultV1,
  type ImportedDesignContinuationRequestV1, type ImportedDesignContinuationResultV1 } from "./imported-design-continuation.js";
import { ImportedDesignReviewSubjectV1Schema, type ImportedDesignReviewSubjectV1 } from "./imported-design-review-context.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export const IMPORTED_DESIGN_REVIEW_FEATURE_V1 = "imported-design-review.v1";
export const ImportedDesignReviewControlV1Schema = z.object({ version: z.literal(1), review_id: id, request_digest: digest }).strict();
export type ImportedDesignReviewControlV1 = z.infer<typeof ImportedDesignReviewControlV1Schema>;
export interface ImportedDesignReviewRequestV1 {
  version: 1; review_id: string; continuation_request: ImportedDesignContinuationRequestV1;
  continuation_result: ImportedDesignContinuationResultV1;
  reviewer: z.infer<typeof agent>; before_start: RunStartPayload; review_start: RunStartPayload; after_start: RunStartPayload;
}
function sameVerifier(original: RunStartPayload, start: RunStartPayload): boolean {
  const context = start.context_pack.payload, originalContext = original.context_pack.payload;
  if (!start.verification || !original.verification || !context || !originalContext) return false;
  const { imported_design_review_subject: _subject, ...payload } = context;
  return canonical({ ...start, run_id: original.run_id, verification: original.verification,
    policy_snapshot: { ...start.policy_snapshot, filesystem_write_scope: original.policy_snapshot.filesystem_write_scope },
    context_pack: { ...start.context_pack, payload: { ...payload,
      policy: { ...context.policy, filesystem_write_scope: originalContext.policy.filesystem_write_scope } } } }) === canonical(original)
    && canonical({ ...start.verification, request_id: original.verification.request_id, expected_subject_digest: undefined }) === canonical(original.verification)
    && context.policy.execution_mode === undefined && context.policy.filesystem_write_scope.length === 0 && start.policy_snapshot.filesystem_write_scope.length === 0;
}
export const ImportedDesignReviewRequestV1Schema: z.ZodType<ImportedDesignReviewRequestV1> = z.object({
  version: z.literal(1), review_id: id, continuation_request: ImportedDesignContinuationRequestV1Schema,
  continuation_result: ImportedDesignContinuationResultV1Schema, reviewer: agent,
  before_start: RunStartPayloadSchema, review_start: RunStartPayloadSchema, after_start: RunStartPayloadSchema,
}).strict().superRefine((value, ctx) => {
  const original = value.continuation_request.run_start, context = value.review_start.context_pack.payload, start = value.review_start;
  const completed = value.continuation_result.outcome === "finished" ? value.continuation_result.verified_design : undefined;
  const earlier = value.continuation_request.review_request;
  const source = earlier.operation.intent.request.byte_request.source;
  const priorStarts = [original, earlier.operation.intent.destination_start, earlier.before_start, earlier.review_start, earlier.after_start];
  const starts = [value.before_start, start, value.after_start];
  const runIds = [source.run_id, ...[...priorStarts, ...starts].map(item => item.run_id)],
    requestIds = [source.verification_request_id, ...[...priorStarts, ...starts].map(item => item.verification?.request_id)];
  if (!completed || completed.scope !== "all-declared-workspace-design-cases"
    || value.reviewer.agent_id === value.continuation_request.writer.agent_id || value.reviewer.instance_id === value.continuation_request.writer.instance_id
    || new Set(runIds).size !== runIds.length || requestIds.some(item => !item) || new Set(requestIds).size !== requestIds.length
    || !sameVerifier(original, value.before_start) || !sameVerifier(original, value.after_start)
    || starts.some(item => item.verification?.expected_subject_digest !== completed.subject_digest || item.workspace.root !== original.workspace.root
      || item.workspace.branch != null || item.workspace_allocation || item.runtime === "mock")
    || start.agent_instance_id !== value.reviewer.instance_id || [original.task_id, source.task_id, earlier.review_start.task_id].includes(start.task_id) || context?.task.id !== start.task_id
    || canonical(context?.project) !== canonical(original.context_pack.payload.project) || canonical(context?.goal_context) !== canonical(original.context_pack.payload.goal_context)
    || context?.workspace.root !== original.workspace.root || context.policy.execution_mode !== "discussion"
    || context.policy.filesystem_write_scope.length !== 0 || start.policy_snapshot.filesystem_write_scope.length !== 0
    || canonical(context.policy.requires_approval) !== canonical(original.context_pack.payload.policy.requires_approval)
    || canonical(start.policy_snapshot.requires_approval) !== canonical(original.policy_snapshot.requires_approval)
    || context.imported_clean_validation || context.imported_clean_validation_review_subject || context.imported_recovery_validation || context.imported_recovery_validation_review_subject || context.product_development || context.review_subject || context.imported_review_subject || context.imported_validation || context.imported_validation_review_subject || context.product_design_revision || context.imported_execution || context.imported_execution_review_subject || context.imported_execution_repair
    || canonical(context.transferred_product_input) !== canonical(original.context_pack.payload.transferred_product_input)
    || canonical(context.verification_capabilities) !== canonical(original.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(original.context_pack.payload.release_capabilities)
    || canonical({ ...start.verification, request_id: original.verification!.request_id, expected_subject_digest: undefined }) !== canonical(original.verification)) {
    ctx.addIssue({ code: "custom", message: "H4 requires completed all-case design provenance, distinct exact read-only phases and an independent destination reviewer" });
  }
});
export function inspectImportedCompletedDesignV1(request: ImportedDesignContinuationRequestV1, input: unknown, sha: SourceOperationSha): ImportedCompletedDesignV1 {
  const value = ImportedCompletedDesignV1Schema.parse(input), start = request.run_start, transfer = request.review_request.operation.intent.request;
  const destination = transfer.byte_request.destination, mapped = start.context_pack.payload.transferred_product_input;
  if (value.continuation_id !== request.continuation_id || value.request_digest !== importedDesignContinuationRequestDigestV1(request, sha)
    || value.run_id !== start.run_id || value.run_start_digest !== sha(canonical(start)) || canonical(value.author) !== canonical(request.writer)
    || canonical(value.destination) !== canonical({ node_id: destination.node_id, workspace_root: destination.workspace_root,
      profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest })
    || value.transfer_id !== transfer.byte_request.transfer_id || value.source_export_digest !== transfer.source_export_digest
    || value.mapping_digest !== mapped.mapping_digest || value.research_provenance_digest !== mapped.research_provenance_digest
    || value.verification.request_id !== start.verification!.request_id
    || destination.capabilities.checks.some(check => check.contract.version !== 3
      || check.contract.stage_policy.design !== (value.scope === "all-declared-workspace-design-cases" ? "declared-cases" : "prototype-only"))
    || canonical(value.verification.checks.map(check => check.id).sort()) !== canonical(destination.capabilities.checks.map(check => check.command_id).sort())
    || value.verification.checks.some(check => !destination.capabilities.checks.some(bound => check.id === bound.command_id
      && check.observation?.capability_binding?.config_digest === bound.config_digest && check.observation.capability_binding.contract_digest === bound.contract_digest))) {
    throw Error("Completed imported design differs from its exact author, destination, mapping or verification");
  }
  return value;
}
export function importedDesignReviewSubjectV1(input: Pick<ImportedDesignReviewRequestV1, "review_id" | "continuation_request" | "continuation_result" | "reviewer">,
  sha: SourceOperationSha): ImportedDesignReviewSubjectV1 {
  const result = input.continuation_result;
  if (result.outcome !== "finished" || !result.verified_design) throw Error("Original completed verified design is required");
  const completed = inspectImportedCompletedDesignV1(input.continuation_request, result.verified_design, sha);
  return ImportedDesignReviewSubjectV1Schema.parse({ version: 1, review_id: input.review_id, continuation_id: completed.continuation_id,
    completed_design_digest: sha(canonical(completed)), transfer_id: completed.transfer_id, source_export_digest: completed.source_export_digest,
    mapping_digest: completed.mapping_digest, research_provenance_digest: completed.research_provenance_digest,
    author_run_id: completed.run_id, author_agent_id: completed.author.agent_id, reviewer_agent_id: input.reviewer.agent_id,
    reviewer_instance_id: input.reviewer.instance_id, subject_digest: completed.subject_digest, development_stage: "design", scope: completed.scope });
}
export function inspectImportedDesignReviewRequestV1(input: unknown, bytes: Uint8Array, sha: SourceOperationSha): ImportedDesignReviewRequestV1 {
  const request = ImportedDesignReviewRequestV1Schema.parse(input);
  inspectImportedDesignContinuationRequestV1(request.continuation_request, bytes, sha);
  inspectImportedDesignContinuationResultV1(request.continuation_request, request.continuation_result, sha);
  const subject = importedDesignReviewSubjectV1(request, sha);
  for (const start of [request.before_start, request.review_start, request.after_start]) {
    if (canonical(start.context_pack.payload?.imported_design_review_subject) !== canonical(subject)) throw Error("H4 phase subject differs from the complete author provenance");
  }
  return request;
}
export function importedDesignReviewRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedDesignReviewRequestV1Schema.parse(input))));
}
export const ImportedDesignReviewVerdictV1Schema = z.object({ version: z.literal(1), review_id: id, continuation_id: id,
  completed_design_digest: digest, subject_digest: digest, outcome: z.enum(["accepted", "changes_requested"]),
  summary: z.string().trim().min(1).max(12000), findings: z.array(z.object({ severity: z.enum(["blocking", "nonblocking"]),
    description: z.string().trim().min(1).max(4000), file: z.string().max(4096).optional() }).strict()).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.outcome === "accepted" && value.findings.some(item => item.severity === "blocking")) ctx.addIssue({ code: "custom", message: "Blocking design findings cannot be accepted" });
});
export type ImportedDesignReviewVerdictV1 = z.infer<typeof ImportedDesignReviewVerdictV1Schema>;
const measurement = z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1"),
  scope: z.literal("all-declared-workspace-design-cases"), verification: RunVerificationPayloadSchema }).strict();
const resultBase = { version: z.literal(1), review_id: id, request_digest: digest, execution_authorized: z.literal(false) };
const reason = z.string().min(1).max(2000);
export const ImportedDesignReviewResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...resultBase, outcome: z.literal("reviewed"), closed: z.literal(true), before: measurement, after: measurement,
    reviewer: z.object({ run_id: id, config_digest: digest, closure: z.literal("windows-job-and-tools-closed.v1") }).strict(), verdict: ImportedDesignReviewVerdictV1Schema }).strict(),
  z.object({ ...resultBase, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...resultBase, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...resultBase, outcome: z.literal("cancelled_before_start"), closed: z.literal(true), reason }).strict(),
]);
export type ImportedDesignReviewResultV1 = z.infer<typeof ImportedDesignReviewResultV1Schema>;
export function inspectImportedDesignReviewResultV1(requestInput: unknown, input: unknown, bytes: Uint8Array, sha: SourceOperationSha): ImportedDesignReviewResultV1 {
  const request = inspectImportedDesignReviewRequestV1(requestInput, bytes, sha), result = ImportedDesignReviewResultV1Schema.parse(input);
  if (result.review_id !== request.review_id || result.request_digest !== importedDesignReviewRequestDigestV1(request, sha)) throw Error("H4 result identity differs");
  if (result.outcome !== "reviewed") return result;
  const subject = importedDesignReviewSubjectV1(request, sha);
  const completed = (request.continuation_result as Extract<ImportedDesignContinuationResultV1, { outcome: "finished" }>).verified_design!;
  for (const [start, measured] of [[request.before_start, result.before], [request.after_start, result.after]] as const) {
    const verification: RunVerificationPayload = measured.verification;
    if (measured.run_id !== start.run_id || measured.config_digest !== sha(canonical(start)) || verification.request_id !== start.verification!.request_id
      || verification.subject_digest !== subject.subject_digest || verification.outcome !== "passed"
      || canonical(verification.required_files) !== canonical(completed.verification.required_files)
      || canonical(verification.measurement_plan) !== canonical(completed.verification.measurement_plan)) throw Error("H4 measurement differs from the exact unchanged design phase");
    inspectImportedCompletedDesignV1(request.continuation_request, { ...completed, verification: { ...verification,
      request_id: completed.verification.request_id } }, sha);
  }
  if (result.reviewer.run_id !== request.review_start.run_id || result.reviewer.config_digest !== sha(canonical(request.review_start))
    || result.verdict.review_id !== request.review_id || result.verdict.continuation_id !== subject.continuation_id
    || result.verdict.subject_digest !== subject.subject_digest || result.verdict.completed_design_digest !== subject.completed_design_digest) throw Error("H4 verdict or reviewer binding differs");
  return result;
}
