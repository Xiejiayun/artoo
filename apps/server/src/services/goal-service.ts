import { appendEvent, fileLeases, goals, projects, rooms, runs, tasks } from "@artoo/db";
import {
  type Goal,
  type GoalBudgets,
  type GoalStatus,
  type StopConditions,
  GoalBudgetsSchema,
  GoalSchema,
  ID_PREFIXES,
  StopConditionsSchema,
  applyGoalTransition,
  canTransitionGoal,
  canTransitionTask,
  type TaskStatus,
} from "@artoo/domain";
import { and, desc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { createCheckpointInTx } from "./checkpoint-service.js";
import { transitionTask } from "./transition-service.js";
import { propagateBlocked } from "./dag-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { unsettledGoalRunIds } from "./execution-state.js";

/**
 * V3 #115 P1c — goal lifecycle service. A goal sits above the task/run/DAG
 * machinery; creating one also auto-creates its discussion room (type `goal`,
 * the #114 surface). Human-override transitions (pause/resume/cancel) live here;
 * system-derived status (from child state) is applied by the plan/run hooks in
 * later slices. Every read/write is org-scoped.
 */

export function mapGoal(row: typeof goals.$inferSelect): Goal {
  return GoalSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    project_id: row.projectId,
    room_id: row.roomId,
    owner_user_id: row.ownerUserId,
    title: row.title,
    objective: row.objective,
    priority: row.priority,
    status: row.status,
    acceptance_criteria: (row.acceptanceCriteria as string[] | null) ?? [],
    stop_conditions: StopConditionsSchema.parse(row.stopConditions ?? { rules: [] }),
    budgets: GoalBudgetsSchema.parse(row.budgets ?? {}),
    current_plan_id: row.currentPlanId,
    running_since: row.runningSince,
    elapsed_cost_usd: row.elapsedCostUsd,
    retry_count: row.retryCount,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export interface CreateGoalInput {
  project_id: string;
  title: string;
  objective?: string;
  priority?: Goal["priority"];
  acceptance_criteria?: string[];
  stop_conditions?: Partial<StopConditions>;
  budgets?: Partial<GoalBudgets>;
}

/** Create a draft goal + its auto-created goal room. The goal↔room link is
 *  bidirectional, so the two rows are written then the goal back-linked inside
 *  one transaction (goal first with null room to satisfy the circular FK). */
export async function createGoal(ctx: ServerContext, input: CreateGoalInput): Promise<Goal> {
  const policy = supportedGoalPolicy(input.budgets, input.stop_conditions);
  // House pattern: verify the linked project is in the caller's org before insert.
  const project = (
    await ctx.db.db
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.project_id), eq(projects.organizationId, ctx.organizationId)))
  )[0];
  if (project === undefined) {
    throw AppError.notFound(`project not found: ${input.project_id}`, { project_id: input.project_id });
  }

  const now = ctx.clock.nowIso();
  const goalId = ctx.idGen.generate(ID_PREFIXES.goal);
  const roomId = ctx.idGen.generate(ID_PREFIXES.room);

  await ctx.db.transaction(async (tx) => {
    await tx.insert(goals).values({
      id: goalId,
      organizationId: ctx.organizationId,
      projectId: input.project_id,
      roomId: null,
      ownerUserId: ctx.actorUserId,
      title: input.title,
      objective: input.objective ?? "",
      priority: input.priority ?? "p2",
      status: "draft",
      acceptanceCriteria: input.acceptance_criteria ?? [],
      stopConditions: policy.stopConditions,
      budgets: policy.budgets,
      currentPlanId: null,
      runningSince: null,
      elapsedCostUsd: null,
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(rooms).values({
      id: roomId,
      organizationId: ctx.organizationId,
      projectId: input.project_id,
      taskId: null,
      goalId,
      type: "goal",
      name: `Goal: ${input.title}`.slice(0, 200),
      createdAt: now,
    });
    await tx.update(goals).set({ roomId, updatedAt: now }).where(eq(goals.id, goalId));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "goal.created",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: goalId,
        projectId: input.project_id,
        roomId,
        goalId,
        payload: { goal_id: goalId, room_id: roomId, title: input.title },
      }),
    );
  });

  return getGoal(ctx, goalId) as Promise<Goal>;
}

