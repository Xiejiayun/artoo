import { agentInstances, runs, schedulerExecutionRequests, schedulerStartGrants, tasks } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import { AppError } from "../errors.js";
import { claimSchedulerExecutionRequest } from "./lifecycle-service.js";
import { projectSquadInstanceMembership } from "./project-squad-membership.js";

const requiredFlags = ["execution_requests", "daemon_claim", "isolated_workspaces", "capacity_admission", "attempt_credentials"] as const;
const enabled = (ctx: ServerContext, projectId: string) => requiredFlags.every((flag) => schedulerRolloutEnabled(ctx.schedulerRollout, flag, { organizationId: ctx.organizationId, projectId }));
const r = schedulerExecutionRequests;
export interface SchedulerClaimCursor { createdAt: string; id: string }
export type SchedulerPollAssignment = { task_id: string; request_id: string; run_id: string };

export async function schedulerProjectHasConsumer(ctx: ServerContext, tx: DrizzleDb, projectId: string) {
  if (!enabled(ctx, projectId)) return false;
  const pool = await tx.select({ computerId: agentInstances.computerId }).from(agentInstances)
    .where(and(projectSquadInstanceMembership(ctx.organizationId, projectId), sql`${agentInstances.runtime}<>'mock' AND ${agentInstances.status}<>'disabled'`));
  return pool.some((candidate) => ctx.supportsSchedulerClaim?.(candidate.computerId) === true);
}

/** Availability means a currently negotiated private consumer exists; it is not
 * a promise that capacity, original consent or physical admission will pass. */
export async function schedulerExecutionConsumerStatus(ctx: ServerContext, taskId: string) {
  const [task] = await ctx.db.db.select({ projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.notFound("Task not found");
  return { consumer_available: await schedulerProjectHasConsumer(ctx, ctx.db.db, task.projectId), execution_authorized: false as const };
}

/** Each candidate is consumed by the existing original-user transaction. The
 * bounded per-session cursor prevents stale/unclaimable requests at the front
 * of the queue from hiding eligible work indefinitely. It carries no authority. */
export async function pollSchedulerExecution(ctx: ServerContext, input: { computerId: string; sessionId: string }, cursor?: SchedulerClaimCursor, replayQueued = true): Promise<{ assignment: SchedulerPollAssignment | null; cursor?: SchedulerClaimCursor }> {
  const session = ctx.getPairedNodeSession?.(input.computerId);
  if (!session || session.sessionId !== input.sessionId || ctx.supportsSchedulerClaim?.(input.computerId) !== true)
    throw AppError.permissionDenied("Scheduler poll requires its current negotiated paired session");
  // Response loss may return the same queued assignment ID. No new permission,
  // grant, credential, epoch or physical process is created on this path.
  const retained = replayQueued ? await ctx.db.db.select({ id: r.id, taskId: r.taskId, projectId: r.projectId }).from(r).innerJoin(runs, eq(runs.id, r.consumedRunId)).where(and(eq(r.organizationId, ctx.organizationId), eq(r.state, "consumed"), eq(r.consumedDeviceId, session.deviceId), eq(r.consumedSessionId, input.sessionId), eq(runs.computerId, input.computerId), eq(runs.status, "queued"), isNull(runs.endedAt), sql`NOT EXISTS (SELECT 1 FROM ${schedulerStartGrants} g WHERE g.request_id=${r.id})`)).orderBy(asc(r.consumedAt), asc(r.id)).limit(1) : [];
  if (retained[0] && enabled(ctx, retained[0].projectId)) {
    const row = retained[0];
    const result = await claimSchedulerExecutionRequest(ctx, { ...input, taskId: row.taskId, requestId: row.id });
    return { assignment: { task_id: row.taskId, request_id: row.id, run_id: result.run.id }, cursor };
  }
  const pool = await ctx.db.db.select({ agentId: agentInstances.agentId }).from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId), eq(agentInstances.computerId, input.computerId), isNull(agentInstances.deletedAt)));
  const agentIds = [...new Set(pool.map((candidate) => candidate.agentId))];
  if (!agentIds.length) return { assignment: null };
  const pending = await ctx.db.db.select({ id: r.id, taskId: r.taskId, projectId: r.projectId, createdAt: r.createdAt }).from(r).where(and(eq(r.organizationId, ctx.organizationId), eq(r.state, "pending"), inArray(r.agentId, agentIds), cursor ? sql`(${r.createdAt},${r.id}) > (${cursor.createdAt}::timestamptz,${cursor.id})` : undefined)).orderBy(asc(r.createdAt), asc(r.id)).limit(16);
  let next = cursor;
  for (const row of pending) {
    next = { createdAt: row.createdAt, id: row.id };
    if (!enabled(ctx, row.projectId)) continue;
    try {
      const result = await claimSchedulerExecutionRequest(ctx, { ...input, taskId: row.taskId, requestId: row.id });
      if (ctx.getPairedNodeSession?.(input.computerId)?.sessionId !== input.sessionId || ctx.supportsSchedulerClaim?.(input.computerId) !== true)
        throw AppError.permissionDenied("Scheduler poll session was replaced");
      return { assignment: { task_id: row.taskId, request_id: row.id, run_id: result.run.id }, cursor: next };
    } catch (error) {
      // An ineligible machine, changed consent or racing claimant must leave the
      // original permission untouched. Unexpected storage defects remain errors.
      if (!(error instanceof AppError) || ![400, 403, 404, 409].includes(error.httpStatus)) throw error;
      if (ctx.getPairedNodeSession?.(input.computerId)?.sessionId !== input.sessionId) throw error;
    }
  }
  return { assignment: null, ...(pending.length === 16 ? { cursor: next } : {}) };
}
