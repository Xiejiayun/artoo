import { eventLog, fileLeases, runs, tasks } from "@artoo/db";
import { goalImportedProductReviews, goalImportedProductReviewDeliveries } from "@artoo/db";
import { goalProductHandoffs, goalProductHandoffOperations, goalProductHandoffDeliveries } from "@artoo/db";
import { goalImportedDesignContinuations } from "@artoo/db";
import { ImportedDesignContinuationResultV1Schema } from "@artoo/domain";
import { ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema, ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema } from "@artoo/domain";
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

/** Dedicated operations must never be projected into ordinary run IDs or node verification rows. */
export async function unsettledImportedProductReviews(ctx: ServerContext, tx: DrizzleDb,
  filter: { goalId?: string; computerId?: string; agentInstanceId?: string } = {}) {
  const rows = await tx.select({ review: goalImportedProductReviews }).from(goalImportedProductReviews)
    .innerJoin(goalImportedProductReviewDeliveries, eq(goalImportedProductReviewDeliveries.reviewId, goalImportedProductReviews.id))
    .where(and(eq(goalImportedProductReviews.organizationId, ctx.organizationId), inArray(goalImportedProductReviewDeliveries.control, ["start", "stop"]),
      filter.goalId ? eq(goalImportedProductReviews.goalId, filter.goalId) : undefined,
      filter.computerId ? eq(goalImportedProductReviews.computerId, filter.computerId) : undefined,
      filter.agentInstanceId ? eq(goalImportedProductReviews.reviewerInstanceId, filter.agentInstanceId) : undefined));
  return [...new Map(rows.filter(({ review }) => ImportedProductReviewResultV1Schema.safeParse(review.result).data?.closed !== true)
    .map(({ review }) => [review.id, { ...review, workspaceRoot: ImportedProductReviewRequestV1Schema.parse(review.request).operation.intent.request.byte_request.destination.workspace_root }])).values()];
}

/** Capacity/finalization count; callers that need actual run IDs continue using unsettledGoalRunIds. */
export async function unsettledGoalExecutionCount(ctx: ServerContext, tx: DrizzleDb, goalId: string): Promise<number> {
  const runIds = new Set(await unsettledGoalRunIds(ctx, tx, goalId));
  const standalone = await unsettledStandaloneExecutions(ctx, tx, { goalId });
  for (const operation of standalone) if (operation.kind === "design") runIds.add(operation.runId);
  return runIds.size + standalone.filter(operation => operation.kind !== "design").length;
}

export async function unsettledProductSourceOperations(ctx: ServerContext, tx: DrizzleDb,
  filter: { goalId?: string; computerId?: string; agentInstanceId?: string } = {}) {
  const rows = await tx.select({ operation: goalProductHandoffOperations, goalId: goalProductHandoffs.goalId, stopRequested: goalProductHandoffs.stopRequested, sourceInstanceId: runs.agentInstanceId })
    .from(goalProductHandoffOperations).innerJoin(goalProductHandoffs, eq(goalProductHandoffs.id, goalProductHandoffOperations.handoffId))
    .innerJoin(runs, eq(runs.id, goalProductHandoffs.sourceRunId))
    .innerJoin(goalProductHandoffDeliveries, eq(goalProductHandoffDeliveries.operationId, goalProductHandoffOperations.id))
    .where(and(eq(goalProductHandoffs.organizationId, ctx.organizationId), inArray(goalProductHandoffDeliveries.control, ["start", "stop"]),
      filter.goalId ? eq(goalProductHandoffs.goalId, filter.goalId) : undefined,
      filter.computerId ? eq(goalProductHandoffOperations.computerId, filter.computerId) : undefined));
  const unique = new Map<string, { id: string; goalId: string; computerId: string; agentInstanceId: string; workspaceRoot: string; result: unknown; stopRequested: boolean }>();
  for (const row of rows) {
    if (ProductSourceOperationResultV1Schema.safeParse(row.operation.result).data?.closed === true) continue;
    const payload = ProductSourceOperationV1Schema.parse(row.operation.payload), source = payload.kind === "upload";
    const agentInstanceId = source ? row.sourceInstanceId : payload.intent.destination_start.agent_instance_id;
    if (filter.agentInstanceId && agentInstanceId !== filter.agentInstanceId) continue;
    unique.set(row.operation.id, { id: row.operation.id, goalId: row.goalId, stopRequested: row.stopRequested, computerId: row.operation.computerId, agentInstanceId,
      workspaceRoot: source ? payload.intent.request.byte_request.source.workspace_root : payload.intent.request.byte_request.destination.workspace_root, result: row.operation.result });
  }
  return [...unique.values()];
}

/** Shared capacity/workspace facts for dedicated operations; identifiers keep their own namespaces. */
export async function unsettledStandaloneExecutions(ctx: ServerContext, tx: DrizzleDb,
  filter: { goalId?: string; computerId?: string; agentInstanceId?: string } = {}) {
  const source = await unsettledProductSourceOperations(ctx, tx, filter), imported = await unsettledImportedProductReviews(ctx, tx, filter);
  // Creating the immutable H3 intent reserves its real run, including before any wire delivery.
  const designs = await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedDesignContinuations.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedDesignContinuations.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalImportedDesignContinuations.writerInstanceId, filter.agentInstanceId) : undefined));
  return [...source.map(row => ({ ...row, kind: "handoff" as const })), ...imported.map(row => ({ id: row.id, goalId: row.goalId,
    computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "review" as const })),
    ...designs.filter(row => ImportedDesignContinuationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, workspaceRoot: row.workspaceRoot,
      result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "design" as const }))];
}
