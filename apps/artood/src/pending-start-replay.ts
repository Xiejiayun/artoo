import { AsyncLocalStorage } from "node:async_hooks";
import type { RunStartCommand } from "@artoo/protocol";
import { createSourceStartReplay, type SourceStartOutcome, type SourceStartScope } from "./source-start-replay.js";

type Replay = ReturnType<typeof createSourceStartReplay>;
interface PendingStart { readonly runId: string; readonly scope: SourceStartScope; readonly replay: Replay; readonly replyIds: Set<string>; readonly sends: Set<string> }
interface ObservedAck { readonly pending: PendingStart; readonly observed: NonNullable<ReturnType<Replay["observeAck"]>> }

/** Coalesce only startup in flight. No retained approval, execution grant or closure evidence. */
export function createPendingStartReplay() {
  const pending = new Map<string, PendingStart>(), replies = new Map<string, PendingStart>();
  const unsettled = new Set<PendingStart>();
  const operation = new AsyncLocalStorage<PendingStart>();
  const prune = (attempt: PendingStart) => {
    if (pending.get(attempt.runId) === attempt) return;
    for (const id of attempt.replyIds) if (!attempt.sends.has(id) && replies.get(id) === attempt) replies.delete(id);
    if (!attempt.sends.size) unsettled.delete(attempt);
  };
  const release = (attempt: PendingStart) => {
    if (pending.get(attempt.runId) === attempt) {
      pending.delete(attempt.runId);
    }
    prune(attempt);
  };
  return {
    has(runId: string): boolean { return pending.has(runId); },
    ownsReply(commandId: string): boolean { return replies.has(commandId); },
    isStopped(runId: string): boolean { return pending.get(runId)?.replay.isStopped(runId) === true; },
    async dispatch(input: RunStartCommand, readScope: () => SourceStartScope | undefined, safe: () => boolean,
      work: (command: RunStartCommand) => Promise<void>, send: (outcome: SourceStartOutcome) => Promise<void>): Promise<void> {
      let attempt: PendingStart, admission: ReturnType<Replay["enter"]>;
      try {
        const previous = pending.get(input.payload.run_id), owner = replies.get(input.id);
        if (owner && owner !== previous && (owner.runId !== input.payload.run_id || !owner.sends.has(input.id))) {
          throw Error("Pending startup command ID belongs to another original operation");
        }
        const scoped = owner ?? previous;
        const scope = readScope();
        if (!scope) {
          scoped?.replay.invalidate();
          throw Error("Pending startup requires its current authenticated session");
        }
        if (scoped && (scoped.scope.session !== scope.session || scoped.scope.runtime !== scope.runtime)) {
          scoped.replay.invalidate();
          throw Error("Pending startup lost its original runtime/session");
        }
        if (owner && owner !== previous) {
          // The original startup ACK settled, but this exact reply is still
          // sending. Validate then join that send; never restore startup admission.
          owner.replay.enter(input, scope);
          return;
        }
        if (!previous && unsettled.size >= 1024) throw Error("Pending startup capacity reached; original ownership is retained");
        if (!owner && replies.size >= 4096) throw Error("Pending startup reply capacity reached; original bindings are retained");
        attempt = previous ?? { runId: input.payload.run_id, scope, replay: createSourceStartReplay(), replyIds: new Set(), sends: new Set() };
        // Reuse full schema, envelope, payload and session binding. In particular,
        // validate changed retries before joining an already pending reply ID.
        admission = attempt.replay.enter(input, scope);
        pending.set(attempt.runId, attempt); replies.set(input.id, attempt); attempt.replyIds.add(input.id); unsettled.add(attempt);
      } catch (error) {
        return send({ status: "rejected", error_code: "process_start_failed", message: error instanceof Error ? error.message : "Pending startup admission failed" });
      }
      if (admission.fresh) {
        try { await operation.run(attempt, () => attempt.replay.run(admission.ticket, () => work(admission.command))); }
        finally { release(attempt); }
        return;
      }
      if (attempt.sends.has(admission.command.id)) return;
      attempt.sends.add(admission.command.id);
      try {
        let outcome = await attempt.replay.replay(admission.ticket, readScope, safe);
        // The original ACK can settle before this continuation runs. Recheck
        // cheap local facts at the send boundary, never reuse that earlier check.
        let current = false;
        try {
          const scope = readScope();
          current = !!scope && scope.runtime === attempt.scope.runtime && scope.session === attempt.scope.session
            && !attempt.replay.isStopped(attempt.runId) && safe();
        } catch { /* Missing local scope cannot authorize a replay ACK. */ }
        if (!current) outcome = { status: "rejected", error_code: "process_start_failed",
          message: "Pending startup is stopped or no longer belongs to its original runtime/session" };
        await send(outcome);
      } finally { attempt.sends.delete(admission.command.id); prune(attempt); }
    },
    observeAck(commandId: string, outcome: SourceStartOutcome): ObservedAck | undefined {
      const attempt = operation.getStore();
      const observed = attempt?.replay.observeAck(commandId, outcome);
      return attempt && observed ? { pending: attempt, observed } : undefined;
    },
    outcome(observed: ObservedAck | undefined): SourceStartOutcome | undefined { return observed?.observed.outcome; },
    finishAck(observed: ObservedAck | undefined, sent: boolean): void {
      if (!observed) return;
      observed.pending.replay.finishAck(observed.observed, sent);
      // The original ACK's actual delivery settles the startup wait. A live run
      // may outlast it; subsequent commands must take the complete audit path.
      release(observed.pending);
    },
    // ACK delivery removes startup admission, but existing replies remain
    // cancellable until their own sends settle. This set never admits new work.
    stopRun(runId: string): void { for (const attempt of unsettled) if (attempt.runId === runId) attempt.replay.stopRun(runId); },
    invalidate(): void { for (const attempt of unsettled) attempt.replay.invalidate(); },
  };
}
