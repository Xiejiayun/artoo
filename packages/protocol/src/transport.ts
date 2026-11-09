import type { ApplicationPublicationStartCommand, ApplicationPublicationStopCommand, ApplicationPublicationStatusCommand, ApplicationPublicationSessionCommand, ApplicationPublicationReceiptMessage, ApplicationPublicationObservationMessage, ApplicationPublicationReceiptAckCommand, ApplicationPublicationObservationAckCommand } from "./application-publication.js";
import type { ProductSourceRecoveryRegister, ProductSourceRecoverySession, ProductSourceRecoveryRegistered, ProductSourceRecoveryAvailable, ProductSourceRecoveryCommand, ProductSourceRecoveryStop, ProductSourceRecoveryStatus, ProductSourceRecoveryReceipt, ProductSourceRecoveryAck, ProductSourceRecoveryResult } from "./source-recovery.js";
import type { SourceLifecycleRegister, SourceCleanCheckpoint, SourceLifecycleRegisteredCommand,
  SourceCleanCheckpointCommittedCommand, SourceLifecycleRejectedCommand } from "./source-clean-lifecycle.js";
import type { ImportedRecoveryValidationCommand, ImportedRecoveryValidationStop, ImportedRecoveryValidationStatus, ImportedRecoveryValidationReceipt, ImportedRecoveryValidationAck, ImportedRecoveryValidationResult } from "./imported-recovery-validation.js";
import type { ImportedCleanValidationCommand, ImportedCleanValidationStop, ImportedCleanValidationStatus, ImportedCleanValidationReceipt, ImportedCleanValidationAck, ImportedCleanValidationResult } from "./imported-clean-validation.js";
import type { ImportedRecoveryValidationReviewCommand, ImportedRecoveryValidationReviewStop, ImportedRecoveryValidationReviewStatus, ImportedRecoveryValidationReviewReceipt, ImportedRecoveryValidationReviewAck, ImportedRecoveryValidationReviewResult } from "./imported-recovery-validation-review.js";
import type { ImportedCleanValidationReviewCommand, ImportedCleanValidationReviewStop, ImportedCleanValidationReviewStatus, ImportedCleanValidationReviewReceipt, ImportedCleanValidationReviewAck, ImportedCleanValidationReviewResult } from "./imported-clean-validation-review.js";
import type {ProductSourceOperationCommand,ProductSourceOperationStop,ProductSourceOperationStatus,ProductSourceOperationReceipt,ProductSourceOperationAck,ProductSourceOperationResult} from "./product-source-operations.js";
import type { ImportedProductReviewCommand, ImportedProductReviewStop, ImportedProductReviewStatus, ImportedProductReviewReceipt, ImportedProductReviewAck, ImportedProductReviewResult } from "./imported-product-review.js";
import type { ImportedDesignContinuationCommand, ImportedDesignContinuationStop, ImportedDesignContinuationStatus, ImportedDesignContinuationReceipt, ImportedDesignContinuationAck, ImportedDesignContinuationResult } from "./imported-design-continuation.js";
import type { ImportedDesignReviewCommand, ImportedDesignReviewStop, ImportedDesignReviewStatus, ImportedDesignReviewReceipt, ImportedDesignReviewAck, ImportedDesignReviewResult } from "./imported-design-review.js";
import type { ImportedExecutionCommand, ImportedExecutionStop, ImportedExecutionStatus, ImportedExecutionReceipt, ImportedExecutionAck, ImportedExecutionResult } from "./imported-execution.js";
import type { ImportedExecutionReviewCommand, ImportedExecutionReviewStop, ImportedExecutionReviewStatus, ImportedExecutionReviewReceipt, ImportedExecutionReviewAck, ImportedExecutionReviewResult } from "./imported-execution-review.js";
import type { ImportedExecutionRepairCommand, ImportedExecutionRepairStop, ImportedExecutionRepairStatus, ImportedExecutionRepairReceipt, ImportedExecutionRepairAck, ImportedExecutionRepairResult } from "./imported-execution-repair.js";
import type { ImportedValidationCommand, ImportedValidationStop, ImportedValidationStatus, ImportedValidationReceipt, ImportedValidationAck, ImportedValidationResult } from "./imported-validation.js";
import type { ImportedValidationReviewCommand, ImportedValidationReviewStop, ImportedValidationReviewStatus, ImportedValidationReviewReceipt, ImportedValidationReviewAck, ImportedValidationReviewResult } from "./imported-validation-review.js";
import type {
  ArtifactCollectCommand,
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  NodeSessionProbe,
  NodeSessionReadyCommand,
  NodeSessionPongCommand,
  RunEventMessage,
  RunEventAckCommand,
  RunResumeCommand,
  RunStartCommand,
  RunStartOwnedResultCommand,
  RunStopCommand,
  ProductReleaseCommand,
  ProductReleaseCancelCommand,
  ProductReleaseReceiptMessage,
  ProductReleaseHealthMessage,
  ProductReleaseHealthAckCommand,
} from "./node-messages.js";

/**
 * Transport seam between the server and a node (design discussion: NodeTransport).
 * `InProcessTransport` (testkit) drives the mock loop with zero IO; a
 * `WebSocketTransport` (artood) carries the same messages over the wire. Both
 * implement this one interface so the mock loop (step 3) and the real node
 * protocol (step 6) share a single command/event contract.
 *
 * Payloads inside run.start / run.event are owned by @artoo/domain; the wire
 * envelopes are owned by this package (single source of truth, no redefinition).
 */
