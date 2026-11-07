import { describe, expect, it } from "vitest";
import { ImportedImplementationSourceV1Schema, ImportedExecutionReviewRequestV1Schema, ImportedExecutionRepairRequestV1Schema,
  ImportedExecutionRequestV1Schema, inspectImportedExecutionReviewRequestV1, inspectImportedExecutionReviewResultV1,
  inspectImportedExecutionRepairRequestV1, inspectImportedExecutionRepairResultV1,
  importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1,
  inspectImportedExecutionReviewVerificationEnvelopeV1, inspectImportedExecutionRepairVerificationEnvelopeV1,
  importedExecutionReviewVerificationEchoV1, importedExecutionRepairVerificationEchoV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { commandSchema } from "@artoo/protocol";
import { importedExecutionReviewRequestFixture, controlledImplementationRepairResult, h6RequestForImplementationFixture,
  implementationFixtureSha as sha } from "./test-fixtures/imported-execution-review-request.js";

describe("H6 and repair controlled contracts; no execution authority", () => {
  it("binds complete before/reviewer/after and separate repair commands over fixed accepted inputs", () => {
    const f = importedExecutionReviewRequestFixture();
    expect(inspectImportedExecutionReviewRequestV1(f.request, f.bytes, sha)).toEqual(f.request);
    expect(inspectImportedExecutionReviewResultV1(f.request, f.result, f.bytes, sha)).toEqual(f.result);
    expect(inspectImportedExecutionRepairRequestV1(f.repair, f.bytes, sha)).toEqual(f.repair);
    const repair = controlledImplementationRepairResult(f.repair);
    expect(inspectImportedExecutionRepairResultV1(f.repair, repair, f.bytes, sha)).toEqual(repair);
    for (const [type, payload] of [["product.source.execution-review.v1", f.request], ["product.source.execution-repair.v1", f.repair]] as const)
      expect(commandSchema.parse({ kind: "command", id: type, idempotency_key: type, type, payload }).payload).toEqual(payload);
  });
  it.each(["before_start", "review_start", "after_start"] as const)("returns a parser failure for absent/URI-only %s context or verifier", field => {
    for (const change of ["absent-context", "uri-context", "absent-verifier"]) {
      const f = importedExecutionReviewRequestFixture(), value = f.request[field] as unknown as Record<string, unknown>;
      if (change === "absent-context") value.context_pack = { id: "empty" };
      if (change === "uri-context") value.context_pack = { id: "remote", uri: "https://example.invalid/context" };
      if (change === "absent-verifier") delete value.verification;
      expect(() => ImportedExecutionReviewRequestV1Schema.safeParse(f.request)).not.toThrow();
      expect(ImportedExecutionReviewRequestV1Schema.safeParse(f.request).success).toBe(false);
    }
  });
  it("fails safely for nested dirty H5 and missing source/repair verifier contexts", () => {
    for (const change of ["h5-verifier", "h5-completion", "source-context", "source-verifier", "repair-context", "repair-verifier"]) {
      const f = importedExecutionReviewRequestFixture();
      if (change === "h5-verifier") delete (f.repair.execution_request.run_start as { verification?: unknown }).verification;
      if (change === "h5-completion" && f.repair.execution_request.review_request.continuation_result.outcome === "finished")
        delete f.repair.execution_request.review_request.continuation_result.verified_design;
      if (change === "source-context") (f.repair.source.run_start as unknown as { context_pack: unknown }).context_pack = { id: "empty" };
      if (change === "source-verifier") delete (f.repair.source.run_start as { verification?: unknown }).verification;
      if (change === "repair-context") (f.repair.run_start as unknown as { context_pack: unknown }).context_pack = { id: "empty" };
      if (change === "repair-verifier") delete (f.repair.run_start as { verification?: unknown }).verification;
      expect(() => ImportedExecutionRepairRequestV1Schema.safeParse(f.repair)).not.toThrow();
      expect(ImportedExecutionRepairRequestV1Schema.safeParse(f.repair).success).toBe(false);
    }
  });
  it.each(["agent", "instance", "pin", "scope", "subject", "old-run", "old-request"])("rejects changed H6 %s", change => {
    const f = importedExecutionReviewRequestFixture(), request = f.request;
    if (change === "agent") request.reviewer.agent_id = request.source.author.agent_id;
    if (change === "instance") request.reviewer.instance_id = request.source.author.instance_id;
    if (change === "pin") request.before_start.context_pack.payload.product_development!.accepted_inputs!.files[0]!.size += 1;
    if (change === "scope") request.review_start.context_pack.payload.policy.filesystem_write_scope = [request.review_start.workspace.root];
    if (change === "subject") request.after_start.verification.expected_subject_digest = sha("changed");
    if (change === "old-run") request.before_start.run_id = request.source.run_start.run_id;
    if (change === "old-request") request.after_start.verification.request_id = request.source.run_start.verification.request_id;
    expect(() => inspectImportedExecutionReviewRequestV1(request, f.bytes, sha)).toThrow();
  });
  it.each(["missing-case", "viewport", "program", "measurement", "accepted-blocking", "rejected-empty", "subject"])("rejects changed reviewed %s facts even after a rejected verdict", change => {
    const f = importedExecutionReviewRequestFixture(), result = f.result;
    if (result.outcome !== "reviewed") throw Error("Controlled reviewed fixture required");
    const observation = result.after.verification.checks[0]!.observation;
    if (observation?.version !== 3) throw Error("Controlled complete cases required");
    if (change === "missing-case") observation.cases.pop();
    if (change === "viewport") observation.cases[0]!.viewport.width += 1;
    if (change === "program") observation.cases[0]!.program_digest = sha("changed");
    if (change === "measurement") result.after.verification.measurement_plan!.measurement_plan_digest = sha("changed");
    if (change === "accepted-blocking") result.verdict.outcome = "accepted";
    if (change === "rejected-empty") result.verdict.findings = [];
    if (change === "subject") result.after.verification.subject_digest = sha("changed");
    expect(() => inspectImportedExecutionReviewResultV1(f.request, result, f.bytes, sha)).toThrow();
  });
  it("compares review independence to the actual repair author and enforces an increasing original-goal retry index", () => {
    const f = importedExecutionReviewRequestFixture(), completed = controlledImplementationRepairResult(f.repair);
    if (completed.outcome !== "finished" || !completed.verified_repair) throw Error("Controlled repaired fixture required");
    const source = ImportedImplementationSourceV1Schema.parse({ version: 1, kind: "repair", operation_id: completed.repair_id,
      request_digest: completed.request_digest, result_digest: sha(canonical(completed)), author: f.repair.writer, run_start: f.repair.run_start,
      subject_digest: completed.verified_repair.subject_digest, verification: completed.verified_repair.verification });
    const request = h6RequestForImplementationFixture(f.request.execution_request, source, "h6-second");
    expect(inspectImportedExecutionReviewRequestV1(request, f.bytes, sha)).toEqual(request);
    request.reviewer.agent_id = f.repair.writer.agent_id;
    expect(ImportedExecutionReviewRequestV1Schema.safeParse(request).success).toBe(false);
    f.repair.source = source;
    expect(ImportedExecutionRepairRequestV1Schema.safeParse(f.repair).success).toBe(false);
  });
  it("checks private request/phase/run/command and real design bytes before emitting echoes", () => {
    const f = importedExecutionReviewRequestFixture(), command = f.request.source.run_start.context_pack.payload.verification_capabilities!.checks[0]!.command_id;
    const review = { version: 1, request: f.request, request_digest: importedExecutionReviewRequestDigestV1(f.request, sha),
      run_id: f.request.before_start.run_id, verification_request_id: f.request.before_start.verification.request_id,
      phase: "before", subject_digest: f.request.source.subject_digest };
    const repair = { version: 1, request: f.repair, request_digest: importedExecutionRepairRequestDigestV1(f.repair, sha),
      run_id: f.repair.run_start.run_id, verification_request_id: f.repair.run_start.verification.request_id, scope: "final", subject_digest: sha("new subject") };
    expect(inspectImportedExecutionReviewVerificationEnvelopeV1(review, f.bytes, f.designBytes, sha).envelope.phase).toBe("before");
    expect(inspectImportedExecutionRepairVerificationEnvelopeV1(repair, f.bytes, f.designBytes, sha).envelope.scope).toBe("final");
    for (const patch of [{ run_id: "other" }, { verification_request_id: "other" }, { request_digest: sha("other") }]) {
      expect(() => importedExecutionReviewVerificationEchoV1({ ...review, ...patch }, command, sha)).toThrow();
      expect(() => importedExecutionRepairVerificationEchoV1({ ...repair, ...patch }, command, sha)).toThrow();
    }
    expect(() => importedExecutionReviewVerificationEchoV1({ ...review, phase: "after" }, command, sha)).toThrow();
    expect(() => importedExecutionRepairVerificationEchoV1({ ...repair, scope: "preview" }, command, sha)).toThrow();
    expect(() => importedExecutionReviewVerificationEchoV1(review, "unconfigured", sha)).toThrow();
    expect(() => importedExecutionRepairVerificationEchoV1(repair, "unconfigured", sha)).toThrow();
    expect(() => inspectImportedExecutionReviewVerificationEnvelopeV1(review, f.bytes, Buffer.from("changed"), sha)).toThrow();
    expect(() => inspectImportedExecutionRepairVerificationEnvelopeV1(repair, f.bytes, Buffer.from("changed"), sha)).toThrow();
  });
  it("preserves optional legacy context while rejecting a new descriptor in H5", () => {
    const f = importedExecutionReviewRequestFixture(), execution = f.request.execution_request;
    execution.run_start.context_pack.payload.imported_execution_review_subject = f.request.review_start.context_pack.payload.imported_execution_review_subject;
    expect(ImportedExecutionRequestV1Schema.safeParse(execution).success).toBe(false);
  });
});
