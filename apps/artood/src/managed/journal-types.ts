import type { RunStartPayload } from "@artoo/domain";
import type { AgentInstanceHandle, NodeRunEvent, RuntimeAdapter } from "@artoo/protocol";
import type { OwnedRunAdmission } from "../process-adapter.js";
import type { MaterializedWorktree } from "../owned/worktree-reservation.js";

declare const permitBrand: unique symbol;
/** Same-process authority only; copying, serializing or casting does not grant it. */
export interface FreshLaunchPermit { readonly [permitBrand]: true }
export interface JournalLocation { readonly directory: string; readonly controllerScope: string; readonly nodeId: string }
export interface JournalOptions extends JournalLocation {
  readonly expectedNamespace: string;
  readonly operationTimeoutMs?: number;
}
export interface RunQuery { readonly expectedNamespace: string; readonly runId: string }
export interface StartRequest extends RunQuery { readonly idempotencyKey: string; readonly payload: RunStartPayload }
export type DurablePhase = "admitted" | "preparing" | "launch_intent" | "started" | "closed";
export interface DurableReceipt {
  readonly id: string;
  readonly namespace: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly launchKey: string | null;
  readonly ownerRevision: number;
  readonly kind: "accepted" | "not_started_fenced" | "run_fenced_unbound" | "process_exit_confirmed";
  readonly contentJson: string;
}
export interface JournalRun {
  readonly namespace: string;
  readonly runId: string;
  readonly mode: "per-run" | "legacy" | "fenced";
  readonly launchKey: string | null;
  readonly revision: number;
  readonly phase: DurablePhase;
  readonly stopRequested: boolean;
  /** local_claim is not a current-running observation. A restarted live row is unknown. */
  readonly ownership: "local_claim" | "unknown" | "fenced";
  readonly receipt: DurableReceipt | null;
  readonly finalOutcomeJson: string | null;
  readonly liveAbort: LiveDeliveryAbort | null;
}
export interface LiveDeliveryAbort { readonly code: string; readonly message: string; readonly sequence?: number; readonly attemptId?: string }
export interface LiveDeliveryView { readonly state: "pending" | "waiting" | "stop_required"; readonly abort: LiveDeliveryAbort | null }
export type LiveDeliveryClaim = Extract<ClosedRunDeliveryClaim, { kind: "claimed" }>
  | { readonly kind: "waiting" | "stop_required"; readonly view: LiveDeliveryView };
export interface TerminalSettlement {
  readonly terminal: { readonly type: "run.lifecycle"; readonly payload: {
    readonly phase: "completed" | "failed" | "cancelled"; readonly reason?: string | null;
  } };
  readonly retentionOutcome: "completed" | "failed" | "cancelled" | "incomplete_delivery";
}
export type AdmissionResult =
  | { readonly kind: "fresh"; readonly permit: FreshLaunchPermit; readonly run: JournalRun; readonly payload: RunStartPayload }
  | { readonly kind: "pending" | "replay" | "conflict" | "fenced" | "unknown"; readonly run: JournalRun };
export interface StoredEvent {
  readonly namespace: string; readonly nodeId: string; readonly runId: string;
  readonly sequence: number; readonly eventId: string; readonly contentJson: string;
  readonly contentSha256: string; readonly committed: boolean;
  readonly role: "event" | "original_retention" | "original_terminal" | "correction_retention" | "correction_terminal";
  readonly superseded: boolean;
}
/** Delivery-only authority for a genuinely settled run; never a live event lane
 * or permission to start/adopt a producer. Future live delivery is separate. */
export interface ClosedRunDeliveryScope extends RunQuery { readonly launchKey: string; readonly physicalReceiptId: string }
export type DeliveryFailureReason = "rejected" | "transport_failure" | "receipt_timeout";
export interface DeliveryCorrection {
  readonly id: string; readonly revision: 1; readonly physicalReceiptId: string;
  readonly trigger: { readonly sequence: number; readonly attemptId: string; readonly reason: DeliveryFailureReason };
  readonly retention: { readonly sequence: number; readonly eventId: string; readonly contentSha256: string };
  readonly terminal: { readonly sequence: number; readonly eventId: string; readonly contentSha256: string };
}
export interface ClosedRunDeliveryView {
  readonly revision: 0 | 1; readonly state: "pending" | "correcting" | "delivered" | "blocked";
  readonly originalOutcomeJson: string; readonly physicalReceiptId: string;
  readonly correction: DeliveryCorrection | null;
  readonly committed: number; readonly superseded: number; readonly outstanding: number;
  /** May include a previously claimed frame that cannot be unsent. */
  readonly possibleCompletedExposure: boolean;
}
export type ClosedRunDeliveryClaim =
  | { readonly kind: "claimed"; readonly event: StoredEvent; readonly attemptId: string;
      readonly revision: 0 | 1; readonly clockId: string; readonly deadlineTickMs: number }
  | { readonly kind: "blocked" | "complete" | "waiting"; readonly reason: string; readonly view: ClosedRunDeliveryView };
