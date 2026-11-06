import { z } from "zod";
import { AcceptedProductInputsSchema } from "./product-development.js";
import { ImportedValidationBaselineV1Schema, ImportedValidationOriginV1Schema } from "./imported-validation.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { ProductSourceRecoveryRegistrationV1Schema, RecoveryOperationRefV1Schema } from "./source-recovery.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SOURCE_CLEAN_RESTART_FEATURE_V1 = "product.source.clean-restart.v1";
export const SOURCE_LIFECYCLE_ROUTE_V1 = "/api/v1/node/source-lifecycle";

/** These projections contain no HANDLE, native lock, challenge secret or opaque
 * prepared object. Their schemas validate transport, never produce authority. */
export const SourceSupervisorIdentityV1Schema = z.object({
  pid: z.number().int().positive(), creationTime: z.string().regex(/^\d+$/).max(128),
  image: z.string().min(1).max(4096), sid: z.string().startsWith("S-1-").max(256),
}).strict();
export const SourceStableConfigurationV1Schema = z.object({
  version: z.literal(1), node_id: id, device_id: id,
  store_family_identity_digest: digest, genesis_store_identity_digest: digest,
  workspace_root: z.string().min(1).max(4096), workspace_identity_digest: digest,
  // Produced from explicitly enumerated stable local configuration. The old
  // configuration_digest and each exact launch identity retain their v1 meaning.
  stable_configuration_digest: digest,
}).strict();
export type SourceStableConfigurationV1 = z.infer<typeof SourceStableConfigurationV1Schema>;
export const SourceSupervisorLaunchV1Schema = z.object({
  version: z.literal(1), observer_id: uuid, supervisor: SourceSupervisorIdentityV1Schema,
  launch_identity_digest: digest, runtime_manifest_digest: digest,
  stable: SourceStableConfigurationV1Schema,
}).strict();
export type SourceSupervisorLaunchV1 = z.infer<typeof SourceSupervisorLaunchV1Schema>;

/** Sent by the actual daemon on its current paired execution transport. The
 * parent sends SourceSupervisorLaunch independently on the original observer. */
export const SourceLifecycleRegistrationV1Schema = z.object({
  version: z.literal(1), launch: SourceSupervisorLaunchV1Schema,
  registration: ProductSourceRecoveryRegistrationV1Schema,
  successor_grant_digest: digest.optional(),
}).strict().superRefine((value, ctx) => {
  const stable = value.launch.stable, binding = value.registration.binding;
  if (stable.node_id !== binding.node_id || stable.device_id !== binding.device_id
    || stable.workspace_root !== binding.workspace_root || stable.workspace_identity_digest !== binding.workspace_identity_digest)
    ctx.addIssue({ code: "custom", message: "Clean lifecycle registration changed its physical workspace or device" });
});
export type SourceLifecycleRegistrationV1 = z.infer<typeof SourceLifecycleRegistrationV1Schema>;

const operationSet = z.array(RecoveryOperationRefV1Schema).max(128).superRefine((values, ctx) => {
  const keys = values.map(value => value.kind + ":" + value.operation_id);
  if (new Set(keys).size !== keys.length || canonical(keys) !== canonical([...keys].sort()))
    ctx.addIssue({ code: "custom", message: "Clean stop covers one complete, unique and canonically ordered operation set" });
});
export const SourceCleanStopIntentV1Schema = z.object({
  version: z.literal(1), stop_id: uuid, lineage_id: uuid, generation_id: uuid,
  revision: z.number().int().nonnegative(), launch: SourceSupervisorLaunchV1Schema,
  registration: ProductSourceRecoveryRegistrationV1Schema,
  origin: ImportedValidationOriginV1Schema, goal_id: id, plan_id: id,
  authorization: z.object({ event_id: id, actor_user_id: id, consent_id: id.nullable(), policy_version: id }).strict(),
  operations: operationSet,
}).strict().superRefine((value, ctx) => {
  const context = value.origin.execution_request.run_start.context_pack.payload.goal_context;
  if (value.goal_id !== context?.goal_id || value.plan_id !== context?.plan?.id
    || value.registration.binding.node_id !== value.launch.stable.node_id
    || value.registration.binding.device_id !== value.launch.stable.device_id
    || value.registration.binding.workspace_identity_digest !== value.launch.stable.workspace_identity_digest)
    ctx.addIssue({ code: "custom", message: "Clean stop intent changed its accepted H6 goal or original launch" });
});
export type SourceCleanStopIntentV1 = z.infer<typeof SourceCleanStopIntentV1Schema>;

