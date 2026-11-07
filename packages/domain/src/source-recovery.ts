import { z } from "zod";
import { AcceptedProductInputsSchema } from "./product-development.js";
import { ImportedValidationBaselineV1Schema, ImportedValidationOriginV1Schema, inspectImportedValidationOriginV1 } from "./imported-validation.js";
import { importedExecutionAcceptedInputsV1 } from "./imported-execution.js";
import { canonicalProductSourceTransferValueV1 as canonical } from "./product-source-transfer.js";
import type { SourceOperationSha } from "./product-source-operations.js";

const id = z.string().min(1).max(128), uuid = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), integer = z.number().int().nonnegative().max(2147483647);
const reason = z.string().trim().min(1).max(2000);
export const PRODUCT_SOURCE_RECOVERY_FEATURE_V1 = "product.source.recovery.v1";

/** Native HANDLEs, pipe credentials and same-process brands deliberately have no wire schema. */
export const RecoveryNodeBindingV1Schema = z.object({
  version: z.literal(1), node_id: id, device_id: id, guardian_instance_id: uuid,
  store_identity_digest: digest, configuration_digest: digest,
  workspace_root: z.string().min(1).max(4096), workspace_identity_digest: digest,
}).strict();
export type RecoveryNodeBindingV1 = z.infer<typeof RecoveryNodeBindingV1Schema>;
export const RecoveryEpochV1Schema = z.object({
  version: z.literal(1), epoch_id: uuid, generation: integer, session_id: id,
  roster_revision: integer, roster_digest: digest,
}).strict();
export type RecoveryEpochV1 = z.infer<typeof RecoveryEpochV1Schema>;

/** A native slot may be a helper/observer and does not imply a persisted Server run. */
export const RecoveryNativeSlotV1Schema = z.object({
  slot_id: uuid, operation_kind: z.enum(["author", "verifier", "browser", "observer", "git", "tool"]),
  operation_id: id, binding_digest: digest, terminal_digest: digest,
}).strict();
export type RecoveryNativeSlotV1 = z.infer<typeof RecoveryNativeSlotV1Schema>;
export const RecoveryOperationRefV1Schema = z.object({
  kind: z.enum(["validation", "validation_review", "release"]), operation_id: id, request_digest: digest,
  run_id: id.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === "validation" ? !value.run_id : value.run_id !== undefined)
    ctx.addIssue({ code: "custom", message: "Only validation author recovery binds an actual persisted run ID" });
});
export type RecoveryOperationRefV1 = z.infer<typeof RecoveryOperationRefV1Schema>;
const operations = z.array(RecoveryOperationRefV1Schema).max(128).superRefine((values, ctx) => {
  const keys = values.map(value => value.kind + ":" + value.operation_id);
  if (new Set(keys).size !== keys.length || canonical(keys) !== canonical([...keys].sort()))
    ctx.addIssue({ code: "custom", message: "Recovery operations must be unique and canonically sorted" });
});

export const ProductSourceRecoveryRegistrationV1Schema = z.object({
  version: z.literal(1), registration_id: uuid, binding: RecoveryNodeBindingV1Schema, epoch: RecoveryEpochV1Schema,
}).strict();
export type ProductSourceRecoveryRegistrationV1 = z.infer<typeof ProductSourceRecoveryRegistrationV1Schema>;
export function productSourceRecoveryRegistrationDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ProductSourceRecoveryRegistrationV1Schema.parse(input))));
}
export const ProductSourceRecoveryAvailabilityV1Schema = z.discriminatedUnion("state", [
  z.object({ version: z.literal(1), state: z.literal("recoverable"), registration_id: uuid,
    binding: RecoveryNodeBindingV1Schema, previous_epoch: RecoveryEpochV1Schema, current_session_id: id,
    new_daemon_identity_digest: digest, operations }).strict(),
  z.object({ version: z.literal(1), state: z.literal("unknown"), registration_id: uuid,
    binding: RecoveryNodeBindingV1Schema, previous_epoch: RecoveryEpochV1Schema, current_session_id: id, reason }).strict(),
]);
export type ProductSourceRecoveryAvailabilityV1 = z.infer<typeof ProductSourceRecoveryAvailabilityV1Schema>;

