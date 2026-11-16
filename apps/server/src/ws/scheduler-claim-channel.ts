import type { SchedulerClaimPollMessage, SchedulerClaimResponseCommand } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import { pollSchedulerExecution, type SchedulerClaimCursor } from "../services/scheduler-claim-consumer-service.js";

export function createSchedulerClaimServerChannel(
  ctx: ServerContext,
  options: {
    computerId: string;
    sessionId: string;
    isCurrent(): boolean;
    send(message: SchedulerClaimResponseCommand): Promise<void>;
    close(reason: string): void;
    onRejected(): void;
  },
) {
  let busy = false,
    replayQueued = true,
    cursor: SchedulerClaimCursor | undefined;
  return async (message: SchedulerClaimPollMessage) => {
    if (!options.isCurrent() || message.node_id !== options.computerId || message.session_id !== options.sessionId)
      return;
    if (busy) {
      options.close("scheduler claim poll already pending");
      return;
    }
    busy = true;
    const base = {
      version: 1 as const,
      node_id: options.computerId,
      session_id: options.sessionId,
      exchange_id: message.exchange_id,
    };
    let payload: SchedulerClaimResponseCommand["payload"];
    try {
      try {
        const result = await pollSchedulerExecution(
          ctx,
          { computerId: options.computerId, sessionId: options.sessionId },
          cursor,
          replayQueued,
        );
        // A locally fenced pre-grant assignment must not starve other work.
        replayQueued = !replayQueued;
        cursor = result.cursor;
        payload = result.assignment
          ? { ...base, status: "claimed", ...result.assignment }
          : { ...base, status: "idle", retry_after_ms: 2000 };
      } catch {
        payload = { ...base, status: "rejected" };
        options.onRejected();
      }
      if (!options.isCurrent()) return;
      try {
        await options.send({
          kind: "command",
          id: message.exchange_id,
          idempotency_key: message.exchange_id,
          type: "scheduler.claim.response.v1",
          payload,
        });
      } catch {
        options.close("scheduler claim response write failed");
      }
    } finally {
      busy = false;
    }
  };
}
