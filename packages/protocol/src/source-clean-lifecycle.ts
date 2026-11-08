import { z } from "zod";
import { SourceSupervisorLaunchV1Schema, SourceLifecycleRegistrationV1Schema, SourceSupervisedCleanClosureV1Schema,
  SourceCleanStopIntentV1Schema, SourceCleanStopReceiptV1Schema, SourceCleanRestartGrantV1Schema,
  SourceCleanRestartCheckpointV1Schema, SourceCleanRestartReceiptV1Schema } from "@artoo/domain";
const uuid = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const header = { version: z.literal(1), request_id: uuid, sequence: z.number().int().positive().max(2147483647),
  observer_id: uuid, challenge: z.string().regex(/^[a-f0-9]{64}$/) };

/** This separate original-parent channel never carries run.start. The secret
 * challenge remains in the parent and is never placed in the daemon environment. */
export const SourceLifecycleParentMessageV1Schema = z.discriminatedUnion("type", [
  z.object({ ...header, type: z.literal("node.source-lifecycle.bind.v1"), payload: SourceSupervisorLaunchV1Schema }).strict(),
  z.object({ ...header, type: z.literal("node.source-clean-stop.prepare.v1"), payload: z.object({}).strict() }).strict(),
  z.object({ ...header, type: z.literal("node.source-clean-stop.await-prepare.v1"), payload: z.object({}).strict() }).strict(),
  z.object({ ...header, type: z.literal("node.source-clean-stop.commit.v1"), payload: SourceSupervisedCleanClosureV1Schema }).strict(),
  z.object({ ...header, type: z.literal("node.source-clean-restart.claim.v1"), payload: z.object({ stop_id: uuid }).strict() }).strict(),
]);
export type SourceLifecycleParentMessageV1 = z.infer<typeof SourceLifecycleParentMessageV1Schema>;
const reply = { version: z.literal(1), request_id: uuid, sequence: z.number().int().positive(), observer_id: uuid };
export const SourceLifecycleServerMessageV1Schema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("node.source-lifecycle.opened.v1"), observer_id: uuid,
    challenge: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ ...reply, type: z.literal("node.source-lifecycle.bound.v1"), payload: z.object({ version: z.literal(1), observer_id: uuid, launch_digest: digest }).strict() }).strict(),
  z.object({ ...reply, type: z.literal("node.source-clean-stop.prepared.v1"), payload: SourceCleanStopIntentV1Schema }).strict(),
  z.object({ ...reply, type: z.literal("node.source-clean-stop.committed.v1"), payload: SourceCleanStopReceiptV1Schema }).strict(),
  z.object({ ...reply, type: z.literal("node.source-clean-restart.claimed.v1"), payload: SourceCleanRestartGrantV1Schema }).strict(),
  z.object({ ...reply, type: z.literal("node.source-lifecycle.error.v1"), message: z.string().min(1).max(500) }).strict(),
]);
export type SourceLifecycleServerMessageV1 = z.infer<typeof SourceLifecycleServerMessageV1Schema>;

