// Controlled contract projections only. No native, provider or receipt authority is fabricated by these helpers.
import { ImportedImplementationSourceV1Schema, importedImplementationSourceDigestV1, importedExecutionReviewSubjectV1,
  importedExecutionReviewRequestDigestV1, importedExecutionRepairContextV1, importedExecutionRepairRequestDigestV1,
  canonicalProductSourceTransferValueV1 as canonical, type ImportedExecutionRequestV1, type ImportedExecutionResultV1,
  type ImportedImplementationSourceV1, type ImportedImplementationRunStartV1, type ImportedExecutionReviewRequestV1,
  type ImportedExecutionReviewResultV1, type ImportedExecutionRepairRequestV1, type ImportedExecutionRepairResultV1 } from "@artoo/domain";
import { importedExecutionRequestFixture, controlledCompletedImplementation, executionFixtureSha as sha } from "./imported-execution-request.js";
export { sha as implementationFixtureSha };

export function h6RequestForImplementationFixture(execution_request: ImportedExecutionRequestV1, source: ImportedImplementationSourceV1,
  review_id = "h6-review"): ImportedExecutionReviewRequestV1 {
  const subject = importedExecutionReviewSubjectV1({ review_id, execution_request, source }, sha);
  const verifier = (phase: string): ImportedImplementationRunStartV1 => {
    const start = structuredClone(source.run_start);
    start.run_id = review_id + "-" + phase; start.verification.request_id = review_id + "-" + phase + "-verification";
    start.verification.expected_subject_digest = source.subject_digest; start.context_pack.id = review_id + "-" + phase + "-context";
    start.policy_snapshot.filesystem_write_scope = []; start.context_pack.payload.policy.filesystem_write_scope = [];
    delete start.context_pack.payload.imported_execution; delete start.context_pack.payload.imported_execution_repair;
    start.context_pack.payload.imported_execution_review_subject = subject;
    return start;
  };
  const before_start = verifier("before"), after_start = verifier("after"), review_start = verifier("review");
  review_start.task_id = review_id + "-task"; review_start.agent_instance_id = review_id + "-instance";
  review_start.context_pack.payload.task = { id: review_start.task_id, title: "Review implementation", description: "Controlled H6 review", acceptance_criteria: [] };
  review_start.context_pack.payload.policy.execution_mode = "discussion";
  delete review_start.context_pack.payload.product_development;
  return { version: 1, review_id, execution_request, source, before_start, review_start, after_start,
    reviewer: { agent_id: review_id + "-agent", instance_id: review_start.agent_instance_id } };
}
export function controlledImplementationReviewResult(request: ImportedExecutionReviewRequestV1, outcome: "accepted" | "rejected" = "rejected"): ImportedExecutionReviewResultV1 {
  const measured = (start: ImportedImplementationRunStartV1) => ({ run_id: start.run_id, config_digest: sha(canonical(start)),
    closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-implementation-cases" as const,
    verification: { ...structuredClone(request.source.verification), request_id: start.verification.request_id } });
  return { version: 1, review_id: request.review_id, request_digest: importedExecutionReviewRequestDigestV1(request, sha),
    execution_authorized: false, outcome: "reviewed", closed: true, before: measured(request.before_start), after: measured(request.after_start),
    reviewer: { run_id: request.review_start.run_id, config_digest: sha(canonical(request.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: request.review_id, source_digest: importedImplementationSourceDigestV1(request.source, sha),
      subject_digest: request.source.subject_digest, outcome, summary: "Controlled implementation verdict; no model or browser executed",
      findings: outcome === "rejected" ? [{ severity: "blocking", description: "Clarify the visible empty state", file: "product/index.html" }] : [] } };
}
export function repairRequestForH6Fixture(request: ImportedExecutionReviewRequestV1, result: ImportedExecutionReviewResultV1,
  repair_id = "h6-repair", attempt_index = 1): ImportedExecutionRepairRequestV1 {
  const run_start = structuredClone(request.source.run_start);
  run_start.run_id = repair_id + "-run"; run_start.agent_instance_id = repair_id + "-instance";
  run_start.context_pack.id = repair_id + "-context"; run_start.verification.request_id = repair_id + "-final";
  delete run_start.context_pack.payload.imported_execution; delete run_start.context_pack.payload.imported_execution_repair;
  const fields = { repair_id, execution_request: request.execution_request, source: request.source, review_id: request.review_id,
    review_request_digest: result.request_digest, review_result_digest: sha(canonical(result)),
    authorization: { event_id: repair_id + "-authorization", goal_id: run_start.context_pack.payload.goal_context!.goal_id, attempt_index } };
  run_start.context_pack.payload.imported_execution_repair = importedExecutionRepairContextV1(fields);
  return { version: 1, ...fields, writer: { agent_id: repair_id + "-agent", instance_id: run_start.agent_instance_id }, run_start };
}
export function controlledImplementationRepairResult(request: ImportedExecutionRepairRequestV1): ImportedExecutionRepairResultV1 {
  const execution = controlledCompletedImplementation(request.execution_request), start = request.run_start;
  const subject_digest = sha("controlled repaired subject " + request.repair_id);
  const verification = { ...structuredClone(execution.verification), request_id: start.verification.request_id, subject_digest };
  const control = { version: 1 as const, repair_id: request.repair_id, request_digest: importedExecutionRepairRequestDigestV1(request, sha), run_id: start.run_id };
  const mapped = start.context_pack.payload.transferred_product_input!;
  return { ...control, outcome: "finished", closed: true, verified_repair: { ...control, stage: "implementation",
    run_start_digest: sha(canonical(start)), author: request.writer, destination: execution.destination,
    initial_subject_digest: request.source.subject_digest, subject_digest, base_execution_id: request.execution_request.execution_id,
    review_id: request.review_id, review_request_digest: request.review_request_digest, review_result_digest: request.review_result_digest,
    authorization_event_id: request.authorization.event_id, attempt_index: request.authorization.attempt_index,
    transfer_id: mapped.transfer_id, source_export_digest: mapped.source_export_digest, mapping_digest: mapped.mapping_digest,
    research_provenance_digest: mapped.research_provenance_digest, closure: "windows-job-and-tools-closed.v1",
    scope: "all-declared-workspace-implementation-cases", verification } };
}
export function importedExecutionReviewRequestFixture() {
  const { request: execution_request, bytes, designBytes } = importedExecutionRequestFixture(), verified_execution = controlledCompletedImplementation(execution_request);
  const original: ImportedExecutionResultV1 = { version: 1, execution_id: execution_request.execution_id, request_digest: verified_execution.request_digest,
    run_id: execution_request.run_start.run_id, outcome: "finished", closed: true, verified_execution };
  const source = ImportedImplementationSourceV1Schema.parse({ version: 1, kind: "execution", operation_id: original.execution_id,
    request_digest: original.request_digest, result_digest: sha(canonical(original)), author: execution_request.writer,
    run_start: execution_request.run_start, subject_digest: verified_execution.subject_digest, verification: verified_execution.verification });
  const request = h6RequestForImplementationFixture(execution_request, source), result = controlledImplementationReviewResult(request);
  const repair = repairRequestForH6Fixture(request, result);
  return { request, result, repair, original, bytes, designBytes };
}
