import { describe, expect, it } from "vitest";
import { ImportedDesignContinuationResultV1Schema, ImportedDesignReviewRequestV1Schema, ImportedDesignReviewResultV1Schema,
  inspectImportedDesignReviewRequestV1, inspectImportedDesignReviewResultV1, importedDesignReviewRequestDigestV1,
  importedDesignReviewSubjectV1, inspectImportedDesignReviewVerificationEnvelopeV1, importedDesignReviewVerificationEchoV1 } from "@artoo/domain";
import { importedDesignReviewCommandSchema, importedDesignReviewReceiptSchema } from "@artoo/protocol";
import { importedDesignReviewRequestFixture, fixtureSha as sha } from "./test-fixtures/imported-design-review-request.js";

describe("H4 exact public contracts over controlled all-case transfer facts", () => {
  it("preserves the original foreign research and pins the completed design in three distinct read-only phases", () => {
    const { request, bytes, result } = importedDesignReviewRequestFixture(), before = bytes.slice();
    expect(inspectImportedDesignReviewRequestV1(request, bytes, sha)).toEqual(request);
    expect(inspectImportedDesignReviewResultV1(request, result, bytes, sha)).toEqual(result);
    expect(bytes).toEqual(before);
    expect(request.before_start.verification!.expected_subject_digest).not.toBe(request.continuation_request.run_start.context_pack.payload.transferred_product_input.initial_subject_digest);
    expect(request.review_start.context_pack.payload!.transferred_product_input).toEqual(request.continuation_request.run_start.context_pack.payload.transferred_product_input);
  });
  it("preserves lifecycle-only H3 parsing but rejects it as H4 provenance", () => {
    const { request, bytes } = importedDesignReviewRequestFixture();
    if (request.continuation_result.outcome !== "finished") throw Error("fixture");
    delete request.continuation_result.verified_design;
    expect(ImportedDesignContinuationResultV1Schema.safeParse(request.continuation_result).success).toBe(true);
    expect(() => inspectImportedDesignReviewRequestV1(request, bytes, sha)).toThrow();
  });
  for (const change of ["author-agent", "author-instance", "same-run", "same-request", "old-subject", "write-scope", "review-write", "review-stage",
    "mapping", "research", "source", "source-run", "approval-policy", "before-approval", "after-approval", "profile", "completion-digest", "prototype-only", "failed-verifier", "missing-observation", "local-revision", "foreign-input"] as const) {
    it(`rejects ${change} before H4 dispatch`, () => {
      const { request, bytes } = importedDesignReviewRequestFixture();
      if (request.continuation_result.outcome !== "finished" || !request.continuation_result.verified_design) throw Error("fixture");
      const completion = request.continuation_result.verified_design, context = request.review_start.context_pack.payload!;
      if (change === "author-agent") request.reviewer.agent_id = request.continuation_request.writer.agent_id;
      if (change === "author-instance") request.reviewer.instance_id = request.continuation_request.writer.instance_id;
      if (change === "same-run") request.after_start.run_id = request.before_start.run_id;
      if (change === "same-request") request.after_start.verification!.request_id = request.before_start.verification!.request_id;
      if (change === "old-subject") request.before_start.verification!.expected_subject_digest = request.continuation_request.run_start.context_pack.payload.transferred_product_input.initial_subject_digest;
      if (change === "write-scope") request.before_start.policy_snapshot.filesystem_write_scope = [request.before_start.workspace.root];
      if (change === "review-write") context.policy.filesystem_write_scope = [request.review_start.workspace.root];
      if (change === "review-stage") context.product_development = request.continuation_request.run_start.context_pack.payload.product_development;
      if (change === "mapping") completion.mapping_digest = sha("other mapping");
      if (change === "research") bytes[0] = bytes[0]! ^ 1;
      if (change === "source") completion.subject_digest = sha("other subject");
      if (change === "source-run") request.before_start.run_id = request.continuation_request.review_request.operation.intent.request.byte_request.source.run_id;
      if (change === "approval-policy") context.policy.requires_approval = ["changed-policy"];
      if (change === "before-approval") request.before_start.context_pack.payload!.policy.requires_approval = ["changed-policy"];
      if (change === "after-approval") request.after_start.context_pack.payload!.policy.requires_approval = ["changed-policy"];
      if (change === "profile") completion.destination.profile_digest = sha("other profile");
      if (change === "completion-digest") context.imported_design_review_subject!.completed_design_digest = sha("other completion");
      if (change === "prototype-only") completion.scope = "prototype-only";
      if (change === "failed-verifier") completion.verification.outcome = "failed";
      if (change === "missing-observation") delete completion.verification.checks[0]!.observation;
      if (change === "local-revision") (context as any).product_design_revision = {};
      if (change === "foreign-input") delete context.transferred_product_input;
      expect(() => inspectImportedDesignReviewRequestV1(request, bytes, sha)).toThrow();
    });
  }
  for (const change of ["after-from-before", "after-digest", "reviewer-run", "verdict-source", "verdict-provenance", "blocking-accepted", "writer-authority", "required-file"] as const) {
    it(`rejects result ${change}`, () => {
      const { request, bytes, result } = importedDesignReviewRequestFixture();
      if (result.outcome !== "reviewed") throw Error("fixture");
      if (change === "after-from-before") result.after = result.before;
      if (change === "after-digest") result.after.verification.subject_digest = sha("other subject");
      if (change === "reviewer-run") result.reviewer.run_id = request.continuation_request.run_start.run_id;
      if (change === "verdict-source") result.verdict.subject_digest = sha("other subject");
      if (change === "verdict-provenance") result.verdict.completed_design_digest = sha("other completion");
      if (change === "blocking-accepted") result.verdict.findings.push({ severity: "blocking", description: "Coverage missing" });
      if (change === "writer-authority") (result as any).execution_authorized = true;
      if (change === "required-file") result.after.verification.required_files[1]!.checksum = sha("mutated design");
      expect(() => inspectImportedDesignReviewResultV1(request, result, bytes, sha)).toThrow();
    });
  }
  it("binds private before and after envelopes separately without H3 permit or old research subject", () => {
    const { request, bytes } = importedDesignReviewRequestFixture(), subject = importedDesignReviewSubjectV1(request, sha);
    const request_digest = importedDesignReviewRequestDigestV1(request, sha), command = request.continuation_request.run_start.context_pack.payload.verification_capabilities!.checks[0]!.command_id;
    const envelope = { version: 1, request, request_digest, phase: "before", run_id: request.before_start.run_id,
      verification_request_id: request.before_start.verification!.request_id, scope: "final", subject_digest: subject.subject_digest };
    expect(inspectImportedDesignReviewVerificationEnvelopeV1(envelope, bytes, sha).research.measurement_plan!.profile_digest)
      .toBe(request.continuation_request.run_start.context_pack.payload.verification_capabilities!.profile_digest);
    expect(importedDesignReviewVerificationEchoV1(envelope, command, sha)).toMatchObject({ phase: "before", completed_design_digest: subject.completed_design_digest });
    for (const patch of [{ phase: "after" }, { scope: "preview" }, { request_digest: sha("other request") }, { verification_request_id: request.continuation_request.run_start.verification!.request_id }]) {
      expect(() => inspectImportedDesignReviewVerificationEnvelopeV1({ ...envelope, ...patch }, bytes, sha)).toThrow();
    }
  });
  it("uses a separate strict protocol family and never aliases H3 commands", () => {
    const { request, result } = importedDesignReviewRequestFixture();
    const base = { kind: "command", id: "h4", idempotency_key: "h4" };
    expect(importedDesignReviewCommandSchema.parse({ ...base, type: "product.source.design-review.v1", payload: request }).payload).toEqual(request);
    expect(importedDesignReviewCommandSchema.safeParse({ ...base, type: "product.source.design.v1", payload: request }).success).toBe(false);
    expect(importedDesignReviewReceiptSchema.safeParse({ ...base, type: "product.source.design-review.receipt.v1", status: "accepted", result_digest: sha("result"),
      payload: { version: 1, review_id: request.review_id, request_digest: result.request_digest } }).success).toBe(true);
    expect(ImportedDesignReviewRequestV1Schema.safeParse({ ...request, writer: request.reviewer }).success).toBe(false);
    expect(ImportedDesignReviewResultV1Schema.safeParse({ ...result, execution_authorized: true }).success).toBe(false);
  });
});
