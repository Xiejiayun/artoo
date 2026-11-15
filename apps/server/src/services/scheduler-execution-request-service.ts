import { appendEvent, schedulerExecutionRequests, tasks } from "@artoo/db";
import {
  CreateSchedulerExecutionRequestV2Schema,
  SchedulerExecutionRequestSnapshotV2Schema,
  normalizeLeasePath,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, or } from "drizzle-orm";
import { auditDigestV1 } from "../audit-signature.js";
import { requireAdministrator, requireCurrentTeamMember } from "../auth/request-auth.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import {
  captureSchedulerRequestBindings,
  lockSchedulerRequestTask,
  schedulerTaskVersion,
} from "./scheduler-request-bindings.js";

type ExecutionRequestRow = typeof schedulerExecutionRequests.$inferSelect;

export function checkSchedulerExecutionRequestSnapshot(row: ExecutionRequestRow) {
  const parsed = SchedulerExecutionRequestSnapshotV2Schema.safeParse(row.snapshot);
  if (
    !parsed.success ||
    row.version !== 2 ||
    auditDigestV1(parsed.data) !== row.snapshotDigest ||
    parsed.data.organization_id !== row.organizationId ||
    parsed.data.project_id !== row.projectId ||
    parsed.data.task_id !== row.taskId ||
    parsed.data.actor_user_id !== row.actorUserId ||
    parsed.data.request.agent_id !== row.agentId ||
    parsed.data.request.request_key !== row.requestKey
  )
    throw AppError.conflict("Scheduling execution request identity or immutable snapshot changed");
  return parsed.data;
}

/** Stores conditional permission only. No consumer, reservation, Run or dispatch is implemented here. */
export async function createSchedulerExecutionRequest(ctx: ServerContext, taskId: string, input: unknown) {
  const parsed = CreateSchedulerExecutionRequestV2Schema.safeParse(input);
  if (!parsed.success) throw AppError.validation("Invalid explicit version 2 execution request");
  const request = parsed.data;
  if (ctx.automationActor) throw AppError.permissionDenied("An explicit original-user scheduling request is required");
  for (const path of request.write_paths)
    if (!normalizeLeasePath("", path).ok) throw AppError.validation("Invalid write path");
  return ctx.db.db
    .transaction(
      async (tx) => {
        await requireCurrentTeamMember(ctx, tx);
        const task = await lockSchedulerRequestTask(ctx, tx, taskId);
        if (
          !schedulerRolloutEnabled(ctx.schedulerRollout, "execution_requests", {
            organizationId: ctx.organizationId,
            projectId: task.projectId,
          })
        )
          throw AppError.conflict("Execution request staging is disabled");
        const existing = await tx
          .select()
          .from(schedulerExecutionRequests)
          .where(
            and(
              eq(schedulerExecutionRequests.taskId, taskId),
              or(
                eq(schedulerExecutionRequests.requestKey, request.request_key),
                eq(schedulerExecutionRequests.state, "pending"),
              ),
            ),
          );
        const replay = existing.find((row) => row.requestKey === request.request_key);
        if (replay) {
          const snapshot = checkSchedulerExecutionRequestSnapshot(replay);
          if (
            replay.organizationId !== ctx.organizationId ||
            replay.projectId !== task.projectId ||
            replay.actorUserId !== ctx.actorUserId ||
            auditDigestV1(snapshot.request) !== auditDigestV1(request)
          )
            throw AppError.conflict("Scheduling request key already has different inputs");
          return replay;
        }
        if (existing.some((row) => row.state === "pending"))
          throw AppError.conflict("Cancel the existing execution request before staging another");
        if (request.base_version !== (await schedulerTaskVersion(ctx, tx, taskId, false)))
          throw AppError.conflict("Task version changed; read it again before staging");
        const sharing = await requireAiSharingAuthorization(ctx, tx);
        const bindings = await captureSchedulerRequestBindings(ctx, tx, task, request);
        const snapshot = SchedulerExecutionRequestSnapshotV2Schema.parse({
          version: 2,
          organization_id: ctx.organizationId,
          project_id: task.projectId,
          task_id: taskId,
          actor_user_id: ctx.actorUserId,
          request,
          ai_sharing: { consent_id: sharing.consentId, policy_version: sharing.policyVersion },
          ...bindings,
        });
        const [row] = await tx
          .insert(schedulerExecutionRequests)
          .values({
            id: ctx.idGen.generate("scheduler_execution_request"),
            organizationId: ctx.organizationId,
            projectId: task.projectId,
            taskId,
            agentId: request.agent_id,
            actorUserId: ctx.actorUserId,
            requestKey: request.request_key,
            snapshot,
            snapshotDigest: auditDigestV1(snapshot),
            createdAt: ctx.clock.nowIso(),
          })
          .returning();
        if (!row) throw AppError.conflict("Scheduling execution request was not persisted");
        await appendEvent(
          tx,
          buildEvent(ctx, {
            type: "scheduler.execution_request.created",
            actorType: "user",
            actorId: ctx.actorUserId,
            correlationId: row.id,
            projectId: row.projectId,
            taskId,
            payload: {
              version: 2,
              request_id: row.id,
              agent_id: row.agentId,
              snapshot_digest: row.snapshotDigest,
              permission: "execute_once",
            },
          }),
        );
        return row;
      },
      { isolationLevel: "repeatable read" },
    )
    .catch((error: unknown) => {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const databaseError = cause as { code?: string; constraint?: string } | null;
      if (
        databaseError?.code === "40001" ||
        (databaseError?.code === "23505" &&
          (databaseError.constraint === "scheduler_execution_request_pending_task_idx" ||
            databaseError.constraint === "scheduler_execution_request_key_unique"))
      )
        throw AppError.conflict(
          "Concurrent execution request update; read the current Task and requests before retrying",
        );
      throw error;
    });
}

