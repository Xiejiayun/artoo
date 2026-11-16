import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  SchedulerStartGrantV1Schema,
  type SchedulerAttemptCredentialV1,
  type SchedulerExecutionLeaseBindingV1,
  type SchedulerExecutionLeaseV1,
  type SchedulerStartGrantV1,
} from "@artoo/domain";
import {
  schedulerLeaseAcquireMessageSchema,
  schedulerLeaseRenewMessageSchema,
  schedulerLeaseResponseCommandSchema,
  type SchedulerLeaseRequestMessage,
  type SchedulerLeaseResponseCommand,
} from "@artoo/protocol";
import { monotonicMs, type ManagedSession } from "./managed-delivery.js";

/** A private renewal closure, not process ownership or a physical start permit.
 * signal observes this generation/local forgetting, not server lease validity. */
export interface SchedulerAttemptRenewal {
  readonly binding: Readonly<SchedulerExecutionLeaseBindingV1>;
  readonly signal: AbortSignal;
  renew(): Promise<SchedulerExecutionLeaseV1>;
  /** Drops local plaintext only; does not revoke a lease or release resources. */
  forget(): void;
}
export interface SchedulerLeaseSession {
  readonly session: ManagedSession;
  readonly signal: AbortSignal;
  acquire(
    grant: SchedulerStartGrantV1,
  ): Promise<
    | { status: "acquired"; lease: SchedulerExecutionLeaseV1; renewal: SchedulerAttemptRenewal }
    | { status: "retained"; lease: SchedulerExecutionLeaseV1 }
  >;
}
type Payload = SchedulerLeaseResponseCommand["payload"];
interface Pending {
  exchangeId: string;
  operation: "acquire" | "renew";
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  resolve(payload: Payload): void;
  reject(error: Error): void;
}
const grantFields = [
  "request_id",
  "organization_id",
  "project_id",
  "task_id",
  "run_id",
  "actor_user_id",
  "agent_instance_id",
  "computer_id",
  "device_id",
  "session_id",
  "grant_id",
  "journal_namespace",
  "node_attempt_id",
] as const;
const freezeLease = (lease: SchedulerExecutionLeaseV1) => {
  Object.freeze(lease.binding);
  return Object.freeze(lease);
};

/** No credential or pending exchange is persisted, replayed or returned to the
 * ordinary transport. Forgetting/closure removes all retained plaintext. */
