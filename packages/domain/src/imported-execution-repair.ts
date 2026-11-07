import { z } from "zod";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { ImportedExecutionRequestV1Schema, importedExecutionAcceptedInputsV1, type ImportedExecutionRequestV1 } from "./imported-execution.js";
import { ImportedImplementationSourceV1Schema, inspectImportedImplementationSourceV1, inspectImportedImplementationVerificationV1,
  ImportedImplementationRunStartV1Schema, type ImportedImplementationRunStartV1, type ImportedImplementationSourceV1 } from "./imported-implementation-source.js";
import { ImportedExecutionRepairContextV1Schema } from "./imported-implementation-context.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), reason = z.string().min(1).max(2000);
const agent = z.object({ agent_id: id, instance_id: id }).strict();
export interface ImportedExecutionRepairRequestV1 { version: 1; repair_id: string; execution_request: ImportedExecutionRequestV1;
  source: ImportedImplementationSourceV1; review_id: string; review_request_digest: string; review_result_digest: string;
  authorization: { event_id: string; goal_id: string; attempt_index: number }; writer: z.infer<typeof agent>; run_start: ImportedImplementationRunStartV1 }
export const ImportedExecutionRepairRequestV1Schema: z.ZodType<ImportedExecutionRepairRequestV1> = z.object({ version: z.literal(1), repair_id: id,
  execution_request: ImportedExecutionRequestV1Schema, source: ImportedImplementationSourceV1Schema, review_id: id,
  review_request_digest: digest, review_result_digest: digest, authorization: z.object({ event_id: id, goal_id: id, attempt_index: z.number().int().positive() }).strict(),
  writer: agent, run_start: ImportedImplementationRunStartV1Schema }).strict().superRefine((value, ctx) => {
  const start = value.run_start, context = start.context_pack.payload, original = value.execution_request.run_start, source = value.source.run_start;
  let pins: unknown; try { pins = importedExecutionAcceptedInputsV1(value.execution_request); } catch { pins = undefined; }
  if (!original.verification || !pins || start.task_id !== original.task_id || context.task.id !== start.task_id || start.agent_instance_id !== value.writer.instance_id
    || start.run_id === source.run_id || start.run_id === original.run_id || start.runtime === "mock" || start.workspace.branch != null || start.workspace_allocation
    || start.workspace.root !== original.workspace.root || context.workspace.root !== original.workspace.root
    || !start.verification || start.verification.expected_subject_digest !== undefined || start.verification.request_id === source.verification?.request_id
    || start.verification.request_id === original.verification?.request_id
    || canonical({ ...start.verification, request_id: original.verification!.request_id }) !== canonical(original.verification)
    || context.imported_execution || context.imported_execution_review_subject || context.imported_design_review_subject || context.imported_review_subject || context.review_subject || context.imported_validation || context.imported_validation_review_subject || context.product_design_revision
    || context.product_development?.stage !== "implementation" || context.policy.execution_mode !== undefined
    || canonical(context.product_development.accepted_inputs) !== canonical(pins)
    || canonical(context.project) !== canonical(original.context_pack.payload.project) || canonical(context.goal_context) !== canonical(original.context_pack.payload.goal_context)
    || context.goal_context?.goal_id !== value.authorization.goal_id || canonical(context.policy) !== canonical(original.context_pack.payload.policy)
    || canonical(start.policy_snapshot) !== canonical(original.policy_snapshot)
    || canonical(context.transferred_product_input) !== canonical(original.context_pack.payload.transferred_product_input)
    || canonical(context.verification_capabilities) !== canonical(original.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(original.context_pack.payload.release_capabilities)
    || value.authorization.attempt_index <= (source.context_pack.payload.imported_execution_repair?.attempt_index ?? 0)) {
    ctx.addIssue({ code: "custom", message: "Repair requires a distinct exact author over the original task, immutable inputs and increasing original goal retry index" });
  }
});
export function importedExecutionRepairContextV1(input: Pick<ImportedExecutionRepairRequestV1,
  "repair_id" | "execution_request" | "source" | "review_id" | "review_request_digest" | "review_result_digest" | "authorization">) {
  return ImportedExecutionRepairContextV1Schema.parse({ version: 1, repair_id: input.repair_id, base_execution_id: input.execution_request.execution_id,
    review_id: input.review_id, review_request_digest: input.review_request_digest, review_result_digest: input.review_result_digest,
    authorization_event_id: input.authorization.event_id, attempt_index: input.authorization.attempt_index, initial_subject_digest: input.source.subject_digest });
}
export function inspectImportedExecutionRepairRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionRepairRequestV1 {
  const value = ImportedExecutionRepairRequestV1Schema.parse(input);
  inspectImportedImplementationSourceV1(value.execution_request, value.source, researchBytes, sha);
  if (canonical(value.run_start.context_pack.payload.imported_execution_repair) !== canonical(importedExecutionRepairContextV1(value)))
    throw Error("Repair context differs from its rejected review, source or independent authorization");
  return value;
}
export function importedExecutionRepairRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedExecutionRepairRequestV1Schema.parse(input))));
}
export const ImportedExecutionRepairControlV1Schema = z.object({ version: z.literal(1), repair_id: id, request_digest: digest, run_id: id }).strict();
export type ImportedExecutionRepairControlV1 = z.infer<typeof ImportedExecutionRepairControlV1Schema>;
export const ImportedCompletedExecutionRepairV1Schema = z.object({ version: z.literal(1), stage: z.literal("implementation"), repair_id: id,
  request_digest: digest, run_id: id, run_start_digest: digest, author: agent,
  destination: z.object({ node_id: id, workspace_root: z.string().min(1).max(4096), profile_id: id, profile_digest: digest }).strict(),
  initial_subject_digest: digest, subject_digest: digest, base_execution_id: id, review_id: id, review_request_digest: digest, review_result_digest: digest,
  authorization_event_id: id, attempt_index: z.number().int().positive(), transfer_id: id, source_export_digest: digest, mapping_digest: digest, research_provenance_digest: digest,
  closure: z.literal("windows-job-and-tools-closed.v1"), scope: z.literal("all-declared-workspace-implementation-cases"), verification: RunVerificationPayloadSchema }).strict();
