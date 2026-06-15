import { appendEvent, taskDependencies, tasks } from "@artoo/db";
import {
  type CreateDependencyRequest,
  type DagEdge,
  type DagSnapshot,
  ID_PREFIXES,
  incomingEdges,
  isGatingDependency,
  isTaskUnlocked,
  type TaskDependency,
  type TaskStatus,
  wouldCreateCycle,
} from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapDependency } from "../mappers.js";
import { transitionTask } from "./transition-service.js";

/** Load all dependency edges for the org as DAG edges (from=prereq, to=dependent). */
async function loadEdges(
  ctx: ServerContext,
  tx: ServerContext["db"]["db"],
): Promise<DagEdge[]> {
  const rows = await tx
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.organizationId, ctx.organizationId));
  return rows.map((r) => ({ from_task_id: r.fromTaskId, to_task_id: r.toTaskId, type: r.type as DagEdge["type"] }));
}

/**
 * POST /tasks/:id/dependencies — `:id` (the DEPENDENT) depends on
 * `depends_on_task_id` (the PREREQUISITE). Edge stored from=prerequisite,
 * to=dependent. Rejects self-dependency (400) and cycles (409).
 */
export async function createDependency(
  ctx: ServerContext,
  dependentTaskId: string,
  req: CreateDependencyRequest,
): Promise<TaskDependency> {
  const now = ctx.clock.nowIso();
  const prerequisiteId = req.depends_on_task_id;
  return ctx.db.transaction(async (tx) => {
    if (prerequisiteId === dependentTaskId) {
      throw AppError.validation("a task cannot depend on itself", { task_id: dependentTaskId });
    }
    const dependent = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, dependentTaskId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (dependent === undefined) {
      throw AppError.notFound(`task not found: ${dependentTaskId}`, { task_id: dependentTaskId });
    }
    const prerequisite = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, prerequisiteId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (prerequisite === undefined) {
      throw AppError.notFound(`prerequisite task not found: ${prerequisiteId}`, {
        depends_on_task_id: prerequisiteId,
      });
    }
    if (dependent.projectId !== prerequisite.projectId) {
      throw AppError.validation("dependencies must stay within one project", {
        dependent_task_id: dependentTaskId,
        dependent_project_id: dependent.projectId,
        prerequisite_task_id: prerequisiteId,
        prerequisite_project_id: prerequisite.projectId,
      });
    }

    const edges = await loadEdges(ctx, tx);
    if (wouldCreateCycle(edges, prerequisiteId, dependentTaskId)) {
      throw AppError.conflict("dependency would create a cycle", {
        from_task_id: prerequisiteId,
        to_task_id: dependentTaskId,
      });
    }
    const existing = (
      await tx
        .select({ id: taskDependencies.id })
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.organizationId, ctx.organizationId),
            eq(taskDependencies.fromTaskId, prerequisiteId),
            eq(taskDependencies.toTaskId, dependentTaskId),
            eq(taskDependencies.type, req.type),
          ),
        )
    )[0];
    if (existing !== undefined) {
      throw AppError.conflict("dependency already exists", {
        dependency_id: existing.id,
        from_task_id: prerequisiteId,
        to_task_id: dependentTaskId,
        type: req.type,
      });
    }

    const dependencyId = ctx.idGen.generate(ID_PREFIXES.dependency);
    await tx.insert(taskDependencies).values({
      id: dependencyId,
      organizationId: ctx.organizationId,
      fromTaskId: prerequisiteId,
      toTaskId: dependentTaskId,
      type: req.type,
      createdAt: now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "task.updated",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: dependentTaskId,
        projectId: dependent.projectId,
        taskId: dependentTaskId,
        payload: {
          dependency_added: { from_task_id: prerequisiteId, to_task_id: dependentTaskId, type: req.type },
        },
      }),
    );

    const row = (await tx.select().from(taskDependencies).where(eq(taskDependencies.id, dependencyId)))[0];
    if (row === undefined) {
      throw new Error("createDependency: row missing after insert");
    }
    return mapDependency(row);
  });
}

