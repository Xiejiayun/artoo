import {productSourceOperationCommandSchema,productSourceOperationStopSchema,productSourceOperationStatusSchema,productSourceOperationReceiptSchema} from "./product-source-operations.js";
import { importedProductReviewCommandSchema, importedProductReviewStopSchema, importedProductReviewStatusSchema, importedProductReviewReceiptSchema } from "./imported-product-review.js";
import { importedDesignContinuationCommandSchema, importedDesignContinuationStopSchema, importedDesignContinuationStatusSchema, importedDesignContinuationReceiptSchema } from "./imported-design-continuation.js";
import { importedDesignReviewCommandSchema, importedDesignReviewStopSchema, importedDesignReviewStatusSchema, importedDesignReviewReceiptSchema } from "./imported-design-review.js";
import { importedExecutionCommandSchema, importedExecutionStopSchema, importedExecutionStatusSchema, importedExecutionReceiptSchema } from "./imported-execution.js";
import { importedExecutionReviewCommandSchema, importedExecutionReviewStopSchema, importedExecutionReviewStatusSchema, importedExecutionReviewReceiptSchema } from "./imported-execution-review.js";
import { importedExecutionRepairCommandSchema, importedExecutionRepairStopSchema, importedExecutionRepairStatusSchema, importedExecutionRepairReceiptSchema } from "./imported-execution-repair.js";
import { importedValidationCommandSchema, importedValidationStopSchema, importedValidationStatusSchema, importedValidationReceiptSchema } from "./imported-validation.js";
import { importedValidationReviewCommandSchema, importedValidationReviewStopSchema, importedValidationReviewStatusSchema, importedValidationReviewReceiptSchema } from "./imported-validation-review.js";
import { productSourceRecoveryCommandSchema, productSourceRecoveryStopSchema, productSourceRecoveryStatusSchema, productSourceRecoveryReceiptSchema, productSourceRecoveryRegisteredSchema, productSourceRecoverySessionSchema } from "./source-recovery.js";
import { sourceLifecycleRegisteredCommandSchema, sourceCleanCheckpointCommittedCommandSchema, sourceLifecycleRejectedCommandSchema } from "./source-clean-lifecycle.js";
import { importedRecoveryValidationCommandSchema, importedRecoveryValidationStopSchema, importedRecoveryValidationStatusSchema, importedRecoveryValidationReceiptSchema } from "./imported-recovery-validation.js";
import { importedCleanValidationCommandSchema, importedCleanValidationStopSchema, importedCleanValidationStatusSchema, importedCleanValidationReceiptSchema } from "./imported-clean-validation.js";
import { importedRecoveryValidationReviewCommandSchema, importedRecoveryValidationReviewStopSchema, importedRecoveryValidationReviewStatusSchema, importedRecoveryValidationReviewReceiptSchema } from "./imported-recovery-validation-review.js";
import { importedCleanValidationReviewCommandSchema, importedCleanValidationReviewStopSchema, importedCleanValidationReviewStatusSchema, importedCleanValidationReviewReceiptSchema } from "./imported-clean-validation-review.js";
import { z } from "zod";

import {
  ArtifactPayloadSchema,
  RunAnswerPayloadSchema,
  RunLifecyclePayloadSchema,
  RunOutputPayloadSchema,
  RunStartPayloadSchema,
  RunWorkspaceRetainedPayloadSchema,
  RunVerificationPayloadSchema,
  VerificationProfileAdvertisementsSchema,
  ReleaseProfileAdvertisementsSchema,
  ProductReleaseRequestSchema,
  ProductReleaseReceiptSchema,
  ProductReleaseHealthReportSchema,
  RunUsagePayloadSchema
} from "@artoo/domain";
import { ProductSourceExportV1Schema, ProductSourceExportV2Schema, ProductSourceRoutingV1Schema, NodeOwnedResultProfileDescriptorsV1Schema, NodeOwnedResultVerificationEvidenceV1Schema,
  OwnedResultRunAdmissionV1Schema } from "@artoo/domain";

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
// These opaque identifiers retain the v3 hexadecimal UUID shape; v4 uuid() would add version/variant restrictions.

// --- Node -> Server -------------------------------------------------------

export const nodeHelloSchema = z.object({
  kind: z.literal("node.hello"),
  node_id: z.string().min(1),
  protocol_version: z.string().min(1),
  artood_version: z.string().min(1),
  machine: machineSchema,
  execution_features: z.array(z.string().min(1).max(128)).max(32).optional(),
  verification_profiles: VerificationProfileAdvertisementsSchema.optional(),
  release_profiles: ReleaseProfileAdvertisementsSchema.optional(),
  owned_result_profiles: NodeOwnedResultProfileDescriptorsV1Schema.optional(),
  product_source_routing: ProductSourceRoutingV1Schema.optional(),
  managed_receipts: z.object({ version: z.number().int().positive(), nonce: z.string().guid(),
    required_contract: z.string().min(1).max(128) }).optional()
});

