// Controlled JSON/controller seams only. These fixtures hold no native authority.
import { createHash } from "node:crypto";
import { ProductSourceRecoveryRegistrationV1Schema, ProductSourceRecoveryRequestV1Schema, ProductSourceRecoveryCheckpointV1Schema,
  ProductSourceRecoveryResultV1Schema,
  productSourceRecoveryCheckpointDigestV1, productSourceRecoveryRequestDigestV1,
  importedExecutionAcceptedInputsV1, canonicalProductSourceTransferValueV1 as canonical,
  ImportedRecoveryValidationRequestV1Schema, importedRecoveryValidationContextV1, importedRecoveryValidationRequestDigestV1,
  ImportedRecoveryValidationVerificationEnvelopeV1Schema, importedValidationOriginDigestV1,
  importedRecoveryValidationReviewSubjectV1, importedRecoveryValidationReviewRequestDigestV1, importedRecoveryValidationSourceDigestV1,
  type ImportedRecoveryValidationRequestV1, type ImportedRecoveryValidationResultV1, type ImportedRecoveryValidationSourceV1,
  type ImportedRecoveryValidationReviewRequestV1, type ImportedRecoveryValidationReviewResultV1 } from "@artoo/domain";
import { importedValidationRequestFixture } from "./imported-validation-request.js";

const sha = (value: string | Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex");
const oldEpoch = "a47d69f7-00d2-49da-8c80-f7cf51e12427", newEpoch = "46f0b9fc-a7df-40e9-aeb4-f6e1d14a2745";
export function sourceRecoveryRequestFixture() {
  const original = importedValidationRequestFixture(), origin = original.request.origin;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: "f3d561c4-46cf-40b9-ac77-93404c7c0a0a",
    binding: { version: 1, node_id: destination.node_id, device_id: "device-b", guardian_instance_id: "f59fc26d-c852-4aeb-bf2b-b38246336826",
      store_identity_digest: sha("store"), configuration_digest: sha("config"), workspace_root: origin.execution_request.run_start.workspace.root, workspace_identity_digest: sha("physical workspace") },
    epoch: { version: 1, epoch_id: oldEpoch, generation: 0, session_id: "old-authenticated-session", roster_revision: 2, roster_digest: sha("complete native roster") } });
  const request = ProductSourceRecoveryRequestV1Schema.parse({ version: 1, recovery_id: "recovery-one", registration_id: registration.registration_id,
    origin_review_id: origin.review_id, origin, goal_id: origin.execution_request.run_start.context_pack.payload.goal_context!.goal_id,
    plan_id: origin.execution_request.run_start.context_pack.payload.goal_context!.plan!.id, binding: registration.binding,
    previous_epoch: registration.epoch, current_session_id: "new-authenticated-session", new_daemon_identity_digest: sha("exact new daemon"),
    challenge_id: "f9f06d6b-343e-4653-a630-015bb5e6d354",
    operations: [{ kind: "validation", operation_id: "old-validation", request_digest: sha("old author request"), run_id: "actual-old-run" },
      { kind: "validation_review", operation_id: "old-review", request_digest: sha("old review request") }],
    authorization: { event_id: "new-authorization", actor_user_id: "initiating-user", consent_id: "current-consent", policy_version: "original-policy" } });
  const directories = [".artoo/product", "product"], files = [{ path: "product/index.html", checksum: sha("actual fixture bytes"), size: 20, reference: "protected-file-reference" }];
  const subject = sha("unverified current source"), checkpoint = ProductSourceRecoveryCheckpointV1Schema.parse({ version: 1, recovery_id: request.recovery_id,
    request_digest: productSourceRecoveryRequestDigestV1(request, sha), binding: request.binding, old_epoch_id: oldEpoch, new_epoch_id: newEpoch, generation: 1,
    current_session_id: request.current_session_id, new_daemon_identity_digest: request.new_daemon_identity_digest, challenge_id: request.challenge_id,
    roster_revision: request.previous_epoch.roster_revision, roster_digest: request.previous_epoch.roster_digest, closure_set_digest: sha("native closure set"),
    operations: request.operations, subject_digest: subject, baseline: { version: 1, snapshot_id: "fresh-baseline", subject_digest: subject,
      manifest_digest: sha(canonical({ directories, files })), directories, files }, accepted_inputs: importedExecutionAcceptedInputsV1(origin.execution_request), source_state: "unverified" });
  const result = ProductSourceRecoveryResultV1Schema.parse({ version: 1, recovery_id: request.recovery_id, request_digest: checkpoint.request_digest,
    outcome: "recovered", closed: true, checkpoint });
  return { registration, request, checkpoint, result, original };
}

