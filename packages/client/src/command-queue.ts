/**
 * @artoo/client — offline command queue (#27 v2-B slice 2c). The command half of
 * the cross-client contract, paired with the slice-1 read/sync client. A client
 * that issues mutating commands while offline (or across a reconnect) queues them
 * and replays them in order when connectivity returns.
 *
 * Each command carries:
 *  - a stable idempotency `key` so a replay after a lost ack does NOT double
 *    apply (the server dedupes on the key and returns the stored response);
 *  - an optional `baseVersion` (the resource snapshot the user acted on) so the
 *    server can reject a command whose target advanced — a stale conflict is
 *    surfaced to the caller, never silently dropped.
 *
 * No IO here: the actual send is an injected function so this stays a pure,
 * testable state machine over { applied, conflict, retry } outcomes.
 */

/** Server conflict record when a command's base_version is stale (mirrors the
 *  server `stale_base_version` AppError details). */
export interface CommandConflict {
  reason: "stale_base_version";
  base_version: number;
  current_version: number;
  resource: { type: string; id: string };
}

/** A queued mutating command. `payload` is opaque to the queue — the injected
 *  sender turns it into a request (with the idempotency key + base_version). */
export interface PendingCommand {
  /** Idempotency key — stable across replays of the SAME logical command. */
  key: string;
  /** Optimistic-concurrency snapshot the user acted on (omit to skip OCC). */
  baseVersion?: number;
  /** Opaque request body for the sender. */
  payload: unknown;
}

/** What the injected sender reports for one attempt. */
export type SendResult =
  | { status: "applied"; response?: unknown }
  | { status: "conflict"; conflict: CommandConflict }
  /** Transient (offline / network / 5xx): keep queued, stop this flush pass. */
  | { status: "retry" };

/** Terminal outcome the queue settles a command to (applied or conflict). */
export type CommandOutcome =
  | { status: "applied"; key: string; response: unknown; duplicate: boolean }
  | { status: "conflict"; key: string; conflict: CommandConflict };

export interface CommandQueueOptions {
  /** Perform one send attempt. Maps a 2xx to applied, a stale-version 409 to
   *  conflict, and offline/transient failures to retry. */
  send: (cmd: PendingCommand) => Promise<SendResult>;
  /** Notified as each command settles (applied or conflict). */
  onOutcome?: (outcome: CommandOutcome) => void;
}

export interface CommandQueue {
  /** Append a command to the tail of the offline queue. */
  enqueue(cmd: PendingCommand): void;
  /**
   * Replay queued commands in FIFO order. Stops at the first `retry` (preserving
   * order for the next reconnect) and returns the outcomes settled this pass.
   * Concurrent flushes are coalesced — a flush already in progress is awaited.
   */
  flush(): Promise<CommandOutcome[]>;
  /** Commands still waiting to be applied (not yet settled). */
  pending(): PendingCommand[];
}

/**
 * Create an offline command queue. Replay semantics:
 *  - `applied`  → settle; if the key already settled-applied once, mark
 *                 `duplicate: true` (a replayed, server-deduped command);
 *  - `conflict` → settle and surface the conflict; replay continues with the
 *                 next command (a stale command does not wedge the queue);
 *  - `retry`    → leave this command and the rest queued, stop the pass.
 */
export function createCommandQueue(opts: CommandQueueOptions): CommandQueue {
  const queue: PendingCommand[] = [];
  const settledAppliedKeys = new Set<string>();
  let flushing: Promise<CommandOutcome[]> | null = null;

  function settle(outcome: CommandOutcome): void {
    opts.onOutcome?.(outcome);
  }

  async function runFlush(): Promise<CommandOutcome[]> {
    const outcomes: CommandOutcome[] = [];
    while (queue.length > 0) {
      const cmd = queue[0]!;
      const result = await opts.send(cmd);
      if (result.status === "retry") {
        break; // keep cmd (and the rest) queued, preserve order
      }
      queue.shift();
      if (result.status === "applied") {
        const duplicate = settledAppliedKeys.has(cmd.key);
        settledAppliedKeys.add(cmd.key);
        const outcome: CommandOutcome = {
          status: "applied",
          key: cmd.key,
          response: result.response ?? null,
          duplicate,
        };
        outcomes.push(outcome);
        settle(outcome);
      } else {
        const outcome: CommandOutcome = { status: "conflict", key: cmd.key, conflict: result.conflict };
        outcomes.push(outcome);
        settle(outcome);
      }
    }
    return outcomes;
  }

  return {
    enqueue(cmd: PendingCommand): void {
      queue.push(cmd);
    },
    flush(): Promise<CommandOutcome[]> {
      // Coalesce concurrent flushes so a single command is never sent twice in
      // parallel (which would defeat ordered replay).
      if (flushing !== null) {
        return flushing;
      }
      const run = runFlush().finally(() => {
        flushing = null;
      });
      flushing = run;
      return run;
    },
    pending(): PendingCommand[] {
      return [...queue];
    },
  };
}
