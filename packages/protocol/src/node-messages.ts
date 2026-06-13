import { z } from "zod";

import { nodeErrorCodeSchema } from "./errors.js";

/**
 * Transport-level node protocol messages (design.md §4.6).
 *
 * These are WIRE ENVELOPES only. Payloads that carry business data
 * (run.start's RunStartPayload, run.event's RunEvent payloads) are owned by
 * @artoo/domain and imported here in the domain-dependent phase — they are NOT
 * redefined in this package. The messages below carry no domain payload, so
 * they live entirely in the protocol layer.
 */

export const machineSchema = z.object({
  hostname: z.string().min(1),
  os: z.string().min(1),
  arch: z.string().min(1)
});

// --- Node -> Server -------------------------------------------------------

export const nodeHelloSchema = z.object({
  kind: z.literal("node.hello"),
  node_id: z.string().min(1),
  protocol_version: z.string().min(1),
  artood_version: z.string().min(1),
  machine: machineSchema
});

export const runtimeStatusSchema = z.object({
  runtime: z.string().min(1),
  status: z.enum(["detected", "available", "missing", "disabled"]),
  version: z.string().nullable().optional()
});

export const nodeHeartbeatSchema = z.object({
  kind: z.literal("node.heartbeat"),
  node_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  resources: z.object({
    cpu_load: z.number(),
    memory_used_pct: z.number(),
    disk_free_gb: z.number()
  }),
  runtimes: z.array(runtimeStatusSchema),
  running_instances: z.array(z.string())
});

// A command.ack is a discriminated union on `status`: an accepted ack carries
// no error code (message optional/nullable); a rejected ack MUST carry a closed
// NodeErrorCode plus a human-readable message, so the server can pick the right
// recovery rule (design.md §4.6, Round 13/18).
const commandAckBase = {
  kind: z.literal("command.ack"),
  node_id: z.string().min(1),
  command_id: z.string().min(1)
};

export const commandAckAcceptedSchema = z.object({
  ...commandAckBase,
  status: z.literal("accepted"),
  message: z.string().nullable().optional()
});

export const commandAckRejectedSchema = z.object({
  ...commandAckBase,
  status: z.literal("rejected"),
  error_code: nodeErrorCodeSchema,
  message: z.string().min(1)
});

export const commandAckSchema = z.discriminatedUnion("status", [
  commandAckAcceptedSchema,
  commandAckRejectedSchema
]);

// --- Server -> Node (transport-only commands) -----------------------------
// run.start is added in the domain-dependent phase because its payload is the
// domain RunStartPayload. run.stop and artifact.collect carry no domain payload.

const commandEnvelope = {
  kind: z.literal("command"),
  id: z.string().min(1),
  idempotency_key: z.string().min(1),
  deadline_at: z.string().datetime().optional()
};

export const runStopCommandSchema = z.object({
  ...commandEnvelope,
  type: z.literal("run.stop"),
  payload: z.object({
    run_id: z.string().min(1),
    reason: z.string()
  })
});

export const artifactCollectCommandSchema = z.object({
  ...commandEnvelope,
  type: z.literal("artifact.collect"),
  payload: z.object({
    run_id: z.string().min(1),
    paths: z.array(z.string())
  })
});

export type Machine = z.infer<typeof machineSchema>;
export type NodeHello = z.infer<typeof nodeHelloSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type NodeHeartbeat = z.infer<typeof nodeHeartbeatSchema>;
export type CommandAck = z.infer<typeof commandAckSchema>;
export type RunStopCommand = z.infer<typeof runStopCommandSchema>;
export type ArtifactCollectCommand = z.infer<typeof artifactCollectCommandSchema>;
