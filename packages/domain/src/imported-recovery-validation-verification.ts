import { z } from "zod";
import { ImportedRecoveryValidationRequestV1Schema, importedRecoveryValidationRequestDigestV1,
  inspectImportedRecoveryValidationRequestV1, importedRecoveryValidationSourceDigestV1 } from "./imported-recovery-validation.js";
import { ImportedRecoveryValidationReviewRequestV1Schema, importedRecoveryValidationReviewRequestDigestV1,
  inspectImportedRecoveryValidationReviewRequestV1 } from "./imported-recovery-validation-review.js";
import { type ImportedValidationOriginV1 } from "./imported-validation.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ProductDesignSchema, ProductResearchReportSchema } from "./product-development.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { productSourceRecoveryCheckpointDigestV1 } from "./source-recovery.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const binding = { version: z.literal(1), request_digest: digest, run_id: id, verification_request_id: id, subject_digest: digest };
export const ImportedRecoveryValidationVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedRecoveryValidationRequestV1Schema, scope: z.enum(["preview", "final"]) }).strict().superRefine((value, ctx) => {
  if (value.run_id !== value.request.run_start.run_id || (value.scope === "final"
    ? value.verification_request_id !== value.request.run_start.verification.request_id
    : value.verification_request_id === value.request.run_start.verification.request_id))
    ctx.addIssue({ code: "custom", message: "Recovery verifier requires its exact fresh author run and preview/final request" });
});
export type ImportedRecoveryValidationVerificationEnvelopeV1 = z.infer<typeof ImportedRecoveryValidationVerificationEnvelopeV1Schema>;
export const ImportedRecoveryValidationReviewVerificationEnvelopeV1Schema = z.object({ ...binding,
  request: ImportedRecoveryValidationReviewRequestV1Schema, phase: z.enum(["before", "after"]) }).strict().superRefine((value, ctx) => {
  const start = value.phase === "before" ? value.request.before_start : value.request.after_start;
  if (value.run_id !== start.run_id || value.verification_request_id !== start.verification.request_id || value.subject_digest !== value.request.source.subject_digest)
    ctx.addIssue({ code: "custom", message: "Recovery review verifier requires its exact final source and before/after request" });
});
export type ImportedRecoveryValidationReviewVerificationEnvelopeV1 = z.infer<typeof ImportedRecoveryValidationReviewVerificationEnvelopeV1Schema>;

function research(origin: ImportedValidationOriginV1, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const pin = importedExecutionAcceptedInputsV1(origin.execution_request).files.find(file => file.path === ".artoo/product/design.json");
  if (!pin || design.byteLength !== pin.size || sha(design) !== pin.checksum) throw Error("Recovery verifier accepted design bytes changed");
  ProductDesignSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(design)));
  const accepted = origin.execution_request.review_request.continuation_request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("Recovery verifier lacks original accepted imported research");
  const mapped = inspectProductSourceVerificationEnvelope(accepted.after.admission, bytes, sha);
  return ProductResearchReportSchema.parse({ ...JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)), measurement_plan: mapped.effective_plan });
}
export function inspectImportedRecoveryValidationVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedRecoveryValidationVerificationEnvelopeV1Schema.parse(input);
  const request = inspectImportedRecoveryValidationRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedRecoveryValidationRequestDigestV1(request, sha)) throw Error("Recovery private verifier changed its exact invocation");
  return { envelope, research: research(request.origin, bytes, design, sha) };
}
export function inspectImportedRecoveryValidationReviewVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, design: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedRecoveryValidationReviewVerificationEnvelopeV1Schema.parse(input);
  const request = inspectImportedRecoveryValidationReviewRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedRecoveryValidationReviewRequestDigestV1(request, sha)) throw Error("Recovery review private verifier changed its exact source or phase");
  return { envelope, research: research(request.origin, bytes, design, sha) };
}
function command(origin: ImportedValidationOriginV1, commandId: string) {
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (!destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("Recovery verifier command is outside the original protected profile");
}
export function importedRecoveryValidationVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedRecoveryValidationVerificationEnvelopeV1Schema.parse(input); command(value.request.origin, commandId);
  if (value.request_digest !== importedRecoveryValidationRequestDigestV1(value.request, sha)) throw Error("Recovery verifier request digest changed");
  return { version: 1 as const, stage: "validation" as const, recovery_id: value.request.recovery_id,
    checkpoint_digest: productSourceRecoveryCheckpointDigestV1(value.request.checkpoint, sha), epoch_id: value.request.checkpoint.new_epoch_id,
    validation_id: value.request.validation_id, root_validation_id: value.request.root_validation_id,
    request_digest: value.request_digest, run_id: value.run_id, verification_request_id: value.verification_request_id, scope: value.scope,
    subject_digest: value.subject_digest, authorization_event_id: value.request.authorization.event_id, attempt_index: value.request.authorization.attempt_index, command_id: commandId };
}
export function importedRecoveryValidationReviewVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const value = ImportedRecoveryValidationReviewVerificationEnvelopeV1Schema.parse(input); command(value.request.origin, commandId);
  if (value.request_digest !== importedRecoveryValidationReviewRequestDigestV1(value.request, sha)) throw Error("Recovery review verifier request digest changed");
  return { version: 1 as const, stage: "validation" as const, recovery_id: value.request.recovery_id,
    checkpoint_digest: productSourceRecoveryCheckpointDigestV1(value.request.checkpoint, sha), epoch_id: value.request.checkpoint.new_epoch_id,
    validation_id: value.request.source.validation_id, review_id: value.request.review_id,
    request_digest: value.request_digest, source_digest: importedRecoveryValidationSourceDigestV1(value.request.source, sha), run_id: value.run_id,
    verification_request_id: value.verification_request_id, phase: value.phase, subject_digest: value.subject_digest,
    authorization_event_id: value.request.authorization.event_id, attempt_index: value.request.authorization.attempt_index, command_id: commandId };
}
