import { z } from "zod";
import { ContextPackSchema, type ContextPack } from "./context-pack.js";
import { RunStartPayloadSchema, type RunStartPayload } from "./node-payloads.js";
import { ImportedDesignReviewRequestV1Schema, ImportedDesignReviewResultV1Schema, importedDesignReviewRequestDigestV1,
  inspectImportedDesignReviewResultV1, type ImportedDesignReviewRequestV1, type ImportedDesignReviewResultV1 } from "./imported-design-review.js";
import { ImportedExecutionContextV1Schema, type ImportedExecutionContextV1 } from "./imported-execution-context.js";
import { ImportedCompletedExecutionV1Schema, type ImportedCompletedExecutionV1 } from "./imported-execution-completion.js";
import { TransferredProductInputV1Schema, type TransferredProductInputV1 } from "./transferred-product-input.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const IMPORTED_EXECUTION_FEATURE_V1 = "imported-execution.v1";
export interface ImportedExecutionRunStartV1 extends Omit<RunStartPayload, "context_pack"> {
  context_pack: { id: string; payload: ContextPack & { transferred_product_input: TransferredProductInputV1; imported_execution: ImportedExecutionContextV1 } };
}
export interface ImportedExecutionRequestV1 {
  version: 1; stage: "implementation"; execution_id: string;
  review_request: ImportedDesignReviewRequestV1; review_result: ImportedDesignReviewResultV1;
  acceptance_event_id: string; design_evidence_id: string;
  writer: { agent_id: string; instance_id: string }; run_start: ImportedExecutionRunStartV1;
}
const startSchema: z.ZodType<ImportedExecutionRunStartV1> = RunStartPayloadSchema.extend({
  context_pack: z.object({ id, payload: ContextPackSchema.extend({
    transferred_product_input: TransferredProductInputV1Schema, imported_execution: ImportedExecutionContextV1Schema,
    imported_clean_validation: z.never().optional(), imported_clean_validation_review_subject: z.never().optional(),
    imported_recovery_validation: z.never().optional(), imported_recovery_validation_review_subject: z.never().optional(),
  }) }).strict(),
});
/** Evidence IDs are qualified by the server. File facts remain exact node measurements. */
export function importedExecutionAcceptedInputsV1(input: Pick<ImportedExecutionRequestV1, "review_request" | "design_evidence_id">) {
  const author = input.review_request.continuation_request, result = input.review_request.continuation_result;
  if (result.outcome !== "finished" || !result.verified_design) throw Error("H5 requires completed design evidence");
  const design = result.verified_design.verification.required_files.find(file => file.path === ".artoo/product/design.json");
  const research = author.run_start.context_pack.payload.product_development?.accepted_inputs?.files;
  if (!design || !design.size || research?.length !== 1 || research[0]!.path !== ".artoo/product/research.json") throw Error("H5 requires exact measured research/design pins");
  return { version: 1 as const, files: [{ ...research[0]! }, { ...design, path: ".artoo/product/design.json" as const,
    source_task_id: author.run_start.task_id, source_run_id: author.run_start.run_id, evidence_id: input.design_evidence_id }] };
}
export const ImportedExecutionRequestV1Schema: z.ZodType<ImportedExecutionRequestV1> = z.object({
  version: z.literal(1), stage: z.literal("implementation"), execution_id: id,
  review_request: ImportedDesignReviewRequestV1Schema, review_result: ImportedDesignReviewResultV1Schema,
  acceptance_event_id: id, design_evidence_id: id, writer: z.object({ agent_id: id, instance_id: id }).strict(), run_start: startSchema,
}).strict().superRefine((value, ctx) => {
  const review = value.review_request, design = review.continuation_request, original = design.run_start;
  const start = value.run_start, context = start.context_pack.payload, result = value.review_result;
  const transfer = design.review_request.operation.intent.request, destination = transfer.byte_request.destination;
  const h2 = design.review_request, source = transfer.byte_request.source;
  const prior = [h2.operation.intent.destination_start, h2.before_start, h2.review_start, h2.after_start,
    original, review.before_start, review.review_start, review.after_start];
  const oldGoal = original.context_pack.payload.goal_context, goal = context.goal_context;
  let pins: unknown; try { pins = importedExecutionAcceptedInputsV1(value); } catch { pins = null; }
  if (result.outcome !== "reviewed" || !result.closed || result.verdict.outcome !== "accepted"
    || start.agent_instance_id !== value.writer.instance_id || start.runtime === "mock" || start.workspace.branch != null || start.workspace_allocation
    || start.workspace.root !== destination.workspace_root || context.workspace.root !== destination.workspace_root
    || start.task_id === source.task_id || prior.some(item => item.task_id === start.task_id || item.run_id === start.run_id)
    || start.run_id === source.run_id || context.task.id !== start.task_id
    || !start.verification || start.verification.expected_subject_digest !== undefined
    || start.verification.request_id === source.verification_request_id || prior.some(item => item.verification?.request_id === start.verification!.request_id)
    || canonical({ ...start.verification, request_id: original.verification?.request_id }) !== canonical(original.verification)
    || canonical(context.project) !== canonical(original.context_pack.payload.project)
    || !oldGoal || !goal || canonical({ ...goal, plan: goal.plan ? { ...goal.plan, spec_ref: oldGoal.plan?.spec_ref } : null }) !== canonical(oldGoal)
    || context.policy.execution_mode !== undefined || context.review_subject || context.imported_review_subject || context.imported_design_review_subject
    || context.imported_validation || context.imported_validation_review_subject || context.product_design_revision || context.imported_execution_review_subject || context.imported_execution_repair || context.product_development?.stage !== "implementation" || !pins
    || canonical(context.product_development.accepted_inputs) !== canonical(pins)
    || canonical(context.transferred_product_input) !== canonical(original.context_pack.payload.transferred_product_input)
    || canonical(context.policy.filesystem_write_scope) !== canonical([destination.workspace_root])
    || canonical(context.policy.filesystem_write_scope) !== canonical(start.policy_snapshot.filesystem_write_scope)
    || canonical(context.policy.requires_approval) !== canonical(start.policy_snapshot.requires_approval)
    || canonical(context.policy.requires_approval) !== canonical(original.policy_snapshot.requires_approval)
    || canonical(context.verification_capabilities) !== canonical(original.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(original.context_pack.payload.release_capabilities)
    || destination.capabilities.measurement_plan_policy?.version !== 2
    || destination.capabilities.checks.some(check => check.contract.version !== 3 || check.contract.stage_policy.implementation !== "declared-cases")) {
    ctx.addIssue({ code: "custom", message: "H5 requires one new exact implementation run, accepted H4, immutable research/design and original destination bindings" });
  }
});
export function importedExecutionContextV1(input: Pick<ImportedExecutionRequestV1, "execution_id" | "review_request" | "review_result" | "acceptance_event_id">,
  sha: SourceOperationSha): ImportedExecutionContextV1 {
  const result = input.review_result;
  if (result.outcome !== "reviewed" || result.verdict.outcome !== "accepted") throw Error("Accepted H4 result is required");
  return ImportedExecutionContextV1Schema.parse({ version: 1, execution_id: input.execution_id, h4_review_id: input.review_request.review_id,
    h4_request_digest: importedDesignReviewRequestDigestV1(input.review_request, sha), h4_result_digest: sha(canonical(result)),
    acceptance_event_id: input.acceptance_event_id, initial_subject_digest: result.after.verification.subject_digest });
}
export function inspectImportedExecutionRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionRequestV1 {
  const request = ImportedExecutionRequestV1Schema.parse(input);
  inspectImportedDesignReviewResultV1(request.review_request, request.review_result, researchBytes, sha);
  if (canonical(request.run_start.context_pack.payload.imported_execution) !== canonical(importedExecutionContextV1(request, sha))) throw Error("H5 context differs from accepted H4");
  const research = importedExecutionAcceptedInputsV1(request).files[0]!;
  if (researchBytes.byteLength !== research.size || sha(researchBytes) !== research.checksum) throw Error("H5 accepted research bytes changed");
  return request;
}
export function importedExecutionRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedExecutionRequestV1Schema.parse(input))));
}
export const ImportedExecutionControlV1Schema = z.object({ version: z.literal(1), execution_id: id, request_digest: digest, run_id: id }).strict();
export type ImportedExecutionControlV1 = z.infer<typeof ImportedExecutionControlV1Schema>;
const identity = { version: z.literal(1), execution_id: id, request_digest: digest, run_id: id }, reason = z.string().min(1).max(2000);
export const ImportedExecutionResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...identity, outcome: z.literal("finished"), closed: z.literal(true), verified_execution: ImportedCompletedExecutionV1Schema.optional() }).strict(),
  z.object({ ...identity, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...identity, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
  z.object({ ...identity, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
]);
export type ImportedExecutionResultV1 = z.infer<typeof ImportedExecutionResultV1Schema>;
export function inspectImportedCompletedExecutionV1(request: ImportedExecutionRequestV1, input: unknown, sha: SourceOperationSha): ImportedCompletedExecutionV1 {
  const value = ImportedCompletedExecutionV1Schema.parse(input), start = request.run_start, context = start.context_pack.payload;
  const transfer = request.review_request.continuation_request.review_request.operation.intent.request, destination = transfer.byte_request.destination;
  const source = context.transferred_product_input, h4 = importedExecutionContextV1(request, sha), evidence = value.verification;
  const reviewed = request.review_result.outcome === "reviewed" ? request.review_result.after.verification : undefined;
  if (!reviewed) throw Error("H5 completion requires the accepted H4 final measurement");
  // The immutable design and protected profile give both phases the same declared programs/viewports.
  // New traces and captures are intentionally excluded: implementation must produce fresh evidence.
  const cases = (check: typeof evidence.checks[number]) => check.observation?.version === 3
    ? check.observation.cases.map(item => canonical({ case_id: item.case_id, viewport: item.viewport, program_digest: item.program_digest })).sort() : undefined;
  if (value.execution_id !== request.execution_id || value.request_digest !== importedExecutionRequestDigestV1(request, sha)
    || value.run_id !== start.run_id || value.run_start_digest !== sha(canonical(start)) || canonical(value.author) !== canonical(request.writer)
    || canonical(value.destination) !== canonical({ node_id: destination.node_id, workspace_root: destination.workspace_root,
      profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest })
    || value.initial_subject_digest !== h4.initial_subject_digest || value.h4_review_id !== h4.h4_review_id
    || value.h4_result_digest !== h4.h4_result_digest || value.acceptance_event_id !== request.acceptance_event_id
    || value.transfer_id !== source.transfer_id || value.source_export_digest !== source.source_export_digest
    || value.mapping_digest !== source.mapping_digest || value.research_provenance_digest !== source.research_provenance_digest
    || evidence.request_id !== start.verification!.request_id
    || canonical(evidence.measurement_plan) !== canonical(reviewed.measurement_plan)
    || canonical(evidence.checks.map(check => check.id).sort()) !== canonical(destination.capabilities.checks.map(check => check.command_id).sort())
    || evidence.checks.some(check => {
      const prior = reviewed.checks.find(item => item.id === check.id), actual = cases(check);
      return !prior || !actual?.length || canonical(actual) !== canonical(cases(prior));
    })
    || evidence.checks.some(check => !destination.capabilities.checks.some(bound => bound.command_id === check.id
      && check.observation?.capability_binding?.config_digest === bound.config_digest && check.observation.capability_binding.contract_digest === bound.contract_digest))
    || importedExecutionAcceptedInputsV1(request).files.some(pin => !evidence.required_files.some(file => file.path === pin.path
      && file.checksum === pin.checksum && file.size === pin.size))) throw Error("H5 completion differs from its author, accepted inputs, destination or final verification");
  return value;
}
export function inspectImportedExecutionResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionResultV1 {
  const request = inspectImportedExecutionRequestV1(requestInput, researchBytes, sha), result = ImportedExecutionResultV1Schema.parse(input);
  if (result.execution_id !== request.execution_id || result.run_id !== request.run_start.run_id || result.request_digest !== importedExecutionRequestDigestV1(request, sha)) throw Error("H5 result differs from its exact request");
  if (result.outcome === "finished" && result.verified_execution) inspectImportedCompletedExecutionV1(request, result.verified_execution, sha);
  return result;
}
