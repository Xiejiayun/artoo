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
  budgetStopAction,
  evaluateBudget,
} from "@artoo/domain";
import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { buildEvent } from "../events.js";
import { createCheckpointInTx } from "./checkpoint-service.js";

/**
 * Pause scheduling when elapsed/retry budgets are exceeded, while allowing
 * active executions to drain. Assignment also checks budgets transactionally;
 * concurrency is a scheduling capacity limit, not a reason to pause a goal.
 * Both terminal run events and the live monitor invoke this idempotent path.
 */

type Tx = DrizzleDb;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
const PAUSE_BUDGETS: ReadonlySet<BudgetViolation["budget"]> = new Set([
  "max_elapsed_ms",
  "max_retries",
]);

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
      await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update")
    )[0];
    // Idempotent / no-op: unknown, cross-org, or not currently running (already
    // paused/blocked/terminal) → nothing to enforce.
    if (goal === undefined || goal.status !== "running") return { enforced: false };

    const budgets: GoalBudgets = GoalBudgetsSchema.parse(goal.budgets ?? {});
    const stopConditions: StopConditions = StopConditionsSchema.parse(goal.stopConditions ?? { rules: [] });
    const usage = await computeUsageInTx(ctx, tx, goal);
    const violations = evaluateBudget(budgets, usage).filter((violation) =>
      PAUSE_BUDGETS.has(violation.budget),
    );
    // An elapsed limit is a deadline, so its exact boundary also stops starts.
    if (budgets.max_elapsed_ms !== null && usage.elapsed_ms === budgets.max_elapsed_ms) {
      violations.push({ budget: "max_elapsed_ms", limit: budgets.max_elapsed_ms, actual: usage.elapsed_ms });
    }
    const action = budgetStopAction(violations, stopConditions);
    // Unsupported rules are rejected at configuration and scheduling boundaries.
    // Older stored data may still contain them; never claim an unperformed stop.
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

/** One bounded, non-overlapping scan for all organizations. Shutdown drains it. */
export function startGoalBudgetMonitor(ctx: ServerContext, options: {
  intervalMs?: number;
  onError?: (error: unknown) => void;
} = {}): { stop: () => Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const scan = async (): Promise<void> => {
    const running = await ctx.db.db.select({ id: goals.id, organizationId: goals.organizationId }).from(goals).where(eq(goals.status, "running"));
    for (const goal of running) {
      if (stopped) break;
      try { await enforceGoalBudget({ ...ctx, organizationId: goal.organizationId }, goal.id); }
      catch (error) { options.onError?.(error); }
    }
  };
  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = scan().catch((error: unknown) => options.onError?.(error)).finally(() => { inFlight = undefined; });
  }, options.intervalMs ?? 1000);
  timer.unref();
  return { stop: async () => { stopped = true; clearInterval(timer); await inFlight; } };
}
