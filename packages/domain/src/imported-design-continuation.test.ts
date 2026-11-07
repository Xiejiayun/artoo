import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema, productSourceOperationDigestV1 } from "./product-source-operations.js";
import { inspectProductSourceVerificationEnvelope } from "./product-source-verification.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import { importedProductReviewSubjectV1, importedProductReviewRequestDigestV1,
  type ImportedProductReviewRequestV1, type ImportedProductReviewResultV1 } from "./imported-product-review.js";
import { productDevelopmentContext } from "./product-development.js";
import { ContextPackSchema } from "./context-pack.js";
import { importedDesignContinuationRequestDigestV1, inspectImportedDesignContinuationRequestV1, transferredProductInputV1,
  inspectImportedDesignContinuationResultV1, type ImportedDesignContinuationRequestV1, type ImportedDesignRunStartV1 } from "./imported-design-continuation.js";
import { ImportedDesignContinuationControlV1Schema } from "./imported-design-continuation.js";
import { inspectImportedDesignVerificationEnvelopeV1, importedDesignVerificationEchoV1 } from "./imported-design-verification.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const recorded = JSON.parse(readFileSync(new URL("../test-fixtures/product-source-operation.json", import.meta.url), "utf8"));

/** Recorded H1 bytes plus controlled H2 receipts. No native/model execution is claimed by this fixture. */
function fixture() {
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

describe("imported research to one design run data binding (controlled review receipts)", () => {
  it("preserves the optional descriptor through ordinary context parsing while keeping older contexts valid", () => {
    const { request } = fixture(), context = request.run_start.context_pack.payload;
    expect(ContextPackSchema.parse(context).transferred_product_input).toEqual(context.transferred_product_input);
    const { transferred_product_input: _descriptor, ...ordinary } = context;
    expect(ContextPackSchema.parse(ordinary)).toEqual(ordinary);
  });
  it("preserves original accepted research and initial digest while permitting a changed final design subject", () => {
    const { request, bytes } = fixture(), inspected = inspectImportedDesignContinuationRequestV1(request, bytes, sha);
    expect(inspected).toEqual(request);
    expect(inspected.run_start.verification?.expected_subject_digest).toBeUndefined();
    expect(inspected.run_start.context_pack.payload.transferred_product_input.initial_subject_digest)
      .toBe(request.review_request.operation.intent.request.byte_request.source.subject_digest);
    expect(importedDesignContinuationRequestDigestV1(request, sha)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(request.review_result.execution_authorized).toBe(false);
  });
  for (const change of ["review-rejected", "review-before", "next-task", "reused-run", "reused-verification", "writer-instance", "workspace",
    "profile", "goal", "accepted-input", "mapping", "initial-subject", "review-result", "continuation-id", "readonly-subject",
    "discussion", "frozen-final-subject", "write-policy", "project-metadata", "both-write-scopes", "uri"] as const) {
    it(`rejects ${change} substitution`, () => {
      const { request, bytes } = fixture(), start = request.run_start, context = start.context_pack.payload;
      if (request.review_result.outcome !== "reviewed") throw Error("Expected controlled reviewed fixture");
      if (change === "review-rejected") request.review_result.verdict.outcome = "changes_requested";
      if (change === "review-before") request.review_result.before.fresh.destination_run_id = "different";
      if (change === "next-task") start.task_id = "different";
      if (change === "reused-run") start.run_id = request.review_request.before_start.run_id;
      if (change === "reused-verification") start.verification!.request_id = request.review_request.before_start.verification!.request_id;
      if (change === "writer-instance") request.writer.instance_id = "different";
      if (change === "workspace") start.workspace.root += "-other";
      if (change === "profile") start.verification!.profile_id = "different";
      if (change === "goal") context.goal_context!.objective = "different objective";
      if (change === "accepted-input") context.product_development!.accepted_inputs!.files[0]!.evidence_id = "invented-local-evidence";
      if (change === "mapping") context.transferred_product_input.mapping_digest = sha("different");
      if (change === "initial-subject") context.transferred_product_input.initial_subject_digest = sha("different");
      if (change === "review-result") context.transferred_product_input.imported_review_result_digest = sha("different");
      if (change === "continuation-id") request.continuation_id = "different";
      if (change === "readonly-subject") context.imported_review_subject = request.review_request.review_start.context_pack.payload!.imported_review_subject;
      if (change === "discussion") context.policy.execution_mode = "discussion";
      if (change === "frozen-final-subject") start.verification!.expected_subject_digest = context.transferred_product_input.initial_subject_digest;
      if (change === "write-policy") start.policy_snapshot.filesystem_write_scope = ["different"];
      if (change === "project-metadata") context.project.default_workspace = "other-workspace";
      if (change === "both-write-scopes") {
        context.policy.filesystem_write_scope = ["../other-workspace"];
        start.policy_snapshot.filesystem_write_scope = [...context.policy.filesystem_write_scope];
      }
      const input = change === "uri" ? { ...request, run_start: { ...start, context_pack: { ...start.context_pack, uri: "file:///other" } } } : request;
      expect(() => inspectImportedDesignContinuationRequestV1(input, bytes, sha)).toThrow();
    });
  }
  it("rejects changed research bytes even if every serialized review and writer binding agrees", () => {
    const { request, bytes } = fixture(), changed = new Uint8Array(bytes); changed[0] = changed[0]! ^ 1;
    expect(() => inspectImportedDesignContinuationRequestV1(request, changed, sha)).toThrow();
  });

  it.each(["finished", "cancelled_before_start", "failed", "uncertain"] as const)("binds %s lifecycle facts without product acceptance", outcome => {
    const { request } = fixture();
    const result = { version: 1, continuation_id: request.continuation_id, run_id: request.run_start.run_id,
      request_digest: importedDesignContinuationRequestDigestV1(request, sha), outcome, closed: outcome !== "uncertain",
      ...(["failed", "uncertain"].includes(outcome) ? { reason: "Controlled lifecycle fixture" } : {}) };
    expect(inspectImportedDesignContinuationResultV1(request, result, sha)).toEqual(result);
    expect(result).not.toHaveProperty("verification");
  });
  it("requires the exact run identity on control so stop before start can persist its terminal result", () => {
    const { request } = fixture(), identity = { version: 1, continuation_id: request.continuation_id,
      request_digest: importedDesignContinuationRequestDigestV1(request, sha) };
    expect(() => ImportedDesignContinuationControlV1Schema.parse(identity)).toThrow();
    expect(ImportedDesignContinuationControlV1Schema.parse({ ...identity, run_id: request.run_start.run_id }))
      .toEqual({ ...identity, run_id: request.run_start.run_id });
  });
  it.each(["continuation", "run", "digest", "uncertain-closed", "finished-open", "authority", "verification", "empty-reason"])("rejects lifecycle %s substitution", change => {
    const { request } = fixture();
    const result: Record<string, unknown> = { version: 1, continuation_id: request.continuation_id, run_id: request.run_start.run_id,
      request_digest: importedDesignContinuationRequestDigestV1(request, sha), outcome: "finished", closed: true };
    if (change === "continuation") result.continuation_id = "different";
    if (change === "run") result.run_id = "different";
    if (change === "digest") result.request_digest = sha("different");
    if (change === "uncertain-closed") { result.outcome = "uncertain"; result.reason = "Unknown closure"; }
    if (change === "finished-open") result.closed = false;
    if (change === "authority") result.execution_authorized = true;
    if (change === "verification") result.verification = { outcome: "passed" };
    if (change === "empty-reason") { result.outcome = "failed"; result.reason = ""; }
    expect(() => inspectImportedDesignContinuationResultV1(request, result, sha)).toThrow();
  });
  it.each(["preview", "final"] as const)("projects %s verifier data without rewriting accepted research or granting execution", scope => {
    const { request, bytes } = fixture(), before = bytes.slice();
    const envelope = { version: 1, request, request_digest: importedDesignContinuationRequestDigestV1(request, sha),
      run_id: request.run_start.run_id, verification_request_id: scope === "final" ? request.run_start.verification!.request_id : "preview-only-request",
      scope, subject_digest: sha("New design source differs from initial imported research") };
    const result = inspectImportedDesignVerificationEnvelopeV1(envelope, bytes, sha);
    expect(bytes).toEqual(before);
    expect(result.research.measurement_plan?.profile_digest).toBe(request.run_start.context_pack.payload.verification_capabilities?.profile_digest);
    expect(result).not.toHaveProperty("execution_authorized");
    const command = request.review_request.operation.intent.request.byte_request.destination.capabilities.checks[0]!.command_id;
    expect(importedDesignVerificationEchoV1(result.envelope, command, sha)).toMatchObject({ run_id: request.run_start.run_id, scope,
      subject_digest: envelope.subject_digest, command_id: command });
    expect(() => importedDesignVerificationEchoV1(result.envelope, "unconfigured-command", sha)).toThrow();
  });
  it.each(["request-digest", "run", "final-id", "preview-id", "bytes", "context", "extra-authority"])("rejects private verifier %s substitution", change => {
    const { request, bytes } = fixture();
    const envelope: Record<string, unknown> = { version: 1, request, request_digest: importedDesignContinuationRequestDigestV1(request, sha),
      run_id: request.run_start.run_id, verification_request_id: request.run_start.verification!.request_id,
      scope: "final", subject_digest: sha("Current design source") };
    if (change === "request-digest") envelope.request_digest = sha("different");
    if (change === "run") envelope.run_id = "different";
    if (change === "final-id") envelope.verification_request_id = "different";
    if (change === "preview-id") envelope.scope = "preview";
    if (change === "bytes") bytes[0] = bytes[0]! ^ 1;
    if (change === "context") request.run_start.context_pack.payload.goal_context!.objective = "different";
    if (change === "extra-authority") envelope.execution_authorized = true;
    expect(() => inspectImportedDesignVerificationEnvelopeV1(envelope, bytes, sha)).toThrow();
  });
});
