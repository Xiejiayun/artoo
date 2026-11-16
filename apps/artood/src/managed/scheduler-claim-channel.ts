import { randomUUID } from "node:crypto";
import {
  schedulerClaimPollMessageSchema,
  schedulerClaimResponseCommandSchema,
  type SchedulerClaimPollMessage,
  type SchedulerClaimResponseCommand,
} from "@artoo/protocol";
import { monotonicMs, type ManagedSession } from "./managed-delivery.js";

export type SchedulerClaimReply = SchedulerClaimResponseCommand["payload"];
export interface SchedulerClaimSession {
  readonly session: ManagedSession;
  readonly signal: AbortSignal;
  poll(): Promise<SchedulerClaimReply>;
}
/** A single outstanding claim observation in one generation. A claimed ID is
 * only input to the existing one-use admission, never physical start authority. */
export function createSchedulerClaimClientChannel(options: {
  session: ManagedSession;
  assertCurrent(): void;
  send(message: SchedulerClaimPollMessage): void;
}) {
  const session = options.session,
    controller = new AbortController();
  let pending:
    | {
        id: string;
        deadline: number;
        timer: ReturnType<typeof setTimeout>;
        resolve(reply: SchedulerClaimReply): void;
        reject(error: Error): void;
      }
    | undefined;
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    options.assertCurrent();
  };
  function settle(error?: Error, reply?: SchedulerClaimReply) {
    const item = pending;
    if (!item) return;
    pending = undefined;
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(reply!);
  }
  const client = Object.freeze<SchedulerClaimSession>({
    session,
    signal: controller.signal,
    async poll() {
      assertCurrent();
      if (pending) throw new Error("A scheduler claim poll is already pending");
      const started = monotonicMs(),
        deadline = started + 10000,
        id = randomUUID();
      const reply = await new Promise<SchedulerClaimReply>((resolve, reject) => {
        const timer = setTimeout(
          () => settle(new Error("Scheduler claim poll expired")),
          Math.max(0, deadline - monotonicMs()),
        );
        pending = { id, deadline, timer, resolve, reject };
        try {
          options.send(
            schedulerClaimPollMessageSchema.parse({
              kind: "scheduler.claim.poll.v1",
              node_id: session.nodeId,
              session_id: session.sessionId,
              exchange_id: id,
            }),
          );
        } catch {
          settle(new Error("Scheduler claim write failed"));
        }
      });
      assertCurrent();
      if (monotonicMs() < started || monotonicMs() >= deadline)
        throw new Error("Scheduler claim reply exceeded its original window");
      return reply;
    },
  });
  return {
    open() {
      assertCurrent();
      return client;
    },
    receive(raw: unknown) {
      const parsed = schedulerClaimResponseCommandSchema.safeParse(raw);
      if (!parsed.success || !pending) return;
      const { payload, id, idempotency_key } = parsed.data;
      if (
        id !== pending.id ||
        idempotency_key !== id ||
        payload.exchange_id !== pending.id ||
        payload.node_id !== session.nodeId ||
        payload.session_id !== session.sessionId
      )
        return;
      if (monotonicMs() >= pending.deadline) {
        settle(new Error("Scheduler claim reply expired"));
        return;
      }
      settle(undefined, payload);
    },
    close(error: Error) {
      controller.abort(error);
      settle(error);
    },
  };
}
