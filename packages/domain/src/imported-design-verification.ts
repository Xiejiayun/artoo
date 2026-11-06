import { z } from "zod";
import { ImportedDesignContinuationRequestV1Schema, importedDesignContinuationRequestDigestV1,
  inspectImportedDesignContinuationRequestV1 } from "./imported-design-continuation.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { ProductResearchReportSchema } from "./product-development.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Private verifier data only. Neither inspection nor a child echo grants writer authority. */
export const ImportedDesignVerificationEnvelopeV1Schema = z.object({
  version: z.literal(1), request: ImportedDesignContinuationRequestV1Schema,
  request_digest: digest, run_id: id, verification_request_id: id,
  scope: z.enum(["preview", "final"]), subject_digest: digest,
}).strict().superRefine((value, ctx) => {
  const start = value.request.run_start;
  if (value.run_id !== start.run_id || (value.scope === "final"
    ? value.verification_request_id !== start.verification?.request_id
    : value.verification_request_id === start.verification?.request_id)) {
    ctx.addIssue({ code: "custom", message: "Imported design verification requires its exact run and phase-specific request identity" });
  }
});
export type ImportedDesignVerificationEnvelopeV1 = z.infer<typeof ImportedDesignVerificationEnvelopeV1Schema>;

export function inspectImportedDesignVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedDesignVerificationEnvelopeV1Schema.parse(input);
  const request = inspectImportedDesignContinuationRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedDesignContinuationRequestDigestV1(request, sha)) {
    throw Error("Imported design private verifier request changed");
  }
  if (request.review_result.outcome !== "reviewed") throw Error("Accepted imported research review is required");
  const original = inspectProductSourceVerificationEnvelope(request.review_result.after.admission, bytes, sha);
  const research = ProductResearchReportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  // A design author changes the full subject; only the accepted research bytes
  // retain their old checksum. The original report file is never rewritten.
  return { envelope, research: ProductResearchReportSchema.parse({ ...research, measurement_plan: original.effective_plan }) };
}

export function importedDesignVerificationEchoV1(envelopeInput: unknown, commandId: string, sha: SourceOperationSha) {
  const envelope = ImportedDesignVerificationEnvelopeV1Schema.parse(envelopeInput), request = envelope.request;
  const transfer = request.review_request.operation.intent.request;
  if (envelope.request_digest !== importedDesignContinuationRequestDigestV1(request, sha)
    || !transfer.byte_request.destination.capabilities.checks.some(check => check.command_id === commandId)) {
    throw Error("Imported design verifier echo requires the exact request and destination command");
  }
  return { version: 1 as const, continuation_id: request.continuation_id, request_digest: envelope.request_digest,
    run_id: envelope.run_id, verification_request_id: envelope.verification_request_id, scope: envelope.scope,
    subject_digest: envelope.subject_digest, command_id: commandId,
    mapping_digest: request.run_start.context_pack.payload.transferred_product_input.mapping_digest,
    research_provenance_digest: transfer.source_export.research_provenance_digest, source_export_digest: transfer.source_export_digest };
}
