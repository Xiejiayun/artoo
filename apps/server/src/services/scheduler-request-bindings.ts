import {
  agentInstances,
  agents,
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
  schedulerProjectPolicies,
  skillInstalls,
  tasks,
} from "@artoo/db";
import {
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerProjectPolicyV1Schema,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { auditDigestV1 } from "../audit-signature.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { assertExecutionApprovalGranted } from "./approval-service.js";
import { readSchedulerQueueMetadata } from "./scheduler-queue-metadata-service.js";
import { readTaskSourceInputs } from "./task-source-input-service.js";

// Only these request-audit records are metadata. All other Task events remain inputs.
const metadataEvents = [
  "scheduler.intent.created",
  "scheduler.intent.cancelled",
  "scheduler.execution_request.created",
  "scheduler.execution_request.cancelled",
  "scheduler.start_grant.created",
  "scheduler.execution_lease.created",
  "scheduler.execution_lease.renewed",
  "scheduler.execution_lease.expired",
  "scheduler.execution_lease.revoked",
];

export async function schedulerTaskVersion(ctx: ServerContext, tx: DrizzleDb, taskId: string, inputsOnly: boolean) {
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

export async function lockSchedulerRequestTask(ctx: ServerContext, tx: DrizzleDb, taskId: string) {
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    .for("update");
  if (!task) throw AppError.notFound("task not found");
  return task;
}

async function assertPlainTaskOwner(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect) {
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
}

/** Caller holds the Task lock. Configuration reads are a bounded snapshot, not real admission. */
export async function captureSchedulerRequestBindings(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  request: { agent_id: string },
) {
  if (task.status !== "ready") throw AppError.invalidState("Only a ready task can stage a scheduling intent");
  await assertPlainTaskOwner(ctx, tx, task);
  await assertExecutionApprovalGranted(ctx, tx, task.id);
  return collectSchedulerBindings(ctx, tx, task, request);
}

/** Captures the actual post-assignment Task. Never reconstruct a ready Task or refresh user permission. */
export async function captureSchedulerAssignedBindings(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  request: { agent_id: string },
) {
  if (task.status !== "assigned") throw AppError.invalidState("Prepared scheduling start requires an assigned task");
  await assertPlainTaskOwner(ctx, tx, task);
  return collectSchedulerBindings(ctx, tx, task, request);
}

async function collectSchedulerBindings(
  ctx: ServerContext,
  tx: DrizzleDb,
  task: typeof tasks.$inferSelect,
  request: { agent_id: string },
) {
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
    task_input_version: await schedulerTaskVersion(ctx, tx, task.id, true),
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
