import type { SchedulerStartRequestMessage, SchedulerStartResponseCommand } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import { prepareSchedulerStartProposal } from "../services/scheduler-start-proposal-service.js";
import { grantSchedulerStart } from "../services/scheduler-start-grant-service.js";

/** Only exchanges metadata/grants for an already consumed request. It cannot
 * consume a permission, dispatch run.start, renew a lease or start a process. */
export function createSchedulerStartServerChannel(
  ctx: ServerContext,
  options: {
    computerId: string;
    sessionId: string;
    namespace: string;
    isCurrent(): boolean;
    send(message: SchedulerStartResponseCommand): Promise<void>;
    close(reason: string): void;
    onRejected(error: unknown, operation: "proposal" | "grant"): void;
  },
) {
  let busy = false;
  return async (message: SchedulerStartRequestMessage): Promise<void> => {
    // Transport supplies these identities from its authenticated paired binding.
    if (!options.isCurrent() || message.node_id !== options.computerId || message.session_id !== options.sessionId)
      return;
    if (busy) {
      options.close("scheduler start channel already has a pending exchange");
      return;
    }
    busy = true;
    const operation = message.kind === "scheduler.start.propose.v1" ? "proposal" : "grant";
    const base = {
      version: 1 as const,
      node_id: options.computerId,
      session_id: options.sessionId,
      exchange_id: message.exchange_id,
    };
    let payload: SchedulerStartResponseCommand["payload"] = { ...base, status: "rejected", operation };
    // At most one database operation per connection; heartbeat stays independent.
    try {
      try {
        const input = {
          taskId: message.task_id,
          requestId: message.kind === "scheduler.start.propose.v1" ? message.request_id : message.ready.request_id,
          computerId: options.computerId,
          sessionId: options.sessionId,
        };
        if (message.kind === "scheduler.start.propose.v1") {
          payload = { ...base, status: "proposal", result: await prepareSchedulerStartProposal(ctx, input) };
        } else if (message.ready.journal_namespace === options.namespace) {
          payload = { ...base, status: "grant", result: await grantSchedulerStart(ctx, input, message.ready) };
        }
      } catch (error) {
        // An explicit rejection reports the failed exchange without disclosing
        // context/credential/database details. No reservation is released here.
        payload = { ...base, status: "rejected", operation };
        options.onRejected(error, operation);
      }
      if (!options.isCurrent()) return;
      try {
        await options.send({
          kind: "command",
          type: "scheduler.start.response.v1",
          id: message.exchange_id,
          idempotency_key: message.exchange_id,
          payload,
        });
      } catch {
        options.close("scheduler start response write failed");
      }
    } finally {
      busy = false;
    }
  };
}