/**
 * GET /tasks/:id/dag — snapshot of the task's subtree (root + descendants via
 * parent_task_id) and the dependency edges among those nodes.
 */
export async function getDag(ctx: ServerContext, rootTaskId: string): Promise<DagSnapshot> {
  const db = ctx.db.db;
  const root = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, rootTaskId), eq(tasks.organizationId, ctx.organizationId)))
  )[0];
  if (root === undefined) {
    throw AppError.notFound(`task not found: ${rootTaskId}`, { task_id: rootTaskId });
  }

  // Collect the subtree (root + transitive children via parent_task_id).
  const allTasks = await db.select().from(tasks).where(eq(tasks.organizationId, ctx.organizationId));
  const childrenByParent = new Map<string, typeof allTasks>();
  for (const t of allTasks) {
    if (t.parentTaskId !== null) {
      const list = childrenByParent.get(t.parentTaskId) ?? [];
      list.push(t);
      childrenByParent.set(t.parentTaskId, list);
    }
  }
  const nodeIds = new Set<string>([rootTaskId]);
  const queue = [rootTaskId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const child of childrenByParent.get(id) ?? []) {
      if (!nodeIds.has(child.id)) {
        nodeIds.add(child.id);
        queue.push(child.id);
      }
    }
  }

  const nodes = allTasks
    .filter((t) => nodeIds.has(t.id))
    .map((t) => ({
      task_id: t.id,
      status: t.status as TaskStatus,
      parent_task_id: t.parentTaskId,
      title: t.title,
    }));
  const edges = (await loadEdges(ctx, db)).filter(
    (e) => nodeIds.has(e.from_task_id) && nodeIds.has(e.to_task_id),
  );

  return { root_task_id: rootTaskId, nodes, edges };
}

/**
 * GET /tasks/:id/dependencies — list the task's direct prerequisites (edges
 * where `:id` is the DEPENDENT, i.e. `to_task_id = :id`). Symmetric with the
 * POST/DELETE endpoints, which treat `:id` as the dependent.
 */
export async function listDependencies(
  ctx: ServerContext,
  dependentTaskId: string,
): Promise<TaskDependency[]> {
  const rows = await ctx.db.db
    .select()
    .from(taskDependencies)
    .where(
      and(
        eq(taskDependencies.organizationId, ctx.organizationId),
        eq(taskDependencies.toTaskId, dependentTaskId),
      ),
    );
  return rows.map(mapDependency);
}

/**
 * DELETE /tasks/:id/dependencies/:dependencyId — remove a prerequisite edge owned
 * by `:id` (the dependent). 404 if the edge is unknown, 400 if it does not belong
 * to this task. Structural only: the dependent is NOT auto-transitioned (a human
 * removing a blocker then calls /ready). Emits task.updated.dependency_removed.
 */
export async function deleteDependency(
  ctx: ServerContext,
  dependentTaskId: string,
  dependencyId: string,
): Promise<void> {
  const now = ctx.clock.nowIso();
  await ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.id, dependencyId),
            eq(taskDependencies.organizationId, ctx.organizationId),
          ),
        )
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`dependency not found: ${dependencyId}`, {
        dependency_id: dependencyId,
      });
    }
    if (row.toTaskId !== dependentTaskId) {
      throw AppError.validation("dependency does not belong to this task", {
        dependency_id: dependencyId,
        task_id: dependentTaskId,
      });
    }
    await tx.delete(taskDependencies).where(eq(taskDependencies.id, dependencyId));
    const dependent = (await tx.select().from(tasks).where(eq(tasks.id, dependentTaskId)))[0];
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "task.updated",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: dependentTaskId,
        projectId: dependent?.projectId ?? null,
        taskId: dependentTaskId,
        roomId: dependent?.roomId ?? null,
        payload: {
          dependency_removed: {
            id: dependencyId,
            from_task_id: row.fromTaskId,
            to_task_id: row.toTaskId,
            type: row.type,
          },
        },
      }),
    );
  });
}

