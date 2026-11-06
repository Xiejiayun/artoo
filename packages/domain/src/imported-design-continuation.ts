import { z } from "zod";
import { ContextPackSchema, type ContextPack } from "./context-pack.js";
import { RunStartPayloadSchema, type RunStartPayload } from "./node-payloads.js";
import { TransferredProductInputV1Schema, type TransferredProductInputV1 } from "./transferred-product-input.js";
import { ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema,
  importedProductReviewRequestDigestV1, inspectImportedProductReviewResultV1,
  type ImportedProductReviewRequestV1, type ImportedProductReviewResultV1 } from "./imported-product-review.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
import { ImportedCompletedDesignV1Schema } from "./imported-design-completion.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 = "imported-design-continuation.v1";

// This dedicated parser requires the otherwise optional context extension.
export interface ImportedDesignRunStartV1 extends Omit<RunStartPayload, "context_pack"> {
  context_pack: { id: string; payload: ContextPack & { transferred_product_input: TransferredProductInputV1 } };
}
const startSchema: z.ZodType<ImportedDesignRunStartV1> = RunStartPayloadSchema.extend({
  context_pack: z.object({ id, payload: ContextPackSchema.extend({ transferred_product_input: TransferredProductInputV1Schema,
    imported_clean_validation: z.never().optional(), imported_clean_validation_review_subject: z.never().optional(),
    imported_recovery_validation: z.never().optional(), imported_recovery_validation_review_subject: z.never().optional() }) }).strict(),
});
export interface ImportedDesignContinuationRequestV1 {
  version: 1; continuation_id: string;
  review_request: ImportedProductReviewRequestV1; review_result: ImportedProductReviewResultV1;
  writer: { agent_id: string; instance_id: string }; run_start: ImportedDesignRunStartV1;
}

export const ImportedDesignContinuationRequestV1Schema: z.ZodType<ImportedDesignContinuationRequestV1> = z.object({
  version: z.literal(1), continuation_id: id,
  review_request: ImportedProductReviewRequestV1Schema, review_result: ImportedProductReviewResultV1Schema,
  writer: z.object({ agent_id: id, instance_id: id }).strict(), run_start: startSchema,
}).strict().superRefine((value, ctx) => {
  const review = value.review_request, operation = review.operation, transfer = operation.intent.request;
  const destination = transfer.byte_request.destination, source = transfer.byte_request.source;
  const start = value.run_start, context = start.context_pack.payload, result = value.review_result;
  const original = operation.intent.destination_start, verification = start.verification;
  const previous = [original, review.review_start, review.before_start, review.after_start];
  const expectedInput = transfer.source_export.research_provenance.research;
  const accepted = { version: 1, files: [{ ...expectedInput, source_task_id: source.task_id,
    source_run_id: source.run_id, evidence_id: source.evidence_id }] };
  // Final verification measures the changed design. The initial digest belongs
  // in transferred_product_input and the opaque node permit, not a read-only
  // expected_subject_digest that would incorrectly reject legitimate writes.
  const sameVerifier = verification && original.verification
    && canonical({ ...verification, request_id: original.verification.request_id,
      expected_subject_digest: original.verification.expected_subject_digest }) === canonical(original.verification);
  const oldGoal = original.context_pack.payload?.goal_context, newGoal = context.goal_context;
  const sameGoal = oldGoal && newGoal && canonical({ ...newGoal,
    plan: newGoal.plan ? { ...newGoal.plan, spec_ref: oldGoal.plan?.spec_ref } : null }) === canonical(oldGoal);
  if (result.outcome !== "reviewed" || result.verdict.outcome !== "accepted" || result.closed !== true
    || destination.capabilities.measurement_plan_policy?.version !== 2
    || destination.capabilities.checks.some(check => check.contract.version !== 3)
    || start.task_id !== operation.intent.next_task_id || start.agent_instance_id !== value.writer.instance_id
    || start.workspace.root !== destination.workspace_root || start.workspace.branch != null || start.workspace_allocation
    || start.run_id === source.run_id || previous.some(prior => prior.run_id === start.run_id)
    || !verification || verification.expected_subject_digest !== undefined || !sameVerifier
    || previous.some(prior => prior.verification?.request_id === verification.request_id)
    || start.runtime === "mock" || context.task.id !== start.task_id || context.project.id !== transfer.byte_request.project_id
    || canonical(context.project) !== canonical(original.context_pack.payload?.project)
    || context.workspace.root !== destination.workspace_root || !sameGoal
    || context.policy.execution_mode !== undefined || context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.imported_validation || context.imported_validation_review_subject || context.product_design_revision || context.imported_execution || context.imported_execution_review_subject || context.imported_execution_repair
    || context.product_development?.stage !== "design" || canonical(context.product_development.accepted_inputs) !== canonical(accepted)
    || canonical(context.policy.filesystem_write_scope) !== canonical([destination.workspace_root])
    || canonical(context.policy.filesystem_write_scope) !== canonical(start.policy_snapshot.filesystem_write_scope)
    || canonical(context.policy.requires_approval) !== canonical(start.policy_snapshot.requires_approval)
    || canonical(context.verification_capabilities) !== canonical({ ...destination.capabilities, profile_id: destination.profile_id })
    || canonical(context.release_capabilities) !== canonical(transfer.measurement_v2?.destination_release)) {
    ctx.addIssue({ code: "custom", message: "Imported design requires accepted research, a distinct exact design run and the original destination/verifier/goal bindings" });
  }
});

