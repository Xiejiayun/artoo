import { appendEvent, schedulerIntents, tasks } from "@artoo/db";
import { CreateSchedulerIntentV1Schema, SchedulerIntentSnapshotV1Schema, normalizeLeasePath } from "@artoo/domain";
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

type IntentRow = typeof schedulerIntents.$inferSelect;

function checkedSnapshot(row: IntentRow) {
  const parsed = SchedulerIntentSnapshotV1Schema.safeParse(row.snapshot);
  if (
    !parsed.success ||
    row.version !== 1 ||
    row.executionAuthorized ||
    auditDigestV1(parsed.data) !== row.snapshotDigest ||
    parsed.data.organization_id !== row.organizationId ||
    parsed.data.project_id !== row.projectId ||
    parsed.data.task_id !== row.taskId ||
    parsed.data.actor_user_id !== row.actorUserId ||
    parsed.data.request.agent_id !== row.agentId ||
    parsed.data.request.request_key !== row.requestKey
  )
    throw AppError.conflict("Scheduling intent identity or immutable snapshot changed");
  return parsed.data;
}

/** New requests are deliberately shadow-only until real admission and node claim exist. */
export async function createSchedulerIntent(ctx: ServerContext, taskId: string, input: unknown) {
  const parsed = CreateSchedulerIntentV1Schema.safeParse(input);
  if (!parsed.success) throw AppError.validation("Invalid version 1 shadow scheduling intent");
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
          !schedulerRolloutEnabled(ctx.schedulerRollout, "claim_shadow", {
            organizationId: ctx.organizationId,
            projectId: task.projectId,
          })
        )
          throw AppError.conflict("Shadow scheduling intent staging is disabled");
        const existing = await tx
          .select()
          .from(schedulerIntents)
          .where(
            and(
              eq(schedulerIntents.taskId, taskId),
              or(eq(schedulerIntents.requestKey, request.request_key), eq(schedulerIntents.state, "pending")),
            ),
          );
        const replay = existing.find((row) => row.requestKey === request.request_key);
        if (replay) {
          const snapshot = checkedSnapshot(replay);
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
          throw AppError.conflict("Cancel the existing scheduling intent before staging another");
        if (request.base_version !== (await schedulerTaskVersion(ctx, tx, taskId, false)))
          throw AppError.conflict("Task version changed; read it again before staging");
        const sharing = await requireAiSharingAuthorization(ctx, tx);
        const bindings = await captureSchedulerRequestBindings(ctx, tx, task, request);
        const snapshot = SchedulerIntentSnapshotV1Schema.parse({
          version: 1,
          organization_id: ctx.organizationId,
          project_id: task.projectId,
          task_id: taskId,
          actor_user_id: ctx.actorUserId,
          request,
          ai_sharing: { consent_id: sharing.consentId, policy_version: sharing.policyVersion },
          ...bindings,
          execution_authorized: false,
        });
        const [row] = await tx
          .insert(schedulerIntents)
          .values({
            id: ctx.idGen.generate("scheduler_intent"),
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
        if (!row) throw AppError.conflict("Scheduling intent was not persisted");
        await appendEvent(
          tx,
          buildEvent(ctx, {
            type: "scheduler.intent.created",
            actorType: "user",
            actorId: ctx.actorUserId,
            correlationId: row.id,
            projectId: row.projectId,
            taskId,
            payload: {
              version: 1,
              intent_id: row.id,
              agent_id: row.agentId,
              snapshot_digest: row.snapshotDigest,
              execution_authorized: false,
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
          (databaseError.constraint === "scheduler_intent_pending_task_idx" ||
            databaseError.constraint === "scheduler_intent_request_unique"))
      )
        throw AppError.conflict(
          "Concurrent scheduling intent update; read the current Task and intents before retrying",
        );
      throw error;
    });
}

export async function listSchedulerIntents(ctx: ServerContext, taskId: string) {
  const [task] = await ctx.db.db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.notFound("task not found");
  const rows = await ctx.db.db
    .select()
    .from(schedulerIntents)
    .where(and(eq(schedulerIntents.taskId, taskId), eq(schedulerIntents.organizationId, ctx.organizationId)))
    .orderBy(desc(schedulerIntents.createdAt), desc(schedulerIntents.id))
    .limit(50);
  for (const row of rows) {
    if (row.projectId !== task.projectId) throw AppError.conflict("Scheduling intent project changed");
    checkedSnapshot(row);
  }
  return rows;
}

export async function cancelSchedulerIntent(ctx: ServerContext, taskId: string, intentId: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    const task = await lockSchedulerRequestTask(ctx, tx, taskId);
    const [row] = await tx
      .select()
      .from(schedulerIntents)
      .where(
        and(
          eq(schedulerIntents.id, intentId),
          eq(schedulerIntents.organizationId, ctx.organizationId),
          eq(schedulerIntents.taskId, taskId),
        ),
      );
    if (!row) throw AppError.notFound("Scheduling intent not found");
    if (row.projectId !== task.projectId) throw AppError.conflict("Scheduling intent project changed");
    checkedSnapshot(row);
    if (row.actorUserId !== ctx.actorUserId) await requireAdministrator(ctx, tx);
    if (row.state === "cancelled") return row;
    const [cancelled] = await tx
      .update(schedulerIntents)
      .set({ state: "cancelled", cancelledAt: ctx.clock.nowIso(), cancelledByUserId: ctx.actorUserId })
      .where(eq(schedulerIntents.id, row.id))
      .returning();
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "scheduler.intent.cancelled",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: row.id,
        projectId: row.projectId,
        taskId,
        payload: { version: 1, intent_id: row.id, snapshot_digest: row.snapshotDigest, execution_authorized: false },
      }),
    );
    return cancelled!;
  });
}

/** Caller holds the Task lock. Rebuild authority from the original user, never a daemon's default actor. */
export async function validateSchedulerIntentForShadow(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  intentId: string,
) {
  const [row] = await tx
    .select()
    .from(schedulerIntents)
    .where(
      and(
        eq(schedulerIntents.id, intentId),
        eq(schedulerIntents.organizationId, ctx.organizationId),
        eq(schedulerIntents.taskId, task.id),
        eq(schedulerIntents.projectId, task.projectId),
      ),
    );
  if (!row || row.state !== "pending") throw AppError.conflict("Scheduling intent is missing or cancelled");
  const snapshot = checkedSnapshot(row);
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
      throw AppError.conflict(`Scheduling intent ${key} changed; a new request is required`);
  return { row, snapshot };
}
