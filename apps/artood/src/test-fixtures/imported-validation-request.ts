// Controlled contract projections only; these fixtures own no native process, receipt or baseline bytes.
import { canonicalProductSourceTransferValueV1 as canonical, importedValidationContextV1, importedValidationOriginDigestV1,
  importedValidationRequestDigestV1, importedValidationReviewSubjectV1, importedValidationReviewRequestDigestV1,
  importedValidationSourceDigestV1, type ImportedValidationRequestV1, type ImportedValidationResultV1,
  type ImportedValidationSourceV1, type ImportedValidationReviewRequestV1, type ImportedValidationReviewResultV1 } from "@artoo/domain";
import { importedExecutionReviewRequestFixture, controlledImplementationReviewResult, implementationFixtureSha as sha } from "./imported-execution-review-request.js";
export { sha as validationFixtureSha };

export function importedValidationRequestFixture() {
  const h6 = importedExecutionReviewRequestFixture(), accepted = controlledImplementationReviewResult(h6.request, "accepted");
  const origin = { version: 1 as const, review_id: h6.request.review_id, request_digest: accepted.request_digest,
    result_digest: sha(canonical(accepted)), acceptance_event_id: "h6-acceptance-event", execution_request: h6.request.execution_request,
    implementation_source: h6.request.source };
  const start = structuredClone(h6.request.source.run_start);
  start.run_id = "h7-author-run"; start.task_id = "validation-task"; start.agent_instance_id = "validation-instance";
  start.context_pack.id = "h7-author-context"; start.verification.request_id = "h7-author-final";
  start.context_pack.payload.task = { id: start.task_id, title: "Validate complete product", description: "Controlled validation fixture", acceptance_criteria: [] };
  if (start.context_pack.payload.goal_context?.plan) start.context_pack.payload.goal_context.plan.spec_ref = "validation-task-spec";
  start.context_pack.payload.product_development!.stage = "validation";
  delete start.context_pack.payload.imported_execution; delete start.context_pack.payload.imported_execution_repair;
  const fields = { validation_id: "h7-validation", root_validation_id: "h7-validation", generation: 0, kind: "initial" as const,
    origin, source: origin.implementation_source, authorization: { event_id: "h7-author-authorization",
      goal_id: start.context_pack.payload.goal_context!.goal_id, attempt_index: 0 } };
  start.context_pack.payload.imported_validation = importedValidationContextV1(fields, sha);
  const request: ImportedValidationRequestV1 = { version: 1, ...fields, writer: { agent_id: "validation-agent", instance_id: start.agent_instance_id }, run_start: start };
  return { request, bytes: h6.bytes, designBytes: h6.designBytes, h6, accepted };
}
export function controlledValidationResult(request: ImportedValidationRequestV1, failure?: "author-failed" | "verification-failed"): ImportedValidationResultV1 {
  const start = request.run_start, subject_digest = sha("controlled validation subject " + request.validation_id);
  const directories = [".artoo/product", "product", "product/empty"], files = [{ path: "product/index.html", checksum: sha("fixture source"), size: 14, reference: "fixture-baseline-file" }];
  const baseline = { version: 1 as const, snapshot_id: request.validation_id + "-baseline", subject_digest: request.source.subject_digest,
    manifest_digest: sha(canonical({ directories, files })), directories, files };
  const verification = structuredClone(request.origin.implementation_source.verification);
  verification.request_id = start.verification.request_id; verification.subject_digest = subject_digest;
  for (const check of verification.checks) if (check.observation?.version === 3) check.observation.stage = "validation";
  verification.required_files = verification.required_files.filter(file => file.path !== ".artoo/product/validation.json");
  verification.required_files.push({ path: ".artoo/product/validation.json", checksum: sha("controlled report"), size: 17 });
  if (failure === "verification-failed") {
    verification.outcome = "failed"; verification.reason = "Controlled measurement failure";
    delete verification.measurement_plan; delete verification.product_design_revision;
    for (const check of verification.checks) delete check.observation;
  }
  const destination = request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const control = { version: 1 as const, validation_id: request.validation_id, request_digest: importedValidationRequestDigestV1(request, sha), run_id: start.run_id };
  const value = { ...control, root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
    author: request.writer, run_start_digest: sha(canonical(start)), destination: { node_id: destination.node_id, workspace_root: start.workspace.root,
      profile_id: start.verification.profile_id, profile_digest: destination.capabilities.profile_digest }, initial_subject_digest: request.source.subject_digest,
    subject_digest, authorization_event_id: request.authorization.event_id, attempt_index: request.authorization.attempt_index,
    baseline, closure: "windows-job-and-tools-closed.v1" as const };
  return failure ? { ...control, outcome: "failed", closed: true, reason: "Controlled failure", closed_failure: { ...value, failure_kind: failure,
    reason: "Controlled failure", ...(failure === "verification-failed" ? { verification } : {}) } }
    : { ...control, outcome: "finished", closed: true, verified_validation: { ...value, stage: "validation", scope: "all-declared-workspace-validation-cases", verification } };
}
export function controlledValidationSource(request: ImportedValidationRequestV1, result: ImportedValidationResultV1): ImportedValidationSourceV1 {
  const value = result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined;
  if (!value) throw Error("Fixture requires a verified result or explicitly typed closed failure");
  return { version: 1, kind: "validation", outcome: result.outcome === "finished" ? "verified" : "closed-failure", validation_id: request.validation_id,
    root_validation_id: request.root_validation_id, generation: request.generation, request_digest: result.request_digest, result_digest: sha(canonical(result)),
    origin_digest: value.origin_digest, author: request.writer, run_start: request.run_start, initial_subject_digest: value.initial_subject_digest,
    subject_digest: value.subject_digest, baseline: value.baseline, ...(value.verification ? { verification: value.verification } : {}),
    ...("failure_kind" in value ? { failure_kind: value.failure_kind, failure_reason: value.reason } : {}) };
}
export function validationRepairFixture(request: ImportedValidationRequestV1, source: ImportedValidationSourceV1,
  predecessor: ImportedValidationRequestV1["predecessor"], attempt_index = 1): ImportedValidationRequestV1 {
  const start = structuredClone(request.run_start), validation_id = "h7-repair-" + attempt_index;
  start.run_id = validation_id + "-run"; start.context_pack.id = validation_id + "-context"; start.verification.request_id = validation_id + "-final";
  const next = { ...request, validation_id, source, generation: source.generation + 1, kind: "repair" as const, predecessor,
    authorization: { ...request.authorization, event_id: validation_id + "-authorization", attempt_index }, run_start: start };
  start.context_pack.payload.imported_validation = importedValidationContextV1(next, sha); return next;
}
export function validationReviewFixture(request: ImportedValidationRequestV1, source: ImportedValidationSourceV1): ImportedValidationReviewRequestV1 {
  const review_id = source.validation_id + "-review", authorization = { ...request.authorization, event_id: review_id + "-authorization" };
  const subject = importedValidationReviewSubjectV1({ review_id, source, authorization }, sha);
  const phase = (name: string) => {
    const start = structuredClone(source.run_start); start.run_id = review_id + "-" + name; start.context_pack.id = start.run_id + "-context";
    start.verification.request_id = start.run_id + "-final"; start.verification.expected_subject_digest = source.subject_digest;
    start.context_pack.payload.policy.filesystem_write_scope = []; start.policy_snapshot.filesystem_write_scope = [];
    delete start.context_pack.payload.imported_validation; start.context_pack.payload.imported_validation_review_subject = subject; return start;
  };
  const before_start = phase("before"), after_start = phase("after"), review_start = phase("reviewer");
  review_start.task_id = review_id + "-task"; review_start.agent_instance_id = review_id + "-instance";
  review_start.context_pack.payload.task = { id: review_start.task_id, title: "Review final product", description: "Controlled full product review", acceptance_criteria: [] };
  review_start.context_pack.payload.policy.execution_mode = "discussion"; delete review_start.context_pack.payload.product_development;
  return { version: 1, review_id, origin: request.origin, source, authorization, before_start, review_start, after_start,
    reviewer: { agent_id: review_id + "-agent", instance_id: review_start.agent_instance_id } };
}
export function controlledValidationReviewResult(request: ImportedValidationReviewRequestV1): ImportedValidationReviewResultV1 {
  const measured = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: sha(canonical(start)), closure: "windows-job-and-tools-closed.v1" as const,
    scope: "all-declared-workspace-validation-cases" as const, verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
  return { version: 1, review_id: request.review_id, request_digest: importedValidationReviewRequestDigestV1(request, sha), outcome: "reviewed", closed: true,
    execution_authorized: false, before: measured(request.before_start), after: measured(request.after_start), reviewer: {
      run_id: request.review_start.run_id, config_digest: sha(canonical(request.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: request.review_id, validation_id: request.source.validation_id, source_digest: importedValidationSourceDigestV1(request.source, sha),
      subject_digest: request.source.subject_digest, outcome: "accepted", summary: "Controlled complete product verdict; no browser or model executed", findings: [] } };
}