export function transferredProductInputV1(input: Pick<ImportedDesignContinuationRequestV1,
  "continuation_id" | "review_request" | "review_result">, sha: SourceOperationSha): TransferredProductInputV1 {
  const request = input.review_request, result = input.review_result, transfer = request.operation.intent.request;
  if (result.outcome !== "reviewed" || result.verdict.outcome !== "accepted") throw Error("Accepted imported review is required");
  return TransferredProductInputV1Schema.parse({ version: 1, stage: "research", continuation_id: input.continuation_id,
    transfer_id: transfer.byte_request.transfer_id, imported_review_id: request.review_id,
    imported_review_request_digest: importedProductReviewRequestDigestV1(request, sha),
    imported_review_result_digest: sha(canonical(result)), source_export_digest: transfer.source_export_digest,
    mapping_digest: result.after.fresh.mapping_digest, research_provenance_digest: result.after.fresh.research_provenance_digest,
    measurement_mapping: result.after.admission.mapping,
    initial_subject_digest: result.after.admission.ready.destination.subject_digest });
}

/** Public consistency checks only. Current authorization and one-use ownership remain trusted server/node checks. */
export function inspectImportedDesignContinuationRequestV1(input: unknown, researchBytes: Uint8Array,
  sha: SourceOperationSha): ImportedDesignContinuationRequestV1 {
  const request = ImportedDesignContinuationRequestV1Schema.parse(input);
  inspectImportedProductReviewResultV1(request.review_request, request.review_result, researchBytes, sha);
  if (canonical(request.run_start.context_pack.payload.transferred_product_input) !== canonical(transferredProductInputV1(request, sha))) {
    throw Error("Design transferred input differs from the complete accepted imported review");
  }
  return request;
}
export function importedDesignContinuationRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedDesignContinuationRequestV1Schema.parse(input))));
}

export const ImportedDesignContinuationControlV1Schema = z.object({
  version: z.literal(1), continuation_id: id, request_digest: digest, run_id: id,
}).strict();
export type ImportedDesignContinuationControlV1 = z.infer<typeof ImportedDesignContinuationControlV1Schema>;

const resultIdentity = { version: z.literal(1), continuation_id: id, request_digest: digest, run_id: id };
const reason = z.string().min(1).max(2048);
/** Lifecycle facts only. A finished result cannot substitute for verification or independent review. */
export const ImportedDesignContinuationResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...resultIdentity, outcome: z.literal("finished"), closed: z.literal(true), verified_design: ImportedCompletedDesignV1Schema.optional() }).strict(),
  z.object({ ...resultIdentity, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
  z.object({ ...resultIdentity, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...resultIdentity, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
]);
export type ImportedDesignContinuationResultV1 = z.infer<typeof ImportedDesignContinuationResultV1Schema>;

export function inspectImportedDesignContinuationResultV1(requestInput: unknown, resultInput: unknown,
  sha: SourceOperationSha): ImportedDesignContinuationResultV1 {
  const request = ImportedDesignContinuationRequestV1Schema.parse(requestInput);
  const result = ImportedDesignContinuationResultV1Schema.parse(resultInput);
  if (result.continuation_id !== request.continuation_id || result.run_id !== request.run_start.run_id
    || result.request_digest !== importedDesignContinuationRequestDigestV1(request, sha)) {
    throw Error("Imported design lifecycle result differs from its exact request/run binding");
  }
  return result;
}
