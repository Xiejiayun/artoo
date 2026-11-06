import { z } from "zod";
import { ImportedValidationRequestV1Schema, importedValidationRequestDigestV1, inspectImportedValidationRequestV1,
  importedValidationSourceDigestV1, type ImportedValidationOriginV1 } from "./imported-validation.js";
import { ImportedValidationReviewRequestV1Schema, importedValidationReviewRequestDigestV1, inspectImportedValidationReviewRequestV1 } from "./imported-validation-review.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ProductDesignSchema, ProductResearchReportSchema } from "./product-development.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import type { SourceOperationSha } from "./product-source-operations.js";
const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const binding = { version: z.literal(1), request_digest: digest, run_id: id, verification_request_id: id, subject_digest: digest };
export const ImportedValidationVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedValidationRequestV1Schema, scope: z.enum(["preview", "final"]) }).strict().superRefine((value, ctx) => {
  if (value.run_id !== value.request.run_start.run_id || (value.scope === "final"
    ? value.verification_request_id !== value.request.run_start.verification.request_id : value.verification_request_id === value.request.run_start.verification.request_id))
    ctx.addIssue({ code: "custom", message: "Validation verifier requires its exact author run and preview/final request" });
});
export type ImportedValidationVerificationEnvelopeV1 = z.infer<typeof ImportedValidationVerificationEnvelopeV1Schema>;
export const ImportedValidationReviewVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedValidationReviewRequestV1Schema, phase: z.enum(["before", "after"]) }).strict().superRefine((value, ctx) => {
  const start = value.phase === "before" ? value.request.before_start : value.request.after_start;
  if (value.run_id !== start.run_id || value.verification_request_id !== start.verification.request_id || value.subject_digest !== value.request.source.subject_digest)
    ctx.addIssue({ code: "custom", message: "Validation review verifier requires its exact source and before/after request" });
});
export type ImportedValidationReviewVerificationEnvelopeV1 = z.infer<typeof ImportedValidationReviewVerificationEnvelopeV1Schema>;
function research(origin: ImportedValidationOriginV1, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const pin = importedExecutionAcceptedInputsV1(origin.execution_request).files.find(file => file.path === ".artoo/product/design.json")!;
  if (design.byteLength !== pin.size || sha(design) !== pin.checksum) throw Error("Validation verifier accepted design bytes changed");
  ProductDesignSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(design)));
  const accepted = origin.execution_request.review_request.continuation_request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("Validation verifier lacks accepted imported research");
  const mapped = inspectProductSourceVerificationEnvelope(accepted.after.admission, bytes, sha);
  return ProductResearchReportSchema.parse({ ...JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)), measurement_plan: mapped.effective_plan });
}
export function inspectImportedValidationVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedValidationVerificationEnvelopeV1Schema.parse(input), request = inspectImportedValidationRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedValidationRequestDigestV1(request, sha) || envelope.run_id !== request.run_start.run_id
    || (envelope.scope === "final" ? envelope.verification_request_id !== request.run_start.verification.request_id
      : envelope.verification_request_id === request.run_start.verification.request_id)) throw Error("Validation private verifier changed its exact invocation");
  return { envelope, research: research(request.origin, bytes, design, sha) };
}
export function inspectImportedValidationReviewVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedValidationReviewVerificationEnvelopeV1Schema.parse(input), request = inspectImportedValidationReviewRequestV1(envelope.request, bytes, sha);
  const start = envelope.phase === "before" ? request.before_start : request.after_start;
  if (envelope.request_digest !== importedValidationReviewRequestDigestV1(request, sha) || envelope.run_id !== start.run_id
    || envelope.verification_request_id !== start.verification.request_id || envelope.subject_digest !== request.source.subject_digest)
    throw Error("Validation review private verifier changed its exact source or phase");
  return { envelope, research: research(request.origin, bytes, design, sha) };
}
function command(origin: ImportedValidationOriginV1, commandId: string) {
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (!destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("Validation verifier command is outside the bound original profile");
}
export function importedValidationVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedValidationVerificationEnvelopeV1Schema.parse(input); command(value.request.origin, commandId);
  if (value.request_digest !== importedValidationRequestDigestV1(value.request, sha)) throw Error("Validation verifier request digest changed");
  return { version: 1 as const, stage: "validation" as const, validation_id: value.request.validation_id, root_validation_id: value.request.root_validation_id,
    request_digest: value.request_digest, run_id: value.run_id, verification_request_id: value.verification_request_id, scope: value.scope,
    subject_digest: value.subject_digest, authorization_event_id: value.request.authorization.event_id, attempt_index: value.request.authorization.attempt_index, command_id: commandId };
}
export function importedValidationReviewVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedValidationReviewVerificationEnvelopeV1Schema.parse(input); command(value.request.origin, commandId);
  if (value.request_digest !== importedValidationReviewRequestDigestV1(value.request, sha)) throw Error("Validation review verifier request digest changed");
  return { version: 1 as const, stage: "validation" as const, validation_id: value.request.source.validation_id, review_id: value.request.review_id,
    request_digest: value.request_digest, source_digest: importedValidationSourceDigestV1(value.request.source, sha), run_id: value.run_id,
    verification_request_id: value.verification_request_id, phase: value.phase, subject_digest: value.subject_digest,
    authorization_event_id: value.request.authorization.event_id, attempt_index: value.request.authorization.attempt_index, command_id: commandId };
}
