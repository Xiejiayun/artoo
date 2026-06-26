/**
 * V3 #115 P2 groundwork — pure resume-from-checkpoint evaluation.
 *
 * After a daemon/server restart (or a human resume), a goal's last checkpoint
 * recorded which runs were active. This module reconciles those recorded active
 * runs against the runs' *current* DB facts to decide, per run, whether work
 * simply continues or a blocker must be surfaced (#128 §3 steps 2–6). It is pure
 * (no IO/time/randomness); the service feeds DB facts in and acts on the result.
 *
 * Kept independent of the goal/plan service layer: it depends only on the stable
 * RunStatus enum and the CheckpointRefs shape.
 */
import type { CheckpointRefs } from "./goal.js";
import { type RunStatus, RunStatusSchema } from "./state.js";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/** Blocker type a surfaced run maps to (a subset of the #114 BlockerType vocab). */
export type ResumeBlockerType = "failed_run" | "stale_runtime";

export type RunResumeOutcome =
  | "continue" // still non-terminal and progressing — resume as-is
  | "completed" // finished during the outage — nothing to do
  | "failed_blocker" // terminated failed/cancelled during the outage
  | "stale_blocker" // still non-terminal but no progress since the checkpoint
  | "missing_blocker"; // no run row found at all

export interface RunResumeFact {
  run_id: string;
  /** Current DB status, or null when no run row exists. */
  status: RunStatus | null;
  /** Whether the run row was updated at or after the checkpoint was taken. */
  updated_since_checkpoint: boolean;
}

/** Classify a single previously-active run against its current fact. */
export function reconcileRun(fact: RunResumeFact): RunResumeOutcome {
  if (fact.status === null) return "missing_blocker";
  if (fact.status === "completed") return "completed";
  if (fact.status === "failed" || fact.status === "cancelled") return "failed_blocker";
  // Non-terminal (queued/starting/running/awaiting_input/paused).
  return fact.updated_since_checkpoint ? "continue" : "stale_blocker";
}

export interface ResumeBlocker {
  run_id: string;
  type: ResumeBlockerType;
  /** Why the blocker was raised, for the blocker summary / audit. */
  reason: RunResumeOutcome;
}

export interface ResumeEvaluation {
  /** Runs to keep running (no action). */
  continue_runs: string[];
  /** Runs that finished during the outage (informational). */
  completed_runs: string[];
  /** Blockers to open before the goal can safely resume. */
  blockers: ResumeBlocker[];
  /** True when no blocker needs human/system attention — safe to resume. */
  safe_to_resume: boolean;
}

const BLOCKER_TYPE_BY_OUTCOME: Record<"failed_blocker" | "stale_blocker" | "missing_blocker", ResumeBlockerType> = {
  failed_blocker: "failed_run",
  stale_blocker: "stale_runtime",
  missing_blocker: "failed_run",
};

/**
 * Evaluate a resume against the checkpoint's recorded active runs. `facts` is the
 * current DB fact per run (missing entries are treated as a missing run row).
 * Deterministic and order-stable (follows the checkpoint's active_runs order).
 */
export function evaluateResume(
  checkpoint: Pick<CheckpointRefs, "active_runs">,
  facts: ReadonlyMap<string, RunResumeFact> | Record<string, RunResumeFact>,
): ResumeEvaluation {
  const lookup = (runId: string): RunResumeFact => {
    const f = facts instanceof Map ? facts.get(runId) : (facts as Record<string, RunResumeFact>)[runId];
    return f ?? { run_id: runId, status: null, updated_since_checkpoint: false };
  };

  const continue_runs: string[] = [];
  const completed_runs: string[] = [];
  const blockers: ResumeBlocker[] = [];

  for (const runId of checkpoint.active_runs) {
    const outcome = reconcileRun(lookup(runId));
    switch (outcome) {
      case "continue":
        continue_runs.push(runId);
        break;
      case "completed":
        completed_runs.push(runId);
        break;
      default:
        blockers.push({ run_id: runId, type: BLOCKER_TYPE_BY_OUTCOME[outcome], reason: outcome });
    }
  }

  return { continue_runs, completed_runs, blockers, safe_to_resume: blockers.length === 0 };
}

/** Narrowing helper for callers reading raw status strings from the DB. */
export function asRunStatus(value: string): RunStatus | null {
  const parsed = RunStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