const daemon = z.object({ generation: z.number().int().min(0).max(8), identity: SourceSupervisorIdentityV1Schema,
  root_wait_observed: z.literal(true), exit_code: z.number().int().nonnegative(),
  stdout_eof: z.literal(true), stderr_eof: z.literal(true), input_settled: z.literal(true), atomic_job_member: z.literal(true),
}).strict();
export const SourceSupervisedCleanClosureV1Schema = z.object({
  version: z.literal(1), kind: z.literal("whole-supervisor-job-closed.v1"), stop_id: uuid, intent_digest: digest,
  observer_id: uuid, supervisor: SourceSupervisorIdentityV1Schema, launch_identity_digest: digest,
  native_terminal_digest: digest, retained_history_digest: digest, incarnations: z.array(daemon).min(1).max(9),
  normal_daemon_shutdown: z.literal(true), graceful_stop_armed: z.literal(true), graceful_stop_timed_out: z.literal(false),
  job_empty_observed: z.literal(true), forced_job_termination: z.boolean(),
  parent: z.object({ spawned: z.literal(true), exited: z.literal(true), closed: z.literal(true),
    stdout_eof: z.literal(true), stderr_eof: z.literal(true), exit_code: z.literal(0), close_code: z.literal(0),
    signal: z.null(), close_signal: z.null(), inputs_unchanged: z.literal(true) }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.incarnations.some((item, index) => item.generation !== index) || value.incarnations.at(-1)?.exit_code !== 0
    || new Set(value.incarnations.map(item => canonical(item.identity))).size !== value.incarnations.length)
    ctx.addIssue({ code: "custom", message: "Clean closure requires the complete original daemon roster and a successful final daemon" });
});
export type SourceSupervisedCleanClosureV1 = z.infer<typeof SourceSupervisedCleanClosureV1Schema>;
export const SourceCleanStopReceiptV1Schema = z.object({
  version: z.literal(1), stop_id: uuid, lineage_id: uuid, generation_id: uuid,
  intent_digest: digest, closure_digest: digest, committed_event_id: id,
}).strict();
export type SourceCleanStopReceiptV1 = z.infer<typeof SourceCleanStopReceiptV1Schema>;

export const SourceCleanRestartGrantV1Schema = z.object({
  version: z.literal(1), lineage_id: uuid, predecessor_generation_id: uuid, generation_id: uuid,
  claimant_observer_id: uuid, revision: z.number().int().positive(), stable: SourceStableConfigurationV1Schema,
  predecessor: SourceCleanStopReceiptV1Schema, predecessor_history_digest: digest, origin: ImportedValidationOriginV1Schema,
  goal_id: id, plan_id: id,
  authorization: z.object({ event_id: id, actor_user_id: id, consent_id: id.nullable(), policy_version: id }).strict(),
  scope: z.literal("unverified-h7-recovery"),
}).strict().superRefine((value, ctx) => {
  if (value.generation_id === value.predecessor_generation_id || value.lineage_id !== value.predecessor.lineage_id
    || value.predecessor_generation_id !== value.predecessor.generation_id)
    ctx.addIssue({ code: "custom", message: "Clean restart must reserve exactly one new generation of its original workspace lineage" });
});
export type SourceCleanRestartGrantV1 = z.infer<typeof SourceCleanRestartGrantV1Schema>;

export const SourceCleanRestartCheckpointV1Schema = z.object({
  version: z.literal(1), lineage_id: uuid, generation_id: uuid, grant_digest: digest,
  lifecycle_registration: SourceLifecycleRegistrationV1Schema,
  predecessor_history_digest: digest, subject_digest: digest,
  baseline: ImportedValidationBaselineV1Schema, accepted_inputs: AcceptedProductInputsSchema,
  source_state: z.literal("unverified"),
}).strict();
export type SourceCleanRestartCheckpointV1 = z.infer<typeof SourceCleanRestartCheckpointV1Schema>;
export const SourceCleanRestartReceiptV1Schema = z.object({
  version: z.literal(1), lineage_id: uuid, generation_id: uuid, grant_digest: digest,
  checkpoint_digest: digest, registration_id: uuid, session_id: id, committed_event_id: id,
  source_state: z.literal("unverified"),
}).strict();
export type SourceCleanRestartReceiptV1 = z.infer<typeof SourceCleanRestartReceiptV1Schema>;

export function sourceCleanDigestV1(value: unknown, sha: SourceOperationSha): string { return digest.parse(sha(canonical(value))); }
export function inspectSourceCleanClosureV1(intentInput: unknown, input: unknown, sha: SourceOperationSha) {
  const intent = SourceCleanStopIntentV1Schema.parse(intentInput), value = SourceSupervisedCleanClosureV1Schema.parse(input);
  if (value.stop_id !== intent.stop_id || value.intent_digest !== sourceCleanDigestV1(intent, sha)
    || value.observer_id !== intent.launch.observer_id || value.launch_identity_digest !== intent.launch.launch_identity_digest
    || canonical(value.supervisor) !== canonical(intent.launch.supervisor)) throw Error("Clean closure changed its original parent, native launch or prepared stop");
  return value;
}
export function inspectSourceCleanCheckpointV1(grantInput: unknown, input: unknown, sha: SourceOperationSha) {
  const grant = SourceCleanRestartGrantV1Schema.parse(grantInput), value = SourceCleanRestartCheckpointV1Schema.parse(input);
  const lifecycle = value.lifecycle_registration, registration = lifecycle.registration;
  if (value.lineage_id !== grant.lineage_id || value.generation_id !== grant.generation_id
    || value.grant_digest !== sourceCleanDigestV1(grant, sha) || lifecycle.successor_grant_digest !== value.grant_digest
    || value.predecessor_history_digest !== grant.predecessor_history_digest
    || lifecycle.launch.observer_id !== grant.claimant_observer_id || canonical(lifecycle.launch.stable) !== canonical(grant.stable)
    || registration.binding.store_identity_digest === grant.stable.genesis_store_identity_digest
    || value.subject_digest !== value.baseline.subject_digest
    || value.baseline.manifest_digest !== sourceCleanDigestV1({ directories: value.baseline.directories, files: value.baseline.files }, sha)
    || canonical(value.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(grant.origin.execution_request)))
    throw Error("Clean restart checkpoint changed its reserved generation, fresh store, accepted inputs or unverified baseline");
  return value;
}
