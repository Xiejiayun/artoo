import { appendEvent, goals, runs, tasks } from "@artoo/db";
import {
  type BudgetAction,
  type BudgetUsage,
  type BudgetViolation,
  type GoalBudgets,
  type StopConditions,
  GoalBudgetsSchema,
  StopConditionsSchema,
  applyGoalTransition,
  evaluateBudgetAction,
} from "@artoo/domain";
import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { buildEvent } from "../events.js";
import { createCheckpointInTx } from "./checkpoint-service.js";

/**
 * V3 #115 P3a — goal budget enforcement (pause path only).
 *
 * `enforceGoalBudget` runs in a single transaction that re-reads the goal, so an
 * already paused/terminal goal is a no-op; it evaluates the goal's budget against
 * current usage and, only when the running→paused compare-and-set actually
 * changes the row, writes the S1 paused checkpoint plus goal.paused and
 * goal.budget_exceeded — never a duplicate event/checkpoint on a repeat call.
 *
 * SCOPE: only the v3.0 must-have `pause` action is enforced (elapsed/retry).
 * The pure core also recognizes cancel/notify, but this service does NOT action
 * them (no state/event claim without full coverage). The enforcement is
 * event-driven (hooked after a terminal run-event commits) with no background
 * timer, so `max_elapsed_ms` is checked opportunistically; a precise elapsed
 * timer and cost/concurrent enforcement are later/release work.
 */

type Tx = DrizzleDb;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

export interface EnforceBudgetResult {
  enforced: boolean;
  action?: BudgetAction;
  violations?: BudgetViolation[];
}

async function computeUsageInTx(ctx: ServerContext, tx: Tx, goal: typeof goals.$inferSelect): Promise<BudgetUsage> {
  const elapsed_ms =
    goal.runningSince == null ? null : Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince));

  const taskRows = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id)));
  const taskIds = taskRows.map((t) => t.id);
  const concurrent_runs =
    taskIds.length === 0
      ? 0
      : (
          await tx
            .select({ id: runs.id })
            .from(runs)
            .where(
              and(
                eq(runs.organizationId, ctx.organizationId),
                inArray(runs.taskId, taskIds),
                notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
              ),
            )
        ).length;

  return { elapsed_ms, retry_count: goal.retryCount, cost_usd: goal.elapsedCostUsd, concurrent_runs };
}

export async function enforceGoalBudget(ctx: ServerContext, goalId: string): Promise<EnforceBudgetResult> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const goal = (
      await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)))
    )[0];
    // Idempotent / no-op: unknown, cross-org, or not currently running (already
    // paused/blocked/terminal) → nothing to enforce.
    if (goal === undefined || goal.status !== "running") return { enforced: false };

    const budgets: GoalBudgets = GoalBudgetsSchema.parse(goal.budgets ?? {});
    const stopConditions: StopConditions = StopConditionsSchema.parse(goal.stopConditions ?? { rules: [] });
    const usage = await computeUsageInTx(ctx, tx, goal);
    const { violations, action } = evaluateBudgetAction(budgets, usage, stopConditions);
    // P3a only actions `pause`.
    if (action !== "pause" || violations.length === 0) return { enforced: false };

    // Pause via compare-and-set; only emit if the row actually changed.
    const to = applyGoalTransition("running", "pause"); // "paused"
    const changed = await tx
      .update(goals)
      .set({ status: to, updatedAt: now })
      .where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId), eq(goals.status, "running")))
      .returning({ id: goals.id });
    if (changed.length === 0) return { enforced: false }; // lost the race → no duplicate event

    // Reuse the S1 pause behaviour in the same tx: goal.paused event + paused
    // checkpoint (linked to it), then the budget-specific event.
    const pausedEvent = buildEvent(ctx, {
      type: "goal.paused",
      actorType: "system",
      actorId: "budget_enforcer",
      correlationId: goalId,
      projectId: goal.projectId,
      roomId: goal.roomId,
      goalId,
      payload: { goal_id: goalId, from: "running", to, trigger: "pause", reason: "budget_exceeded" },
    });
    await appendEvent(tx, pausedEvent);
    await createCheckpointInTx(ctx, tx, { ...goal, status: to }, "paused", {
      triggerEventId: pausedEvent.id,
      summary: "Paused: budget exceeded",
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "goal.budget_exceeded",
        actorType: "system",
        actorId: "budget_enforcer",
        correlationId: goalId,
        projectId: goal.projectId,
        roomId: goal.roomId,
        goalId,
        payload: { goal_id: goalId, action: "pause", violations },
      }),
    );
    return { enforced: true, action: "pause", violations };
  });
}
