import { z } from "zod";
import { ImportedExecutionReviewRequestV1Schema, importedExecutionReviewRequestDigestV1, inspectImportedExecutionReviewRequestV1 } from "./imported-execution-review.js";
import { ImportedExecutionRepairRequestV1Schema, importedExecutionRepairRequestDigestV1, inspectImportedExecutionRepairRequestV1 } from "./imported-execution-repair.js";
import { importedExecutionAcceptedInputsV1, type ImportedExecutionRequestV1 } from "./imported-execution.js";
import { importedImplementationSourceDigestV1 } from "./imported-implementation-source.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { ProductDesignSchema, ProductResearchReportSchema } from "./product-development.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const binding = { version: z.literal(1), request_digest: digest, run_id: id, verification_request_id: id, subject_digest: digest };
export const ImportedExecutionReviewVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedExecutionReviewRequestV1Schema, phase: z.enum(["before", "after"]) }).strict().superRefine((value, ctx) => {
  const start = value.phase === "before" ? value.request.before_start : value.request.after_start;
  if (value.run_id !== start.run_id || value.verification_request_id !== start.verification?.request_id || value.subject_digest !== value.request.source.subject_digest)
    ctx.addIssue({ code: "custom", message: "H6 envelope requires its exact source, run and before/after verification request" });
});
export type ImportedExecutionReviewVerificationEnvelopeV1 = z.infer<typeof ImportedExecutionReviewVerificationEnvelopeV1Schema>;
export const ImportedExecutionRepairVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedExecutionRepairRequestV1Schema, scope: z.enum(["preview", "final"]) }).strict().superRefine((value, ctx) => {
  if (value.run_id !== value.request.run_start.run_id || (value.scope === "final"
    ? value.verification_request_id !== value.request.run_start.verification?.request_id
    : value.verification_request_id === value.request.run_start.verification?.request_id))
    ctx.addIssue({ code: "custom", message: "Repair envelope requires its exact run and preview/final verification request" });
});
export type ImportedExecutionRepairVerificationEnvelopeV1 = z.infer<typeof ImportedExecutionRepairVerificationEnvelopeV1Schema>;
function research(execution: ImportedExecutionRequestV1, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const pin = importedExecutionAcceptedInputsV1(execution).files[1]!;
  if (design.byteLength !== pin.size || sha(design) !== pin.checksum) throw Error("Implementation verifier accepted design bytes changed");
  ProductDesignSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(design)));
  const accepted = execution.review_request.continuation_request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("Implementation verifier lacks original imported research");
  const mapped = inspectProductSourceVerificationEnvelope(accepted.after.admission, bytes, sha);
  return ProductResearchReportSchema.parse({ ...JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)), measurement_plan: mapped.effective_plan });
}
export function inspectImportedExecutionReviewVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedExecutionReviewVerificationEnvelopeV1Schema.parse(input), request = inspectImportedExecutionReviewRequestV1(envelope.request, bytes, sha);
  const start = envelope.phase === "before" ? request.before_start : request.after_start;
  if (envelope.request_digest !== importedExecutionReviewRequestDigestV1(request, sha) || envelope.run_id !== start.run_id
    || envelope.verification_request_id !== start.verification!.request_id || envelope.subject_digest !== request.source.subject_digest)
    throw Error("H6 private verifier differs from its exact source and phase");
  return { envelope, research: research(request.execution_request, bytes, design, sha) };
}
export function inspectImportedExecutionRepairVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedExecutionRepairVerificationEnvelopeV1Schema.parse(input), request = inspectImportedExecutionRepairRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedExecutionRepairRequestDigestV1(request, sha) || envelope.run_id !== request.run_start.run_id
    || (envelope.scope === "final" ? envelope.verification_request_id !== request.run_start.verification!.request_id
      : envelope.verification_request_id === request.run_start.verification!.request_id)) throw Error("Repair private verifier differs from its exact invocation");
  return { envelope, research: research(request.execution_request, bytes, design, sha) };
}
export function importedExecutionReviewVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedExecutionReviewVerificationEnvelopeV1Schema.parse(input);
  const destination = value.request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (value.request_digest !== importedExecutionReviewRequestDigestV1(value.request, sha)
    || !destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("H6 verifier request digest or command changed");
  return { version: 1 as const, stage: "implementation" as const, review_id: value.request.review_id, request_digest: value.request_digest,
    run_id: value.run_id, verification_request_id: value.verification_request_id, phase: value.phase, subject_digest: value.subject_digest,
    source_digest: importedImplementationSourceDigestV1(value.request.source, sha), command_id: commandId };
}
export function importedExecutionRepairVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedExecutionRepairVerificationEnvelopeV1Schema.parse(input);
  const destination = value.request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (value.request_digest !== importedExecutionRepairRequestDigestV1(value.request, sha)
    || !destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("Repair verifier request digest or command changed");
  return { version: 1 as const, stage: "implementation" as const, repair_id: value.request.repair_id, request_digest: value.request_digest,
    run_id: value.run_id, verification_request_id: value.verification_request_id, scope: value.scope, subject_digest: value.subject_digest,
    review_result_digest: value.request.review_result_digest, authorization_event_id: value.request.authorization.event_id,
    attempt_index: value.request.authorization.attempt_index, source_digest: importedImplementationSourceDigestV1(value.request.source, sha), command_id: commandId };
}
