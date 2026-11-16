import type { SchedulerLeaseRequestMessage, SchedulerLeaseResponseCommand } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import {
  acquireSchedulerAttemptCredential,
  renewSchedulerAttemptCredential,
} from "../services/scheduler-attempt-credential-service.js";

/** One outstanding DB exchange per connection, independent of heartbeat. This
 * lane cannot start/stop a process or release any physical reservation. */
export function createSchedulerLeaseServerChannel(
  ctx: ServerContext,
  options: {
    computerId: string;
    sessionId: string;
    namespace: string;
    isCurrent(): boolean;
    send(message: SchedulerLeaseResponseCommand): Promise<void>;
    close(reason: string): void;
    // Deliberately excludes raw errors: query/validation errors can carry secrets.
    onRejected(operation: "acquire" | "renew"): void;
  },
) {
  let busy = false;
  return async (message: SchedulerLeaseRequestMessage): Promise<void> => {
    if (!options.isCurrent() || message.node_id !== options.computerId || message.session_id !== options.sessionId)
      return;
    if (busy) {
      options.close("scheduler lease channel already has a pending exchange");
      return;
    }
    busy = true;
    const operation = message.kind === "scheduler.lease.acquire.v1" ? "acquire" : "renew";
    const base = {
      version: 1 as const,
      node_id: options.computerId,
      session_id: options.sessionId,
      exchange_id: message.exchange_id,
    };
    let payload: SchedulerLeaseResponseCommand["payload"] = { ...base, status: "rejected", operation };
    try {
      try {
        const scope = message.kind === "scheduler.lease.acquire.v1" ? message.grant : message.binding;
        if (scope.journal_namespace !== options.namespace) throw new Error("Scheduler lease namespace differs");
        const input = {
          taskId: scope.task_id,
          requestId: scope.request_id,
          computerId: options.computerId,
          sessionId: options.sessionId,
        };
        if (message.kind === "scheduler.lease.acquire.v1")
          payload = { ...base, ...(await acquireSchedulerAttemptCredential(ctx, input, message.grant)) };
        else
          payload = {
            ...base,
            status: "renewed",
            lease: await renewSchedulerAttemptCredential(ctx, input, message.binding, message.credential),
          };
      } catch {
        payload = { ...base, status: "rejected", operation };
        options.onRejected(operation);
      }
      if (!options.isCurrent()) return;
      try {
        await options.send({
          kind: "command",
          type: "scheduler.lease.response.v1",
          id: message.exchange_id,
          idempotency_key: message.exchange_id,
          payload,
        });
      } catch {
        options.close("scheduler lease response write failed");
      }
    } finally {
      busy = false;
    }
  };
}
