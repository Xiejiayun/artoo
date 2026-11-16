import { isDeepStrictEqual } from "node:util";
import type { Journal } from "./journal-types.js";
import { admitSchedulerStartFromSession, type SchedulerSessionAdmission } from "./scheduler-session-admission.js";
import type { SchedulerStartSession } from "./scheduler-start-channel.js";
import type { SchedulerLeaseSession } from "./scheduler-lease-channel.js";
import type { SchedulerRunSession } from "./scheduler-run-channel.js";
import { DeliveryCancelled, monotonicMs } from "./managed-delivery.js";
import type { RunStartPayload } from "@artoo/domain";

export interface SchedulerOwnerChannels {
  readonly start: SchedulerStartSession;
  readonly lease: SchedulerLeaseSession;
  readonly run: SchedulerRunSession;
}
export interface SchedulerPhysicalOwner {
  readonly requestId: string;
  readonly assertStartCurrent: () => void;
  beforeStart(): Promise<void>;
  monitor(onStop: () => void, onFailure: (error: Error) => void): void;
  /** Actual physical closure ends renewal; event authority remains for receipts. */
  closed(): void;
  /** Called after closed journal delivery; uncertainty retains ownership. */
  forget(): void;
}
export interface SchedulerOwnedAdmission {
  readonly admitted: Extract<SchedulerSessionAdmission, { kind: "fresh" }>;
  readonly owner: SchedulerPhysicalOwner;
}
const renewalLanes = new WeakMap<SchedulerLeaseSession, Promise<unknown>>();
function leaseExchange<T>(session: SchedulerLeaseSession, operation: () => Promise<T>): Promise<T> {
  const queuedAt = monotonicMs();
  const work = (renewalLanes.get(session) ?? Promise.resolve()).then(() => {
    session.signal.throwIfAborted();
    if (monotonicMs() < queuedAt || monotonicMs() >= queuedAt + 10000) throw new Error("Scheduler renewal lane expired");
    return operation();
  });
  renewalLanes.set(session, work.catch(() => {}));
  return work;
}

/** Composes independent authorities without creating a second process owner.
 * In particular, renewing the long lease never changes assertStartCurrent. */
export async function prepareSchedulerPhysicalOwner(input: {
  journal: Journal; channels: SchedulerOwnerChannels; taskId: string; requestId: string; runId: string; signal: AbortSignal;
  prepareInputs?: (payload: RunStartPayload, signal: AbortSignal) => Promise<void>;
}): Promise<SchedulerOwnedAdmission> {
  const { journal, channels, taskId, requestId, runId, signal } = input;
  if (channels.start.session !== channels.lease.session || channels.start.session !== channels.run.session)
    throw new Error("Scheduler authorities must belong to one original authenticated generation");
  const admitted = await admitSchedulerStartFromSession({ journal, channel: channels.start, taskId, requestId, runId, signal, prepareInputs: input.prepareInputs });
  if (admitted.kind !== "fresh") throw new Error(`Scheduler start is retained (${admitted.stage}:${admitted.status}); no new physical authority`);
  admitted.assertStartCurrent();
  const acquired = await Promise.allSettled([leaseExchange(channels.lease, () => channels.lease.acquire(admitted.grant)), channels.run.acquire(admitted.grant)]);
  const lease = acquired[0], events = acquired[1];
  if (lease.status === "rejected" || events.status === "rejected" || lease.value.status !== "acquired") {
    if (lease.status === "fulfilled" && lease.value.status === "acquired") lease.value.renewal.forget();
    if (events.status === "fulfilled") events.value.forget();
    throw new Error("Scheduler attempt did not acquire both fresh private authorities; durable admission retained");
  }
  const renewal = lease.value.renewal, authority = events.value;
  try {
    admitted.assertStartCurrent(); signal.throwIfAborted();
    if (!isDeepStrictEqual(renewal.binding, authority.binding)) throw new Error("Scheduler lease and event authorities differ");
  } catch (error) { renewal.forget(); authority.forget(); throw error; }
  let stopped = false, started = false, timer: ReturnType<typeof setTimeout> | undefined;
  let detachSession = () => {};
  let stopOwnedStart: (() => void) | undefined;
  let nextRenewal = monotonicMs() + 5000;
  const closed = () => { stopped = true; clearTimeout(timer); detachSession(); renewal.forget(); };
  const owner = Object.freeze<SchedulerPhysicalOwner>({ requestId, assertStartCurrent: admitted.assertStartCurrent,
    async beforeStart() {
      admitted.assertStartCurrent(); signal.throwIfAborted();
      const current = await authority.status();
      admitted.assertStartCurrent(); signal.throwIfAborted();
      if (current.stop_requested || authority.stopRequested) {
        stopOwnedStart?.();
        throw new DeliveryCancelled("Scheduler Stop was observed before physical startup");
      }
    },
    monitor(onStop, onFailure) {
      if (started || stopped) throw new Error("Scheduler physical monitor already started or closed");
      started = true;
      stopOwnedStart = () => { if (!stopped) { stopped = true; clearTimeout(timer); detachSession(); onStop(); } };
      if (authority.stopRequested) { stopOwnedStart(); return; }
      const fail = (cause: unknown) => {
        if (stopped) return;
        stopped = true; clearTimeout(timer); detachSession();
        onFailure(cause instanceof Error ? cause : new Error("Scheduler original authority lost"));
      };
      const tick = async () => {
        if (stopped) return;
        try {
          signal.throwIfAborted(); channels.start.signal.throwIfAborted(); renewal.signal.throwIfAborted(); authority.signal.throwIfAborted();
          const status = await authority.status();
          if (stopped) return;
          if (status.stop_requested) { stopOwnedStart?.(); return; }
          if (monotonicMs() >= nextRenewal) {
            const renewed = await leaseExchange(channels.lease, () => renewal.renew());
            if (stopped) return;
            if (renewed.state !== "active") throw new Error("Scheduler execution lease is no longer active");
            nextRenewal = monotonicMs() + 5000;
          }
          if (!stopped) timer = setTimeout(() => { void tick(); }, 1000);
        } catch (error) { fail(error); }
      };
      // Generation loss cancels the existing physical owner immediately; it
      // cannot wait for the ordinary reconnect grace or mint a new credential.
      const sessionLost = () => fail(channels.start.signal.reason);
      channels.start.signal.addEventListener("abort", sessionLost, { once: true });
      detachSession = () => channels.start.signal.removeEventListener("abort", sessionLost);
      if (channels.start.signal.aborted) { sessionLost(); return; }
      timer = setTimeout(() => { void tick(); }, 1000);
    },
    closed,
    forget() { closed(); authority.forget(); },
  });
  return Object.freeze({ admitted, owner });
}
