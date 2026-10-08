import { z } from "zod";

import {
  ArtifactPayloadSchema,
  RunAnswerPayloadSchema,
  RunLifecyclePayloadSchema,
  RunOutputPayloadSchema,
  RunStartPayloadSchema,
  RunWorkspaceRetainedPayloadSchema,
  RunUsagePayloadSchema
} from "@artoo/domain";

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

export const MANAGED_RECEIPT_CONTRACT = "run-event-body-v1" as const;
const sessionIdentifier = z.string().min(1).max(128);

// --- Node -> Server -------------------------------------------------------

export const nodeHelloSchema = z.object({
  kind: z.literal("node.hello"),
  node_id: z.string().min(1),
  protocol_version: z.string().min(1),
  artood_version: z.string().min(1),
  machine: machineSchema,
  execution_features: z.array(z.string().min(1).max(128)).max(32).optional(),
  managed_receipts: z.object({ version: z.number().int().positive(), nonce: z.string().uuid(),
    required_contract: z.string().min(1).max(128) }).optional()
});

export const nodeSessionProbeSchema = z.object({ kind: z.literal("node.session.probe"),
  node_id: sessionIdentifier, session_id: z.string().uuid(), probe_id: z.string().uuid() });

export const runtimeStatusSchema = z.object({
  runtime: z.string().min(1),
  status: z.enum(["detected", "available", "missing", "disabled"]),
  version: z.string().nullable().optional(),
  // Capability tags this runtime advertises (e.g. "code.read", "code.modify").
  // Optional for back-compat: pre-capability heartbeats omit it and parse to [],
  // never undefined, so the scheduler can always read an array.
  capabilities: z.array(z.string()).default([])
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

export const nodeSessionReadyCommandSchema = z.object({ ...commandEnvelope, type: z.literal("node.session.ready"),
  payload: z.object({ version: z.number().int().positive(), node_id: sessionIdentifier,
    hello_nonce: z.string().uuid(), session_id: z.string().uuid(), receipt_contract: z.string().min(1).max(128),
    sequence_max: z.number().int().positive(), liveness: z.object({
      probe_interval_ms: z.number().int().positive(), probe_timeout_ms: z.number().int().positive() }) }) });
export const nodeSessionPongCommandSchema = z.object({ ...commandEnvelope, type: z.literal("node.session.pong"),
  payload: z.object({ node_id: sessionIdentifier, session_id: z.string().uuid(), probe_id: z.string().uuid() }) });

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

// run.resume (#115 P2-S3): sent to a reconnected node to continue an
// already-active run after a brief disconnect grace window. Minimal payload —
// just the run id; the node either continues the live process or acks rejected.
export const runResumeCommandSchema = z.object({
  ...commandEnvelope,
  type: z.literal("run.resume"),
  payload: z.object({
    run_id: z.string().min(1)
  })
});

/** Receipt sent after a run event has committed, enabling safe replay. */
export const runEventAckCommandSchema = z.object({
  ...commandEnvelope,
  type: z.literal("run.event.ack"),
  payload: z.object({
    run_id: z.string().min(1), sequence: z.number().int().nonnegative().max(2147483647),
    status: z.enum(["accepted", "rejected"]), message: z.string().optional(),
  }),
});

// run.start carries the domain RunStartPayload (imported, not redefined — the
// payload is owned by @artoo/domain). The wire envelope (id/idempotency_key/
// deadline_at) is owned here.
export const runStartCommandSchema = z.object({
  ...commandEnvelope,
  type: z.literal("run.start"),
  payload: RunStartPayloadSchema
});

/** All Server -> Node commands, discriminated on `type`. */
export const commandSchema = z.discriminatedUnion("type", [
  nodeSessionReadyCommandSchema,
  nodeSessionPongCommandSchema,
  runStartCommandSchema,
  runStopCommandSchema,
  artifactCollectCommandSchema,
  runResumeCommandSchema,
  runEventAckCommandSchema
]);

// --- Node -> Server: run.event --------------------------------------------
// The event body is a discriminated union over the domain payloads; the wire
// message adds the transport tuple (node_id, run_id, sequence) used for ordered,
// idempotent ingest (see RunEventDeduper).
export const adapterRunEventBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.output"), payload: RunOutputPayloadSchema }),
  z.object({ type: z.literal("run.answer"), payload: RunAnswerPayloadSchema }),
  z.object({ type: z.literal("run.usage"), payload: RunUsagePayloadSchema }),
  z.object({ type: z.literal("run.lifecycle"), payload: RunLifecyclePayloadSchema }),
  z.object({ type: z.literal("artifact.created"), payload: ArtifactPayloadSchema })
]);

/** Retention evidence is node-owned and cannot be supplied by a RuntimeAdapter. */
export const runEventBodySchema = z.discriminatedUnion("type", [
  ...adapterRunEventBodySchema.options,
  z.object({ type: z.literal("run.workspace.retained"), payload: RunWorkspaceRetainedPayloadSchema }),
]);

export const runEventMessageSchema = z.object({
  kind: z.literal("run.event"),
  node_id: z.string().min(1),
  run_id: z.string().min(1),
  sequence: z.number().int().nonnegative().max(2147483647),
  event: runEventBodySchema
});

export type Machine = z.infer<typeof machineSchema>;
export type NodeHello = z.infer<typeof nodeHelloSchema>;
export type NodeSessionProbe = z.infer<typeof nodeSessionProbeSchema>;
export type NodeSessionReadyCommand = z.infer<typeof nodeSessionReadyCommandSchema>;
export type NodeSessionPongCommand = z.infer<typeof nodeSessionPongCommandSchema>;
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;
export type NodeHeartbeat = z.infer<typeof nodeHeartbeatSchema>;
export type CommandAck = z.infer<typeof commandAckSchema>;
export type RunStopCommand = z.infer<typeof runStopCommandSchema>;
export type ArtifactCollectCommand = z.infer<typeof artifactCollectCommandSchema>;
export type RunStartCommand = z.infer<typeof runStartCommandSchema>;
export type RunResumeCommand = z.infer<typeof runResumeCommandSchema>;
export type RunEventAckCommand = z.infer<typeof runEventAckCommandSchema>;
export type Command = z.infer<typeof commandSchema>;
/** A single adapter-emitted event (domain payload), framed by run.event. */
export type RunEvent = z.infer<typeof adapterRunEventBodySchema>;
export type NodeRunEvent = z.infer<typeof runEventBodySchema>;
export type RunEventMessage = z.infer<typeof runEventMessageSchema>;
