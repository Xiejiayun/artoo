import { appendEvent, taskDependencies, tasks } from "@artoo/db";
import {
  type CreateDependencyRequest,
  type DagEdge,
  type DagSnapshot,
  ID_PREFIXES,
  type TaskDependency,
  type TaskStatus,
  wouldCreateCycle,
} from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapDependency } from "../mappers.js";

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

    const edges = await loadEdges(ctx, tx);
    if (wouldCreateCycle(edges, prerequisiteId, dependentTaskId)) {
      throw AppError.conflict("dependency would create a cycle", {
        from_task_id: prerequisiteId,
        to_task_id: dependentTaskId,
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
