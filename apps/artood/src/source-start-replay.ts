import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { runStartCommandSchema, type NodeErrorCode, type RunStartCommand } from "@artoo/protocol";

export type SourceStartOutcome = Readonly<{ status: "accepted" } | { status: "rejected"; error_code: NodeErrorCode; message: string }>;
export interface SourceStartScope { readonly runtime: object; readonly session: object }
interface Attempt {
  readonly key: string; readonly ownerId: string; readonly runId: string; readonly scope: SourceStartScope;
  readonly ready: Promise<void>; resolve?: () => void; outcome?: SourceStartOutcome;
  delivery?: "sent" | "failed"; workSettled: boolean; stopped: boolean; waiters: number;
}
declare const sourceStartTicket: unique symbol;
export interface SourceStartTicket { readonly [sourceStartTicket]: true }
interface ObservedAck { readonly attempt: Attempt; readonly outcome: SourceStartOutcome }
const rejected = (message: string): SourceStartOutcome => Object.freeze({ status: "rejected", error_code: "process_start_failed", message });
const unavailable = () => rejected("Original source startup is stopped or no longer belongs to this authenticated epoch/session");
const freeze = (value: object): void => { for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child); Object.freeze(value); };

/** One client/session's bounded startup facts. These objects never grant execution or prove process closure. */
export function createSourceStartReplay() {
  const attempts = new Map<string, Attempt>(), owners = new Map<string, Attempt>(), tickets = new WeakMap<SourceStartTicket, Attempt>();
  const stoppedRuns = new Set<string>();
  const operation = new AsyncLocalStorage<Attempt>();
  let stopped = false;
  const wake = (attempt: Attempt) => { attempt.resolve?.(); attempt.resolve = undefined; };
  const invalidate = () => { stopped = true; for (const attempt of attempts.values()) { attempt.stopped = true; wake(attempt); } };
  const record = (ticket: SourceStartTicket) => {
    const attempt = tickets.get(ticket); if (!attempt) throw Error("Original source startup ticket required"); return attempt;
  };
  const ticketFor = (attempt: Attempt): SourceStartTicket => {
    const ticket = Object.freeze({}) as SourceStartTicket; tickets.set(ticket, attempt); return ticket;
  };
  const current = (attempt: Attempt, scope: SourceStartScope) => !stopped && !attempt.stopped
    && attempt.scope.runtime === scope.runtime && attempt.scope.session === scope.session;
  return {
    enter(input: RunStartCommand, scope: SourceStartScope): { fresh: boolean; ticket: SourceStartTicket; command: RunStartCommand } {
      if (stopped) throw Error("Source startup admission is stopping");
      const command = runStartCommandSchema.parse(input);
      // Reject unsupported fields rather than silently dropping them from replay identity.
      if (canonical(input) !== canonical(command)) throw Error("Source startup contains fields outside its complete supported schema");
      const runId = command.payload.run_id;
      if (runId.length > 256 || command.id.length > 256 || command.idempotency_key !== `${runId}:start`) throw Error("Source startup requires a bounded stable run start identity");
      if (stoppedRuns.has(runId)) throw Error("Source startup replay is fenced by Stop before its original admission");
      const { id: _replyId, ...binding } = command;
      const key = createHash("sha256").update(canonical(binding)).digest("hex");
      const previous = attempts.get(runId), owner = owners.get(command.id);
      if (owner && owner !== previous) throw Error("Source startup command ID belongs to another original operation");
      if (previous) {
        if (previous.key !== key || !current(previous, scope)) throw Error("Source startup replay changed payload, envelope, epoch, session or Stop fence");
        // A retry reply ID cannot subsequently acquire another run's ACK binding.
        if (!owner && owners.size >= 4096) throw Error("Source startup command identity capacity reached; original bindings are retained");
        owners.set(command.id, previous);
        return { fresh: false, ticket: ticketFor(previous), command };
      }
      // Never evict a started/failed identity and thereby grant it a second start.
      // Compact records retain digests/outcomes only; exhaustion fails closed until a new client.
      if (attempts.size + stoppedRuns.size >= 1024) throw Error("Source startup replay capacity reached; original execution identities are retained");
      if (owners.size >= 4096) throw Error("Source startup command identity capacity reached; original bindings are retained");
      let resolve!: () => void;
      const attempt: Attempt = { key, ownerId: command.id, runId, scope: Object.freeze({ ...scope }),
        ready: new Promise<void>(done => { resolve = done; }), resolve: () => resolve(), workSettled: false, stopped: false, waiters: 0 };
      attempts.set(runId, attempt); owners.set(command.id, attempt);
      freeze(command);
      return { fresh: true, ticket: ticketFor(attempt), command };
    },
    async run<T>(ticket: SourceStartTicket, work: () => Promise<T>): Promise<T> {
      const attempt = record(ticket);
      return operation.run(attempt, async () => {
        try { return await work(); }
        finally {
          // Ending startup does not establish an outcome or prove that an ACK send failed.
          // Only the original ACK observation and actual send completion record those facts.
          attempt.workSettled = true;
          wake(attempt);
        }
      });
    },
    observeAck(commandId: string, value: SourceStartOutcome): ObservedAck | undefined {
      const attempt = operation.getStore();
      // Detached descendants retain async context, but cannot supply a first outcome after startup ended.
      if (!attempt || attempt.ownerId !== commandId || attempt.outcome || attempt.workSettled) return undefined;
      // Bound retained diagnostics; the original and replay ACK use the same explicitly truncated text.
      const outcome: SourceStartOutcome = value.status === "accepted" ? Object.freeze({ status: "accepted" })
        : Object.freeze({ ...value, message: value.message.length <= 8192 ? value.message : value.message.slice(0, 8150) + "\n[Startup diagnostic truncated]" });
      attempt.outcome = outcome; // Real startup fact is independent of transport delivery.
      return { attempt, outcome };
    },
    finishAck(observed: ObservedAck | undefined, sent: boolean): void {
      if (!observed || observed.attempt.outcome !== observed.outcome) return;
      observed.attempt.delivery = sent ? "sent" : "failed"; wake(observed.attempt);
    },
    async replay(ticket: SourceStartTicket, readScope: () => SourceStartScope | undefined, safe: () => boolean): Promise<SourceStartOutcome> {
      const attempt = record(ticket);
      if (attempt.waiters >= 64) return rejected("Source startup replay waiter capacity reached; original execution is retained");
      attempt.waiters++;
      try {
        await attempt.ready;
        try {
          const scope = readScope();
          if (!scope || !current(attempt, scope) || !safe()) return unavailable();
        } catch { return unavailable(); }
        if (attempt.delivery === "failed") return rejected("Original source startup ACK delivery failed; original execution ownership is retained");
        if (!attempt.outcome) return rejected("Original source startup outcome remains unknown; original execution ownership is retained");
        if (attempt.delivery !== "sent") return rejected("Original source startup ACK delivery remains unconfirmed; original execution ownership is retained");
        return attempt.outcome;
      } finally { attempt.waiters--; }
    },
    isStopped(runId: string): boolean { return stopped || stoppedRuns.has(runId) || attempts.get(runId)?.stopped === true; },
    stopRun(runId: string): void {
      const attempt = attempts.get(runId);
      if (attempt) { attempt.stopped = true; wake(attempt); return; }
      if (stoppedRuns.has(runId)) return;
      // Stop precedes startup admission too. If a new tombstone cannot be retained,
      // close all new admission instead of forgetting that Stop ever arrived.
      if (runId.length > 256 || attempts.size + stoppedRuns.size >= 1024) { invalidate(); return; }
      stoppedRuns.add(runId);
    },
    invalidate,
  };
}
