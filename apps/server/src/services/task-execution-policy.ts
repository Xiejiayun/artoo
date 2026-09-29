import { approvals, contextPacks, fileLeases, runs, tasks } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/** Follow-ups point directly to their policy root; fail closed for invalid restored links. */
export async function resolveExecutionPolicyTask(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect): Promise<typeof tasks.$inferSelect> {
  const visited = new Set<string>();
  let current = task;
  while (current.executionPolicyTaskId !== null) {
    if (visited.has(current.id) || visited.size >= 32) throw AppError.validation("Cyclic task execution policy");
    visited.add(current.id);
    const parent = (await tx.select().from(tasks).where(and(eq(tasks.id, current.executionPolicyTaskId), eq(tasks.organizationId, ctx.organizationId))))[0];
    if (!parent || parent.projectId !== task.projectId || parent.goalId !== task.goalId) throw AppError.validation("Task execution policy must belong to the same project and goal");
    current = parent;
  }
  return current;
}

/** Leases prove a previous explicit declaration; the pack preserves path casing. */
export async function inheritedWritePaths(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect, policyTask: typeof tasks.$inferSelect): Promise<string[]> {
  for (const taskId of await executionPolicySources(ctx, tx, task, policyTask)) {
    const previous = (await tx.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.organizationId, ctx.organizationId)))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0];
    if (!previous) continue;
    const leases = await tx.select({ id: fileLeases.id }).from(fileLeases).where(and(eq(fileLeases.runId, previous.id), eq(fileLeases.organizationId, ctx.organizationId))).limit(1);
    if (leases.length === 0) continue;
    const pack = previous.contextPackId ? (await tx.select().from(contextPacks).where(and(eq(contextPacks.id, previous.contextPackId), eq(contextPacks.organizationId, ctx.organizationId))))[0] : undefined;
    const parsed = ContextPackSchema.safeParse(pack?.payload);
    if (!parsed.success || parsed.data.policy.filesystem_write_scope.length === 0) throw AppError.validation("Cannot verify the previous execution's write scope");
    return parsed.data.policy.filesystem_write_scope;
  }
  return [];
}

export async function assertInheritedApprovalRequired(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect, policyTask: typeof tasks.$inferSelect): Promise<void> {
  if (policyTask.id === task.id) return;
  const sources = (await executionPolicySources(ctx, tx, task, policyTask)).filter((id) => id !== task.id);
  const inherited = await tx.select({ id: approvals.id }).from(approvals).where(and(inArray(approvals.taskId, sources), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start"))).limit(1);
  if (inherited.length === 0) return;
  const local = await tx.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.taskId, task.id), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start"))).limit(1);
  if (local.length === 0) throw AppError.conflict("Execution approval is required for this follow-up task");
}

/** Each follow-up carries its own inherited gates; include the immediate source
 * so newly introduced approval/write restrictions survive later follow-ups. */
async function executionPolicySources(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect, policyTask: typeof tasks.$inferSelect): Promise<string[]> {
  const ids = [task.id];
  if (task.executionPolicyTaskId && task.parentTaskId) {
    const parent = (await tx.select().from(tasks).where(and(eq(tasks.id, task.parentTaskId), eq(tasks.organizationId, ctx.organizationId))))[0];
    if (!parent || parent.projectId !== task.projectId || parent.goalId !== task.goalId ||
      (await resolveExecutionPolicyTask(ctx, tx, parent)).id !== policyTask.id) throw AppError.validation("Cannot verify the follow-up task's execution policy source");
    ids.push(parent.id);
  }
  ids.push(policyTask.id);
  return [...new Set(ids)];
}