export async function getGoal(ctx: ServerContext, id: string): Promise<Goal | null> {
  const row = (
    await ctx.db.db
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId)))
  )[0];
  return row === undefined ? null : mapGoal(row);
}

export interface ListGoalsFilter {
  projectId?: string;
  status?: string;
}

export async function listGoals(ctx: ServerContext, filter: ListGoalsFilter = {}): Promise<Goal[]> {
  const conds = [eq(goals.organizationId, ctx.organizationId)];
  if (filter.projectId !== undefined && filter.projectId !== "") {
    conds.push(eq(goals.projectId, filter.projectId));
  }
  if (filter.status !== undefined && filter.status !== "") {
    conds.push(eq(goals.status, filter.status));
  }
  const rows = await ctx.db.db
    .select()
    .from(goals)
    .where(and(...conds))
    .orderBy(desc(goals.createdAt));
  return rows.map(mapGoal);
}

/** Map a goal trigger to its lifecycle event type (defaults to goal.status_changed). */
function eventTypeForTrigger(trigger: string, to: GoalStatus): string {
  if (trigger === "pause") return "goal.paused";
  if (trigger === "resume") return "goal.resumed";
  if (trigger === "cancel") return "goal.cancelled";
  if (to === "completed") return "goal.completed";
  return "goal.status_changed";
}

/**
 * Apply a goal status transition (validated against the state machine) and emit
 * the lifecycle event. `running_since` is stamped on first entry to `running`.
 * Returns null if the goal does not exist; throws on an illegal transition.
 */
export async function transitionGoal(
  ctx: ServerContext,
  id: string,
  trigger: Parameters<typeof applyGoalTransition>[1],
): Promise<Goal | null> {
  const now = ctx.clock.nowIso();
  await ctx.db.transaction(async (tx) => {
    const row = (await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
    if (!row) return;
    const existing = mapGoal(row);
    if (!canTransitionGoal(existing.status, trigger)) {
      throw AppError.invalidState(`cannot '${trigger}' a goal in status '${existing.status}'`, { status: existing.status, trigger });
    }
    const to = applyGoalTransition(existing.status, trigger);
    await tx
      .update(goals)
      .set({
        status: to,
        runningSince: to === "running" && existing.running_since == null ? now : existing.running_since,
        updatedAt: now,
      })
      .where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId)));
    const transitionEvent = buildEvent(ctx, {
      type: eventTypeForTrigger(trigger, to),
      actorType: "user",
      actorId: ctx.actorUserId,
      correlationId: id,
      projectId: existing.project_id,
      roomId: existing.room_id,
      goalId: id,
      payload: { goal_id: id, from: existing.status, to, trigger },
    });
    await appendEvent(tx, transitionEvent);
    // P2-S1: a pause/resume override is a safe boundary — write a checkpoint in
    // the same tx, linked to the transition event (so the marker is associated
    // with goal.paused / goal.resumed). Reflects the post-transition goal row.
    if (trigger === "pause" || trigger === "resume") {
      const goalRow = (
        await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId)))
      )[0]!;
      await createCheckpointInTx(ctx, tx, goalRow, trigger === "pause" ? "paused" : "resumed", {
        triggerEventId: transitionEvent.id,
        summary: trigger === "pause" ? "Goal paused" : "Goal resumed",
      });
    }
  });
  return getGoal(ctx, id);
}

export const pauseGoal = (ctx: ServerContext, id: string): Promise<Goal | null> => transitionGoal(ctx, id, "pause");
const cancellations = new WeakMap<object, Map<string, Promise<Goal | null>>>();
export const resumeGoal = (ctx: ServerContext, id: string): Promise<Goal | null> => {
  if (cancellations.get(ctx.db)?.has(id)) throw AppError.conflict("goal cancellation is waiting for execution nodes to stop");
  return transitionGoal(ctx, id, "resume");
};

/** Pause scheduling, confirm all external writers stopped, then cancel children. */
export async function cancelGoal(ctx: ServerContext, id: string, stopRun?: (runId: string) => Promise<void>): Promise<Goal | null> {
  let pending = cancellations.get(ctx.db);
  if (!pending) { pending = new Map(); cancellations.set(ctx.db, pending); }
  const existing = pending.get(id);
  if (existing) return existing;
  const work = cancelGoalExecution(ctx, id, stopRun);
  pending.set(id, work);
  try { return await work; } finally { pending.delete(id); }
}

