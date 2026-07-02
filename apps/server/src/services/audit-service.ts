import { createHash } from "node:crypto";

import {
  artifacts,
  approvals,
  blockers,
  checkpoints,
  decisionRecords,
  eventLog,
  goals,
  handoffs,
  messages,
  plans,
  rooms,
  runs,
  schedulerDecisions,
  tasks,
} from "@artoo/db";
import {
  AuditBundleExportSchema,
  GoalAuditBundleExportSchema,
  GoalAuditBundleSchema,
  TaskAuditBundleSchema,
  type AuditBundleExport,
  type GoalAuditBundle,
  type GoalAuditBundleExport,
  type TaskAuditBundle,
} from "@artoo/domain";
import { and, asc, eq, or } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import {
  mapApproval,
  mapArtifact,
  mapAuditEvent,
  mapMessage,
  mapRoom,
  mapRun,
  mapSchedulerDecision,
  mapTask,
} from "../mappers.js";
import { mapCheckpoint } from "./checkpoint-service.js";
import { mapBlocker, mapDecision, mapHandoff } from "./collaboration-service.js";
import { mapGoal } from "./goal-service.js";
import { mapPlan } from "./plan-service.js";
import { redactGoalAuditBundle, redactTaskAuditBundle } from "./redaction.js";

/** GET /api/v1/tasks/:id/audit-bundle — deterministic read-only task evidence. */
export async function getTaskAuditBundle(ctx: ServerContext, taskId: string): Promise<TaskAuditBundle> {
  const db = ctx.db.db;
  const taskRow = (
    await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
  )[0];
  if (taskRow === undefined) {
    throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
  }

  const roomRow =
    taskRow.roomId != null
      ? (
          await db
            .select()
            .from(rooms)
            .where(and(eq(rooms.id, taskRow.roomId), eq(rooms.organizationId, ctx.organizationId)))
        )[0]
      : undefined;
  const messageRows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.organizationId, ctx.organizationId), eq(messages.taskId, taskId)))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const runRows = await db
    .select()
    .from(runs)
    .where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, taskId)))
    .orderBy(asc(runs.createdAt), asc(runs.id));
  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.taskId, taskId)))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
  const approvalRows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.organizationId, ctx.organizationId), eq(approvals.taskId, taskId)))
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
  const schedulerDecisionRows = await db
    .select()
    .from(schedulerDecisions)
    .where(and(eq(schedulerDecisions.organizationId, ctx.organizationId), eq(schedulerDecisions.taskId, taskId)))
    .orderBy(asc(schedulerDecisions.createdAt), asc(schedulerDecisions.id));
  const eventRows = await db
    .select()
    .from(eventLog)
    .where(
      and(
        eq(eventLog.organizationId, ctx.organizationId),
        or(eq(eventLog.taskId, taskId), eq(eventLog.correlationId, taskId)),
      ),
    )
    .orderBy(asc(eventLog.position));

  // V3 #114 — team discussion records linked to this task.
  const decisionRows = await db
    .select()
    .from(decisionRecords)
    .where(and(eq(decisionRecords.organizationId, ctx.organizationId), eq(decisionRecords.taskId, taskId)))
    .orderBy(asc(decisionRecords.createdAt), asc(decisionRecords.id));
  const handoffRows = await db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.organizationId, ctx.organizationId), eq(handoffs.taskId, taskId)))
    .orderBy(asc(handoffs.createdAt), asc(handoffs.id));
  const blockerRows = await db
    .select()
    .from(blockers)
    .where(and(eq(blockers.organizationId, ctx.organizationId), eq(blockers.taskId, taskId)))
    .orderBy(asc(blockers.createdAt), asc(blockers.id));

  const bundle = TaskAuditBundleSchema.parse({
    task: mapTask(taskRow),
    room: roomRow !== undefined ? mapRoom(roomRow) : null,
    messages: messageRows.map(mapMessage),
    runs: runRows.map(mapRun),
    artifacts: artifactRows.map(mapArtifact),
    approvals: approvalRows.map(mapApproval),
    scheduler_decisions: schedulerDecisionRows.map(mapSchedulerDecision),
    events: eventRows.map(mapAuditEvent),
    decisions: decisionRows.map(mapDecision),
    handoffs: handoffRows.map(mapHandoff),
    blockers: blockerRows.map(mapBlocker),
  });
  return redactTaskAuditBundle(bundle);
}