export const nodeSessionProbeSchema = z.object({ kind: z.literal("node.session.probe"),
  node_id: sessionIdentifier, session_id: z.string().guid(), probe_id: z.string().guid() });

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
  sequence: z.number().refine(Number.isInteger, "Expected an integer").nonnegative(),
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
    hello_nonce: z.string().guid(), session_id: z.string().guid(), receipt_contract: z.string().min(1).max(128),
    sequence_max: z.number().int().positive(), liveness: z.object({
      probe_interval_ms: z.number().int().positive(), probe_timeout_ms: z.number().int().positive() }) }) });
export const nodeSessionPongCommandSchema = z.object({ ...commandEnvelope, type: z.literal("node.session.pong"),
  payload: z.object({ node_id: sessionIdentifier, session_id: z.string().guid(), probe_id: z.string().guid() }) });

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
const ownedResultModeMarkers = {
  requirement: z.never().optional(), run_start: z.never().optional(),
  owned_result: z.never().optional(), owned_result_assignment: z.never().optional(),
  owned_result_requirement: z.never().optional(), owned_result_admission: z.never().optional(),
  owned_result_profile: z.never().optional(), owned_result_profiles: z.never().optional(),
};
// Inspect raw payload keys before the ordinary domain codec can strip them.
// Unrelated legacy extension fields retain their existing compatibility.
const legacyRunStartPayloadSchema = z.unknown().superRefine((raw, ctx) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of Object.keys(ownedResultModeMarkers)) if (Object.hasOwn(raw, key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Owned result requests require run.start.owned-result.v1" });
    }
    const pack = (raw as Record<string, unknown>).context_pack;
    const payload = pack && typeof pack === "object" ? (pack as Record<string, unknown>).payload : undefined;
    if (payload && typeof payload === "object") {
      for (const key of ["imported_recovery_validation", "imported_recovery_validation_review_subject", "imported_clean_validation", "imported_clean_validation_review_subject"]) {
        if (Object.hasOwn(payload, key) && (payload as Record<string, unknown>)[key] !== undefined)
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["context_pack", "payload", key], message: "Recovery contexts require their dedicated command and current local admission" });
      }
    }
  }
}).pipe(RunStartPayloadSchema).superRefine((start, ctx) => {
  const context = start.context_pack.payload;
  if (!start.verification?.application && !context?.app_delivery) return;
  if (!start.verification?.application || !context?.app_delivery || !context.verification_capabilities?.application
    || start.workspace_allocation || start.workspace.branch != null || context.release_capabilities
    || Object.keys(context).some(key => key.startsWith("imported_") || key === "transferred_product_input" || key === "product_research_revision")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["verification", "application"],
      message: "Application development requires its ordinary inline workspace context without handoff, managed allocation or static publication" });
  }
});
export const runStartCommandSchema = z.object({
  ...commandEnvelope,
  ...ownedResultModeMarkers,
  type: z.literal("run.start"),
  payload: legacyRunStartPayloadSchema
});

export const runStartOwnedResultCommandSchema = z.object({
  ...commandEnvelope, type: z.literal("run.start.owned-result.v1"), payload: OwnedResultRunAdmissionV1Schema,
}).strict();

export const productReleaseCommandSchema = z.object({
  ...commandEnvelope, type: z.literal("product.release"), payload: ProductReleaseRequestSchema,
});
export const productReleaseCancelCommandSchema = z.object({
  ...commandEnvelope, type: z.literal("product.release.cancel"), payload: ProductReleaseRequestSchema,
});

export const productReleaseReceiptMessageSchema = z.object({
  kind: z.literal("product.release.receipt"), node_id: z.string().min(1), payload: ProductReleaseReceiptSchema,
});
export const productReleaseHealthMessageSchema = z.object({
  kind: z.literal("product.release.health"), node_id: z.string().min(1), payload: ProductReleaseHealthReportSchema,
});
/** Commits one immutable health observation; a socket write alone is not a receipt. */
export const productReleaseHealthAckCommandSchema = z.object({
  ...commandEnvelope, type: z.literal("product.release.health.ack"),
  payload: z.object({ event_id: sessionIdentifier, release_id: sessionIdentifier,
    sequence: z.number().int().min(1).max(2147483647), status: z.enum(["accepted", "rejected"]),
    message: z.string().max(2000).optional() }).strict(),
});

