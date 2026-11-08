// Controlled wire projections only. No Supervisor, Server settlement, native
// process, retained store or published product is created by these fixtures.
import { canonicalProductSourceTransferValueV1 as canonical, SourceCleanRestartGrantV1Schema,
  SourceCleanRestartCheckpointV1Schema, SourceCleanValidationOriginV1Schema, sourceCleanDigestV1,
  sourceCleanValidationOriginDigestV1, importedCleanValidationContextV1,
  importedCleanValidationRequestDigestV1, inspectImportedCleanValidationCompletionV1,
  importedCleanValidationReviewSubjectV1, importedValidationOriginDigestV1,
  type ImportedCleanValidationRequestV1, type ImportedCleanValidationResultV1,
  type ImportedCleanValidationSourceV1, type ImportedCleanValidationReviewRequestV1 } from "@artoo/domain";
import { sourceRecoveryRequestFixture, recoveryFixtureSha as sha } from "./source-recovery-request.js";
import { importedValidationRequestFixture, controlledValidationResult } from "./imported-validation-request.js";
export { sha as cleanValidationFixtureSha };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function importedCleanValidationRequestFixture() {
  const old = sourceRecoveryRequestFixture(), origin = old.request.origin, binding = old.registration.binding;
  const stable = { version: 1 as const, node_id: binding.node_id, device_id: binding.device_id,
    store_family_identity_digest: sha("controlled physical family"), genesis_store_identity_digest: binding.store_identity_digest,
    workspace_root: binding.workspace_root, workspace_identity_digest: binding.workspace_identity_digest,
    stable_configuration_digest: sha("controlled stable configuration") };
  const grant = SourceCleanRestartGrantV1Schema.parse({ version: 1, lineage_id: uuid(101), predecessor_generation_id: uuid(102),
    generation_id: uuid(103), claimant_observer_id: uuid(104), revision: 3, stable,
    predecessor: { version: 1, stop_id: uuid(105), lineage_id: uuid(101), generation_id: uuid(102),
      intent_digest: sha("controlled old intent"), closure_digest: sha("controlled old closure"), committed_event_id: "controlled-closure-event" },
    predecessor_history_digest: sha("controlled old history"), origin, goal_id: old.request.goal_id, plan_id: old.request.plan_id,
    authorization: { ...old.request.authorization, consent_id: null }, scope: "unverified-h7-recovery" });
  const registration = { ...old.registration, registration_id: uuid(106), binding: { ...binding,
    guardian_instance_id: uuid(107), store_identity_digest: sha("controlled fresh store") },
    epoch: { ...old.registration.epoch, epoch_id: uuid(108), generation: 0, session_id: "controlled-fresh-session" } };
  const checkpoint = SourceCleanRestartCheckpointV1Schema.parse({ version: 1, lineage_id: grant.lineage_id,
    generation_id: grant.generation_id, grant_digest: sourceCleanDigestV1(grant, sha), lifecycle_registration: { version: 1,
      registration, successor_grant_digest: sourceCleanDigestV1(grant, sha), launch: { version: 1,
        observer_id: grant.claimant_observer_id, stable, supervisor: { pid: 200, creationTime: "2000",
          image: "C:\\controlled\\Supervisor.exe", sid: "S-1-5-21-100" },
        launch_identity_digest: sha("controlled fresh launch"), runtime_manifest_digest: sha("controlled native inventory") } },
    predecessor_history_digest: grant.predecessor_history_digest, subject_digest: old.checkpoint.subject_digest,
    baseline: old.checkpoint.baseline, accepted_inputs: old.checkpoint.accepted_inputs, source_state: "unverified" });
  const restart = SourceCleanValidationOriginV1Schema.parse({ version: 1, kind: "clean-restart.v1", generation_id: grant.generation_id,
    lineage_id: grant.lineage_id, grant, checkpoint, receipt: { version: 1, lineage_id: grant.lineage_id,
      generation_id: grant.generation_id, grant_digest: sourceCleanDigestV1(grant, sha), checkpoint_digest: sourceCleanDigestV1(checkpoint, sha),
      registration_id: registration.registration_id, session_id: registration.epoch.session_id,
      committed_event_id: "controlled-checkpoint-event", source_state: "unverified" }, settlement_event_id: "controlled-settlement-event" });
  const start = structuredClone(old.original.request.run_start);
  start.run_id = "clean-author-run"; start.context_pack.id = "clean-author-context"; start.verification.request_id = "clean-author-final";
  delete start.context_pack.payload.imported_validation;
  const fields = { clean_generation_id: grant.generation_id, validation_id: "clean-validation", root_validation_id: "clean-validation",
    generation: 0, kind: "initial" as const, origin, restart,
    authorization: { event_id: "clean-author-authorization", goal_id: grant.goal_id, attempt_index: 1 } };
  start.context_pack.payload.imported_clean_validation = importedCleanValidationContextV1(fields, sha);
  const request: ImportedCleanValidationRequestV1 = { version: 1, ...fields, writer: old.original.request.writer, run_start: start };
  return { request, grant, checkpoint, restart, bytes: old.original.bytes, designBytes: old.original.designBytes };
}

