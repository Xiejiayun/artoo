import { appendEvent, approvals, blockers, checkpoints, eventLog, goals, plans, runs, tasks } from "@artoo/db";
import {
  type Checkpoint,
  type CheckpointRefs,
  type CheckpointType,
  CheckpointSchema,
  ID_PREFIXES,
} from "@artoo/domain";
import { and, asc, desc, eq, inArray, max, notInArray } from "drizzle-orm";

import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";

/**
 * V3 #115 P2-S1 — goal checkpoints. A checkpoint is a reference-based marker on a
 * safe boundary (#128 §3): it stores only ids/summaries that point at live DB
 * state, never copies of it. Checkpoints are written inside the SAME transaction
 * as the state change that triggers them (materialize / pause / resume), so a
 * checkpoint can never describe a transition that did not commit.
 *
 * S1 scope: synthesis + create/list/get + the materialize/pause/resume hooks.
 * Resume evaluation, run.resume protocol, grace window and the daemon handler are
 * later P2 slices.
 */

type Tx = DrizzleDb;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
const ACTIVE_BLOCKER_STATUSES = ["open", "mitigated"] as const;

function mapCheckpoint(row: typeof checkpoints.$inferSelect): Checkpoint {
  return CheckpointSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    goal_id: row.goalId,
    plan_id: row.planId,
    type: row.type,
    trigger_event_id: row.triggerEventId,
    state_refs: row.stateRefs,
    summary: row.summary,
    created_at: row.createdAt,
  });
}

/**
 * Synthesize CheckpointRefs from current DB facts within a transaction. Returns
 * only references/summaries: child task statuses, non-terminal run ids, active
 * blocker ids, pending approval ids, the current plan version, and the global
 * event-log position (the explainable resume cursor — every event up to and
 * including the trigger has position ≤ event_cursor). All reads are org-scoped.
 */
export async function synthesizeRefsInTx(
  ctx: ServerContext,
  tx: Tx,
  goal: typeof goals.$inferSelect,
): Promise<CheckpointRefs> {
  const taskRows = await tx
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id)))
    .orderBy(asc(tasks.id));
  const taskIds = taskRows.map((t) => t.id);

  const activeRunRows =
    taskIds.length === 0
      ? []
      : await tx
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.organizationId, ctx.organizationId),
              inArray(runs.taskId, taskIds),
              notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
            ),
          )
          .orderBy(asc(runs.id));

  const pendingApprovalRows =
    taskIds.length === 0
      ? []
      : await tx
          .select({ id: approvals.id })
          .from(approvals)
          .where(
            and(
              eq(approvals.organizationId, ctx.organizationId),
              inArray(approvals.taskId, taskIds),
              eq(approvals.status, "pending"),
            ),
          )
          .orderBy(asc(approvals.id));

  const openBlockerRows = await tx
    .select({ id: blockers.id })
    .from(blockers)
    .where(
      and(
        eq(blockers.organizationId, ctx.organizationId),
        eq(blockers.goalId, goal.id),
        inArray(blockers.status, [...ACTIVE_BLOCKER_STATUSES]),
      ),
    )
    .orderBy(asc(blockers.id));

  let planVersion = 0;
  if (goal.currentPlanId != null) {
    const planRow = (
      await tx
        .select({ version: plans.version })
        .from(plans)
        .where(and(eq(plans.id, goal.currentPlanId), eq(plans.organizationId, ctx.organizationId)))
    )[0];
    planVersion = planRow?.version ?? 0;
  }

  const cursorRow = (
    await tx
      .select({ cursor: max(eventLog.position) })
      .from(eventLog)
      .where(eq(eventLog.organizationId, ctx.organizationId))
  )[0];

  return {
    goal_status: goal.status as CheckpointRefs["goal_status"],
    plan_version: planVersion,
    task_statuses: taskRows.map((t) => ({ task_id: t.id, status: t.status })),
    active_runs: activeRunRows.map((r) => r.id),
    open_blockers: openBlockerRows.map((b) => b.id),
    pending_approvals: pendingApprovalRows.map((a) => a.id),
    event_cursor: cursorRow?.cursor ?? 0,
  };
}

export interface CreateCheckpointOptions {
  planId?: string | null;
  triggerEventId?: string | null;
  summary?: string;
}

/**
 * Create a checkpoint INSIDE the caller's transaction (atomic with the state
 * change). Emits goal.checkpoint_created. The materialize hook guards against a
 * duplicate dag_materialized checkpoint per plan; pause/resume pass the
 * triggering goal.paused/resumed event id so the marker links to the transition.
 */
export async function createCheckpointInTx(
  ctx: ServerContext,
  tx: Tx,
  goal: typeof goals.$inferSelect,
  type: CheckpointType,
  opts: CreateCheckpointOptions = {},
): Promise<Checkpoint> {
  if (goal.organizationId !== ctx.organizationId) {
    throw AppError.notFound(`goal not found: ${goal.id}`, { goal_id: goal.id });
  }
  const now = ctx.clock.nowIso();
  const id = ctx.idGen.generate(ID_PREFIXES.checkpoint);
  const refs = await synthesizeRefsInTx(ctx, tx, goal);
  await tx.insert(checkpoints).values({
    id,
    organizationId: ctx.organizationId,
    goalId: goal.id,
    planId: opts.planId ?? goal.currentPlanId ?? null,
    type,
    triggerEventId: opts.triggerEventId ?? null,
    stateRefs: refs,
    summary: opts.summary ?? "",
    createdAt: now,
  });
  await appendEvent(
    tx,
    buildEvent(ctx, {
      type: "goal.checkpoint_created",
      actorType: "system",
      actorId: "checkpointer",
      correlationId: goal.id,
      projectId: goal.projectId,
      roomId: goal.roomId,
      goalId: goal.id,
      payload: { goal_id: goal.id, checkpoint_id: id, checkpoint_type: type, trigger_event_id: opts.triggerEventId ?? null },
    }),
  );
  const row = (
    await tx.select().from(checkpoints).where(and(eq(checkpoints.id, id), eq(checkpoints.organizationId, ctx.organizationId)))
  )[0]!;
  return mapCheckpoint(row);
}

/** True when a dag_materialized checkpoint already exists for this plan, so a
 *  materialize retry does not create a duplicate (gate criterion 5). */
export async function hasMaterializeCheckpoint(ctx: ServerContext, tx: Tx, planId: string): Promise<boolean> {
  const row = (
    await tx
      .select({ id: checkpoints.id })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.organizationId, ctx.organizationId),
          eq(checkpoints.planId, planId),
          eq(checkpoints.type, "dag_materialized"),
        ),
      )
  )[0];
  return row !== undefined;
}

export async function getCheckpoint(ctx: ServerContext, id: string): Promise<Checkpoint | null> {
  return ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.id, id), eq(checkpoints.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) return null;
    const goal = (
      await tx.select({ id: goals.id }).from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId)))
    )[0];
    return goal === undefined ? null : mapCheckpoint(row);
  });
}

/** List a goal's checkpoints, latest first. Verifies the goal is in-org. */
export async function listCheckpoints(ctx: ServerContext, goalId: string): Promise<Checkpoint[]> {
  return ctx.db.transaction(async (tx) => {
    const goal = (
      await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)))
    )[0];
    if (goal === undefined) {
      throw AppError.notFound(`goal not found: ${goalId}`, { goal_id: goalId });
    }
    const rows = await tx
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.organizationId, ctx.organizationId), eq(checkpoints.goalId, goalId)))
      .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id));
    return rows.map(mapCheckpoint);
  });
}
