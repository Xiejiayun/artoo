// Controlled contract projections; these values own no process, checkpoint or product evidence.
import { canonicalProductSourceTransferValueV1 as canonical, importedExecutionAcceptedInputsV1, importedRecoveryValidationContextV1,
  importedRecoveryValidationRequestDigestV1, inspectImportedRecoveryValidationCompletionV1, importedRecoveryValidationReviewSubjectV1,
  productSourceRecoveryRequestDigestV1, productSourceRecoveryCheckpointDigestV1, importedValidationOriginDigestV1,
  type ImportedRecoveryValidationRequestV1, type ImportedRecoveryValidationResultV1, type ImportedRecoveryValidationSourceV1,
  type ImportedRecoveryValidationReviewRequestV1, type ProductSourceRecoveryRequestV1, type ProductSourceRecoveryCheckpointV1 } from "@artoo/domain";
import { importedValidationRequestFixture, controlledValidationResult, validationFixtureSha as sha } from "./imported-validation-request.js";
export { sha as recoveryValidationFixtureSha };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export function importedRecoveryValidationRequestFixture() {
  const old = importedValidationRequestFixture(), origin = old.request.origin, prior = origin.execution_request.run_start;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const binding = { version: 1 as const, node_id: destination.node_id, device_id: "recovery-fixture-device", guardian_instance_id: uuid(1),
    store_identity_digest: sha("store"), configuration_digest: sha("configuration"), workspace_root: prior.workspace.root, workspace_identity_digest: sha("workspace") };
  const recovery: ProductSourceRecoveryRequestV1 = { version: 1, recovery_id: "h9-recovery", registration_id: uuid(4), origin_review_id: origin.review_id,
    origin, goal_id: prior.context_pack.payload.goal_context!.goal_id, plan_id: prior.context_pack.payload.goal_context!.plan!.id, binding,
    previous_epoch: { version: 1, epoch_id: uuid(2), generation: 0, session_id: "old-session", roster_revision: 0, roster_digest: sha("[]") },
    current_session_id: "new-session", new_daemon_identity_digest: sha("new-daemon"), challenge_id: uuid(5), operations: [],
    authorization: { event_id: "recovery-authorized", actor_user_id: "user", consent_id: "consent", policy_version: "policy" } };
  const directories = [".artoo/product", "product"], files = [{ path: "product/index.html", checksum: sha("source"), size: 6, reference: "recovery-baseline-file" }];
  const checkpoint: ProductSourceRecoveryCheckpointV1 = { version: 1, recovery_id: recovery.recovery_id,
    request_digest: productSourceRecoveryRequestDigestV1(recovery, sha), binding, old_epoch_id: uuid(2), new_epoch_id: uuid(3), generation: 1,
    current_session_id: recovery.current_session_id, new_daemon_identity_digest: recovery.new_daemon_identity_digest, challenge_id: recovery.challenge_id,
    roster_revision: 0, roster_digest: sha("[]"), closure_set_digest: sha("[]"), operations: [], subject_digest: old.request.source.subject_digest,
    baseline: { version: 1, snapshot_id: "recovery-fixture-baseline", subject_digest: old.request.source.subject_digest,
      manifest_digest: sha(canonical({ directories, files })), directories, files }, accepted_inputs: importedExecutionAcceptedInputsV1(origin.execution_request), source_state: "unverified" };
  const start = structuredClone(old.request.run_start); start.run_id = "h9-author-run"; start.context_pack.id = "h9-author-context";
  start.verification.request_id = "h9-author-final"; delete start.context_pack.payload.imported_validation;
  const fields = { recovery_id: recovery.recovery_id, validation_id: "h9-validation", root_validation_id: "h9-validation", generation: 0,
    kind: "initial" as const, origin, checkpoint, authorization: { event_id: "h9-author-authorization", goal_id: recovery.goal_id, attempt_index: 1 } };
  start.context_pack.payload.imported_recovery_validation = importedRecoveryValidationContextV1(fields, sha);
  const request: ImportedRecoveryValidationRequestV1 = { version: 1, ...fields, writer: old.request.writer, run_start: start };
  return { request, recovery, checkpoint, bytes: old.bytes, designBytes: old.designBytes, old };
}
export function controlledRecoveryValidationResult(request: ImportedRecoveryValidationRequestV1): ImportedRecoveryValidationResultV1 {
  const old = controlledValidationResult(importedValidationRequestFixture().request);
  if (old.outcome !== "finished") throw Error("Expected controlled successful fixture");
  const { destination: _oldDestination, ...value } = old.verified_validation;
  const control = { version: 1 as const, validation_id: request.validation_id, request_digest: importedRecoveryValidationRequestDigestV1(request, sha), run_id: request.run_start.run_id };
  return { ...control, outcome: "finished", closed: true, verified_validation: { ...value, ...control, recovery_id: request.recovery_id,
    checkpoint_digest: productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha), root_validation_id: request.root_validation_id,
    generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha), author: request.writer,
    run_start_digest: sha(canonical(request.run_start)), initial_subject_digest: request.checkpoint.subject_digest,
    authorization_event_id: request.authorization.event_id, attempt_index: request.authorization.attempt_index,
    verification: { ...value.verification, request_id: request.run_start.verification.request_id } } };
}
export function controlledRecoveryValidationSource(request: ImportedRecoveryValidationRequestV1, result: ImportedRecoveryValidationResultV1): ImportedRecoveryValidationSourceV1 {
  return inspectImportedRecoveryValidationCompletionV1(request, result, importedValidationRequestFixture().bytes, sha).source!;
}
export function recoveryValidationReviewFixture(request: ImportedRecoveryValidationRequestV1, source: ImportedRecoveryValidationSourceV1): ImportedRecoveryValidationReviewRequestV1 {
  const review_id = "h9-independent-review", authorization = { event_id: "h9-review-authorization", goal_id: request.authorization.goal_id, attempt_index: 1 };
  const subject = importedRecoveryValidationReviewSubjectV1({ review_id, source, authorization }, sha);
  const phase = (name: string) => {
    const start = structuredClone(request.run_start); start.run_id = review_id + "-" + name; start.context_pack.id = start.run_id + "-context";
    start.verification.request_id = start.run_id + "-verification"; start.verification.expected_subject_digest = source.subject_digest;
    start.policy_snapshot.filesystem_write_scope = []; start.context_pack.payload.policy.filesystem_write_scope = [];
    delete start.context_pack.payload.imported_recovery_validation; start.context_pack.payload.imported_recovery_validation_review_subject = subject; return start;
  };
  const before_start = phase("before"), after_start = phase("after"), review_start = phase("reviewer");
  review_start.task_id = review_id + "-task"; review_start.agent_instance_id = review_id + "-instance";
  review_start.context_pack.payload.task = { id: review_start.task_id, title: "Independent product review", description: "Controlled fixture", acceptance_criteria: [] };
  review_start.context_pack.payload.policy.execution_mode = "discussion"; delete review_start.context_pack.payload.product_development;
  return { version: 1, review_id, recovery_id: request.recovery_id, origin: request.origin, checkpoint: request.checkpoint, source, authorization,
    before_start, review_start, after_start, reviewer: { agent_id: review_id + "-agent", instance_id: review_start.agent_instance_id } };
}
