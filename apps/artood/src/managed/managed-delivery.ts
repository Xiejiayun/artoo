import { randomUUID } from "node:crypto";
import { runEventBodySchema, type NodeRunEvent, type RunEventMessage } from "@artoo/protocol";
import type { Journal, FreshLaunchPermit, JournalRun, ClosedRunDeliveryScope, ClosedRunDeliveryClaim, LiveDeliveryView } from "./journal-types.js";

export interface ManagedSession {
  readonly namespace: string; readonly nodeId: string; readonly generation: number;
  readonly sessionId: string; readonly helloNonce: string;
}
export interface ManagedExposureContext {
  readonly namespace: string; readonly nodeId: string; readonly runId: string;
  readonly eventId: string; readonly sequence: number; readonly contentSha256: string;
  readonly attemptId: string; readonly clockId: string; readonly deadlineTickMs: number;
  readonly signal: AbortSignal;
}
/** Only observes a claimed frame. It never allocates or independently replays. */
export interface ManagedEventChannel {
  assertCurrentSession(expected?: ManagedSession): ManagedSession;
  waitUntilUsable(deadlineTickMs: number, signal: AbortSignal, requiredBytes?: number): Promise<ManagedSession>;
  exposeOnce(frame: RunEventMessage, context: ManagedExposureContext): Promise<"accepted" | "rejected">;
}
export type RunDeliveryMode = "legacy" | "managed";
/** Trusted local routing only; a wire command cannot select or replace a lane. */
export interface MixedRunRouting {
  readonly allowNewAllocations: boolean;
  bindRun(runId: string, mode: RunDeliveryMode): void;
}
export interface ManagedJournalOptions {
  readonly journal: Journal;
  readonly channel: ManagedEventChannel;
  /** Absent retains the managed-only admission and transport contract. */
  readonly mixed?: MixedRunRouting;
}
type Claim = Extract<ClosedRunDeliveryClaim, { kind: "claimed" }>;
export class DeliveryDeadline extends Error {}
export class DeliveryStopped extends Error {}
export class DeliveryCancelled extends DeliveryStopped {}
export const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
export async function boundedOperation<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeliveryDeadline("Managed operation deadline expired")), Math.max(0, milliseconds));
  })]); } finally { clearTimeout(timer); }
}
/** The underlying receipt/next Promise remains observed after cancellation. */
export async function abortableOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason instanceof Error ? signal.reason : new DeliveryCancelled("Managed operation cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class ManagedDelivery {
  private scope: ClosedRunDeliveryScope | undefined;
  private cancellation = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  private closingDelivery: Promise<void> | undefined;
  private interruptedLiveAttempt: { sequence: number; attemptId: string } | undefined;
  readonly lateReceiptErrors: string[] = [];
  constructor(readonly journal: Journal, readonly permit: FreshLaunchPermit | undefined, readonly nodeId: string,
    readonly runId: string, private readonly channel: ManagedEventChannel) {}
  get signal(): AbortSignal { return this.cancellation.signal; }
  cancelUnexposed(reason: unknown): void {
    if (!this.signal.aborted) this.cancellation.abort(reason instanceof Error ? reason : new DeliveryCancelled(String(reason)));
  }
  useClosed(run: JournalRun): void {
    if (run.namespace !== this.journal.namespace || run.runId !== this.runId || run.phase !== "closed"
      || run.receipt?.kind !== "process_exit_confirmed" || !run.launchKey) throw new Error("Managed closed delivery lacks physical settlement");
    if (this.scope) {
      if (this.scope.physicalReceiptId !== run.receipt.id || this.scope.launchKey !== run.launchKey) throw new Error("Managed closed scope changed");
      return;
    }
    this.cancelUnexposed(new DeliveryCancelled("Live delivery transferred to physical closed scope"));
    this.scope = { expectedNamespace: this.journal.namespace, runId: this.runId, launchKey: run.launchKey, physicalReceiptId: run.receipt.id };
    this.cancellation = new AbortController();
  }
  private async expose(claim: Claim): Promise<LiveDeliveryView | void> {
    if (claim.event.namespace !== this.journal.namespace || claim.event.nodeId !== this.nodeId || claim.event.runId !== this.runId) throw new Error("Managed claimed event identity differs from the configured channel");
    const ownerSignal = this.signal, attempt = new AbortController();
    const cancel = () => attempt.abort(ownerSignal.reason);
    ownerSignal.addEventListener("abort", cancel, { once: true });
    if (ownerSignal.aborted) cancel();
    const timer = setTimeout(() => attempt.abort(new DeliveryDeadline("Managed event receipt deadline expired")), Math.max(0, claim.deadlineTickMs - monotonicMs()));
    const { sequence, contentSha256, eventId } = claim.event;
    const { attemptId, clockId, deadlineTickMs } = claim;
    const frame: RunEventMessage = { kind: "run.event", node_id: this.nodeId, run_id: this.runId,
      sequence, event: JSON.parse(claim.event.contentJson) as NodeRunEvent };
    const context: ManagedExposureContext = Object.freeze({ namespace: this.journal.namespace, nodeId: this.nodeId,
      runId: this.runId, eventId, sequence, contentSha256, attemptId, clockId, deadlineTickMs, signal: attempt.signal });
    const observed = Promise.resolve().then(() => {
      attempt.signal.throwIfAborted();
      return this.channel.exposeOnce(frame, context);
    }).then(async (status) => {
      if (status !== "accepted" && status !== "rejected") throw new Error("Managed channel returned an invalid receipt");
      const receipt = { sequence, contentSha256, attemptId, status };
      if (this.scope) { await this.journal.recordClosedRunEventReceipt(this.scope, receipt); return; }
      if (!this.permit) throw new Error("A live receipt requires the original fresh permit");
      return this.journal.recordLiveEventReceipt(this.permit, receipt);
    });
    // Only a already-exposed observer may finish after the operational deadline.
    void observed.catch((error: unknown) => { if (this.lateReceiptErrors.length < 16) this.lateReceiptErrors.push(String(error)); });
    try { return await abortableOperation(observed, attempt.signal); }
    finally { clearTimeout(timer); ownerSignal.removeEventListener("abort", cancel); }
  }
  private async waitRetry(claim: Claim): Promise<void> {
    this.signal.throwIfAborted();
    const bytes = Buffer.byteLength(JSON.stringify({ kind: "run.event", node_id: this.nodeId, run_id: this.runId,
      sequence: claim.event.sequence, event: JSON.parse(claim.event.contentJson) }));
    await this.channel.waitUntilUsable(claim.deadlineTickMs, this.signal, bytes);
    this.signal.throwIfAborted();
    if (monotonicMs() >= claim.deadlineTickMs) throw new DeliveryDeadline("Original managed event deadline expired while disconnected");
  }
  sendLive(event: NodeRunEvent): Promise<void> {
    const id = `live:${randomUUID()}`;
    const content = JSON.stringify(runEventBodySchema.parse(event));
    if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Managed event exceeds the bounded payload size");
    const snapshot = JSON.parse(content) as NodeRunEvent;
    const operation = this.tail.then(async () => {
      this.signal.throwIfAborted();
      if (this.scope) throw new Error("Closed run cannot append a live event");
      const permit = this.permit;
      if (!permit) throw new Error("Live delivery requires a fresh permit");
      const stored = await this.journal.appendEvent(permit, id, snapshot);
      for (;;) {
        this.signal.throwIfAborted();
        const claim = await this.journal.claimNextLiveDelivery(permit);
        if (claim.kind !== "claimed") throw new DeliveryStopped(claim.kind === "stop_required" ? "Live delivery requires confirmed stop" : "Existing live attempt remains pending");
        let observed: LiveDeliveryView | void;
        try { observed = await this.expose(claim); }
        catch (error) {
          if (this.signal.aborted) {
            // The durable claim can exist even when cancellation prevents the
            // channel call. Keep it until physical settlement fixes the outcome.
            this.interruptedLiveAttempt = { sequence: claim.event.sequence, attemptId: claim.attemptId };
            throw error;
          }
          const failure = { sequence: claim.event.sequence, attemptId: claim.attemptId,
            reason: error instanceof DeliveryDeadline ? "receipt_timeout" as const : "transport_failure" as const };
          const view = await this.journal.recordLiveAttemptFailure(permit, failure);
          if (view.state === "stop_required") throw new DeliveryStopped(view.abort?.message ?? "Live delivery requires stop");
          try { await this.waitRetry(claim); }
          catch (waitError) {
            if (waitError instanceof DeliveryDeadline && !this.signal.aborted) await this.journal.recordLiveAttemptFailure(permit, { ...failure, reason: "receipt_timeout" });
            throw waitError;
          }
          continue;
        }
        if (observed?.state === "stop_required") throw new DeliveryStopped(observed.abort?.message ?? "Live stop requested");
        if (claim.event.eventId === stored.eventId) return;
      }
    });
    this.tail = operation.then(() => {}, () => {}); return operation;
  }
  async abort(error: unknown): Promise<void> {
    this.cancelUnexposed(error);
    if (!this.permit) throw new Error("Live abort requires the original fresh permit");
    const message = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f]/gu, " ").slice(0, 500).toWellFormed() || "Managed delivery failed";
    await this.journal.latchLiveDeliveryAbort(this.permit, { code: "delivery_failure", message });
  }
  drainClosed(): Promise<void> {
    if (this.closingDelivery) return this.closingDelivery;
    const operation = this.drainClosedOnce(); this.closingDelivery = operation;
    void operation.finally(() => { if (this.closingDelivery === operation) this.closingDelivery = undefined; }).catch(() => {});
    return operation;
  }
  private async drainClosedOnce(): Promise<void> {
    if (!this.scope) throw new Error("No closed delivery scope");
    const interrupted = this.interruptedLiveAttempt;
    if (interrupted) {
      // Retire only the exact interrupted attempt, after genuine physical
      // settlement. Its possible late receipt remains observed and authoritative.
      await this.journal.recordClosedRunAttemptFailure(this.scope, { ...interrupted, reason: "transport_failure" });
      if (this.interruptedLiveAttempt === interrupted) this.interruptedLiveAttempt = undefined;
    }
    for (;;) {
      this.signal.throwIfAborted();
      const claim = await this.journal.claimNextClosedRunDelivery(this.scope);
      if (claim.kind === "complete") return;
      if (claim.kind !== "claimed") throw new DeliveryStopped(`Closed delivery ${claim.kind}: ${claim.reason}`);
      try { await this.expose(claim); }
      catch (error) {
        if (this.signal.aborted) throw error;
        const failure = { sequence: claim.event.sequence, attemptId: claim.attemptId,
          reason: error instanceof DeliveryDeadline ? "receipt_timeout" as const : "transport_failure" as const };
        await this.journal.recordClosedRunAttemptFailure(this.scope, failure);
        if (error instanceof DeliveryDeadline) continue; // The journal selects correction/blocked state.
        try { await this.waitRetry(claim); }
        catch (waitError) {
          if (waitError instanceof DeliveryDeadline && !this.signal.aborted) {
            await this.journal.recordClosedRunAttemptFailure(this.scope, { ...failure, reason: "receipt_timeout" });
            continue;
          }
          throw waitError;
        }
      }
    }
  }
}
