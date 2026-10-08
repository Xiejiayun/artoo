import { eventLog, fileLeases, runs, tasks } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, notInArray } from "drizzle-orm";

import type { ServerContext } from "../context.js";

/** A disconnect timeout is not process exit, even when no write lease exists. */
export async function unconfirmedDisconnectRunIds(ctx: ServerContext, tx: DrizzleDb, filter: { goalId?: string; computerId?: string; taskId?: string; agentInstanceId?: string }): Promise<string[]> {
  const candidates = await tx.select({ id: runs.id }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId)).where(and(
    eq(runs.organizationId, ctx.organizationId), eq(tasks.organizationId, ctx.organizationId), eq(runs.status, "failed"), eq(runs.failureReason, "daemon_disconnect"),
    filter.goalId ? eq(tasks.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(runs.computerId, filter.computerId) : undefined,
    filter.taskId ? eq(runs.taskId, filter.taskId) : undefined,
    filter.agentInstanceId ? eq(runs.agentInstanceId, filter.agentInstanceId) : undefined,
  ));
  if (candidates.length === 0) return [];
  const evidence = await tx.select({ runId: eventLog.runId, payload: eventLog.payload }).from(eventLog).where(and(
    eq(eventLog.organizationId, ctx.organizationId), inArray(eventLog.runId, candidates.map((run) => run.id)),
    inArray(eventLog.type, ["run.failed", "run.reconciled"]),
  ));
  const confirmed = new Set(evidence.filter((event) => event.payload !== null && typeof event.payload === "object"
    && "process_exit_confirmed" in event.payload && event.payload.process_exit_confirmed === true).map((event) => event.runId));
  return candidates.filter((run) => !confirmed.has(run.id)).map((run) => run.id);
}

/** Includes processes whose database run failed but whose actual exit is unknown. */
export async function unsettledGoalRunIds(ctx: ServerContext, tx: DrizzleDb, goalId: string): Promise<string[]> {
  const live = await tx.select({ id: runs.id }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId)).where(and(
    eq(runs.organizationId, ctx.organizationId), eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goalId), notInArray(runs.status, ["completed", "failed", "cancelled"]),
  ));
  const held = await tx.select({ runId: fileLeases.runId }).from(fileLeases).innerJoin(tasks, eq(tasks.id, fileLeases.taskId)).where(and(
    eq(fileLeases.organizationId, ctx.organizationId), eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goalId), eq(fileLeases.status, "held"),
  ));
  return [...new Set([...live.map((run) => run.id), ...held.flatMap((lease) => lease.runId === null ? [] : [lease.runId]), ...await unconfirmedDisconnectRunIds(ctx, tx, { goalId })])];
}
