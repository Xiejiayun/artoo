import { taskDelegations, tasks } from "@artoo/db";
import { TASK_DELEGATION_LIMITS, TaskDelegationTreeV1Schema, type TaskDelegationRequestV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq, inArray, is, or, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

const treeTaskColumns = {
  id: tasks.id,
  organizationId: tasks.organizationId,
  projectId: tasks.projectId,
  parentTaskId: tasks.parentTaskId,
  title: tasks.title,
  status: tasks.status,
};
type TreeTask = Pick<typeof tasks.$inferSelect, keyof typeof treeTaskColumns>;
const invalidTree = () =>
  AppError.conflict("Explicit delegation tree identity is inconsistent", {
    reason: "delegation_tree_invalid",
  });

async function selectedTask(ctx: ServerContext, tx: DrizzleDb, taskId: string) {
  const [task] = await tx
    .select(treeTaskColumns)
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.notFound("Task not found");
  return task;
}

/** Bounded explicit history; old provenance parents never become delegation by inference. */
async function readTree(ctx: ServerContext, tx: DrizzleDb, selected: TreeTask) {
  const [selectedEdge] = await tx.select().from(taskDelegations).where(eq(taskDelegations.taskId, selected.id));
  const rootId = selectedEdge?.rootTaskId ?? selected.id;
  const links = await tx
    .select()
    .from(taskDelegations)
    .where(or(eq(taskDelegations.rootTaskId, rootId), eq(taskDelegations.taskId, rootId)))
    .orderBy(asc(taskDelegations.depth), asc(taskDelegations.taskId))
    .limit(31);
  // Root + 29 children is the complete allowed history, including terminal work.
  if (
    links.length >= TASK_DELEGATION_LIMITS.max_tasks ||
    links.some(
      (link) =>
        link.version !== 1 ||
        link.organizationId !== ctx.organizationId ||
        link.projectId !== selected.projectId ||
        link.rootTaskId !== rootId ||
        link.taskId === rootId ||
        link.depth < 1 ||
        link.depth > TASK_DELEGATION_LIMITS.max_depth,
    )
  )
    throw invalidTree();
  const rows = await tx
    .select(treeTaskColumns)
    .from(tasks)
    .where(
      and(
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.projectId, selected.projectId),
        inArray(tasks.id, [rootId, ...links.map((link) => link.taskId)]),
      ),
    );
  if (rows.length !== links.length + 1) throw invalidTree();
  const byId = new Map(rows.map((task) => [task.id, task]));
  const byChild = new Map(links.map((link) => [link.taskId, link]));
  if (!byId.has(selected.id) || (selectedEdge && byChild.get(selected.id)?.taskId !== selectedEdge.taskId))
    throw invalidTree();
  for (const link of links) {
    const parent = byChild.get(link.parentTaskId);
    if (
      byId.get(link.taskId)?.parentTaskId !== link.parentTaskId ||
      (link.depth === 1 ? link.parentTaskId !== rootId : !parent || parent.depth + 1 !== link.depth)
    )
      throw invalidTree();
  }
  const root = byId.get(rootId)!;
  return TaskDelegationTreeV1Schema.parse({
    version: 1,
    root_task_id: rootId,
    selected_task_id: selected.id,
    creation_enabled: schedulerRolloutEnabled(ctx.schedulerRollout, "delegation_limits", {
      organizationId: ctx.organizationId,
      projectId: selected.projectId,
    }),
    limits: TASK_DELEGATION_LIMITS,
    nodes: [
      { task_id: root.id, parent_task_id: null, depth: 0, title: root.title, status: root.status },
      ...links.map((link) => {
        const task = byId.get(link.taskId)!;
        return {
          task_id: task.id,
          parent_task_id: link.parentTaskId,
          depth: link.depth,
          title: task.title,
          status: task.status,
        };
      }),
    ],
  });
}

/** Readable with rollout off; a historical relationship is never reclassified. */
export async function getTaskDelegationTree(ctx: ServerContext, taskId: string) {
  return ctx.db.db.transaction(async (tx) => readTree(ctx, tx, await selectedTask(ctx, tx, taskId)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/** Called only after exact source replay/active dedupe, before an actual new Task insert. */
export async function prepareTaskDelegation(
  ctx: ServerContext,
  tx: DrizzleDb,
  values: typeof tasks.$inferInsert,
  request: TaskDelegationRequestV1,
): Promise<typeof taskDelegations.$inferInsert> {
  if (
    !schedulerRolloutEnabled(ctx.schedulerRollout, "delegation_limits", {
      organizationId: ctx.organizationId,
      projectId: values.projectId,
    })
  )
    throw AppError.conflict("Explicit delegation is disabled for this project", { reason: "delegation_disabled" });
  if (!is(tx, PgTransaction)) throw AppError.conflict("Delegation requires a database transaction");
  const isolation = await tx.execute(sql`SHOW transaction_isolation`);
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw AppError.conflict("Delegation requires read committed isolation");
  if (
    request.version !== 1 ||
    values.parentTaskId !== request.parent_task_id ||
    values.id === request.parent_task_id ||
    values.organizationId !== ctx.organizationId
  )
    throw AppError.validation("Invalid explicit delegation parent");
  let parent: TreeTask | undefined;
  try {
    [parent] = await tx
      .select(treeTaskColumns)
      .from(tasks)
      .where(
        and(
          eq(tasks.id, request.parent_task_id),
          eq(tasks.organizationId, ctx.organizationId),
          eq(tasks.projectId, values.projectId),
        ),
      )
      .for("share", { noWait: true });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    if ((cause as { code?: string } | null)?.code === "55P03")
      throw AppError.conflict("Delegation parent is changing; retry the complete operation", {
        reason: "delegation_busy",
      });
    throw error;
  }
  if (!parent) throw AppError.validation("Delegation parent must belong to the same project");
  if (["done", "cancelled"].includes(parent.status))
    throw AppError.invalidState("Cannot delegate new work from a terminal parent");
  const [edge] = await tx.select().from(taskDelegations).where(eq(taskDelegations.taskId, parent.id));
  const rootId = edge?.rootTaskId ?? parent.id;
  // Different leaves must serialize on their common root. Never wait while
  // owning source/user/parent locks; retry the entire authorized operation.
  const mutex = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1095914315,
    hashtext(${JSON.stringify([ctx.organizationId, rootId])})) AS acquired`);
  if (mutex.rows[0]?.acquired !== true)
    throw AppError.conflict("Delegation tree is busy; retry the complete operation", { reason: "delegation_busy" });
  const tree = await readTree(ctx, tx, parent);
  const depth = tree.nodes.find((node) => node.task_id === parent.id)!.depth + 1;
  if (depth > TASK_DELEGATION_LIMITS.max_depth)
    throw AppError.conflict("Delegation depth limit reached", {
      reason: "delegation_depth_exceeded",
      limit: TASK_DELEGATION_LIMITS.max_depth,
    });
  if (tree.nodes.length >= TASK_DELEGATION_LIMITS.max_tasks)
    throw AppError.conflict("Delegation tree size limit reached", {
      reason: "delegation_size_exceeded",
      limit: TASK_DELEGATION_LIMITS.max_tasks,
    });
  return {
    taskId: values.id,
    organizationId: ctx.organizationId,
    projectId: values.projectId,
    parentTaskId: parent.id,
    rootTaskId: rootId,
    version: 1,
    depth,
    initiatedByUserId: ctx.actorUserId,
    createdAt: values.createdAt,
  };
}
