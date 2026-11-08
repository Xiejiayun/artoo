import { z } from "zod";
import { ImportedExecutionRequestV1Schema, importedExecutionRequestDigestV1, inspectImportedExecutionRequestV1,
  importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { ProductDesignSchema, ProductResearchReportSchema } from "./product-development.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Private verifier data. Its echo cannot establish author or verifier process closure. */
export const ImportedExecutionVerificationEnvelopeV1Schema = z.object({
  version: z.literal(1), request: ImportedExecutionRequestV1Schema, request_digest: digest,
  run_id: id, verification_request_id: id, scope: z.enum(["preview", "final"]), subject_digest: digest,
}).strict().superRefine((value, ctx) => {
  if (value.run_id !== value.request.run_start.run_id || (value.scope === "final"
    ? value.verification_request_id !== value.request.run_start.verification?.request_id
    : value.verification_request_id === value.request.run_start.verification?.request_id)) {
    ctx.addIssue({ code: "custom", message: "H5 verifier requires its exact run and phase-specific request" });
  }
});
export type ImportedExecutionVerificationEnvelopeV1 = z.infer<typeof ImportedExecutionVerificationEnvelopeV1Schema>;
export function inspectImportedExecutionVerificationEnvelopeV1(input: unknown, researchBytes: Uint8Array, designBytes: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedExecutionVerificationEnvelopeV1Schema.parse(input);
  const request = inspectImportedExecutionRequestV1(envelope.request, researchBytes, sha);
  if (envelope.request_digest !== importedExecutionRequestDigestV1(request, sha)) throw Error("H5 verifier request changed");
  const pin = importedExecutionAcceptedInputsV1(request).files[1]!;
  if (designBytes.byteLength !== pin.size || sha(designBytes) !== pin.checksum) throw Error("H5 accepted design bytes changed");
  ProductDesignSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(designBytes)));
  const accepted = request.review_request.continuation_request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("H5 lacks original accepted imported research");
  const original = inspectProductSourceVerificationEnvelope(accepted.after.admission, researchBytes, sha);
  const research = ProductResearchReportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(researchBytes)));
  return { envelope, research: ProductResearchReportSchema.parse({ ...research, measurement_plan: original.effective_plan }) };
}
export function importedExecutionVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const envelope = ImportedExecutionVerificationEnvelopeV1Schema.parse(input), request = envelope.request;
  const descriptor = request.run_start.context_pack.payload.imported_execution, source = request.run_start.context_pack.payload.transferred_product_input;
  const destination = request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (envelope.request_digest !== importedExecutionRequestDigestV1(request, sha)
    || !destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("H5 verifier echo requires its exact command");
  return { version: 1 as const, stage: "implementation" as const, execution_id: request.execution_id,
    request_digest: envelope.request_digest, run_id: envelope.run_id, verification_request_id: envelope.verification_request_id,
    scope: envelope.scope, subject_digest: envelope.subject_digest, command_id: commandId,
    h4_review_id: descriptor.h4_review_id, h4_result_digest: descriptor.h4_result_digest, acceptance_event_id: request.acceptance_event_id,
    initial_subject_digest: descriptor.initial_subject_digest, mapping_digest: source.mapping_digest,
    research_provenance_digest: source.research_provenance_digest, source_export_digest: source.source_export_digest };
}
