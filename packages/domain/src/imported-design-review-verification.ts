import { z } from "zod";
import { ImportedDesignReviewRequestV1Schema, importedDesignReviewRequestDigestV1, importedDesignReviewSubjectV1,
  inspectImportedDesignReviewRequestV1 } from "./imported-design-review.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { ProductResearchReportSchema } from "./product-development.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Private, phase-specific H4 data. It neither revives H3 nor recreates a node permit. */
export const ImportedDesignReviewVerificationEnvelopeV1Schema = z.object({
  version: z.literal(1), request: ImportedDesignReviewRequestV1Schema, request_digest: digest,
  phase: z.enum(["before", "after"]), run_id: id, verification_request_id: id,
  scope: z.literal("final"), subject_digest: digest,
}).strict().superRefine((value, ctx) => {
  const start = value.phase === "before" ? value.request.before_start : value.request.after_start;
  if (value.run_id !== start.run_id || value.verification_request_id !== start.verification?.request_id
    || value.subject_digest !== start.verification?.expected_subject_digest) ctx.addIssue({ code: "custom", message: "H4 verifier must bind the exact phase, invocation and completed source" });
});
export type ImportedDesignReviewVerificationEnvelopeV1 = z.infer<typeof ImportedDesignReviewVerificationEnvelopeV1Schema>;
export function inspectImportedDesignReviewVerificationEnvelopeV1(input: unknown, bytes: Uint8Array, sha: SourceOperationSha) {
  const envelope = ImportedDesignReviewVerificationEnvelopeV1Schema.parse(input);
  const request = inspectImportedDesignReviewRequestV1(envelope.request, bytes, sha);
  if (envelope.request_digest !== importedDesignReviewRequestDigestV1(request, sha)) throw Error("H4 private request changed");
  const accepted = request.continuation_request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("H4 requires accepted original imported research");
  const original = inspectProductSourceVerificationEnvelope(accepted.after.admission, bytes, sha);
  const research = ProductResearchReportSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)));
  return { envelope, research: ProductResearchReportSchema.parse({ ...research, measurement_plan: original.effective_plan }) };
}
export function importedDesignReviewVerificationEchoV1(input: unknown, commandId: string, sha: SourceOperationSha) {
  const envelope = ImportedDesignReviewVerificationEnvelopeV1Schema.parse(input), request = envelope.request;
  const subject = importedDesignReviewSubjectV1(request, sha);
  const destination = request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (envelope.request_digest !== importedDesignReviewRequestDigestV1(request, sha)
    || !destination.capabilities.checks.some(check => check.command_id === commandId)) throw Error("H4 echo requires the exact command and request");
  return { version: 1 as const, review_id: request.review_id, request_digest: envelope.request_digest, phase: envelope.phase,
    run_id: envelope.run_id, verification_request_id: envelope.verification_request_id, scope: envelope.scope,
    subject_digest: envelope.subject_digest, command_id: commandId, completed_design_digest: subject.completed_design_digest,
    mapping_digest: subject.mapping_digest, research_provenance_digest: subject.research_provenance_digest, source_export_digest: subject.source_export_digest };
}
