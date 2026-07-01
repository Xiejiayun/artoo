import { blockers, eventLog, runs } from "@artoo/db";
import {
  type Checkpoint,
  type ResumeEvaluation,
  type RunResumeFact,
  asRunStatus,
  canTransitionGoal,
  evaluateResume,
  isTerminalGoalStatus,
} from "@artoo/domain";
import { and, eq, gt, inArray } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { listCheckpoints } from "./checkpoint-service.js";
import { createBlocker } from "./collaboration-service.js";
import { getGoal, transitionGoal } from "./goal-service.js";

/**
 * V3 #115 P2-S2 — resume-from-checkpoint reconciliation.
 *
 * Given a goal's latest checkpoint, reconcile the runs it recorded as active
 * against their current DB facts (#128 §3): runs still progressing continue,
 * runs that finished are noted, and runs that failed or went stale become
 * blockers; the goal is then re-derived to `blocked` while active blockers
 * exist. Pure evaluation is `evaluateResume` (domain); this service supplies the
 * DB facts and applies the effects idempotently.
 *
 * S2 scope: reconciliation + blocker + goal-state derivation only. The
 * run.resume protocol, grace window and daemon handler are the separate S3 gate.
 */

const ACTIVE_BLOCKER_STATUSES = ["open", "mitigated"] as const;

export type ResumeReconcileReason = "goal_terminal" | "no_checkpoint" | "reconciled";

export interface ResumeReconcileResult {
  reconciled: boolean;
  reason: ResumeReconcileReason;
  goal_status: string;
  checkpoint_id: string | null;
  evaluation: ResumeEvaluation | null;
  opened_blocker_ids: string[];
}

/**
 * Reconcile a goal against its latest checkpoint. Org/goal-scoped. No-op (with a
 * reason) when the goal is terminal or has no checkpoint. Idempotent: a run that
 * already has an active run-sourced blocker is not blocked again, and the goal is
 * only transitioned running→blocked once.
 */
export async function reconcileGoalFromCheckpoint(
  ctx: ServerContext,
  goalId: string,
): Promise<ResumeReconcileResult> {
  const goal = await getGoal(ctx, goalId); // org-scoped; null → cross-org/unknown
  if (goal === null) {
    throw AppError.notFound(`goal not found: ${goalId}`, { goal_id: goalId });
  }
  if (isTerminalGoalStatus(goal.status)) {
    return { reconciled: false, reason: "goal_terminal", goal_status: goal.status, checkpoint_id: null, evaluation: null, opened_blocker_ids: [] };
  }
  if (goal.room_id === null) {
    // A goal always has an auto-created room; guard defensively.
    throw AppError.invalidState(`goal ${goalId} has no room to attach blockers to`, { goal_id: goalId });
  }

  const checkpoints = await listCheckpoints(ctx, goalId); // latest first, org+goal scoped
  const latest: Checkpoint | undefined = checkpoints[0];
  if (latest === undefined) {
    return { reconciled: false, reason: "no_checkpoint", goal_status: goal.status, checkpoint_id: null, evaluation: null, opened_blocker_ids: [] };
  }

  // Build the current fact for each run the checkpoint recorded as active.
  const facts = new Map<string, RunResumeFact>();
  for (const runId of latest.state_refs.active_runs) {
    const runRow = (
      await ctx.db.db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
    )[0];
    const status = runRow === undefined ? null : asRunStatus(runRow.status);
    // "Updated since checkpoint" iff the run has an event past the checkpoint's
    // cursor. Explainable: no progress event after the cursor ⇒ stale.
    const newer = (
      await ctx.db.db
        .select({ id: eventLog.id })
        .from(eventLog)
        .where(
          and(
            eq(eventLog.organizationId, ctx.organizationId),
            eq(eventLog.runId, runId),
            gt(eventLog.position, latest.state_refs.event_cursor),
          ),
        )
        .limit(1)
    )[0];
    facts.set(runId, { run_id: runId, status, updated_since_checkpoint: newer !== undefined });
  }

  const evaluation = evaluateResume(latest.state_refs, facts);

  // Open a blocker per failed/stale/missing run — idempotently, source-traceable.
  const opened_blocker_ids: string[] = [];
  for (const b of evaluation.blockers) {
    const existing = (
      await ctx.db.db
        .select({ id: blockers.id })
        .from(blockers)
        .where(
          and(
            eq(blockers.organizationId, ctx.organizationId),
            eq(blockers.goalId, goalId),
            eq(blockers.sourceKind, "run"),
            eq(blockers.sourceId, b.run_id),
            inArray(blockers.status, [...ACTIVE_BLOCKER_STATUSES]),
          ),
        )
        .limit(1)
    )[0];
    if (existing !== undefined) continue; // already blocked on this run → no duplicate
    const created = await createBlocker(ctx, {
      room_id: goal.room_id,
      goal_id: goalId,
      // Not linked via the FK run_id: a "missing" run has no row to reference.
      // Traceability is carried by source_kind/source_id (plain refs, no FK).
      type: b.type,
      owner_type: "system",
      owner_id: "resume_reconciler",
      source_kind: "run",
      source_id: b.run_id,
      summary: `resume reconciliation: run ${b.run_id} is ${b.reason.replace("_blocker", "")}`,
    });
    opened_blocker_ids.push(created.id);
  }

  // Re-derive goal state: while any active blocker exists, a running goal moves to
  // blocked. Guarded so an already-blocked goal is not transitioned again.
  const activeBlockers = await ctx.db.db
    .select({ id: blockers.id })
    .from(blockers)
    .where(
      and(
        eq(blockers.organizationId, ctx.organizationId),
        eq(blockers.goalId, goalId),
        inArray(blockers.status, [...ACTIVE_BLOCKER_STATUSES]),
      ),
    );
  let goalStatus: string = goal.status;
  if (activeBlockers.length > 0 && goal.status === "running" && canTransitionGoal("running", "blocked_detected")) {
    await transitionGoal(ctx, goalId, "blocked_detected");
    goalStatus = "blocked";
  }

  return {
    reconciled: true,
    reason: "reconciled",
    goal_status: goalStatus,
    checkpoint_id: latest.id,
    evaluation,
    opened_blocker_ids,
  };
}
