import { describe, expect, it } from "vitest";
import { ContextPackSchema, ImportedExecutionRequestV1Schema, inspectImportedExecutionRequestV1, importedExecutionRequestDigestV1,
  inspectImportedExecutionVerificationEnvelopeV1, importedExecutionVerificationEchoV1, ImportedDesignContinuationRequestV1Schema,
  ImportedDesignReviewRequestV1Schema, ImportedExecutionResultV1Schema, inspectImportedCompletedExecutionV1,
  ImportedProductReviewRequestV1Schema, inspectProductSourceVerificationEnvelope } from "@artoo/domain";
import { commandSchema, importedExecutionResultSchema } from "@artoo/protocol";
import { importedExecutionRequestFixture, controlledCompletedImplementation, executionFixtureSha as sha } from "./test-fixtures/imported-execution-request.js";

describe("H5 controlled public contract and protected verifier data", () => {
  it("preserves H3 lineage and exact source research plus destination design pins", () => {
    const f = importedExecutionRequestFixture(), context = f.request.run_start.context_pack.payload;
    expect(inspectImportedExecutionRequestV1(f.request, f.bytes, sha)).toEqual(f.request);
    expect(context.transferred_product_input).toEqual(f.request.review_request.continuation_request.run_start.context_pack.payload.transferred_product_input);
    expect(context.product_development!.accepted_inputs!.files.map(file => file.path)).toEqual([".artoo/product/research.json", ".artoo/product/design.json"]);
    expect(commandSchema.parse({ kind: "command", id: "start", idempotency_key: "start", type: "product.source.execution.v1", payload: f.request }).payload).toEqual(f.request);
  });
  it.each(["h4-rejected", "pin", "old-run", "old-verifier", "allocation", "mixed-h4", "release-binding", "stage"])("rejects %s", change => {
    const { request } = importedExecutionRequestFixture();
    if (change === "h4-rejected" && request.review_result.outcome === "reviewed") request.review_result.verdict.outcome = "changes_requested";
    if (change === "pin") request.run_start.context_pack.payload.product_development!.accepted_inputs!.files[1]!.checksum = sha("changed");
    if (change === "old-run") request.run_start.run_id = request.review_request.review_start.run_id;
    if (change === "old-verifier") request.run_start.verification!.request_id = request.review_request.after_start.verification!.request_id;
    if (change === "allocation") request.run_start.workspace.branch = "other";
    if (change === "mixed-h4") request.run_start.context_pack.payload.imported_design_review_subject = request.review_request.review_start.context_pack.payload!.imported_design_review_subject;
    if (change === "release-binding") request.run_start.context_pack.payload.release_capabilities = undefined;
    if (change === "stage") (request as unknown as { stage: string }).stage = "validation";
    expect(ImportedExecutionRequestV1Schema.safeParse(request).success).toBe(false);
  });
  it("keeps legacy ContextPack optional while rejecting H5 descriptors in H3/H4", () => {
    const { request } = importedExecutionRequestFixture(), h3 = request.review_request.continuation_request, h4 = request.review_request;
    expect(ContextPackSchema.safeParse(h3.run_start.context_pack.payload).success).toBe(true);
    h3.run_start.context_pack.payload.imported_execution = request.run_start.context_pack.payload.imported_execution;
    expect(ImportedDesignContinuationRequestV1Schema.safeParse(h3).success).toBe(false);
    delete h3.run_start.context_pack.payload.imported_execution;
    h4.review_start.context_pack.payload!.imported_execution = request.run_start.context_pack.payload.imported_execution;
    expect(ImportedDesignReviewRequestV1Schema.safeParse(h4).success).toBe(false);
  });
  it("rejects an H5 descriptor in earlier research review and foreign research verifier paths", () => {
    const { request, bytes } = importedExecutionRequestFixture(), h2 = request.review_request.continuation_request.review_request;
    h2.review_start.context_pack.payload!.imported_execution = request.run_start.context_pack.payload.imported_execution;
    expect(ImportedProductReviewRequestV1Schema.safeParse(h2).success).toBe(false);
    const accepted = request.review_request.continuation_request.review_result;
    if (accepted.outcome !== "reviewed") throw Error("Controlled H2 required");
    const envelope = structuredClone(accepted.after.admission);
    envelope.run_start.context_pack.payload!.imported_execution = request.run_start.context_pack.payload.imported_execution;
    expect(() => inspectProductSourceVerificationEnvelope(envelope, bytes, sha)).toThrow();
  });
  it("requires actual pinned design bytes in the private verifier and separates preview from final", () => {
    const f = importedExecutionRequestFixture(), envelope = { version: 1, request: f.request, request_digest: importedExecutionRequestDigestV1(f.request, sha),
      run_id: f.request.run_start.run_id, verification_request_id: f.request.run_start.verification!.request_id, scope: "final", subject_digest: sha("new implementation") };
    expect(inspectImportedExecutionVerificationEnvelopeV1(envelope, f.bytes, f.designBytes, sha).envelope.subject_digest).toBe(sha("new implementation"));
    expect(() => inspectImportedExecutionVerificationEnvelopeV1(envelope, f.bytes, Buffer.from("changed"), sha)).toThrow(/design bytes/);
    expect(() => inspectImportedExecutionVerificationEnvelopeV1({ ...envelope, scope: "preview" }, f.bytes, f.designBytes, sha)).toThrow();
    const command = f.request.run_start.context_pack.payload.verification_capabilities!.checks[0]!.command_id;
    expect(importedExecutionVerificationEchoV1(envelope, command, sha)).toMatchObject({ stage: "implementation", h4_result_digest: f.request.run_start.context_pack.payload.imported_execution.h4_result_digest });
  });
  it("does not treat finished-without-verification or serialized H4 as completed implementation evidence", () => {
    const { request } = importedExecutionRequestFixture(), control = { version: 1, execution_id: request.execution_id,
      request_digest: importedExecutionRequestDigestV1(request, sha), run_id: request.run_start.run_id };
    expect(ImportedExecutionResultV1Schema.parse({ ...control, outcome: "finished", closed: true })).not.toHaveProperty("verified_execution");
    expect(importedExecutionResultSchema.safeParse({ kind: "product.source.execution.result.v1", node_id: "node", command_id: "start",
      payload: { ...control, outcome: "finished", closed: true, verified_execution: request.review_result } }).success).toBe(false);
  });
  it("requires the exact declared case/viewport/program set while allowing fresh traces and captures", () => {
    const { request } = importedExecutionRequestFixture(), result = controlledCompletedImplementation(request);
    const observation = result.verification.checks[0]!.observation;
    if (observation?.version !== 3) throw Error("Controlled all-case fixture required");
    expect(observation.cases.length).toBeGreaterThan(0);
    observation.cases[0]!.trace_digest = sha("fresh implementation trace");
    observation.cases[0]!.captures[0]!.screenshot_digest = sha("fresh implementation screenshot");
    expect(inspectImportedCompletedExecutionV1(request, result, sha)).toEqual(result);
  });
  it.each(["empty", "missing", "duplicate", "program", "viewport", "preview", "measurement-plan"])("rejects incomplete or changed H5 %s evidence", change => {
    const { request } = importedExecutionRequestFixture(), result = controlledCompletedImplementation(request), observation = result.verification.checks[0]!.observation;
    if (observation?.version !== 3) throw Error("Controlled all-case fixture required");
    if (change === "empty") observation.cases = [];
    if (change === "missing") { expect(observation.cases.length).toBeGreaterThan(1); observation.cases.pop(); expect(observation.cases.length).toBeGreaterThan(0); }
    if (change === "duplicate") observation.cases.push(structuredClone(observation.cases[0]!));
    if (change === "program") observation.cases[0]!.program_digest = sha("different browser program");
    if (change === "viewport") observation.cases[0]!.viewport.width += 1;
    if (change === "preview") observation.scope = "preview";
    if (change === "measurement-plan") result.verification.measurement_plan!.measurement_plan_digest = sha("different accepted mapping");
    expect(() => inspectImportedCompletedExecutionV1(request, result, sha)).toThrow();
  });
});
