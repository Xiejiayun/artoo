import { appendEvent, goals, plans, rooms, runs, taskDependencies, tasks } from "@artoo/db";
import {
  type DagEdge,
  type GoalStatus,
  type Plan,
  type PlanStatus,
  type TaskSpec,
  type TaskStatus,
  applyGoalTransition,
  applyPlanTransition,
  canProposePlan,
  canTransitionTask,
  ID_PREFIXES,
  PlanSchema,
  TaskSpecSchema,
  wouldCreateCycle,
} from "@artoo/domain";
import { and, desc, eq } from "drizzle-orm";

import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { createCheckpointInTx, hasMaterializeCheckpoint } from "./checkpoint-service.js";
import { unsettledGoalRunIds } from "./execution-state.js";
import { transitionTask } from "./transition-service.js";
import { propagateBlocked } from "./dag-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";

/**
 * V3 #115 P1d — plan versioning + plan→DAG materialization.
 *
 * Materialization is the gate piece (SkywalkerCodex 6 conditions): accept +
 * materialize run in a SINGLE transaction (a cycle/failure rolls back the accept
 * too), it is idempotent (re-entrant on `plans.materialized_at`), backed by a DB
 * UNIQUE(source_plan_id, source_plan_spec_ref) so a retry cannot duplicate the
 * DAG; only an accepted+current plan materializes; dependency edges map by stable
 * spec index and fail closed (rollback) on unknown/self/cyclic refs — also
 * validated at propose time so an invalid plan never persists; every query is
 * org-scoped; the goal.plan_materialized event records goal_id + plan_id +
 * created task ids.
 *
 * First acceptance starts the goal. Replacements require a paused goal with
 * confirmed process exit, preserve historical work, and retain the pause fence.
 */

type Tx = DrizzleDb;

export function mapPlan(row: typeof plans.$inferSelect): Plan {
  return PlanSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    goal_id: row.goalId,
    version: row.version,
    author_type: row.authorType,
    author_id: row.authorId,
    rationale: row.rationale,
    status: row.status,
    task_specs: row.taskSpecs ?? [],
    materialized_at: row.materializedAt,
    materialization_event_id: row.materializationEventId,
    created_at: row.createdAt,
    accepted_at: row.acceptedAt,
  });
}

async function requireGoalInOrg(ctx: ServerContext, tx: Tx, goalId: string): Promise<typeof goals.$inferSelect> {
  const goal = (
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update")
  )[0];
  if (goal === undefined) {
    throw AppError.notFound(`goal not found: ${goalId}`, { goal_id: goalId });
  }
  return goal;
}

/**
 * Validate the spec dependency graph and produce edge id-pairs. `idForIndex`
 * maps a spec index to the id used for cycle detection (the spec index string at
 * propose time, the real task id at materialize time). Fails closed on
 * self/unknown/out-of-range refs and cycles.
 */
function buildEdges(specs: TaskSpec[], idForIndex: (i: number) => string): { fromId: string; toId: string; type: string }[] {
  const edges: DagEdge[] = [];
  const out: { fromId: string; toId: string; type: string }[] = [];
  for (let i = 0; i < specs.length; i += 1) {
    for (const dep of specs[i]!.dependencies) {
      const refIdx = Number(dep.ref);
      if (!Number.isInteger(refIdx) || refIdx < 0 || refIdx >= specs.length) {
        throw AppError.validation(`task spec ${i} has an unknown dependency ref '${dep.ref}'`, {
          spec_index: i,
          ref: dep.ref,
        });
      }
      if (refIdx === i) {
        throw AppError.validation(`task spec ${i} cannot depend on itself`, { spec_index: i });
      }
      const fromId = idForIndex(refIdx);
      const toId = idForIndex(i);
      if (wouldCreateCycle(edges, fromId, toId)) {
        throw AppError.conflict("plan dependencies would create a cycle", { spec_index: i, ref: dep.ref });
      }
      edges.push({ from_task_id: fromId, to_task_id: toId, type: dep.type });
      out.push({ fromId, toId, type: dep.type });
    }
  }
  return out;
}

