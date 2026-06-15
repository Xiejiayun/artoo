import { createHash } from "node:crypto";

import {
  artifacts,
  approvals,
  eventLog,
  messages,
  rooms,
  runs,
  schedulerDecisions,
  tasks,
} from "@artoo/db";
import {
  AuditBundleExportSchema,
  TaskAuditBundleSchema,
  type AuditBundleExport,
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
import { redactTaskAuditBundle } from "./redaction.js";

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

  const bundle = TaskAuditBundleSchema.parse({
    task: mapTask(taskRow),
    room: roomRow !== undefined ? mapRoom(roomRow) : null,
    messages: messageRows.map(mapMessage),
    runs: runRows.map(mapRun),
    artifacts: artifactRows.map(mapArtifact),
    approvals: approvalRows.map(mapApproval),
    scheduler_decisions: schedulerDecisionRows.map(mapSchedulerDecision),
    events: eventRows.map(mapAuditEvent),
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
