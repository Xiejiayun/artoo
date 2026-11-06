import { eventLog, fileLeases, runs, tasks } from "@artoo/db";
import { goalImportedProductReviews, goalImportedProductReviewDeliveries } from "@artoo/db";
import { goalProductHandoffs, goalProductHandoffOperations, goalProductHandoffDeliveries } from "@artoo/db";
import { goalImportedDesignContinuations, goalImportedDesignReviews, goalImportedExecutions, goals } from "@artoo/db";
import { goalImportedExecutionReviews, goalImportedExecutionRepairs } from "@artoo/db";
import { goalImportedValidations, goalImportedValidationReviews } from "@artoo/db";
import { goalRecoveryValidations, goalRecoveryValidationReviews, goalSourceRecoverySettlements, goalSourceRecoveries } from "@artoo/db";
import { goalCleanValidations, goalCleanValidationReviews, sourceCleanOperationSettlements, sourceCleanGenerations } from "@artoo/db";
import { ImportedCleanValidationResultV1Schema, ImportedCleanValidationReviewResultV1Schema } from "@artoo/domain";
import { ImportedRecoveryValidationResultV1Schema, ImportedRecoveryValidationReviewResultV1Schema } from "@artoo/domain";
import { ImportedValidationResultV1Schema, ImportedValidationReviewResultV1Schema } from "@artoo/domain";
import { ImportedExecutionReviewResultV1Schema, ImportedExecutionRepairResultV1Schema } from "@artoo/domain";
import { ImportedDesignContinuationResultV1Schema, ImportedDesignReviewResultV1Schema, ImportedExecutionResultV1Schema } from "@artoo/domain";
import { ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema, ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";

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
  for (const operation of standalone) if ("runId" in operation) runIds.add(operation.runId);
  return runIds.size + standalone.filter(operation => !("runId" in operation)).length;
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
  const designReviews = await tx.select().from(goalImportedDesignReviews).where(and(eq(goalImportedDesignReviews.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedDesignReviews.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedDesignReviews.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? or(eq(goalImportedDesignReviews.authorInstanceId, filter.agentInstanceId), eq(goalImportedDesignReviews.reviewerInstanceId, filter.agentInstanceId)) : undefined));
  const executions = await tx.select().from(goalImportedExecutions).where(and(eq(goalImportedExecutions.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedExecutions.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedExecutions.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalImportedExecutions.writerInstanceId, filter.agentInstanceId) : undefined));
  const executionReviews = await tx.select().from(goalImportedExecutionReviews).where(and(eq(goalImportedExecutionReviews.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedExecutionReviews.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedExecutionReviews.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? or(eq(goalImportedExecutionReviews.authorInstanceId, filter.agentInstanceId), eq(goalImportedExecutionReviews.reviewerInstanceId, filter.agentInstanceId)) : undefined));
  const executionRepairs = await tx.select().from(goalImportedExecutionRepairs).where(and(eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedExecutionRepairs.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedExecutionRepairs.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalImportedExecutionRepairs.writerInstanceId, filter.agentInstanceId) : undefined));
  const validations = await tx.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedValidations.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedValidations.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalImportedValidations.writerInstanceId, filter.agentInstanceId) : undefined));
  const validationReviews = await tx.select().from(goalImportedValidationReviews).where(and(eq(goalImportedValidationReviews.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalImportedValidationReviews.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalImportedValidationReviews.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? or(eq(goalImportedValidationReviews.authorInstanceId, filter.agentInstanceId), eq(goalImportedValidationReviews.reviewerInstanceId, filter.agentInstanceId)) : undefined));
  const recoveredAuthors = await tx.select().from(goalRecoveryValidations).where(and(eq(goalRecoveryValidations.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalRecoveryValidations.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalRecoveryValidations.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalRecoveryValidations.writerInstanceId, filter.agentInstanceId) : undefined));
  const recoveredReviews = await tx.select().from(goalRecoveryValidationReviews).where(and(eq(goalRecoveryValidationReviews.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalRecoveryValidationReviews.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalRecoveryValidationReviews.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? or(eq(goalRecoveryValidationReviews.authorInstanceId, filter.agentInstanceId), eq(goalRecoveryValidationReviews.reviewerInstanceId, filter.agentInstanceId)) : undefined));
  const settledRows = await tx.select({ settlement: goalSourceRecoverySettlements, settledAt: goalSourceRecoveries.settledAt }).from(goalSourceRecoverySettlements)
    .innerJoin(goalSourceRecoveries, eq(goalSourceRecoveries.id, goalSourceRecoverySettlements.recoveryId))
    .where(and(eq(goalSourceRecoverySettlements.organizationId, ctx.organizationId), eq(goalSourceRecoveries.organizationId, ctx.organizationId),
      filter.goalId ? eq(goalSourceRecoverySettlements.goalId, filter.goalId) : undefined,
      filter.computerId ? eq(goalSourceRecoverySettlements.computerId, filter.computerId) : undefined));
  const settled = new Set(settledRows.filter(row => row.settledAt !== null).map(({ settlement: row }) => `${row.kind}:${row.operationId}:${row.requestDigest}`));
  const cleanSettledRows = await tx.select({ settlement: sourceCleanOperationSettlements, settledAt: sourceCleanGenerations.settledAt }).from(sourceCleanOperationSettlements)
    .innerJoin(sourceCleanGenerations, eq(sourceCleanGenerations.id, sourceCleanOperationSettlements.generationId))
    .where(and(eq(sourceCleanOperationSettlements.organizationId, ctx.organizationId), eq(sourceCleanGenerations.organizationId, ctx.organizationId),
      filter.goalId ? eq(sourceCleanOperationSettlements.goalId, filter.goalId) : undefined,
      filter.computerId ? eq(sourceCleanOperationSettlements.computerId, filter.computerId) : undefined));
  for (const { settlement: row, settledAt } of cleanSettledRows) if (settledAt !== null) settled.add(`${row.kind}:${row.operationId}:${row.requestDigest}`);
  const cleanAuthors = await tx.select().from(goalCleanValidations).where(and(eq(goalCleanValidations.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalCleanValidations.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalCleanValidations.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? eq(goalCleanValidations.writerInstanceId, filter.agentInstanceId) : undefined));
  const cleanReviews = await tx.select().from(goalCleanValidationReviews).where(and(eq(goalCleanValidationReviews.organizationId, ctx.organizationId),
    filter.goalId ? eq(goalCleanValidationReviews.goalId, filter.goalId) : undefined,
    filter.computerId ? eq(goalCleanValidationReviews.computerId, filter.computerId) : undefined,
    filter.agentInstanceId ? or(eq(goalCleanValidationReviews.authorInstanceId, filter.agentInstanceId), eq(goalCleanValidationReviews.reviewerInstanceId, filter.agentInstanceId)) : undefined));
  return [...cleanAuthors.filter(row => ImportedCleanValidationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
    id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, participantInstanceIds: [row.writerInstanceId],
    workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "clean_validation" as const })),
    ...cleanReviews.filter(row => ImportedCleanValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId],
      workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "clean_validation_review" as const })),
    ...recoveredAuthors.filter(row => ImportedRecoveryValidationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
    id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, participantInstanceIds: [row.writerInstanceId],
    workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "recovery_validation" as const })),
    ...recoveredReviews.filter(row => ImportedRecoveryValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId],
      workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "recovery_validation_review" as const })),
    ...validations.filter(row => ImportedValidationResultV1Schema.safeParse(row.result).data?.closed !== true && !settled.has(`validation:${row.id}:${row.requestDigest}`)).map(row => ({
    id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, participantInstanceIds: [row.writerInstanceId],
    workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "validation" as const })),
    ...validationReviews.filter(row => ImportedValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true && !settled.has(`validation_review:${row.id}:${row.requestDigest}`)).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId],
      workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "validation_review" as const })),
    ...executionReviews.filter(row => ImportedExecutionReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
    id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId],
    workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "execution_review" as const })),
    ...executionRepairs.filter(row => ImportedExecutionRepairResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, participantInstanceIds: [row.writerInstanceId],
      workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "execution_repair" as const })),
    ...executions.filter(row => ImportedExecutionResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
    id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, workspaceRoot: row.workspaceRoot,
    participantInstanceIds: [row.writerInstanceId], result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "execution" as const })),
    ...source.map(row => ({ ...row, participantInstanceIds: [row.agentInstanceId], kind: "handoff" as const })), ...imported.map(row => ({ id: row.id, goalId: row.goalId,
    computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.reviewerInstanceId], workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "review" as const })),
    ...designs.filter(row => ImportedDesignContinuationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.writerInstanceId, workspaceRoot: row.workspaceRoot,
      participantInstanceIds: [row.writerInstanceId], result: row.result, stopRequested: row.stopRequested, runId: row.runId, kind: "design" as const })),
    ...designReviews.filter(row => ImportedDesignReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({
      id: row.id, goalId: row.goalId, computerId: row.computerId, agentInstanceId: row.reviewerInstanceId, participantInstanceIds: [row.authorInstanceId, row.reviewerInstanceId],
      workspaceRoot: row.workspaceRoot, result: row.result, stopRequested: row.stopRequested, kind: "design_review" as const }))];
}

/** H4 completion must not turn an imported plan into ordinary H5 writer or release authority. */
export async function currentImportedDesignBoundary(ctx: ServerContext, tx: DrizzleDb, goalId: string, planId?: string | null) {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal?.currentPlanId || planId !== undefined && planId !== goal.currentPlanId) return undefined;
  return (await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.organizationId, ctx.organizationId),
    eq(goalImportedDesignContinuations.goalId, goalId), eq(goalImportedDesignContinuations.planId, goal.currentPlanId))))[0];
}