export function recoveryValidationRequestFixture() {
  const f = sourceRecoveryRequestFixture(), start = structuredClone(f.original.request.run_start);
  start.run_id = "new-recovery-author-run"; start.context_pack.id = "new-recovery-author-context"; start.verification.request_id = "new-recovery-final-verifier";
  delete start.context_pack.payload.imported_validation;
  const fields = { validation_id: "new-recovery-author", root_validation_id: "new-recovery-author", generation: 0, kind: "initial" as const,
    recovery_id: f.request.recovery_id, checkpoint: f.checkpoint, origin: f.request.origin,
    authorization: { event_id: "new-recovery-author-authorization", goal_id: f.request.goal_id, attempt_index: 1 } };
  start.context_pack.payload.imported_recovery_validation = importedRecoveryValidationContextV1(fields, sha);
  const request = ImportedRecoveryValidationRequestV1Schema.parse({ version: 1, ...fields, writer: f.original.request.writer, run_start: start });
  const envelope = ImportedRecoveryValidationVerificationEnvelopeV1Schema.parse({ version: 1, request, request_digest: importedRecoveryValidationRequestDigestV1(request, sha),
    run_id: start.run_id, verification_request_id: start.verification.request_id, subject_digest: sha("controlled new final subject"), scope: "final" });
  return { ...f, recoveryRequest: f.request, recoveryResult: f.result, request, envelope };
}
export { sha as recoveryFixtureSha };
export function controlledRecoveryValidationResult(request: ImportedRecoveryValidationRequestV1, failure?: "author-failed" | "verification-failed"): ImportedRecoveryValidationResultV1 {
  const start = request.run_start, subject_digest = sha("controlled validation subject " + request.validation_id);
  const directories = [".artoo/product", "product", "product/empty"], files = [{ path: "product/index.html", checksum: sha("fixture source"), size: 14, reference: "fixture-baseline-file" }];
  const baseline = { version: 1 as const, snapshot_id: request.validation_id + "-baseline", subject_digest: (request.previous_source?.subject_digest ?? request.checkpoint.subject_digest),
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
  const control = { version: 1 as const, validation_id: request.validation_id, request_digest: importedRecoveryValidationRequestDigestV1(request, sha), run_id: start.run_id };
  const value = { ...control, root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
    author: request.writer, run_start_digest: sha(canonical(start)), recovery_id: request.recovery_id,
    checkpoint_digest: productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha), initial_subject_digest: (request.previous_source?.subject_digest ?? request.checkpoint.subject_digest),
    subject_digest, authorization_event_id: request.authorization.event_id, attempt_index: request.authorization.attempt_index,
    baseline, closure: "windows-job-and-tools-closed.v1" as const };
  return failure ? { ...control, outcome: "failed", closed: true, reason: "Controlled failure", closed_failure: { ...value, failure_kind: failure,
    reason: "Controlled failure", ...(failure === "verification-failed" ? { verification } : {}) } }
    : { ...control, outcome: "finished", closed: true, verified_validation: { ...value, stage: "validation", scope: "all-declared-workspace-validation-cases", verification } };
}
export function controlledRecoveryValidationSource(request: ImportedRecoveryValidationRequestV1, result: ImportedRecoveryValidationResultV1): ImportedRecoveryValidationSourceV1 {
  const value = result.outcome === "finished" ? result.verified_validation : result.outcome === "failed" ? result.closed_failure : undefined;
  if (!value) throw Error("Fixture requires a verified result or explicitly typed closed failure");
  return { version: 1, kind: "recovery-validation", recovery_id: request.recovery_id, checkpoint_digest: productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha), outcome: result.outcome === "finished" ? "verified" : "closed-failure", validation_id: request.validation_id,
    root_validation_id: request.root_validation_id, generation: request.generation, request_digest: result.request_digest, result_digest: sha(canonical(result)),
    origin_digest: value.origin_digest, author: request.writer, run_start: request.run_start, initial_subject_digest: value.initial_subject_digest,
    subject_digest: value.subject_digest, baseline: value.baseline, ...(value.verification ? { verification: value.verification } : {}),
    ...("failure_kind" in value ? { failure_kind: value.failure_kind, failure_reason: value.reason } : {}) };
}
export function recoveryValidationRepairFixture(request: ImportedRecoveryValidationRequestV1, source: ImportedRecoveryValidationSourceV1,
  predecessor: ImportedRecoveryValidationRequestV1["predecessor"], attempt_index = 2): ImportedRecoveryValidationRequestV1 {
  const start = structuredClone(request.run_start), validation_id = "h7-repair-" + attempt_index;
  start.run_id = validation_id + "-run"; start.context_pack.id = validation_id + "-context"; start.verification.request_id = validation_id + "-final";
  const next = { ...request, validation_id, previous_source: source, generation: source.generation + 1, kind: "repair" as const, predecessor,
    authorization: { ...request.authorization, event_id: validation_id + "-authorization", attempt_index }, run_start: start };
  start.context_pack.payload.imported_recovery_validation = importedRecoveryValidationContextV1(next, sha); return next;
}
export function recoveryValidationReviewFixture(request: ImportedRecoveryValidationRequestV1, source: ImportedRecoveryValidationSourceV1): ImportedRecoveryValidationReviewRequestV1 {
  const review_id = source.validation_id + "-review", authorization = { ...request.authorization, event_id: review_id + "-authorization" };
  const subject = importedRecoveryValidationReviewSubjectV1({ review_id, source, authorization }, sha);
  const phase = (name: string) => {
    const start = structuredClone(source.run_start); start.run_id = review_id + "-" + name; start.context_pack.id = start.run_id + "-context";
    start.verification.request_id = start.run_id + "-final"; start.verification.expected_subject_digest = source.subject_digest;
    start.context_pack.payload.policy.filesystem_write_scope = []; start.policy_snapshot.filesystem_write_scope = [];
    delete start.context_pack.payload.imported_recovery_validation; start.context_pack.payload.imported_recovery_validation_review_subject = subject; return start;
  };
  const before_start = phase("before"), after_start = phase("after"), review_start = phase("reviewer");
  review_start.task_id = review_id + "-task"; review_start.agent_instance_id = review_id + "-instance";
  review_start.context_pack.payload.task = { id: review_start.task_id, title: "Review final product", description: "Controlled full product review", acceptance_criteria: [] };
  review_start.context_pack.payload.policy.execution_mode = "discussion"; delete review_start.context_pack.payload.product_development;
  return { version: 1, review_id, recovery_id: request.recovery_id, checkpoint: request.checkpoint, origin: request.origin, source, authorization, before_start, review_start, after_start,
    reviewer: { agent_id: review_id + "-agent", instance_id: review_start.agent_instance_id } };
}
export function controlledRecoveryValidationReviewResult(request: ImportedRecoveryValidationReviewRequestV1): ImportedRecoveryValidationReviewResultV1 {
  const measured = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: sha(canonical(start)), closure: "windows-job-and-tools-closed.v1" as const,
    scope: "all-declared-workspace-validation-cases" as const, verification: { ...structuredClone(request.source.verification!), request_id: start.verification.request_id } });
  return { version: 1, review_id: request.review_id, request_digest: importedRecoveryValidationReviewRequestDigestV1(request, sha), outcome: "reviewed", closed: true,
    execution_authorized: false, before: measured(request.before_start), after: measured(request.after_start), reviewer: {
      run_id: request.review_start.run_id, config_digest: sha(canonical(request.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: request.review_id, validation_id: request.source.validation_id, source_digest: importedRecoveryValidationSourceDigestV1(request.source, sha),
      subject_digest: request.source.subject_digest, outcome: "accepted", summary: "Controlled complete product verdict; no browser or model executed", findings: [] } };
}