// Name each existing option so declaration emit preserves exact types without expanding the entire graph.
type CommandSchemaOptions = [
  typeof sourceLifecycleRegisteredCommandSchema,
  typeof sourceCleanCheckpointCommittedCommandSchema,
  typeof sourceLifecycleRejectedCommandSchema,
  typeof productSourceRecoverySessionSchema,
  typeof productSourceRecoveryRegisteredSchema,
  typeof productSourceRecoveryCommandSchema,
  typeof productSourceRecoveryStopSchema,
  typeof productSourceRecoveryStatusSchema,
  typeof productSourceRecoveryReceiptSchema,
  typeof importedRecoveryValidationCommandSchema,
  typeof importedRecoveryValidationStopSchema,
  typeof importedRecoveryValidationStatusSchema,
  typeof importedRecoveryValidationReceiptSchema,
  typeof importedCleanValidationCommandSchema,
  typeof importedCleanValidationStopSchema,
  typeof importedCleanValidationStatusSchema,
  typeof importedCleanValidationReceiptSchema,
  typeof importedRecoveryValidationReviewCommandSchema,
  typeof importedRecoveryValidationReviewStopSchema,
  typeof importedRecoveryValidationReviewStatusSchema,
  typeof importedRecoveryValidationReviewReceiptSchema,
  typeof importedCleanValidationReviewCommandSchema,
  typeof importedCleanValidationReviewStopSchema,
  typeof importedCleanValidationReviewStatusSchema,
  typeof importedCleanValidationReviewReceiptSchema,
  typeof importedDesignContinuationCommandSchema,
  typeof importedDesignContinuationStopSchema,
  typeof importedDesignContinuationStatusSchema,
  typeof importedDesignContinuationReceiptSchema,
  typeof importedDesignReviewCommandSchema,
  typeof importedDesignReviewStopSchema,
  typeof importedDesignReviewStatusSchema,
  typeof importedDesignReviewReceiptSchema,
  typeof importedExecutionCommandSchema,
  typeof importedExecutionStopSchema,
  typeof importedExecutionStatusSchema,
  typeof importedExecutionReceiptSchema,
  typeof importedExecutionReviewCommandSchema,
  typeof importedExecutionReviewStopSchema,
  typeof importedExecutionReviewStatusSchema,
  typeof importedExecutionReviewReceiptSchema,
  typeof importedExecutionRepairCommandSchema,
  typeof importedExecutionRepairStopSchema,
  typeof importedExecutionRepairStatusSchema,
  typeof importedExecutionRepairReceiptSchema,
  typeof importedValidationCommandSchema,
  typeof importedValidationStopSchema,
  typeof importedValidationStatusSchema,
  typeof importedValidationReceiptSchema,
  typeof importedValidationReviewCommandSchema,
  typeof importedValidationReviewStopSchema,
  typeof importedValidationReviewStatusSchema,
  typeof importedValidationReviewReceiptSchema,
  typeof importedProductReviewCommandSchema,
  typeof importedProductReviewStopSchema,
  typeof importedProductReviewStatusSchema,
  typeof importedProductReviewReceiptSchema,
  typeof productSourceOperationCommandSchema,
  typeof productSourceOperationStopSchema,
  typeof productSourceOperationStatusSchema,
  typeof productSourceOperationReceiptSchema,
  typeof nodeSessionReadyCommandSchema,
  typeof nodeSessionPongCommandSchema,
  typeof runStartCommandSchema,
  typeof runStartOwnedResultCommandSchema,
  typeof runStopCommandSchema,
  typeof artifactCollectCommandSchema,
  typeof runResumeCommandSchema,
  typeof runEventAckCommandSchema,
  typeof productReleaseCommandSchema,
  typeof productReleaseCancelCommandSchema,
  typeof productReleaseHealthAckCommandSchema,
];