// Parent commands and native pipes remain small. Replies contain the complete
// accepted origin: 1 MiB is an explicit transport support limit, not a schema
// maximum. Both endpoints must use this revision for replies above 64 KiB.
export const SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1 = 64 * 1024;
export const SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 = 1024 * 1024;
// This bounds retained encoded strings, not JavaScript's total heap usage.
export const SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1 = 4 * 1024 * 1024;
// A 500-character error may require 3,000 JSON bytes. The fixed header and
// bounded bind/commit receipts keep every small control reply below 4 KiB.
export const SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1 = 4096;
export function encodeSourceLifecycleServerMessageV1(input: unknown): string {
  const encoded = JSON.stringify(SourceLifecycleServerMessageV1Schema.parse(input));
  if (Buffer.byteLength(encoded, "utf8") > SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1)
    throw Error("Clean lifecycle reply exceeds its 1 MiB UTF-8 byte limit");
  return encoded;
}
export function assertSourceLifecyclePayloadReplyFitsV1(
  type: "node.source-clean-stop.prepared.v1" | "node.source-clean-restart.claimed.v1", payload: unknown,
  byteBudget = SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1,
): void {
  if (!Number.isSafeInteger(byteBudget) || byteBudget < 0 || byteBudget > SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1)
    throw Error("Invalid clean lifecycle reply budget");
  // Sizing only, never sent or persisted: both real IDs are UUIDs (36 bytes),
  // and a request sequence is bounded to 2147483647. This includes the largest
  // legal response header before a service commits its state transition.
  const uuid = "00000000-0000-4000-8000-000000000000";
  const encoded = encodeSourceLifecycleServerMessageV1({ version: 1, type,
    request_id: uuid, sequence: 2147483647, observer_id: uuid, payload });
  if (Buffer.byteLength(encoded, "utf8") > byteBudget)
    throw Error("Clean lifecycle reply exceeds the original connection's retained reply budget");
}

/** These messages travel only on the already-qualified daemon execution channel.
 * Parent observations cannot stand in for the independent paired registration. */
export const sourceLifecycleRegisterSchema = z.object({ kind: z.literal("product.source.lifecycle.register.v1"),
  node_id: z.string().min(1).max(128), payload: SourceLifecycleRegistrationV1Schema }).strict();
export const sourceCleanCheckpointSchema = z.object({ kind: z.literal("product.source.clean-restart.checkpoint.v1"),
  node_id: z.string().min(1).max(128), payload: SourceCleanRestartCheckpointV1Schema }).strict();
export const sourceLifecycleRegisteredSchema = z.object({ version: z.literal(1), observer_id: uuid, lineage_id: uuid,
  registration_id: uuid, registration_digest: digest, generation_id: uuid.optional(), restart_grant: SourceCleanRestartGrantV1Schema.optional() }).strict()
  .superRefine((value, ctx) => {
    if (value.generation_id !== undefined ? !value.restart_grant || value.restart_grant.generation_id !== value.generation_id
      || value.restart_grant.lineage_id !== value.lineage_id || value.restart_grant.claimant_observer_id !== value.observer_id : value.restart_grant !== undefined)
      ctx.addIssue({ code: "custom", message: "Fresh daemon registration must return its exact Server-committed successor grant" });
  });
export const sourceCleanCheckpointCommittedSchema = SourceCleanRestartReceiptV1Schema;
export type SourceLifecycleRegister = z.infer<typeof sourceLifecycleRegisterSchema>;
export type SourceCleanCheckpoint = z.infer<typeof sourceCleanCheckpointSchema>;
const command = { kind: z.literal("command"), id: z.string().min(1).max(128), idempotency_key: z.string().min(1).max(256) };
export const sourceLifecycleRegisteredCommandSchema = z.object({ ...command, type: z.literal("product.source.lifecycle.registered.v1"), payload: sourceLifecycleRegisteredSchema }).strict();
export const sourceCleanCheckpointCommittedCommandSchema = z.object({ ...command, type: z.literal("product.source.clean-restart.checkpointed.v1"), payload: sourceCleanCheckpointCommittedSchema }).strict();
export const sourceLifecycleRejectedCommandSchema = z.object({ ...command, type: z.literal("product.source.lifecycle.rejected.v1"),
  payload: z.object({ version: z.literal(1), control: z.enum(["register", "checkpoint"]), correlation_id: uuid,
    reason: z.string().min(1).max(500) }).strict() }).strict();
export type SourceLifecycleRegisteredCommand = z.infer<typeof sourceLifecycleRegisteredCommandSchema>;
export type SourceCleanCheckpointCommittedCommand = z.infer<typeof sourceCleanCheckpointCommittedCommandSchema>;
export type SourceLifecycleRejectedCommand = z.infer<typeof sourceLifecycleRejectedCommandSchema>;