type ExistingNodeToServerMessage = ImportedCleanValidationAck | ImportedCleanValidationResult | ImportedCleanValidationReviewAck | ImportedCleanValidationReviewResult | SourceLifecycleRegister | SourceCleanCheckpoint | ProductSourceRecoveryRegister | ProductSourceRecoveryAvailable | ProductSourceRecoveryAck | ProductSourceRecoveryResult | ImportedRecoveryValidationAck | ImportedRecoveryValidationResult | ImportedRecoveryValidationReviewAck | ImportedRecoveryValidationReviewResult | ImportedValidationAck | ImportedValidationResult | ImportedValidationReviewAck | ImportedValidationReviewResult | ImportedExecutionReviewAck | ImportedExecutionReviewResult | ImportedExecutionRepairAck | ImportedExecutionRepairResult | ImportedExecutionAck | ImportedExecutionResult | ImportedDesignReviewAck | ImportedDesignReviewResult | ImportedDesignContinuationAck | ImportedDesignContinuationResult | ImportedProductReviewAck | ImportedProductReviewResult | ProductSourceOperationAck | ProductSourceOperationResult | NodeHello | NodeHeartbeat | CommandAck | RunEventMessage | NodeSessionProbe | ProductReleaseReceiptMessage | ProductReleaseHealthMessage;

type ExistingServerToNodeMessage = ImportedCleanValidationCommand | ImportedCleanValidationStop | ImportedCleanValidationStatus | ImportedCleanValidationReceipt | ImportedCleanValidationReviewCommand | ImportedCleanValidationReviewStop | ImportedCleanValidationReviewStatus | ImportedCleanValidationReviewReceipt | SourceLifecycleRegisteredCommand | SourceCleanCheckpointCommittedCommand | SourceLifecycleRejectedCommand | ProductSourceRecoverySession | ProductSourceRecoveryRegistered | ProductSourceRecoveryCommand | ProductSourceRecoveryStop | ProductSourceRecoveryStatus | ProductSourceRecoveryReceipt | ImportedRecoveryValidationCommand | ImportedRecoveryValidationStop | ImportedRecoveryValidationStatus | ImportedRecoveryValidationReceipt | ImportedRecoveryValidationReviewCommand | ImportedRecoveryValidationReviewStop | ImportedRecoveryValidationReviewStatus | ImportedRecoveryValidationReviewReceipt | ImportedValidationCommand | ImportedValidationStop | ImportedValidationStatus | ImportedValidationReceipt | ImportedValidationReviewCommand | ImportedValidationReviewStop | ImportedValidationReviewStatus | ImportedValidationReviewReceipt | ImportedExecutionReviewCommand | ImportedExecutionReviewStop | ImportedExecutionReviewStatus | ImportedExecutionReviewReceipt | ImportedExecutionRepairCommand | ImportedExecutionRepairStop | ImportedExecutionRepairStatus | ImportedExecutionRepairReceipt | ImportedExecutionCommand | ImportedExecutionStop | ImportedExecutionStatus | ImportedExecutionReceipt | ImportedDesignReviewCommand | ImportedDesignReviewStop | ImportedDesignReviewStatus | ImportedDesignReviewReceipt | ImportedDesignContinuationCommand | ImportedDesignContinuationStop | ImportedDesignContinuationStatus | ImportedDesignContinuationReceipt | ImportedProductReviewCommand | ImportedProductReviewStop | ImportedProductReviewStatus | ImportedProductReviewReceipt | ProductSourceOperationCommand | ProductSourceOperationStop | ProductSourceOperationStatus | ProductSourceOperationReceipt | RunStartCommand | RunStartOwnedResultCommand | RunStopCommand | ArtifactCollectCommand | RunResumeCommand | RunEventAckCommand | NodeSessionReadyCommand | NodeSessionPongCommand | ProductReleaseCommand | ProductReleaseCancelCommand | ProductReleaseHealthAckCommand;

export type Unsubscribe = () => void;

export interface NodeTransport {
  send(message: ServerToNodeMessage): Promise<void>;
  subscribe(handler: (message: NodeToServerMessage) => void): Unsubscribe;
  close(): Promise<void>;
}

/** Local delivery policy; never serialized into a protocol frame. */
export interface NodeSendOptions {
  /** Only run.output may skip receipts/replay; disconnected output is dropped. */
  delivery: "best-effort";
}

/**
 * The node's mirror view of the channel: it sends Node->Server messages (acks,
 * run.events) and subscribes to Server->Node commands. `artood`'s node client
 * depends on this interface (not on any test helper); testkit's in-process node
 * endpoint and a real WebSocket node client both satisfy it.
 */
export interface NodeSideTransport {
  /** True when required run.event sends resolve after a committed server receipt. */
  readonly acknowledgesRunEvents?: boolean;
  /** Explicit best-effort run.output sends settle locally without a receipt. */
  send(message: NodeToServerMessage, options?: NodeSendOptions): Promise<void>;
  subscribe(handler: (message: ServerToNodeMessage) => void): Unsubscribe;
  close?(): Promise<void>;
}

export type NodeToServerMessage = ExistingNodeToServerMessage | ApplicationPublicationReceiptMessage | ApplicationPublicationObservationMessage;
export type ServerToNodeMessage = ExistingServerToNodeMessage | ApplicationPublicationStartCommand | ApplicationPublicationStopCommand | ApplicationPublicationStatusCommand | ApplicationPublicationSessionCommand | ApplicationPublicationReceiptAckCommand | ApplicationPublicationObservationAckCommand;
