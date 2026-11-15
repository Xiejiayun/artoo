import {
  agentInstances,
  agents,
  appendEvent,
  approvals,
  assistantTurns,
  autonomousReviews,
  computers,
  discussions,
  effortProfiles,
  eventLog,
  modelProfiles,
  projects,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerIntents,
  schedulerProjectPolicies,
  skillInstalls,
  tasks,
} from "@artoo/db";
import {
  CreateSchedulerIntentV1Schema,
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerIntentSnapshotV1Schema,
  SchedulerProjectPolicyV1Schema,
  normalizeLeasePath,
  type CreateSchedulerIntentV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { auditDigestV1 } from "../audit-signature.js";
import { requireAdministrator, requireCurrentTeamMember } from "../auth/request-auth.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { assertExecutionApprovalGranted } from "./approval-service.js";
import { readSchedulerQueueMetadata } from "./scheduler-queue-metadata-service.js";
import { readTaskSourceInputs } from "./task-source-input-service.js";

const metadataEvents = ["scheduler.intent.created", "scheduler.intent.cancelled"];
type IntentRow = typeof schedulerIntents.$inferSelect;

async function taskVersion(ctx: ServerContext, tx: DrizzleDb, taskId: string, inputsOnly: boolean) {
  const [event] = await tx
    .select({ position: eventLog.position })
    .from(eventLog)
    .where(
      and(
        eq(eventLog.organizationId, ctx.organizationId),
        eq(eventLog.taskId, taskId),
        inputsOnly ? notInArray(eventLog.type, metadataEvents) : undefined,
      ),
    )
    .orderBy(desc(eventLog.position))
    .limit(1);
  if (!event || !Number.isSafeInteger(event.position) || event.position < 1)
    throw AppError.conflict("Task has no supported durable input version");
  return event.position;
}

async function lockTask(ctx: ServerContext, tx: DrizzleDb, taskId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    .for("update");
  if (!task) throw AppError.notFound("task not found");
  return task;
}

async function assertPlainTask(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect) {
  if (task.status !== "ready") throw AppError.invalidState("Only a ready task can stage a scheduling intent");
  const linked = [
    ...(await tx.select({ id: discussions.id }).from(discussions).where(eq(discussions.taskId, task.id)).limit(1)),
    ...(await tx
      .select({ id: autonomousReviews.id })
      .from(autonomousReviews)
      .where(eq(autonomousReviews.reviewTaskId, task.id))
      .limit(1)),
    ...(await tx
      .select({ id: assistantTurns.id })
      .from(assistantTurns)
      .where(eq(assistantTurns.taskId, task.id))
      .limit(1)),
  ];
  if (task.goalId || task.executionPolicyTaskId || task.sourcePlanId || linked.length)
    throw AppError.conflict("This task retains its dedicated planning, assistant or product execution owner");
  await assertExecutionApprovalGranted(ctx, tx, task.id);
}

/** Caller holds the Task lock. Configuration reads are a bounded snapshot, not real admission. */
async function captureBindings(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  request: CreateSchedulerIntentV1,
) {
  await assertPlainTask(ctx, tx, task);
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, task.projectId), eq(projects.organizationId, ctx.organizationId)));
  const [agent] = await tx
    .select()
    .from(agents)
    .where(
      and(eq(agents.id, request.agent_id), eq(agents.organizationId, ctx.organizationId), isNull(agents.deletedAt)),
    );
  if (!project || !agent) throw AppError.notFound("Scheduling project or Agent not found");
  const [projectPolicy] = await tx
    .select()
    .from(schedulerProjectPolicies)
    .where(
      and(
        eq(schedulerProjectPolicies.projectId, project.id),
        eq(schedulerProjectPolicies.organizationId, ctx.organizationId),
      ),
    );
  const [agentPolicy] = await tx
    .select()
    .from(schedulerAgentPolicies)
    .where(
      and(eq(schedulerAgentPolicies.agentId, agent.id), eq(schedulerAgentPolicies.organizationId, ctx.organizationId)),
    );
  if (!projectPolicy || !agentPolicy)
    throw AppError.conflict("Explicit project and Agent scheduling policies are required");
  SchedulerProjectPolicyV1Schema.parse(projectPolicy.policy);
  const agentSettings = SchedulerAgentPolicyV1Schema.parse(agentPolicy.policy);
  const instances = await tx
    .select({
      id: agentInstances.id,
      projectId: agentInstances.projectId,
      computerId: agentInstances.computerId,
      runtime: agentInstances.runtime,
      modelProfileId: agentInstances.modelProfileId,
      effortProfileId: agentInstances.effortProfileId,
      workspaceRoot: agentInstances.workspaceRoot,
      config: agentInstances.config,
    })
    .from(agentInstances)
    .where(
      and(
        eq(agentInstances.organizationId, ctx.organizationId),
        eq(agentInstances.agentId, agent.id),
        isNull(agentInstances.deletedAt),
        or(eq(agentInstances.projectId, project.id), isNull(agentInstances.projectId)),
        agentSettings.pinned_computer_id ? eq(agentInstances.computerId, agentSettings.pinned_computer_id) : undefined,
      ),
    )
    .orderBy(asc(agentInstances.id))
    .limit(4097);
  if (!instances.length || instances.length > 4096)
    throw AppError.conflict("A bounded configured Agent instance pool is required");
  const computerIds = [...new Set(instances.map((instance) => instance.computerId))];
  const hosts = await tx
    .select({ id: computers.id, os: computers.os, arch: computers.arch, capabilities: computers.capabilities })
    .from(computers)
    .where(
      and(
        eq(computers.organizationId, ctx.organizationId),
        inArray(computers.id, computerIds),
        isNull(computers.deletedAt),
      ),
    )
    .orderBy(asc(computers.id));
  const hostPolicies = await tx
    .select()
    .from(schedulerComputerPolicies)
    .where(
      and(
        eq(schedulerComputerPolicies.organizationId, ctx.organizationId),
        inArray(schedulerComputerPolicies.computerId, computerIds),
      ),
    )
    .orderBy(asc(schedulerComputerPolicies.computerId));
  if (hosts.length !== computerIds.length || hostPolicies.length !== computerIds.length)
    throw AppError.conflict("Every configured candidate computer needs a scoped scheduling policy");
  for (const policy of hostPolicies) SchedulerComputerPolicyV1Schema.parse(policy.policy);
  // Capture the catalog used by legacy profile resolution, including its enabled
  // flags. Store only its digest, never model/instance configuration contents.
  const models = await tx
    .select()
    .from(modelProfiles)
    .where(eq(modelProfiles.organizationId, ctx.organizationId))
    .orderBy(asc(modelProfiles.id))
    .limit(4097);
  const efforts = await tx
    .select()
    .from(effortProfiles)
    .where(eq(effortProfiles.organizationId, ctx.organizationId))
    .orderBy(asc(effortProfiles.id))
    .limit(4097);
  const skills = await tx
    .select({
      id: skillInstalls.id,
      version: skillInstalls.version,
      enabled: skillInstalls.enabled,
      manifest: skillInstalls.manifest,
      capabilities: skillInstalls.capabilities,
      compatibleRuntimes: skillInstalls.compatibleRuntimes,
      permissionSummary: skillInstalls.permissionSummary,
    })
    .from(skillInstalls)
    .where(
      and(
        eq(skillInstalls.organizationId, ctx.organizationId),
        or(isNull(skillInstalls.projectId), eq(skillInstalls.projectId, project.id)),
      ),
    )
    .orderBy(asc(skillInstalls.id))
    .limit(4097);
  if ([models, efforts, skills].some((rows) => rows.length > 4096))
    throw AppError.conflict("Scheduling configuration exceeds the staging limit");
  if (
    instances.some(
      (instance) =>
        (instance.modelProfileId !== null && !models.some((model) => model.id === instance.modelProfileId)) ||
        (instance.effortProfileId !== null && !efforts.some((effort) => effort.id === instance.effortProfileId)),
    )
  )
    throw AppError.conflict("Agent instance profiles must belong to this organization");
  const queue = await readSchedulerQueueMetadata(ctx, tx, task.id, task.projectId);
  const source = await readTaskSourceInputs(ctx, tx, task.id);
  const gates = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.organizationId, ctx.organizationId), eq(approvals.taskId, task.id)))
    .orderBy(asc(approvals.id));
  return {
    task_input_version: await taskVersion(ctx, tx, task.id, true),
    task_input_digest: auditDigestV1({ task, source: source ?? null, approvals: gates }),
    queue_revision: queue?.revision ?? null,
    policy_revisions: {
      project: projectPolicy.revision,
      agent: agentPolicy.revision,
      computers: Object.fromEntries(hostPolicies.map((policy) => [policy.computerId, policy.revision])),
    },
    configuration_digest: auditDigestV1({
      project,
      agent: { id: agent.id, kind: agent.kind, capabilities: agent.capabilities },
      instances,
      computers: hosts,
      models,
      efforts,
      skills,
    }),
  };
}

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
        const task = await lockTask(ctx, tx, taskId);
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
        if (request.base_version !== (await taskVersion(ctx, tx, taskId, false)))
          throw AppError.conflict("Task version changed; read it again before staging");
        const sharing = await requireAiSharingAuthorization(ctx, tx);
        const bindings = await captureBindings(ctx, tx, task, request);
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
    const task = await lockTask(ctx, tx, taskId);
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
  const current = await captureBindings(original, tx, task, snapshot.request);
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