export type ImportedCompletedExecutionRepairV1 = z.infer<typeof ImportedCompletedExecutionRepairV1Schema>;
const base = { version: z.literal(1), repair_id: id, request_digest: digest, run_id: id };
export const ImportedExecutionRepairResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("finished"), closed: z.literal(true), verified_repair: ImportedCompletedExecutionRepairV1Schema.optional() }).strict(),
  z.object({ ...base, outcome: z.literal("failed"), closed: z.literal(true), reason }).strict(),
  z.object({ ...base, outcome: z.literal("cancelled_before_start"), closed: z.literal(true) }).strict(),
  z.object({ ...base, outcome: z.literal("uncertain"), closed: z.literal(false), reason }).strict(),
]);
export type ImportedExecutionRepairResultV1 = z.infer<typeof ImportedExecutionRepairResultV1Schema>;
export function inspectImportedCompletedExecutionRepairV1(request: ImportedExecutionRepairRequestV1, input: unknown, sha: SourceOperationSha): ImportedCompletedExecutionRepairV1 {
  const value = ImportedCompletedExecutionRepairV1Schema.parse(input), start = request.run_start, mapped = start.context_pack.payload.transferred_product_input!;
  const destination = request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const evidence = inspectImportedImplementationVerificationV1(request.execution_request, value.verification);
  if (value.repair_id !== request.repair_id || value.request_digest !== importedExecutionRepairRequestDigestV1(request, sha)
    || value.run_id !== start.run_id || value.run_start_digest !== sha(canonical(start)) || canonical(value.author) !== canonical(request.writer)
    || canonical(value.destination) !== canonical({ node_id: destination.node_id, workspace_root: destination.workspace_root,
      profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest })
    || value.initial_subject_digest !== request.source.subject_digest || value.subject_digest !== evidence.subject_digest || evidence.request_id !== start.verification!.request_id
    || value.base_execution_id !== request.execution_request.execution_id || value.review_id !== request.review_id
    || value.review_request_digest !== request.review_request_digest || value.review_result_digest !== request.review_result_digest
    || value.authorization_event_id !== request.authorization.event_id || value.attempt_index !== request.authorization.attempt_index
    || value.transfer_id !== mapped.transfer_id || value.source_export_digest !== mapped.source_export_digest || value.mapping_digest !== mapped.mapping_digest
    || value.research_provenance_digest !== mapped.research_provenance_digest) throw Error("Repair completion differs from its one-use author, rejected review, original authorization or final evidence");
  return value;
}
export function inspectImportedExecutionRepairResultV1(requestInput: unknown, input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha): ImportedExecutionRepairResultV1 {
  const request = inspectImportedExecutionRepairRequestV1(requestInput, researchBytes, sha), result = ImportedExecutionRepairResultV1Schema.parse(input);
  if (result.repair_id !== request.repair_id || result.request_digest !== importedExecutionRepairRequestDigestV1(request, sha) || result.run_id !== request.run_start.run_id)
    throw Error("Repair result differs from its exact request");
  if (result.outcome === "finished" && result.verified_repair) inspectImportedCompletedExecutionRepairV1(request, result.verified_repair, sha);
  return result;
}
