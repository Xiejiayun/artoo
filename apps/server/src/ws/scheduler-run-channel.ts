import type { SchedulerRunRequestMessage, SchedulerRunEventMessage, SchedulerRunResponseCommand, RunEventAckCommand } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import { acquireSchedulerRunCredential, schedulerRunStatus } from "../services/scheduler-run-service.js";
import { ingestSchedulerWireRunEvent } from "../services/run-service.js";

/** Private connection lane, independent of heartbeat. Raw errors may include
 * query parameters, so neither errors nor frames are handed to log callbacks. */
export function createSchedulerRunServerChannel(ctx: ServerContext, options: {
  computerId: string; sessionId: string; namespace: string;
  isCurrent(): boolean;
  send(message: SchedulerRunResponseCommand | RunEventAckCommand): Promise<void>;
  close(reason: string): void;
  onRejected(operation: "acquire" | "status" | "event"): void;
}) {
  let tail = Promise.resolve(), pending = 0;
  async function handle(message: SchedulerRunRequestMessage | SchedulerRunEventMessage): Promise<void> {
    if (!options.isCurrent() || message.node_id !== options.computerId || message.session_id !== options.sessionId) return;
    const operation = message.kind === "scheduler.run.acquire.v1" ? "acquire" : message.kind === "scheduler.run.status.v1" ? "status" : "event";
    try {
      const scope = message.kind === "scheduler.run.acquire.v1" ? message.grant : message.binding;
      if (scope.journal_namespace !== options.namespace) throw new Error("Scheduler lifecycle namespace differs");
      if (message.kind === "scheduler.run.event.v1") {
        await ingestSchedulerWireRunEvent(ctx, message);
        if (!options.isCurrent()) return;
        const id = `receipt:${message.frame.run_id}:${message.frame.sequence}`;
        await options.send({ kind: "command", id, idempotency_key: id, type: "run.event.ack", payload: {
          run_id: message.frame.run_id, sequence: message.frame.sequence, status: "accepted",
        } });
        return;
      }
      const input = { taskId: scope.task_id, requestId: scope.request_id, computerId: options.computerId, sessionId: options.sessionId };
      const base = { version: 1 as const, node_id: options.computerId, session_id: options.sessionId, exchange_id: message.exchange_id };
      let payload: SchedulerRunResponseCommand["payload"];
      try {
        payload = message.kind === "scheduler.run.acquire.v1"
          ? { ...base, ...await acquireSchedulerRunCredential(ctx, input, message.grant) }
          : { ...base, status: "current", ...await schedulerRunStatus(ctx, input, message.binding, message.credential) };
      } catch {
        options.onRejected(operation);
        payload = { ...base, status: "rejected", operation: message.kind === "scheduler.run.acquire.v1" ? "acquire" : "status" };
      }
      if (options.isCurrent()) await options.send({ kind: "command", id: message.exchange_id, idempotency_key: message.exchange_id, type: "scheduler.run.response.v1", payload });
    } catch {
      options.onRejected(operation);
      // No accepted receipt on failed/fenced ingress. Closing triggers the
      // existing physical owner and retains the original durable inner frame.
      options.close("scheduler lifecycle exchange failed");
    }
  }
  return (message: SchedulerRunRequestMessage | SchedulerRunEventMessage): Promise<void> => {
    if (pending >= 64) { options.close("scheduler lifecycle queue exceeded its bound"); return Promise.resolve(); }
    pending++;
    const current = tail.then(() => handle(message)).finally(() => { pending--; });
    tail = current.catch(() => {});
    return current;
  };
}
