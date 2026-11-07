import { z } from "zod";
import { RunStartPayloadSchema, type RunStartPayload } from "./node-payloads.js";
import { ContextPackSchema, type ContextPack } from "./context-pack.js";
import { RunVerificationPayloadSchema, VerificationRequirementSchema, type RunVerificationPayload } from "./autonomy.js";
import { inspectImportedExecutionRequestV1, importedExecutionRequestDigestV1, importedExecutionAcceptedInputsV1,
  type ImportedExecutionRequestV1 } from "./imported-execution.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export interface ImportedImplementationRunStartV1 extends Omit<RunStartPayload, "context_pack" | "verification"> {
  context_pack: { id: string; payload: ContextPack }; verification: z.infer<typeof VerificationRequirementSchema>;
}
/** Private continuation authority requires the full inline context, never a URI to later resolve. */
export const ImportedImplementationRunStartV1Schema: z.ZodType<ImportedImplementationRunStartV1> = RunStartPayloadSchema.extend({
  context_pack: z.object({ id, payload: ContextPackSchema.extend({
    imported_clean_validation: z.never().optional(), imported_clean_validation_review_subject: z.never().optional(),
    imported_recovery_validation: z.never().optional(), imported_recovery_validation_review_subject: z.never().optional(),
  }) }).strict(),
  verification: VerificationRequirementSchema,
});
export const ImportedImplementationSourceV1Schema = z.object({ version: z.literal(1), kind: z.enum(["execution", "repair"]),
  operation_id: id, request_digest: digest, result_digest: digest, author: z.object({ agent_id: id, instance_id: id }).strict(),
  run_start: ImportedImplementationRunStartV1Schema, subject_digest: digest, verification: RunVerificationPayloadSchema }).strict();
export type ImportedImplementationSourceV1 = z.infer<typeof ImportedImplementationSourceV1Schema>;
export function importedImplementationSourceDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ImportedImplementationSourceV1Schema.parse(input))));
}
/** Fixed accepted programs, complete viewports and file pins; fresh traces/images remain independent. */
export function inspectImportedImplementationVerificationV1(execution: ImportedExecutionRequestV1,
  input: unknown): RunVerificationPayload {
  const value = RunVerificationPayloadSchema.parse(input), reviewed = execution.review_result;
  if (reviewed.outcome !== "reviewed") throw Error("Implementation requires original accepted H4 evidence");
  const prior = reviewed.after.verification, destination = execution.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const cases = (check: RunVerificationPayload["checks"][number]) => check.observation?.version === 3
    ? check.observation.cases.map(item => canonical({ case_id: item.case_id, viewport: item.viewport, program_digest: item.program_digest })).sort() : [];
  if (value.outcome !== "passed" || !value.subject_digest || value.profile_id !== destination.profile_id
    || value.profile_digest !== destination.capabilities.profile_digest || value.product_design_revision
    || value.measurement_plan?.version !== 2 || value.measurement_plan.scope !== "final"
    || canonical(value.measurement_plan) !== canonical(prior.measurement_plan)
    || canonical(value.checks.map(check => check.id).sort()) !== canonical(prior.checks.map(check => check.id).sort())
    || new Set(value.checks.map(check => check.id)).size !== value.checks.length || !value.checks.length
    || value.checks.some(check => {
      const old = prior.checks.find(item => item.id === check.id), bound = destination.capabilities.checks.find(item => item.command_id === check.id), actual = cases(check);
      return !old || !bound || !actual.length || new Set(actual).size !== actual.length || canonical(actual) !== canonical(cases(old))
        || check.exit_code !== 0 || check.observation?.version !== 3 || check.observation.stage !== "implementation" || check.observation.scope !== "final"
        || !check.observation.evidence_bundle || check.observation.capability_binding?.config_digest !== bound.config_digest
        || check.observation.capability_binding?.contract_digest !== bound.contract_digest;
    }) || importedExecutionAcceptedInputsV1(execution).files.some(pin => !value.required_files.some(file => file.path === pin.path
      && file.checksum === pin.checksum && file.size === pin.size))
    || !value.required_files.some(file => file.path === ".artoo/product/implementation.md" && file.size > 0)) {
    throw Error("Implementation verification differs from the complete accepted cases, destination or immutable inputs");
  }
  return value;
}
export function inspectImportedImplementationSourceV1(executionInput: unknown, input: unknown, researchBytes: Uint8Array,
  sha: SourceOperationSha): ImportedImplementationSourceV1 {
  const execution = inspectImportedExecutionRequestV1(executionInput, researchBytes, sha), value = ImportedImplementationSourceV1Schema.parse(input);
  const start = value.run_start, context = start.context_pack.payload, original = execution.run_start;
  inspectImportedImplementationVerificationV1(execution, value.verification);
  if (start.task_id !== original.task_id || start.agent_instance_id !== value.author.instance_id || start.runtime === "mock"
    || start.workspace.root !== original.workspace.root || start.workspace.branch != null || start.workspace_allocation
    || context.workspace.root !== original.workspace.root || context.product_development?.stage !== "implementation"
    || context.task.id !== start.task_id || context.policy.execution_mode !== undefined
    || context.imported_execution_review_subject || context.imported_design_review_subject || context.imported_review_subject || context.review_subject || context.imported_validation || context.imported_validation_review_subject || context.product_design_revision
    || canonical(context.project) !== canonical(original.context_pack.payload.project)
    || canonical(context.goal_context) !== canonical(original.context_pack.payload.goal_context)
    || canonical(context.product_development.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(execution))
    || canonical(context.transferred_product_input) !== canonical(original.context_pack.payload.transferred_product_input)
    || canonical(context.verification_capabilities) !== canonical(original.context_pack.payload.verification_capabilities)
    || canonical(context.release_capabilities) !== canonical(original.context_pack.payload.release_capabilities)
    || canonical(context.policy) !== canonical(original.context_pack.payload.policy) || canonical(start.policy_snapshot) !== canonical(original.policy_snapshot)
    || !start.verification || start.verification.expected_subject_digest !== undefined
    || canonical({ ...start.verification, request_id: original.verification!.request_id }) !== canonical(original.verification)
    || value.verification.request_id !== start.verification.request_id || value.verification.subject_digest !== value.subject_digest) throw Error("Implementation source differs from its exact author and original H5 bindings");
  if (value.kind === "execution") {
    if (value.operation_id !== execution.execution_id || value.request_digest !== importedExecutionRequestDigestV1(execution, sha)
      || canonical(start) !== canonical(original) || canonical(value.author) !== canonical(execution.writer) || context.imported_execution_repair) throw Error("H6 execution source differs from original H5");
  } else if (context.imported_execution || !context.imported_execution_repair || context.imported_execution_repair.repair_id !== value.operation_id
    || context.imported_execution_repair.base_execution_id !== execution.execution_id || start.run_id === original.run_id
    || start.verification.request_id === original.verification!.request_id) throw Error("H6 repair source requires its distinct exact repair descriptor");
  return value;
}