export const ProductSourceRecoveryRequestV1Schema = z.object({
  version: z.literal(1), recovery_id: id, registration_id: uuid, origin_review_id: id, goal_id: id, plan_id: id,
  origin: ImportedValidationOriginV1Schema,
  binding: RecoveryNodeBindingV1Schema, previous_epoch: RecoveryEpochV1Schema,
  current_session_id: id, new_daemon_identity_digest: digest, challenge_id: uuid, operations,
  // Local-only policy has an explicit null consent ID, exactly as the original
  // transfer authorization. The current policy/grant is still checked by Server.
  authorization: z.object({ event_id: id, actor_user_id: id, consent_id: id.nullable(), policy_version: id }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.current_session_id === value.previous_epoch.session_id || value.origin.review_id !== value.origin_review_id
    || value.goal_id !== value.origin.execution_request.run_start.context_pack.payload.goal_context?.goal_id
    || value.plan_id !== value.origin.execution_request.run_start.context_pack.payload.goal_context?.plan?.id)
    ctx.addIssue({ code: "custom", message: "Daemon recovery requires its exact original accepted goal and a distinct authenticated session" });
});
export type ProductSourceRecoveryRequestV1 = z.infer<typeof ProductSourceRecoveryRequestV1Schema>;
export function inspectProductSourceRecoveryRequestV1(input: unknown, researchBytes: Uint8Array, sha: SourceOperationSha) {
  const request = ProductSourceRecoveryRequestV1Schema.parse(input), origin = inspectImportedValidationOriginV1(request.origin, researchBytes, sha);
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  if (request.binding.node_id !== destination.node_id || request.binding.workspace_root !== origin.execution_request.run_start.workspace.root)
    throw Error("Recovery original accepted source belongs to another node or workspace");
  return request;
}
export const ProductSourceRecoveryControlV1Schema = z.object({ version: z.literal(1), recovery_id: id, request_digest: digest }).strict();
export type ProductSourceRecoveryControlV1 = z.infer<typeof ProductSourceRecoveryControlV1Schema>;

export const ProductSourceRecoveryCheckpointV1Schema = z.object({
  version: z.literal(1), recovery_id: id, request_digest: digest, binding: RecoveryNodeBindingV1Schema,
  old_epoch_id: uuid, new_epoch_id: uuid, generation: integer, current_session_id: id,
  new_daemon_identity_digest: digest, challenge_id: uuid, roster_revision: integer, roster_digest: digest,
  closure_set_digest: digest, operations,
  subject_digest: digest, baseline: ImportedValidationBaselineV1Schema, accepted_inputs: AcceptedProductInputsSchema,
  source_state: z.literal("unverified"),
}).strict().superRefine((value, ctx) => {
  if (value.old_epoch_id === value.new_epoch_id || value.generation === 0 || value.subject_digest !== value.baseline.subject_digest)
    ctx.addIssue({ code: "custom", message: "Recovery must create a fresh epoch and an unverified measured workspace baseline" });
});
export type ProductSourceRecoveryCheckpointV1 = z.infer<typeof ProductSourceRecoveryCheckpointV1Schema>;
const control = { version: z.literal(1), recovery_id: id, request_digest: digest };
export const ProductSourceRecoveryResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...control, outcome: z.literal("recovered"), closed: z.literal(true), checkpoint: ProductSourceRecoveryCheckpointV1Schema }).strict(),
  z.object({ ...control, outcome: z.literal("unknown"), closed: z.literal(false), reason }).strict(),
]);
export type ProductSourceRecoveryResultV1 = z.infer<typeof ProductSourceRecoveryResultV1Schema>;
export function productSourceRecoveryRequestDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ProductSourceRecoveryRequestV1Schema.parse(input))));
}
export function productSourceRecoveryCheckpointDigestV1(input: unknown, sha: SourceOperationSha): string {
  return digest.parse(sha(canonical(ProductSourceRecoveryCheckpointV1Schema.parse(input))));
}
export function inspectProductSourceRecoveryResultV1(requestInput: unknown, input: unknown, sha: SourceOperationSha): ProductSourceRecoveryResultV1 {
  const request = ProductSourceRecoveryRequestV1Schema.parse(requestInput), result = ProductSourceRecoveryResultV1Schema.parse(input);
  const requestDigest = productSourceRecoveryRequestDigestV1(request, sha);
  if (result.recovery_id !== request.recovery_id || result.request_digest !== requestDigest) throw Error("Recovery result changed its exact request");
  if (result.outcome === "unknown") return result;
  const value = result.checkpoint;
  if (value.recovery_id !== request.recovery_id || value.request_digest !== requestDigest
    || canonical(value.binding) !== canonical(request.binding) || canonical(value.operations) !== canonical(request.operations)
    || value.old_epoch_id !== request.previous_epoch.epoch_id || value.generation !== request.previous_epoch.generation + 1
    || value.current_session_id !== request.current_session_id || value.challenge_id !== request.challenge_id
    || value.new_daemon_identity_digest !== request.new_daemon_identity_digest
    || value.roster_revision !== request.previous_epoch.roster_revision || value.roster_digest !== request.previous_epoch.roster_digest
    || canonical(value.accepted_inputs) !== canonical(importedExecutionAcceptedInputsV1(request.origin.execution_request))
    || value.baseline.manifest_digest !== sha(canonical({ directories: value.baseline.directories, files: value.baseline.files })))
    throw Error("Recovery checkpoint changed its original epoch, complete roster, current session or measured baseline");
  return result;
}