export function createSchedulerLeaseClientChannel(options: {
  session: ManagedSession;
  assertCurrent(): void;
  send(message: SchedulerLeaseRequestMessage): void;
}) {
  const session = options.session,
    controller = new AbortController(),
    disposers = new Set<() => void>();
  let pending: Pending | undefined;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    options.assertCurrent();
  };
  function settle(error?: Error, payload?: Payload) {
    const item = pending;
    if (!item) return;
    pending = undefined;
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(payload!);
  }
  function exchange(request: SchedulerLeaseRequestMessage, operation: "acquire" | "renew"): Promise<Payload> {
    try {
      assertCurrent();
      if (pending) throw new Error("A scheduler lease exchange is already pending");
      const started = monotonicMs(),
        deadline = started + 10000;
      return new Promise<Payload>((resolve, reject) => {
        const timer = setTimeout(
          () => settle(new Error("Scheduler lease exchange expired")),
          Math.max(0, deadline - monotonicMs()),
        );
        pending = { exchangeId: request.exchange_id, operation, deadline, timer, resolve, reject };
        try {
          assertCurrent();
          options.send(request);
        } catch {
          settle(new Error("Scheduler lease exchange write failed"));
        }
      }).then((payload) => {
        assertCurrent();
        const now = monotonicMs();
        if (now < started || now >= deadline)
          throw new Error("Scheduler lease reply exceeded its original exchange window");
        return payload;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  const client = Object.freeze<SchedulerLeaseSession>({
    session,
    signal: controller.signal,
    async acquire(raw) {
      assertCurrent();
      if (disposers.size >= 64) throw new Error("Scheduler attempt credential memory capacity reached");
      const parsed = SchedulerStartGrantV1Schema.safeParse(raw);
      if (!parsed.success) throw new Error("Invalid scheduler lease grant");
      const grant = parsed.data;
      if (
        grant.computer_id !== session.nodeId ||
        grant.session_id !== session.sessionId ||
        grant.journal_namespace !== session.namespace
      )
        throw new Error("Scheduler lease grant differs from its original session/namespace");
      const reply = await exchange(
        schedulerLeaseAcquireMessageSchema.parse({
          kind: "scheduler.lease.acquire.v1",
          node_id: session.nodeId,
          session_id: session.sessionId,
          exchange_id: randomUUID(),
          grant,
        }),
        "acquire",
      );
      assertCurrent();
      if (reply.status !== "issued" && reply.status !== "retained")
        throw new Error("Scheduler lease acquisition was rejected");
      const lease = freezeLease(reply.lease);
      if (grantFields.some((key) => lease.binding[key] !== grant[key]))
        throw new Error("Scheduler lease changed its original grant binding");
      if (reply.status === "retained") return { status: "retained", lease };
      if (disposers.size >= 64) throw new Error("Scheduler attempt credential memory capacity reached");
      let credential: SchedulerAttemptCredentialV1 | undefined = reply.credential;
      const local = new AbortController();
      const forget = () => {
        credential = undefined;
        local.abort(new Error("Scheduler attempt credential was forgotten"));
        disposers.delete(forget);
      };
      disposers.add(forget);
      const renewal = Object.freeze<SchedulerAttemptRenewal>({
        binding: lease.binding,
        signal: local.signal,
        forget,
        async renew() {
          local.signal.throwIfAborted();
          assertCurrent();
          if (!credential) throw new Error("Scheduler attempt credential is unavailable");
          const renewed = await exchange(
            schedulerLeaseRenewMessageSchema.parse({
              kind: "scheduler.lease.renew.v1",
              node_id: session.nodeId,
              session_id: session.sessionId,
              exchange_id: randomUUID(),
              binding: lease.binding,
              credential,
            }),
            "renew",
          );
          local.signal.throwIfAborted();
          assertCurrent();
          if (renewed.status !== "renewed") throw new Error("Scheduler lease renewal was rejected");
          if (!isDeepStrictEqual(renewed.lease.binding, lease.binding))
            throw new Error("Scheduler renewal changed its original lease binding");
          return freezeLease(renewed.lease);
        },
      });
      return { status: "acquired", lease, renewal };
    },
  });
  return {
    open(): SchedulerLeaseSession {
      assertCurrent();
      return client;
    },
    receive(raw: unknown) {
      const parsed = schedulerLeaseResponseCommandSchema.safeParse(raw);
      if (!parsed.success) return;
      const { payload, id, idempotency_key } = parsed.data,
        item = pending;
      if (
        !item ||
        payload.exchange_id !== item.exchangeId ||
        id !== payload.exchange_id ||
        idempotency_key !== id ||
        payload.node_id !== session.nodeId ||
        payload.session_id !== session.sessionId
      )
        return;
      try {
        assertCurrent();
        if (monotonicMs() >= item.deadline)
          throw new Error("Scheduler lease reply arrived after its original deadline");
        const operation =
          payload.status === "rejected" ? payload.operation : payload.status === "renewed" ? "renew" : "acquire";
        if (operation !== item.operation) throw new Error("Scheduler lease reply operation changed");
        settle(undefined, payload);
      } catch (error) {
        settle(error instanceof Error ? error : new Error("Scheduler lease reply rejected"));
      }
    },
    close(error: Error) {
      controller.abort(error);
      for (const forget of [...disposers]) forget();
      settle(error);
    },
  };
}