export function controlledCleanValidationResult(request: ImportedCleanValidationRequestV1): ImportedCleanValidationResultV1 {
  const old = controlledValidationResult(importedValidationRequestFixture().request);
  if (old.outcome !== "finished") throw Error("Expected controlled successful fixture");
  const { destination: _oldDestination, ...value } = old.verified_validation;
  const initialSubject = request.previous_source?.subject_digest ?? request.restart.checkpoint.subject_digest;
  const control = { version: 1 as const, validation_id: request.validation_id,
    request_digest: importedCleanValidationRequestDigestV1(request, sha), run_id: request.run_start.run_id };
  return { ...control, outcome: "finished", closed: true, verified_validation: { ...value, ...control,
    clean_generation_id: request.clean_generation_id, restart_digest: sourceCleanValidationOriginDigestV1(request.restart, sha),
    root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
    author: request.writer, run_start_digest: sha(canonical(request.run_start)), initial_subject_digest: initialSubject,
    baseline: { ...value.baseline, subject_digest: initialSubject }, authorization_event_id: request.authorization.event_id,
    attempt_index: request.authorization.attempt_index, verification: { ...value.verification, request_id: request.run_start.verification.request_id } } };
}
export function controlledCleanValidationSource(request: ImportedCleanValidationRequestV1, result: ImportedCleanValidationResultV1): ImportedCleanValidationSourceV1 {
  return inspectImportedCleanValidationCompletionV1(request, result, importedValidationRequestFixture().bytes, sha).source!;
}
export function cleanValidationReviewFixture(request: ImportedCleanValidationRequestV1, source: ImportedCleanValidationSourceV1): ImportedCleanValidationReviewRequestV1 {
  const review_id = "clean-independent-review", authorization = { event_id: "clean-review-authorization", goal_id: request.authorization.goal_id, attempt_index: 1 };
  const subject = importedCleanValidationReviewSubjectV1({ review_id, source, authorization }, sha);
  const phase = (name: string) => {
    const start = structuredClone(request.run_start); start.run_id = review_id + "-" + name; start.context_pack.id = start.run_id + "-context";
    start.verification.request_id = start.run_id + "-verification"; start.verification.expected_subject_digest = source.subject_digest;
    start.policy_snapshot.filesystem_write_scope = []; start.context_pack.payload.policy.filesystem_write_scope = [];
    delete start.context_pack.payload.imported_clean_validation; start.context_pack.payload.imported_clean_validation_review_subject = subject; return start;
  };
  const before_start = phase("before"), after_start = phase("after"), review_start = phase("reviewer");
  review_start.task_id = review_id + "-task"; review_start.agent_instance_id = review_id + "-instance";
  review_start.context_pack.payload.task = { id: review_start.task_id, title: "Independent product review", description: "Controlled fixture", acceptance_criteria: [] };
  review_start.context_pack.payload.policy.execution_mode = "discussion"; delete review_start.context_pack.payload.product_development;
  return { version: 1, review_id, clean_generation_id: request.clean_generation_id, origin: request.origin, restart: request.restart,
    source, authorization, before_start, review_start, after_start, reviewer: { agent_id: review_id + "-agent", instance_id: review_start.agent_instance_id } };
}