/** Snapshot of every task's status in the org (for unlock evaluation). */
async function loadStatusMap(
  ctx: ServerContext,
  tx: DrizzleDb,
): Promise<Record<string, TaskStatus>> {
  const rows = await tx
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.organizationId, ctx.organizationId));
  const map: Record<string, TaskStatus> = {};
  for (const r of rows) {
    map[r.id] = r.status as TaskStatus;
  }
  return map;
}

/**
 * When `completedTaskId` reaches `done`, auto-unlock any directly-downstream
 * dependent whose gating prerequisites are now ALL done: transition it from
 * backlog -> ready (triage) and emit `dag.node.ready`. soft_context edges never
 * gate, so they never unlock. A dependent with empty acceptance criteria stays
 * in backlog (it cannot be readied). Runs inside the caller's transaction.
 * Returns the ids actually unlocked.
 */
export async function unlockDownstream(
  ctx: ServerContext,
  tx: DrizzleDb,
  completedTaskId: string,
): Promise<string[]> {
  const edges = await loadEdges(ctx, tx);
  const downstreamIds = [
    ...new Set(
      edges
        .filter((e) => e.from_task_id === completedTaskId && isGatingDependency(e.type))
        .map((e) => e.to_task_id),
    ),
  ];
  if (downstreamIds.length === 0) {
    return [];
  }
  const statusById = await loadStatusMap(ctx, tx);
  const now = ctx.clock.nowIso();
  const unlocked: string[] = [];
  for (const dependentId of downstreamIds) {
    const dependent = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, dependentId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (dependent === undefined || dependent.status !== "backlog") {
      continue;
    }
    if ((dependent.acceptanceCriteria as string[]).length === 0) {
      continue;
    }
    if (!isTaskUnlocked(incomingEdges(edges, dependentId), statusById)) {
      continue;
    }
    const res = await transitionTask(tx, ctx, {
      taskId: dependentId,
      from: "backlog",
      trigger: "triage",
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "dag.node.ready",
          actorType: "system",
          actorId: "control_plane",
          correlationId: dependentId,
          projectId: dependent.projectId,
          taskId: dependentId,
          roomId: dependent.roomId,
          payload: { unlocked_by: completedTaskId, status: to },
        }),
        buildEvent(ctx, {
          type: "task.updated",
          actorType: "system",
          actorId: "control_plane",
          correlationId: dependentId,
          projectId: dependent.projectId,
          taskId: dependentId,
          roomId: dependent.roomId,
          payload: { status: to },
        }),
      ],
    });
    if (res.changed) {
      unlocked.push(dependentId);
    }
  }
  return unlocked;
}

/**
 * When `sourceTaskId` becomes blocked or cancelled, emit `dag.node.blocked` for
 * each directly-downstream gating dependent that is still pending (backlog or
 * ready) so the control plane / UI can surface the stall. Dependents are NOT
 * transitioned — this is an advisory signal; recovery (retry of the source)
 * later re-unlocks via {@link unlockDownstream}. soft_context never propagates.
 * Returns the dependent ids that were signalled.
 */
export async function propagateBlocked(
  ctx: ServerContext,
  tx: DrizzleDb,
  sourceTaskId: string,
  reason: string,
): Promise<string[]> {
  const edges = await loadEdges(ctx, tx);
  const downstreamIds = [
    ...new Set(
      edges
        .filter((e) => e.from_task_id === sourceTaskId && isGatingDependency(e.type))
        .map((e) => e.to_task_id),
    ),
  ];
  if (downstreamIds.length === 0) {
    return [];
  }
  const affected: string[] = [];
  for (const dependentId of downstreamIds) {
    const dependent = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, dependentId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (dependent === undefined || (dependent.status !== "backlog" && dependent.status !== "ready")) {
      continue;
    }
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "dag.node.blocked",
        actorType: "system",
        actorId: "control_plane",
        correlationId: dependentId,
        projectId: dependent.projectId,
        taskId: dependentId,
        roomId: dependent.roomId,
        payload: { blocked_by: sourceTaskId, reason },
      }),
    );
    affected.push(dependentId);
  }
  return affected;
}