export interface ProposePlanSpecInput {
  title: string;
  description?: string;
  acceptance_criteria: string[];
  required_capabilities?: string[];
  dependencies?: { ref: string; type: string }[];
  approval_gates?: string[];
  write_scopes?: string[];
  expected_artifacts?: { type: string; description?: string }[];
}

export interface ProposePlanInput {
  rationale?: string;
  task_specs: ProposePlanSpecInput[];
  author_type?: Plan["author_type"];
  author_id?: string;
}

/** The same content rules apply to a rendered suggestion and a saved proposal. */
export function validatePlanTaskSpecs(input: ProposePlanSpecInput[]): TaskSpec[] {
  const specs = input.map((spec) => TaskSpecSchema.parse(spec));
  specs.forEach(assertSupportedPlanTaskControls);
  if (specs.length === 0) throw AppError.validation("a plan must contain at least one task spec");
  buildEdges(specs, (index) => String(index));
  return specs;
}

/** Propose a new plan version for a goal. Version is monotonic per goal; the
 *  mutation rule (re-plan only after pause/block) is enforced via canProposePlan;
 *  the dependency graph is validated here so an invalid plan never persists. */
export async function proposePlan(ctx: ServerContext, goalId: string, input: ProposePlanInput): Promise<Plan> {
  return ctx.db.transaction((tx) => proposePlanInTx(ctx, tx, goalId, input));
}

/** Allows an orchestrator to link its proposal atomically; acceptance remains a separate human action. */
export async function proposePlanInTx(ctx: ServerContext, tx: Tx, goalId: string, input: ProposePlanInput): Promise<Plan> {
  const specs = validatePlanTaskSpecs(input.task_specs);
  const now = ctx.clock.nowIso();
  const planId = ctx.idGen.generate(ID_PREFIXES.plan);
    const goal = await requireGoalInOrg(ctx, tx, goalId);
    const existing = await tx
      .select({ version: plans.version, status: plans.status })
      .from(plans)
      .where(and(eq(plans.organizationId, ctx.organizationId), eq(plans.goalId, goalId)));
    const hasAccepted = existing.some((p) => p.status === "accepted");
    if (!canProposePlan(goal.status as GoalStatus, hasAccepted)) {
      throw AppError.invalidState(
        `cannot propose a plan while goal is '${goal.status}'` +
          (hasAccepted ? " (re-plan requires pause/block first)" : ""),
        { goal_status: goal.status, has_accepted_plan: hasAccepted },
      );
    }
    const nextVersion = existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
    await tx.insert(plans).values({
      id: planId,
      organizationId: ctx.organizationId,
      goalId,
      version: nextVersion,
      authorType: input.author_type ?? "user",
      authorId: input.author_id ?? ctx.actorUserId,
      rationale: input.rationale ?? "",
      status: "proposed",
      taskSpecs: specs,
      materializedAt: null,
      materializationEventId: null,
      createdAt: now,
      acceptedAt: null,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "goal.plan_proposed",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: goalId,
        projectId: goal.projectId,
        roomId: goal.roomId,
        goalId,
        payload: { goal_id: goalId, plan_id: planId, version: nextVersion },
      }),
    );
    const row = (await tx.select().from(plans).where(eq(plans.id, planId)))[0]!;
    return mapPlan(row);
}

export async function getPlan(ctx: ServerContext, id: string): Promise<Plan | null> {
  const row = (
    await ctx.db.db.select().from(plans).where(and(eq(plans.id, id), eq(plans.organizationId, ctx.organizationId)))
  )[0];
  return row === undefined ? null : mapPlan(row);
}

export async function listPlans(ctx: ServerContext, goalId: string): Promise<Plan[]> {
  return ctx.db.transaction(async (tx) => {
    await requireGoalInOrg(ctx, tx, goalId);
    const rows = await tx
      .select()
      .from(plans)
      .where(and(eq(plans.organizationId, ctx.organizationId), eq(plans.goalId, goalId)))
      .orderBy(desc(plans.version));
    return rows.map(mapPlan);
  });
}