/** All Server -> Node commands, discriminated on `type`. */
export const commandSchema: z.ZodDiscriminatedUnion<CommandSchemaOptions, "type"> = z.discriminatedUnion("type", [
  sourceLifecycleRegisteredCommandSchema, sourceCleanCheckpointCommittedCommandSchema, sourceLifecycleRejectedCommandSchema,
  productSourceRecoverySessionSchema,
  productSourceRecoveryRegisteredSchema,
  productSourceRecoveryCommandSchema, productSourceRecoveryStopSchema, productSourceRecoveryStatusSchema, productSourceRecoveryReceiptSchema,
  importedRecoveryValidationCommandSchema, importedRecoveryValidationStopSchema, importedRecoveryValidationStatusSchema, importedRecoveryValidationReceiptSchema,
  importedCleanValidationCommandSchema, importedCleanValidationStopSchema, importedCleanValidationStatusSchema, importedCleanValidationReceiptSchema,
  importedRecoveryValidationReviewCommandSchema, importedRecoveryValidationReviewStopSchema, importedRecoveryValidationReviewStatusSchema, importedRecoveryValidationReviewReceiptSchema,
  importedCleanValidationReviewCommandSchema, importedCleanValidationReviewStopSchema, importedCleanValidationReviewStatusSchema, importedCleanValidationReviewReceiptSchema,
  importedDesignContinuationCommandSchema, importedDesignContinuationStopSchema, importedDesignContinuationStatusSchema, importedDesignContinuationReceiptSchema,
  importedDesignReviewCommandSchema, importedDesignReviewStopSchema, importedDesignReviewStatusSchema, importedDesignReviewReceiptSchema,
  importedExecutionCommandSchema, importedExecutionStopSchema, importedExecutionStatusSchema, importedExecutionReceiptSchema,
  importedExecutionReviewCommandSchema, importedExecutionReviewStopSchema, importedExecutionReviewStatusSchema, importedExecutionReviewReceiptSchema,
  importedExecutionRepairCommandSchema, importedExecutionRepairStopSchema, importedExecutionRepairStatusSchema, importedExecutionRepairReceiptSchema,
  importedValidationCommandSchema, importedValidationStopSchema, importedValidationStatusSchema, importedValidationReceiptSchema,
  importedValidationReviewCommandSchema, importedValidationReviewStopSchema, importedValidationReviewStatusSchema, importedValidationReviewReceiptSchema,
  importedProductReviewCommandSchema, importedProductReviewStopSchema, importedProductReviewStatusSchema, importedProductReviewReceiptSchema,
  productSourceOperationCommandSchema,productSourceOperationStopSchema,productSourceOperationStatusSchema,productSourceOperationReceiptSchema,
  nodeSessionReadyCommandSchema,
  nodeSessionPongCommandSchema,
  runStartCommandSchema,
  runStartOwnedResultCommandSchema,
  runStopCommandSchema,
  artifactCollectCommandSchema,
  runResumeCommandSchema,
  runEventAckCommandSchema,
  productReleaseCommandSchema,
  productReleaseCancelCommandSchema,
  productReleaseHealthAckCommandSchema,
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

/** Retention/verification evidence is node-owned, never adapter-supplied. */
export const runEventBodySchema = z.discriminatedUnion("type", [
  ...adapterRunEventBodySchema.options,
  z.object({ type: z.literal("run.workspace.retained"), payload: RunWorkspaceRetainedPayloadSchema }),
  z.object({ type: z.literal("run.verification"), payload: RunVerificationPayloadSchema }),
  z.object({ type: z.literal("run.product-source.export.v1"), payload: ProductSourceExportV1Schema }),
  z.object({ type: z.literal("run.product-source.export.v2"), payload: ProductSourceExportV2Schema }),
  z.object({ type: z.literal("run.owned-result.verification"), payload: NodeOwnedResultVerificationEvidenceV1Schema }),
]);

export const runEventMessageSchema = z.object({
  kind: z.literal("run.event"),
  node_id: z.string().min(1),
  run_id: z.string().min(1),
  sequence: z.number().int().nonnegative().max(2147483647),
  event: runEventBodySchema
});

export type Machine = z.infer<typeof machineSchema>;
export type ProductReleaseCommand = z.infer<typeof productReleaseCommandSchema>;
export type ProductReleaseCancelCommand = z.infer<typeof productReleaseCancelCommandSchema>;
export type ProductReleaseReceiptMessage = z.infer<typeof productReleaseReceiptMessageSchema>;
export type ProductReleaseHealthMessage = z.infer<typeof productReleaseHealthMessageSchema>;
export type ProductReleaseHealthAckCommand = z.infer<typeof productReleaseHealthAckCommandSchema>;
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
export type RunStartOwnedResultCommand = z.infer<typeof runStartOwnedResultCommandSchema>;
export type RunResumeCommand = z.infer<typeof runResumeCommandSchema>;
export type RunEventAckCommand = z.infer<typeof runEventAckCommandSchema>;
export type Command = z.infer<typeof commandSchema>;
/** A single adapter-emitted event (domain payload), framed by run.event. */
export type RunEvent = z.infer<typeof adapterRunEventBodySchema>;
export type NodeRunEvent = z.infer<typeof runEventBodySchema>;
export type RunEventMessage = z.infer<typeof runEventMessageSchema>;
