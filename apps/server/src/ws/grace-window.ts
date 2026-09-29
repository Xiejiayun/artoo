/**
 * Disconnect grace scheduling. Durable run rows are the recovery source of
 * truth: execution-recovery-service reconstructs these windows before startup.
 *
 * When a node's socket closes, the server does NOT immediately fail that
 * computer's active runs; it arms a grace window (a snapshot of the run ids that
 * were active at disconnect). If the node reconnects within the window, the
 * window is disarmed and the server resumes those runs. If it expires, the
 * snapshot runs are failed (`daemon_disconnect`, re-verified at fire time).
 *
 * Timer handles are local to this process, but losing them cannot strand a run:
 * startup reconstructs a fresh bounded window for every unfinished durable run,
 * including standalone tasks and queued dispatches with no checkpoint.
 *
 * The window is keyed by `computerId` (node identity): each computer has at most
 * one pending window, and only that computer's snapshot runs are affected.
 */

export interface GraceScheduler {
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

const realScheduler: GraceScheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface GraceWindowManager {
  /** Arm a window for a computer with the run ids active at disconnect. Replaces
   *  any existing window for that computer. Empty snapshot = nothing to protect. */
  arm(computerId: string, runIds: readonly string[]): void;
  /** Disarm on reconnect; returns the snapshot run ids to resume (empty if none). */
  disarm(computerId: string): string[];
  /** Whether a window is currently pending for a computer (inspection/tests). */
  isArmed(computerId: string): boolean;
  /** Cancel local handles at shutdown; durable runs remain recoverable. */
  close?(): void;
}

export interface GraceWindowOptions {
  graceMs: number;
  /** Called when a window expires without reconnect, with the snapshot run ids.
   *  The callback re-verifies each run before failing it. */
  onExpire: (computerId: string, runIds: string[]) => void | Promise<void>;
  scheduler?: GraceScheduler;
}

export function createGraceWindowManager(opts: GraceWindowOptions): GraceWindowManager {
  const scheduler = opts.scheduler ?? realScheduler;
  const pending = new Map<string, { runIds: string[]; handle: unknown }>();
  let closed = false;

  return {
    arm(computerId, runIds) {
      if (closed) return;
      const existing = pending.get(computerId);
      if (existing !== undefined) scheduler.cancel(existing.handle);
      if (runIds.length === 0) {
        pending.delete(computerId);
        return;
      }
      const snapshot = [...runIds];
      const handle = scheduler.schedule(() => {
        pending.delete(computerId);
        void opts.onExpire(computerId, snapshot);
      }, opts.graceMs);
      pending.set(computerId, { runIds: snapshot, handle });
    },
    disarm(computerId) {
      const existing = pending.get(computerId);
      if (existing === undefined) return [];
      scheduler.cancel(existing.handle);
      pending.delete(computerId);
      return existing.runIds;
    },
    isArmed(computerId) {
      return pending.has(computerId);
    },
    close() {
      closed = true;
      for (const entry of pending.values()) scheduler.cancel(entry.handle);
      pending.clear();
    },
  };
}