export async function rejectPlan(ctx: ServerContext, planId: string): Promise<Plan | null> {
  return ctx.db.transaction(async (tx) => {
    const lookup = (await tx.select({ goalId: plans.goalId }).from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId))))[0];
    if (!lookup) return null;
    const goal = await requireGoalInOrg(ctx, tx, lookup.goalId);
    const row = (
      await tx.select().from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) return null;
    if (row.status !== "proposed") {
      throw AppError.invalidState(`cannot reject a plan in status '${row.status}'`, { status: row.status });
    }
    applyPlanTransition(row.status as PlanStatus, "reject");
    await tx.update(plans).set({ status: "rejected" }).where(eq(plans.id, planId));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "goal.plan_rejected",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: row.goalId,
        projectId: goal.projectId,
        roomId: goal.roomId,
        goalId: row.goalId,
        payload: { goal_id: row.goalId, plan_id: planId },
      }),
    );
    const updated = (await tx.select().from(plans).where(eq(plans.id, planId)))[0]!;
    return mapPlan(updated);
  });
}

export interface MaterializeResult {
  plan: Plan;
  task_ids: string[];
}

/** The materialize body, run inside a caller-provided transaction so accept +
 *  materialize are atomic. Re-entrant on materialized_at. */
async function materializeInTx(ctx: ServerContext, tx: Tx, planId: string, now: string): Promise<MaterializeResult> {
  const lookup = (await tx.select({ goalId: plans.goalId }).from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId))))[0];
  if (!lookup) throw AppError.notFound(`plan not found: ${planId}`, { plan_id: planId });
  const goal = await requireGoalInOrg(ctx, tx, lookup.goalId);
  const plan = (
    await tx.select().from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId)))
  )[0];
  if (plan === undefined) {
    throw AppError.notFound(`plan not found: ${planId}`, { plan_id: planId });
  }
  if (plan.status !== "accepted") {
    throw AppError.invalidState(`only an accepted plan can materialize (is '${plan.status}')`, { status: plan.status });
  }
  if (goal.currentPlanId !== planId) {
    throw AppError.invalidState("plan is not the goal's current plan", { plan_id: planId });
  }
  const specs = (plan.taskSpecs as TaskSpec[]).map((s) => TaskSpecSchema.parse(s));
  specs.forEach(assertSupportedPlanTaskControls);
  // (1) Idempotent / re-entrant: already materialized → return existing tasks.
  if (plan.materializedAt != null) {
    const existing = await tx
      .select({ id: tasks.id, ref: tasks.sourcePlanSpecRef })
      .from(tasks)
      .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.sourcePlanId, planId)));
    const ordered = [...existing].sort((a, b) => Number(a.ref) - Number(b.ref)).map((t) => t.id);
    return { plan: mapPlan(plan), task_ids: ordered };
  }
  if (goal.status !== "planned" && goal.status !== "paused") {
    throw AppError.invalidState(`goal must be planned or paused to materialize (is '${goal.status}')`, {
      goal_status: goal.status,
    });
  }

  const taskIds = specs.map(() => ctx.idGen.generate(ID_PREFIXES.task));
  // (4) Build + validate edges by stable spec index; fail closed (rollback).
  const edgeRows = buildEdges(specs, (i) => taskIds[i]!);

  // (5)/(6) Create tasks (org from the goal — never cross-org) with full
  // provenance; the UNIQUE(source_plan_id, source_plan_spec_ref) backstops dups.
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i]!;
    const roomId = ctx.idGen.generate(ID_PREFIXES.room);
    await tx.insert(tasks).values({
      id: taskIds[i]!,
      organizationId: goal.organizationId,
      projectId: goal.projectId,
      roomId,
      goalId: goal.id,
      sourcePlanId: planId,
      sourcePlanSpecRef: String(i),
      title: spec.title,
      description: spec.description,
      status: "backlog",
      priority: goal.priority,
      requiredCapabilities: spec.required_capabilities,
      acceptanceCriteria: spec.acceptance_criteria,
      createdByType: "system",
      createdById: "plan_materializer",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(rooms).values({ id: roomId, organizationId: goal.organizationId, projectId: goal.projectId,
      taskId: taskIds[i]!, goalId: goal.id, type: "task", name: spec.title.slice(0, 200), createdAt: now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "task.created",
        actorType: "system",
        actorId: "plan_materializer",
        correlationId: goal.id,
        projectId: goal.projectId,
        taskId: taskIds[i]!,
        roomId,
        goalId: goal.id,
        payload: { title: spec.title, source_plan_id: planId, source_plan_spec_ref: String(i) },
      }),
    );
    await appendEvent(tx, buildEvent(ctx, { type: "room.created", actorType: "system", actorId: "plan_materializer",
      correlationId: goal.id, projectId: goal.projectId, taskId: taskIds[i]!, roomId, goalId: goal.id,
    }));
  }
  for (const e of edgeRows) {
    await tx.insert(taskDependencies).values({
      id: ctx.idGen.generate(ID_PREFIXES.dependency),
      organizationId: goal.organizationId,
      fromTaskId: e.fromId,
      toTaskId: e.toId,
      type: e.type,
      createdAt: now,
    });
  }

  // Replacing a plan keeps the explicit pause until a human resumes the goal.
  const goalStatus = goal.status === "paused" ? "paused" : applyGoalTransition("planned", "dag_materialized");
  await tx
    .update(goals)
    .set({
      status: goalStatus,
      runningSince: goal.runningSince ?? now,
      updatedAt: now,
    })
    .where(eq(goals.id, goal.id));

  // (2)/(6) Stamp the plan's materialization anchors; the event id is the durable
  // provenance link, so build the event before persisting its id.
  const matEvent = buildEvent(ctx, {
    type: "goal.plan_materialized",
    actorType: "system",
    actorId: "plan_materializer",
    correlationId: goal.id,
    projectId: goal.projectId,
    roomId: goal.roomId,
    goalId: goal.id,
    payload: { goal_id: goal.id, plan_id: planId, task_ids: taskIds },
  });
  await tx.update(plans).set({ materializedAt: now, materializationEventId: matEvent.id }).where(eq(plans.id, planId));
  await appendEvent(tx, matEvent);

  // P2-S1: a dag_materialized checkpoint, atomic with the transition and linked
  // to the materialization event. Guarded so a materialize retry (which is
  // already short-circuited by materialized_at) can never create a duplicate.
  if (!(await hasMaterializeCheckpoint(ctx, tx, planId))) {
    await createCheckpointInTx(
      ctx,
      tx,
      { ...goal, status: goalStatus },
      "dag_materialized",
      { planId, triggerEventId: matEvent.id, summary: `Materialized plan into ${taskIds.length} task(s)` },
    );
  }

  const updated = (await tx.select().from(plans).where(eq(plans.id, planId)))[0]!;
  return { plan: mapPlan(updated), task_ids: taskIds };
}

