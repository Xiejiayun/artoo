import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema, productSourceOperationDigestV1 } from "@artoo/domain";
import { inspectProductSourceVerificationEnvelope } from "@artoo/domain";
import { canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { importedProductReviewSubjectV1, importedProductReviewRequestDigestV1,
  type ImportedProductReviewRequestV1, type ImportedProductReviewResultV1 } from "@artoo/domain";
import { productDevelopmentContext } from "@artoo/domain";
import { ContextPackSchema } from "@artoo/domain";
import { importedDesignContinuationRequestDigestV1, inspectImportedDesignContinuationRequestV1, transferredProductInputV1,
  inspectImportedDesignContinuationResultV1, type ImportedDesignContinuationRequestV1, type ImportedDesignRunStartV1 } from "@artoo/domain";
import { ImportedDesignContinuationControlV1Schema } from "@artoo/domain";
import { inspectImportedDesignVerificationEnvelopeV1, importedDesignVerificationEchoV1 } from "@artoo/domain";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const recorded = JSON.parse(readFileSync(new URL("../../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));

/** Recorded H1 bytes plus controlled H2 receipts. No native/model execution is claimed by this fixture. */
export function importedDesignRequestFixture() {
  const bytes = new TextEncoder().encode(recorded.research);
  const operation = ProductSourceOperationV1Schema.parse({ version: 1, operation_id: "import-operation", kind: "import_verify",
    request_digest: recorded.fresh.request_digest, intent: { version: 1, request: recorded.admission.request,
      next_task_id: "design-next", destination_start: recorded.admission.run_start } });
  const result = ProductSourceOperationResultV1Schema.parse({ version: 1, operation_id: operation.operation_id,
    payload_digest: productSourceOperationDigestV1(operation, sha), request_digest: operation.request_digest,
    outcome: "verified", closed: true, admission: recorded.admission, fresh: recorded.fresh });
  const original = operation.intent.destination_start;
  const before = structuredClone(original), after = structuredClone(original), review = structuredClone(original);
  before.run_id = "review-before"; before.verification!.request_id = "request-before";
  after.run_id = "review-after"; after.verification!.request_id = "request-after";
  review.run_id = "review-agent"; review.task_id = "review-task"; review.agent_instance_id = "review-instance";
  review.verification!.request_id = "request-review";
  const context = review.context_pack.payload!;
  context.task.id = review.task_id; delete context.product_development; delete context.review_subject;
  context.policy.execution_mode = "discussion"; context.policy.filesystem_write_scope = [];
  review.policy_snapshot.filesystem_write_scope = [];
  const base = { review_id: "imported-review", operation, result, source_author: { instance_id: "source-instance", agent_id: "author-agent" },
    reviewer: { instance_id: "review-instance", agent_id: "review-agent" } };
  context.imported_review_subject = importedProductReviewSubjectV1(base, sha);
  const reviewRequest: ImportedProductReviewRequestV1 = { version: 1, ...base, review_start: review, before_start: before, after_start: after };
  const measurement = (start: typeof original) => {
    const envelope = structuredClone(recorded.admission); envelope.run_start = start;
    const inspected = inspectProductSourceVerificationEnvelope(envelope, bytes, sha), fresh = structuredClone(recorded.fresh);
    fresh.destination_run_id = start.run_id; fresh.admission_digest = inspected.admission_digest;
    fresh.verification.request_id = start.verification!.request_id;
    return { admission: inspected.envelope, fresh };
  };
  const reviewResult: ImportedProductReviewResultV1 = { version: 1, review_id: reviewRequest.review_id,
    request_digest: importedProductReviewRequestDigestV1(reviewRequest, sha), execution_authorized: false,
    outcome: "reviewed", closed: true, before: measurement(before), after: measurement(after),
    reviewer: { run_id: review.run_id, config_digest: sha(canonical(review)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: reviewRequest.review_id, transfer_id: operation.intent.request.byte_request.transfer_id,
      subject_digest: context.imported_review_subject.subject_digest, source_export_digest: operation.intent.request.source_export_digest,
      outcome: "accepted", summary: "Controlled protocol fixture; no new native/model execution", findings: [] } };
  const continuation = { continuation_id: "design-continuation", review_request: reviewRequest, review_result: reviewResult };
  const transferred = transferredProductInputV1(continuation, sha);
  const cloned = structuredClone(original), source = operation.intent.request.byte_request.source;
  cloned.run_id = "design-run"; cloned.task_id = operation.intent.next_task_id; cloned.agent_instance_id = "design-instance";
  cloned.verification!.request_id = "design-verification"; delete cloned.verification!.expected_subject_digest;
  const payload = cloned.context_pack.payload!;
  payload.task.id = cloned.task_id; payload.task.title = "Design the journal";
  delete payload.policy.execution_mode; payload.policy.filesystem_write_scope = [cloned.workspace.root];
  cloned.policy_snapshot.filesystem_write_scope = [...payload.policy.filesystem_write_scope];
  cloned.policy_snapshot.requires_approval = [...payload.policy.requires_approval];
  payload.product_development = productDevelopmentContext("design", payload.verification_capabilities, payload.release_capabilities);
  payload.product_development.accepted_inputs = { version: 1, files: [{ ...operation.intent.request.source_export.research_provenance.research,
    source_task_id: source.task_id, source_run_id: source.run_id, evidence_id: source.evidence_id }] };
  const start: ImportedDesignRunStartV1 = { ...cloned, context_pack: { id: "design-context", payload: { ...payload, transferred_product_input: transferred } } };
  const request: ImportedDesignContinuationRequestV1 = { version: 1, ...continuation,
    writer: { instance_id: start.agent_instance_id, agent_id: "design-agent" }, run_start: start };
  return { request, bytes };
}
