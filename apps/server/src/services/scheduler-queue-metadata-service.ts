import { appendEvent, computers, schedulerTaskQueueMetadata, tasks } from "@artoo/db";
import { SchedulerQueueMetadataV1Schema } from "@artoo/domain";
import type { SchedulerQueueMetadataV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import { requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";

function mapMetadata(row: typeof schedulerTaskQueueMetadata.$inferSelect) {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1)
    throw AppError.conflict("Invalid queue metadata revision");
  const parsed = SchedulerQueueMetadataV1Schema.safeParse({
    version: row.version,
    not_before_ms: row.notBeforeMs,
    preferred_computer_id: row.preferredComputerId,
    prefer_until_ms: row.preferUntilMs,
  });
  if (!parsed.success) throw AppError.conflict("Invalid persisted queue metadata");
  return {
    task_id: row.taskId,
    project_id: row.projectId,
    revision: row.revision,
    metadata: parsed.data,
    updated_by_user_id: row.updatedByUserId,
    updated_at: row.updatedAt,
  };
}

/** The Task lock held by writers serializes policy edits with decision capture. */
export async function readSchedulerQueueMetadata(ctx: ServerContext, tx: DrizzleDb, taskId: string, projectId: string) {
  const [row] = await tx.select().from(schedulerTaskQueueMetadata).where(eq(schedulerTaskQueueMetadata.taskId, taskId));
  if (!row) return null;
  if (row.organizationId !== ctx.organizationId || row.projectId !== projectId)
    throw AppError.conflict("Queue metadata identity mismatch");
  return mapMetadata(row);
}

export async function getSchedulerQueueMetadata(ctx: ServerContext, taskId: string) {
  return ctx.db.transaction(async (tx) => {
    const [task] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)));
    if (!task) throw AppError.notFound("task not found");
    return readSchedulerQueueMetadata(ctx, tx, taskId, task.projectId);
  });
}

/** Explicit administrator staging only. Does not change Task state, Run or dispatch. */
export async function putSchedulerQueueMetadata(ctx: ServerContext, taskId: string, input: unknown) {
  const parsed = SchedulerQueueMetadataV1Schema.safeParse(input);
  if (!parsed.success) throw AppError.validation("invalid version 1 queue metadata");
  return ctx.db.transaction(async (tx) => {
    await requireAdministrator(ctx, tx);
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
      .for("update");
    if (!task) throw AppError.notFound("task not found");
    if (!["backlog", "ready"].includes(task.status))
      throw AppError.invalidState("Queue metadata can only change while a task is backlog or ready");
    if (parsed.data.preferred_computer_id !== null) {
      const [computer] = await tx
        .select({ id: computers.id })
        .from(computers)
        .where(
          and(
            eq(computers.id, parsed.data.preferred_computer_id),
            eq(computers.organizationId, ctx.organizationId),
            isNull(computers.deletedAt),
          ),
        )
        .for("share");
      if (!computer) throw AppError.notFound("preferred computer not found");
    }
    const old = await readSchedulerQueueMetadata(ctx, tx, taskId, task.projectId);
    if (old && old.revision >= Number.MAX_SAFE_INTEGER) throw AppError.conflict("Queue metadata revision exhausted");
    const metadata: SchedulerQueueMetadataV1 = parsed.data;
    const values = {
      organizationId: ctx.organizationId,
      projectId: task.projectId,
      version: metadata.version,
      revision: (old?.revision ?? 0) + 1,
      notBeforeMs: metadata.not_before_ms,
      preferredComputerId: metadata.preferred_computer_id,
      preferUntilMs: metadata.prefer_until_ms,
      updatedByUserId: ctx.actorUserId,
      updatedAt: ctx.clock.nowIso(),
    };
    const [row] = await tx
      .insert(schedulerTaskQueueMetadata)
      .values({ ...values, taskId })
      .onConflictDoUpdate({
        target: schedulerTaskQueueMetadata.taskId,
        set: values,
        setWhere: and(
          eq(schedulerTaskQueueMetadata.organizationId, ctx.organizationId),
          eq(schedulerTaskQueueMetadata.projectId, task.projectId),
        ),
      })
      .returning();
    if (!row) throw AppError.conflict("Queue metadata identity changed");
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "scheduler.queue-metadata.updated",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: taskId,
        taskId,
        projectId: task.projectId,
        payload: { version: 1, revision: row.revision, metadata, execution_authorized: false },
      }),
    );
    return mapMetadata(row);
  });
}
