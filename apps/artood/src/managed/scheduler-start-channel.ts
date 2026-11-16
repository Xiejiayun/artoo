import { createHash, randomUUID } from "node:crypto";
import {
  canonicalSchedulerStartProposalV1,
  type SchedulerStartGrantResponseV1,
  type SchedulerStartReadyV1,
} from "@artoo/domain";
import {
  schedulerStartProposalRequestSchema,
  schedulerStartReadyMessageSchema,
  schedulerStartResponseCommandSchema,
  type SchedulerStartProposalResult,
  type SchedulerStartRequestMessage,
  type SchedulerStartResponseCommand,
} from "@artoo/protocol";
import { monotonicMs, type ManagedSession } from "./managed-delivery.js";

/** A generation-bound exchange, never a journal preparation or launch permit. */
export interface SchedulerStartSession {
  readonly session: ManagedSession;
  readonly signal: AbortSignal;
  propose(input: { taskId: string; requestId: string }): Promise<SchedulerStartProposalResult>;
  grant(input: { taskId: string; ready: SchedulerStartReadyV1 }): Promise<SchedulerStartGrantResponseV1>;
}
type Payload = SchedulerStartResponseCommand["payload"];
interface Pending {
  readonly request: SchedulerStartRequestMessage;
  readonly operation: "proposal" | "grant";
  readonly deadline: number;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(payload: Payload): void;
  reject(error: Error): void;
}

/** Owned by one socket generation. No request/reply is retained for reconnect. */
export function createSchedulerStartClientChannel(options: {
  session: ManagedSession;
  assertCurrent(): void;
  send(message: SchedulerStartRequestMessage): void;
}) {
  const controller = new AbortController(),
    session = options.session;
  let pending: Pending | undefined;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    options.assertCurrent();
  };
  function settle(error?: Error, payload?: Payload): void {
    const item = pending;
    if (!item) return;
    pending = undefined;
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(payload!);
  }
  function exchange(request: SchedulerStartRequestMessage, operation: "proposal" | "grant"): Promise<Payload> {
    try {
      assertCurrent();
      if (pending) throw new Error("A scheduler start exchange is already pending");
      const started = monotonicMs(),
        deadline = started + (operation === "grant" ? 5000 : 10000);
      return new Promise<Payload>((resolve, reject) => {
        const timer = setTimeout(
          () => settle(new Error("Scheduler start exchange expired")),
          Math.max(0, deadline - monotonicMs()),
        );
        pending = { request, operation, deadline, timer, resolve, reject };
        try {
          assertCurrent();
          options.send(request);
        } catch (cause) {
          settle(cause instanceof Error ? cause : new Error(String(cause)));
        }
      }).then((payload) => {
        assertCurrent();
        const now = monotonicMs();
        if (now < started || now >= deadline)
          throw new Error("Scheduler start reply exceeded its original exchange window");
        return payload;
      });
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  const client = Object.freeze<SchedulerStartSession>({
    session,
    signal: controller.signal,
    async propose(input) {
      const request = schedulerStartProposalRequestSchema.parse({
        kind: "scheduler.start.propose.v1",
        node_id: session.nodeId,
        session_id: session.sessionId,
        exchange_id: randomUUID(),
        task_id: input.taskId,
        request_id: input.requestId,
      });
      const reply = await exchange(request, "proposal");
      assertCurrent();
      if (reply.status !== "proposal") throw new Error("Scheduler start proposal was rejected");
      const result = reply.result,
        prepared = result.proposal.prepared_start;
      if (
        prepared.request_id !== request.request_id ||
        prepared.task_id !== request.task_id ||
        prepared.computer_id !== session.nodeId ||
        prepared.session_id !== session.sessionId ||
        result.proposal_digest !==
          `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(result.proposal)).digest("hex")}`
      )
        throw new Error("Scheduler proposal changed its original request/session binding");
      return result;
    },
    async grant(input) {
      const request = schedulerStartReadyMessageSchema.parse({
        kind: "scheduler.start.ready.v1",
        node_id: session.nodeId,
        session_id: session.sessionId,
        exchange_id: randomUUID(),
        task_id: input.taskId,
        ready: input.ready,
      });
      if (request.ready.journal_namespace !== session.namespace) throw new Error("Scheduler ready namespace differs");
      const reply = await exchange(request, "grant");
      assertCurrent();
      if (reply.status !== "grant") throw new Error("Scheduler start grant was rejected");
      const grant = reply.result.grant;
      if (
        grant.computer_id !== session.nodeId ||
        grant.session_id !== session.sessionId ||
        grant.task_id !== request.task_id ||
        Object.entries(request.ready).some(([key, value]) => grant[key as keyof typeof grant] !== value)
      )
        throw new Error("Scheduler grant changed its original ready/session binding");
      return reply.result;
    },
  });
  return {
    open(): SchedulerStartSession {
      assertCurrent();
      return client;
    },
    receive(raw: SchedulerStartResponseCommand): void {
      const parsed = schedulerStartResponseCommandSchema.safeParse(raw);
      if (!parsed.success) return;
      const payload = parsed.data.payload,
        item = pending;
      if (
        !item ||
        payload.exchange_id !== item.request.exchange_id ||
        payload.session_id !== session.sessionId ||
        payload.node_id !== session.nodeId
      )
        return;
      try {
        assertCurrent();
        // Check elapsed time even if a blocked event loop delays the timer.
        if (monotonicMs() >= item.deadline)
          throw new Error("Scheduler start reply arrived after its original deadline");
        if ((payload.status === "rejected" ? payload.operation : payload.status) !== item.operation)
          throw new Error("Scheduler start reply operation changed");
        settle(undefined, payload);
      } catch (cause) {
        settle(cause instanceof Error ? cause : new Error(String(cause)));
      }
    },
    close(error: Error): void {
      controller.abort(error);
      settle(error);
    },
  };
}