/**
 * Accept a proposed plan AND materialize it into a task DAG in ONE transaction:
 * accept (proposed→accepted, supersede prior accepted, set goal current plan,
 * goal draft→planned) then materialize (goal planned→running, build DAG). A
 * materialize failure rolls back the whole change. A paused goal may replace
 * its plan after all processes have stopped; prior execution history is retained.
 * Re-running an already-accepted+materialized plan is idempotent.
 */
export async function acceptPlan(ctx: ServerContext, planId: string): Promise<MaterializeResult> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const lookup = (await tx.select({ goalId: plans.goalId }).from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId))))[0];
    if (!lookup) throw AppError.notFound(`plan not found: ${planId}`, { plan_id: planId });
    const goal = await requireGoalInOrg(ctx, tx, lookup.goalId);
    const plan = (
      await tx.select().from(plans).where(and(eq(plans.id, planId), eq(plans.organizationId, ctx.organizationId)))
    )[0];
    if (plan === undefined) {
      throw AppError.notFound(`plan not found: ${planId}`, { plan_id: planId });
    }
    if (plan.status === "accepted") {
      return materializeInTx(ctx, tx, planId, now); // re-entrant
    }
    if (plan.status !== "proposed") {
      throw AppError.invalidState(`cannot accept a plan in status '${plan.status}'`, { status: plan.status });
    }
    const replacement = goal.currentPlanId !== null;
    if ((!replacement && goal.status !== "draft") || (replacement && goal.status !== "paused")) {
      throw AppError.invalidState(
        replacement ? "Pause the goal before accepting a replacement plan" : `A first plan requires a draft goal (is '${goal.status}')`,
        { goal_status: goal.status },
      );
    }
    supportedGoalPolicy(goal.budgets, goal.stopConditions);
    const retiredTaskIds: string[] = [];
    if (replacement) {
      const current = (await tx.select({ version: plans.version }).from(plans).where(and(eq(plans.id, goal.currentPlanId!), eq(plans.organizationId, ctx.organizationId))))[0];
      if (!current || plan.version <= current.version) throw AppError.conflict("A replacement plan must be newer than the current accepted plan");
      const unsettled = await unsettledGoalRunIds(ctx, tx, goal.id);
      if (unsettled.length > 0) throw AppError.conflict("Cannot replace a plan until all goal executions have confirmed they stopped", { run_ids: unsettled });
      const previous = await tx.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, goal.currentPlanId!)));
      const executed = await tx.select({ taskId: runs.taskId }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId)).where(and(eq(runs.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id)));
      const historical = new Set(executed.map((run) => run.taskId));
      for (const task of previous) {
        if (historical.has(task.id) || !canTransitionTask(task.status as TaskStatus, "cancel")) continue;
        await transitionTask(tx, ctx, { taskId: task.id, from: task.status as TaskStatus, trigger: "cancel", now,
          events: (to) => [buildEvent(ctx, { type: "task.updated", actorType: "user", actorId: ctx.actorUserId,
            correlationId: goal.id, projectId: goal.projectId, taskId: task.id, roomId: task.roomId, goalId: goal.id,
            payload: { status: to, reason: "plan_superseded", source_plan_id: task.sourcePlanId, replacement_plan_id: planId },
          })],
        });
        retiredTaskIds.push(task.id);
      }
      for (const taskId of retiredTaskIds) await propagateBlocked(ctx, tx, taskId, "plan_superseded");
    }
    applyPlanTransition("proposed", "accept");
    // Supersede any prior accepted plan (invariant: at most one accepted).
    await tx
      .update(plans)
      .set({ status: "superseded" })
      .where(and(eq(plans.organizationId, ctx.organizationId), eq(plans.goalId, plan.goalId), eq(plans.status, "accepted")));
    await tx.update(plans).set({ status: "accepted", acceptedAt: now }).where(eq(plans.id, planId));
    await tx
      .update(goals)
      .set({ status: replacement ? "paused" : applyGoalTransition("draft", "plan_accepted"), currentPlanId: planId, updatedAt: now })
      .where(eq(goals.id, plan.goalId));
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "goal.plan_accepted",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: plan.goalId,
        projectId: goal.projectId,
        roomId: goal.roomId,
        goalId: plan.goalId,
        payload: { goal_id: plan.goalId, plan_id: planId, previous_plan_id: goal.currentPlanId, retired_task_ids: retiredTaskIds },
      }),
    );
    return materializeInTx(ctx, tx, planId, now);
  });
}

/** Standalone retry entry point: materialize an accepted+current plan in its own
 *  transaction (idempotent). */
export async function materializePlan(ctx: ServerContext, planId: string): Promise<MaterializeResult> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction((tx) => materializeInTx(ctx, tx, planId, now));
}