async function cancelGoalExecution(ctx: ServerContext, id: string, stopRun?: (runId: string) => Promise<void>): Promise<Goal | null> {
  const now = ctx.clock.nowIso();
  const fenced = await ctx.db.transaction(async (tx) => {
    const row = (await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
    if (!row || row.status === "cancelled") return row;
    if (!canTransitionGoal(row.status as GoalStatus, "cancel")) throw AppError.invalidState(`cannot cancel goal in status '${row.status}'`);
    if (row.status !== "paused") {
      await tx.update(goals).set({ status: "paused", updatedAt: now }).where(eq(goals.id, id));
      await appendEvent(tx, buildEvent(ctx, {
        type: "goal.paused", actorType: "user", actorId: ctx.actorUserId, correlationId: id,
        projectId: row.projectId, roomId: row.roomId, goalId: id,
        payload: { goal_id: id, from: row.status, to: "paused", reason: "cancellation_requested" },
      }));
    }
    return row;
  });
  if (!fenced || fenced.status === "cancelled") return fenced ? mapGoal(fenced) : null;
  const childRuns = await ctx.db.db.select({ id: runs.id, status: runs.status }).from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.goalId, id), eq(runs.organizationId, ctx.organizationId)));
  const leases = await ctx.db.db.select({ runId: fileLeases.runId }).from(fileLeases)
    .innerJoin(tasks, eq(tasks.id, fileLeases.taskId))
    .where(and(eq(tasks.goalId, id), eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.status, "held")));
  const uncertain = new Set([...leases.map((lease) => lease.runId), ...await unsettledGoalRunIds(ctx, ctx.db.db, id)]);
  for (const run of childRuns) {
    if (["completed", "failed", "cancelled"].includes(run.status) && !uncertain.has(run.id)) continue;
    if (!stopRun) throw AppError.conflict("goal paused: an execution node must confirm its runs have stopped");
    await stopRun(run.id);
  }
  await ctx.db.transaction(async (tx) => {
    const row = (await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
    if (!row || row.status !== "paused") throw AppError.conflict("goal changed during cancellation; retry cancellation");
    const currentRuns = await tx.select({ status: runs.status }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(and(eq(tasks.goalId, id), eq(runs.organizationId, ctx.organizationId)));
    const held = await tx.select({ id: fileLeases.id }).from(fileLeases).innerJoin(tasks, eq(tasks.id, fileLeases.taskId))
      .where(and(eq(tasks.goalId, id), eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.status, "held")));
    if (currentRuns.some((run) => !["completed", "failed", "cancelled"].includes(run.status)) || held.length > 0 || (await unsettledGoalRunIds(ctx, tx, id)).length > 0) {
      throw AppError.conflict("goal paused: process stop is still unconfirmed");
    }
    const children = await tx.select().from(tasks).where(and(eq(tasks.goalId, id), eq(tasks.organizationId, ctx.organizationId)));
    for (const task of children) {
      if (!canTransitionTask(task.status as TaskStatus, "cancel")) continue;
      await transitionTask(tx, ctx, { taskId: task.id, from: task.status as TaskStatus, trigger: "cancel", now,
        events: (to) => [buildEvent(ctx, { type: "task.updated", actorType: "user", actorId: ctx.actorUserId,
          correlationId: task.id, projectId: task.projectId, taskId: task.id, roomId: task.roomId, goalId: id,
          payload: { status: to, reason: "goal_cancelled" },
        })],
      });
      await propagateBlocked(ctx, tx, task.id, "goal_cancelled");
    }
    await tx.update(goals).set({ status: "cancelled", updatedAt: now }).where(eq(goals.id, id));
    await appendEvent(tx, buildEvent(ctx, { type: "goal.cancelled", actorType: "user", actorId: ctx.actorUserId,
      correlationId: id, projectId: row.projectId, roomId: row.roomId, goalId: id,
      payload: { goal_id: id, from: "paused", to: "cancelled", trigger: "cancel", process_exit_confirmed: true },
    }));
  });
  return getGoal(ctx, id);
}