export interface ClosedRunEventReceipt {
  readonly sequence: number; readonly contentSha256: string; readonly attemptId: string;
  readonly status: "accepted" | "rejected";
}
export interface Journal {
  readonly namespace: string;
  readonly incarnation: string;
  readonly pragmas: Readonly<Record<string, string | number>>;
  /** First unexpected failure; resolves before cleanup, never rejects. Clean close leaves it pending. */
  readonly failed: Promise<Error>;
  admitStart(request: StartRequest): Promise<AdmissionResult>;
  lookupRun(request: RunQuery): Promise<JournalRun | null>;
  advance(permit: FreshLaunchPermit, phase: "preparing" | "launch_intent"): Promise<JournalRun>;
  requestStop(request: RunQuery & { readonly expectedKey?: string }): Promise<JournalRun>;
  /** One-shot bridge; only the private frozen full payload can reach the producer. */
  startOwnedProcess(permit: FreshLaunchPermit, adapter: RuntimeAdapter, worktree: MaterializedWorktree, signal: AbortSignal): Promise<{
    readonly handle: AgentInstanceHandle; readonly admission: OwnedRunAdmission;
  }>;
  recordStarted(permit: FreshLaunchPermit, adapter: RuntimeAdapter, handle: AgentInstanceHandle): Promise<JournalRun>;
  /** Requires the exact genuine producer receipt and handle for our private admission. */
  settleOwnedProcess(permit: FreshLaunchPermit, handle: AgentInstanceHandle, producerReceipt: unknown, settlement: TerminalSettlement): Promise<JournalRun>;
  /** Only authenticated confirmed_closed + childSpawned startup errors; not_spawned remains unknown. */
  settleOwnedStartupFailure(permit: FreshLaunchPermit, worktree: MaterializedWorktree, startupError: unknown): Promise<JournalRun>;
  /** Persists event identity; an event never grants physical settlement authority. */
  appendEvent(permit: FreshLaunchPermit, eventId: string, event: NodeRunEvent): Promise<StoredEvent>;
  claimNextLiveDelivery(permit: FreshLaunchPermit): Promise<LiveDeliveryClaim>;
  recordLiveEventReceipt(permit: FreshLaunchPermit, receipt: ClosedRunEventReceipt): Promise<LiveDeliveryView>;
  recordLiveAttemptFailure(permit: FreshLaunchPermit, failure: { readonly sequence: number; readonly attemptId: string; readonly reason: DeliveryFailureReason }): Promise<LiveDeliveryView>;
  latchLiveDeliveryAbort(permit: FreshLaunchPermit, cause: LiveDeliveryAbort): Promise<LiveDeliveryView>;
  /** Inspection only. Includes held/superseded rows; this is never send authorization. */
  pendingEvents(request: RunQuery, limit?: number): Promise<readonly StoredEvent[]>;
  inspectClosedRunDelivery(scope: ClosedRunDeliveryScope): Promise<ClosedRunDeliveryView>;
  claimNextClosedRunDelivery(scope: ClosedRunDeliveryScope): Promise<ClosedRunDeliveryClaim>;
  /** Requires a persisted exact-event claim. No direct markEventCommitted bypass. */
  recordClosedRunEventReceipt(scope: ClosedRunDeliveryScope, receipt: ClosedRunEventReceipt): Promise<ClosedRunDeliveryView>;
  recordClosedRunAttemptFailure(scope: ClosedRunDeliveryScope, failure: {
    readonly sequence: number; readonly attemptId: string; readonly reason: DeliveryFailureReason;
  }): Promise<ClosedRunDeliveryView>;
  close(): Promise<void>;
}

/** Hooks for a future NodeClient integration, not a change to its current control flow. */
export interface NodeJournalHooks { readonly journal: Journal; readonly expectedNamespace: string }
