import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SchedulerStartGrantV1Schema, type SchedulerExecutionLeaseBindingV1, type SchedulerStartGrantV1 } from "@artoo/domain";
import {
  schedulerRunAcquireMessageSchema, schedulerRunStatusMessageSchema, schedulerRunEventMessageSchema,
  schedulerRunResponseCommandSchema, type SchedulerRunRequestMessage, type SchedulerRunResponseCommand,
  type RunEventMessage,
} from "@artoo/protocol";
import { monotonicMs, type ManagedSession } from "./managed-delivery.js";

type Reply = SchedulerRunResponseCommand["payload"];
type Issued = Extract<Reply, { status: "issued" }>;
export interface SchedulerRunAuthority {
  readonly binding: Readonly<SchedulerExecutionLeaseBindingV1>;
  readonly signal: AbortSignal;
  readonly stopRequested: boolean;
  status(): Promise<{ readonly stop_requested: boolean }>;
  forget(): void;
}
export interface SchedulerRunSession {
  readonly session: ManagedSession;
  readonly signal: AbortSignal;
  acquire(grant: SchedulerStartGrantV1): Promise<SchedulerRunAuthority>;
}

/** Secrets exist only in the authenticated generation. Durable delivery keeps
 * the original inner event; the credential is added at the final socket write. */
export function createSchedulerRunClientChannel(options: {
  session: ManagedSession;
  assertCurrent(): void;
  send(message: SchedulerRunRequestMessage): void;
}) {
  const session = options.session, controller = new AbortController();
  const credentials = new Map<string, { binding: SchedulerExecutionLeaseBindingV1; credential: Issued["credential"]; forget(): void }>();
  let lane: Promise<unknown> = Promise.resolve();
  let pending: { id: string; operation: "acquire" | "status"; deadline: number; timer: ReturnType<typeof setTimeout>; resolve(reply: Reply): void; reject(error: Error): void } | undefined;
  const assertCurrent = () => { controller.signal.throwIfAborted(); options.assertCurrent(); };
  function settle(error?: Error, reply?: Reply) {
    const item = pending;
    if (!item) return;
    pending = undefined; clearTimeout(item.timer);
    if (error) item.reject(error); else item.resolve(reply!);
  }
  function exchange(request: SchedulerRunRequestMessage, operation: "acquire" | "status"): Promise<Reply> {
    // One bounded exchange lane, shared by every concurrent physical Run.
    const queuedAt = monotonicMs();
    const work = lane.then(async () => {
      assertCurrent();
      const deadline = queuedAt + 10000;
      if (monotonicMs() >= deadline) throw new Error("Scheduler run exchange expired in queue");
      const reply = await new Promise<Reply>((resolve, reject) => {
        const timer = setTimeout(() => settle(new Error("Scheduler run exchange expired")), Math.max(0, deadline - monotonicMs()));
        pending = { id: request.exchange_id, operation, deadline, timer, resolve, reject };
        try { options.send(request); } catch { settle(new Error("Scheduler run exchange write failed")); }
      });
      assertCurrent();
      if (monotonicMs() < queuedAt || monotonicMs() >= deadline) throw new Error("Scheduler run reply exceeded its original window");
      return reply;
    });
    lane = work.catch(() => {});
    return work;
  }
  const client: SchedulerRunSession = Object.freeze({
    session, signal: controller.signal,
    async acquire(raw: SchedulerStartGrantV1) {
      assertCurrent();
      if (credentials.size >= 64) throw new Error("Scheduler run credential memory capacity reached");
      const grant = SchedulerStartGrantV1Schema.parse(raw);
      if (grant.computer_id !== session.nodeId || grant.session_id !== session.sessionId || grant.journal_namespace !== session.namespace)
        throw new Error("Scheduler run grant differs from its original session");
      if (credentials.has(grant.run_id)) throw new Error("Scheduler run already has original event authority");
      const reply = await exchange(schedulerRunAcquireMessageSchema.parse({ kind: "scheduler.run.acquire.v1", node_id: session.nodeId,
        session_id: session.sessionId, exchange_id: randomUUID(), grant }), "acquire");
      if (reply.status !== "issued" || reply.lease.state !== "active") throw new Error("Scheduler run acquisition did not issue fresh event authority");
      const binding = Object.freeze(reply.lease.binding);
      for (const [key, value] of Object.entries(binding)) {
        if (key in grant && key !== "scope" && key !== "version" && value !== grant[key as keyof SchedulerStartGrantV1])
          throw new Error("Scheduler run event authority changed its original grant");
      }
      const local = new AbortController();
      const forget = () => { credentials.delete(grant.run_id); local.abort(new Error("Scheduler run event authority forgotten")); };
      credentials.set(grant.run_id, { binding, credential: reply.credential, forget });
      return Object.freeze<SchedulerRunAuthority>({ binding, signal: local.signal, stopRequested: reply.stop_requested, forget,
        async status() {
          assertCurrent(); local.signal.throwIfAborted();
          const current = credentials.get(grant.run_id);
          if (!current) throw new Error("Scheduler run event authority unavailable");
          const status = await exchange(schedulerRunStatusMessageSchema.parse({ kind: "scheduler.run.status.v1", node_id: session.nodeId,
            session_id: session.sessionId, exchange_id: randomUUID(), binding, credential: current.credential }), "status");
          assertCurrent(); local.signal.throwIfAborted();
          if (status.status !== "current" || !isDeepStrictEqual(status.lease.binding, binding) || status.lease.state !== "active")
            throw new Error("Scheduler run authority is no longer current");
          return Object.freeze({ stop_requested: status.stop_requested });
        },
      });
    },
  });
  return {
    open() { assertCurrent(); return client; },
    encode(frame: RunEventMessage): string {
      assertCurrent();
      const current = credentials.get(frame.run_id);
      if (!current) throw new Error("Scheduler run has no event authority in this generation");
      return JSON.stringify(schedulerRunEventMessageSchema.parse({ kind: "scheduler.run.event.v1", node_id: session.nodeId,
        session_id: session.sessionId, binding: current.binding, credential: current.credential, frame }));
    },
    receive(raw: unknown) {
      const parsed = schedulerRunResponseCommandSchema.safeParse(raw);
      if (!parsed.success || !pending) return;
      const { payload, id, idempotency_key } = parsed.data;
      if (payload.exchange_id !== pending.id || id !== pending.id || idempotency_key !== id
        || payload.node_id !== session.nodeId || payload.session_id !== session.sessionId) return;
      const operation = payload.status === "rejected" ? payload.operation : payload.status === "current" ? "status" : "acquire";
      if (operation !== pending.operation || monotonicMs() >= pending.deadline) { settle(new Error("Scheduler run reply binding expired or changed")); return; }
      settle(undefined, payload);
    },
    close(error: Error) {
      controller.abort(error);
      for (const current of [...credentials.values()]) current.forget();
      settle(error);
    },
  };
}
