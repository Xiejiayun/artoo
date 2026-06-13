/**
 * Node command/event PAYLOAD shapes (design.md §4.5, §4.6, §5.6).
 *
 * Boundary (agreed with @claude_sde): `@artoo/domain` owns "what is in the
 * message" (these payloads); `@artoo/protocol` owns "how the message is framed
 * on the wire" (node.hello/heartbeat/command/command.ack/run.event envelopes
 * with node_id/sequence/ack). Protocol imports these payloads — neither side
 * redefines them, so run.start / run.event have a single source of truth.
 */
import { z } from "zod";

import { ContextPackSchema } from "./context-pack.js";

export const ArtifactTypeSchema = z.enum([
  "patch",
  "pull_request",
  "file",
  "screenshot",
  "report",
  "log_bundle",
  "url",
  "test_result",
]);
export const ARTIFACT_TYPES = ArtifactTypeSchema.options;
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const PolicySnapshotSchema = z.object({
  filesystem_write_scope: z.array(z.string()),
  requires_approval: z.array(z.string()),
});
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

export const RunStartPayloadSchema = z.object({
  run_id: z.string(),
  task_id: z.string(),
  agent_instance_id: z.string(),
  runtime: z.string(),
  workspace: z.object({
    root: z.string(),
    branch: z.string().nullish(),
  }),
  context_pack: z.object({
    id: z.string(),
    uri: z.string().optional(),
    payload: ContextPackSchema.optional(),
  }),
  policy_snapshot: PolicySnapshotSchema,
  artifact_rules: z.object({
    paths: z.array(z.string()),
  }),
});
export type RunStartPayload = z.infer<typeof RunStartPayloadSchema>;

export const RunStopPayloadSchema = z.object({
  run_id: z.string(),
  reason: z.string(),
});
export type RunStopPayload = z.infer<typeof RunStopPayloadSchema>;

export const RunOutputPayloadSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});
export type RunOutputPayload = z.infer<typeof RunOutputPayloadSchema>;

export const RunLifecyclePayloadSchema = z.object({
  phase: z.enum(["started", "completed", "failed", "cancelled", "paused", "resumed"]),
  reason: z.string().nullish(),
});
export type RunLifecyclePayload = z.infer<typeof RunLifecyclePayloadSchema>;

export const ArtifactPayloadSchema = z.object({
  type: ArtifactTypeSchema,
  uri: z.string(),
  metadata: z.record(z.unknown()).default({}),
  checksum: z.string().nullish(),
});
export type ArtifactPayload = z.infer<typeof ArtifactPayloadSchema>;