export async function listSchedulerExecutionRequests(ctx: ServerContext, taskId: string) {
  const [task] = await ctx.db.db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.notFound("task not found");
  const rows = await ctx.db.db
    .select()
    .from(schedulerExecutionRequests)
    .where(
      and(
        eq(schedulerExecutionRequests.taskId, taskId),
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
      ),
    )
    .orderBy(desc(schedulerExecutionRequests.createdAt), desc(schedulerExecutionRequests.id))
    .limit(50);
  for (const row of rows) {
    if (row.projectId !== task.projectId) throw AppError.conflict("Scheduling execution request project changed");
    checkSchedulerExecutionRequestSnapshot(row);
  }
  return rows;
}

export async function cancelSchedulerExecutionRequest(ctx: ServerContext, taskId: string, requestId: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    const task = await lockSchedulerRequestTask(ctx, tx, taskId);
    const [row] = await tx
      .select()
      .from(schedulerExecutionRequests)
      .where(
        and(
          eq(schedulerExecutionRequests.id, requestId),
          eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
          eq(schedulerExecutionRequests.taskId, taskId),
        ),
      );
    if (!row) throw AppError.notFound("Scheduling execution request not found");
    if (row.projectId !== task.projectId) throw AppError.conflict("Scheduling execution request project changed");
    checkSchedulerExecutionRequestSnapshot(row);
    if (row.actorUserId !== ctx.actorUserId) await requireAdministrator(ctx, tx);
    if (row.state === "consumed")
      throw AppError.conflict("Execution request was consumed; stop its Run through the normal lifecycle");
    if (row.state === "cancelled") return row;
    const [cancelled] = await tx
      .update(schedulerExecutionRequests)
      .set({ state: "cancelled", cancelledAt: ctx.clock.nowIso(), cancelledByUserId: ctx.actorUserId })
      .where(eq(schedulerExecutionRequests.id, row.id))
      .returning();
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "scheduler.execution_request.cancelled",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: row.id,
        projectId: row.projectId,
        taskId,
        payload: { version: 2, request_id: row.id, snapshot_digest: row.snapshotDigest, permission: "execute_once" },
      }),
    );
    return cancelled!;
  });
}

/** Caller holds the Task lock. This bounded snapshot check is NOT active execution admission.
 * A future consumer must also fence current writers, run legacy gates, reserve capacity and bind a real attempt. */
export async function validateSchedulerExecutionRequestSnapshot(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  requestId: string,
) {
  const [row] = await tx
    .select()
    .from(schedulerExecutionRequests)
    .where(
      and(
        eq(schedulerExecutionRequests.id, requestId),
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
        eq(schedulerExecutionRequests.taskId, task.id),
        eq(schedulerExecutionRequests.projectId, task.projectId),
      ),
    );
  if (!row || row.state !== "pending") throw AppError.conflict("Scheduling execution request is missing or cancelled");
  const snapshot = checkSchedulerExecutionRequestSnapshot(row);
  const original = { ...ctx, actorUserId: row.actorUserId, automationActor: undefined };
  await requireCurrentTeamMember(original, tx);
  await requireAiSharingAuthorization(original, tx, {
    consentId: snapshot.ai_sharing.consent_id,
    policyVersion: snapshot.ai_sharing.policy_version,
  });
  const current = await captureSchedulerRequestBindings(original, tx, task, snapshot.request);
  for (const key of [
    "task_input_version",
    "task_input_digest",
    "queue_revision",
    "policy_revisions",
    "configuration_digest",
  ] as const)
    if (auditDigestV1(current[key]) !== auditDigestV1(snapshot[key]))
      throw AppError.conflict(`Scheduling execution request ${key} changed; a new request is required`);
  return { row, snapshot };
}