/** Exportable v1alpha1 evidence envelope. Unsigned by design until key management exists. */
export async function exportTaskAuditBundle(ctx: ServerContext, taskId: string): Promise<AuditBundleExport> {
  const bundle = await getTaskAuditBundle(ctx, taskId);
  return AuditBundleExportSchema.parse({
    schema_version: "v1alpha1",
    exported_at: ctx.clock.nowIso(),
    bundle_sha256: sha256(stableJson(bundle)),
    bundle,
    signature: null,
    signing: {
      status: "deferred",
      reason: "v1 does not manage signing keys yet",
    },
  });
}

/**
 * GET /api/v1/goals/:id/audit-bundle — deterministic read-only goal evidence
 * (V3 #140 / deferred P4). Consolidates the goal row (lifecycle + budgets +
 * retry_count + provenance), its plans and checkpoints, the full per-task audit
 * bundle for each child task, and the goal's own ordered event stream. Every
 * query is org-scoped on `organizationId` + the FK, so a cross-org goal_id is
 * never mounted. Child audit bundles come through `getTaskAuditBundle`
 * (already org-scoped + redacted); the goal/plan/checkpoint/event layer is
 * redacted here. This is a consolidated goal-level proof, not a replacement for
 * the per-task bundles it composes.
 */
export async function getGoalAuditBundle(ctx: ServerContext, goalId: string): Promise<GoalAuditBundle> {
  const db = ctx.db.db;
  const goalRow = (
    await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)))
  )[0];
  if (goalRow === undefined) {
    throw AppError.notFound(`goal not found: ${goalId}`, { goal_id: goalId });
  }

  const roomRow =
    goalRow.roomId != null
      ? (
          await db
            .select()
            .from(rooms)
            .where(and(eq(rooms.id, goalRow.roomId), eq(rooms.organizationId, ctx.organizationId)))
        )[0]
      : undefined;
  const planRows = await db
    .select()
    .from(plans)
    .where(and(eq(plans.organizationId, ctx.organizationId), eq(plans.goalId, goalId)))
    .orderBy(asc(plans.version), asc(plans.id));
  const checkpointRows = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.organizationId, ctx.organizationId), eq(checkpoints.goalId, goalId)))
    .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id));
  const childTaskRows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goalId)))
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  // Compose the existing per-task audit bundle for each child (org-scoped + redacted).
  const childBundles: TaskAuditBundle[] = [];
  for (const child of childTaskRows) {
    childBundles.push(await getTaskAuditBundle(ctx, child.id));
  }
  // The goal's own lifecycle event stream (goal.* events threaded with goal_id or
  // correlated on the goal id). Child task/run event detail lives inside each
  // child bundle above, so this stays the goal-level slice without duplication.
  const eventRows = await db
    .select()
    .from(eventLog)
    .where(
      and(
        eq(eventLog.organizationId, ctx.organizationId),
        or(eq(eventLog.goalId, goalId), eq(eventLog.correlationId, goalId)),
      ),
    )
    .orderBy(asc(eventLog.position));

  const bundle = GoalAuditBundleSchema.parse({
    goal: mapGoal(goalRow),
    room: roomRow !== undefined ? mapRoom(roomRow) : null,
    plans: planRows.map(mapPlan),
    checkpoints: checkpointRows.map(mapCheckpoint),
    tasks: childBundles,
    events: eventRows.map(mapAuditEvent),
  });
  return redactGoalAuditBundle(bundle);
}

/** Exportable v1alpha1 goal-level evidence envelope. Unsigned until key management exists. */
export async function exportGoalAuditBundle(ctx: ServerContext, goalId: string): Promise<GoalAuditBundleExport> {
  const bundle = await getGoalAuditBundle(ctx, goalId);
  return GoalAuditBundleExportSchema.parse({
    schema_version: "v1alpha1",
    exported_at: ctx.clock.nowIso(),
    bundle_sha256: sha256(stableJson(bundle)),
    bundle,
    signature: null,
    signing: {
      status: "deferred",
      reason: "v1 does not manage signing keys yet",
    },
  });
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sha256(input: string): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
