import {
  agentInstances,
  agents,
  computers,
  projects,
  runs,
  tasks,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
} from "@artoo/db";
import {
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerProjectPolicyV1Schema,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, is, isNull, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { ServerContext } from "../context.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import { AppError } from "../errors.js";
import { collectSchedulerOccupants, schedulerOccupancy } from "./scheduler-shadow-snapshot.js";

/** All writers in an opted-in organization protect shared Agent/computer quotas. */
export function schedulerCapacityEnabled(ctx: ServerContext): boolean {
  const workspace = ctx.schedulerRollout?.workspaces[ctx.organizationId];
  return (
    workspace?.flags?.capacity_admission === true ||
    Object.values(workspace?.projects ?? {}).some((project) => project.capacity_admission === true)
  );
}

export function schedulerCapacityStatus(ctx: ServerContext, projectId?: string) {
  return {
    version: 1 as const,
    shared_quotas_enabled: schedulerCapacityEnabled(ctx),
    project_quota_enabled:
      projectId === undefined
        ? null
        : schedulerRolloutEnabled(ctx.schedulerRollout, "capacity_admission", {
            organizationId: ctx.organizationId,
            projectId,
          }),
  };
}

/**
 * Never wait for this mutex while holding an owner's Task/device/workspace locks.
 * A contender must roll back and retry its WHOLE operation. Fresh read-committed
 * statements after this lock observe every previously committed reservation.
 */
export async function lockSchedulerCapacity(ctx: ServerContext, tx: DrizzleDb) {
  if (!schedulerCapacityEnabled(ctx)) return false;
  if (!is(tx, PgTransaction))
    throw AppError.conflict("Capacity admission requires a database transaction", {
      reason: "scheduler_capacity_transaction",
    });
  const result = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(1095914313, hashtext(${ctx.organizationId})) AS acquired`,
  );
  if (result.rows[0]?.acquired !== true)
    throw AppError.conflict("Scheduling capacity is busy; retry the complete operation", {
      reason: "scheduler_capacity_busy",
    });
  const isolation = await tx.execute(sql`SHOW transaction_isolation`);
  if (isolation.rows[0]?.transaction_isolation !== "read committed")
    throw AppError.conflict("Capacity admission requires read committed isolation", {
      reason: "scheduler_capacity_transaction",
    });
  return true;
}

interface CapacityReservation {
  key: string;
  projectId: string;
  taskId?: string;
  computerId: string;
  participantInstanceIds: readonly string[];
}

const sameIds = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

/** Caller persists its original reservation in THIS transaction after admission. */
export async function assertSchedulerCapacity(ctx: ServerContext, tx: DrizzleDb, input: CapacityReservation) {
  if (!(await lockSchedulerCapacity(ctx, tx))) return;
  const instanceIds = [...new Set(input.participantInstanceIds)];
  if (
    !instanceIds.length ||
    !/^(run|handoff|review|design_review|execution_review|validation_review|recovery_validation_review|clean_validation_review):.+$/.test(
      input.key,
    )
  )
    throw AppError.conflict("Invalid capacity reservation identity", { reason: "scheduler_capacity_binding" });
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.organizationId, ctx.organizationId)));
  const [computer] = await tx
    .select({ id: computers.id })
    .from(computers)
    .where(
      and(
        eq(computers.id, input.computerId),
        eq(computers.organizationId, ctx.organizationId),
        isNull(computers.deletedAt),
      ),
    );
  const participants = await tx
    .select({
      id: agentInstances.id,
      agentId: agentInstances.agentId,
      computerId: agentInstances.computerId,
      projectId: agentInstances.projectId,
    })
    .from(agentInstances)
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentInstances.agentId),
        eq(agents.organizationId, ctx.organizationId),
        isNull(agents.deletedAt),
      ),
    )
    .where(
      and(
        eq(agentInstances.organizationId, ctx.organizationId),
        inArray(agentInstances.id, instanceIds),
        isNull(agentInstances.deletedAt),
      ),
    );
  if (
    !project ||
    !computer ||
    participants.length !== instanceIds.length ||
    participants.some(
      (p) => p.computerId !== input.computerId || (p.projectId !== null && p.projectId !== input.projectId),
    )
  )
    throw AppError.conflict("Capacity reservation has mismatched project, computer or participants", {
      reason: "scheduler_capacity_binding",
    });
  const agentIds = [...new Set(participants.map((p) => p.agentId))];
  const [projectPolicy] = await tx
    .select()
    .from(schedulerProjectPolicies)
    .where(
      and(
        eq(schedulerProjectPolicies.organizationId, ctx.organizationId),
        eq(schedulerProjectPolicies.projectId, input.projectId),
      ),
    );
  const [computerPolicy] = await tx
    .select()
    .from(schedulerComputerPolicies)
    .where(
      and(
        eq(schedulerComputerPolicies.organizationId, ctx.organizationId),
        eq(schedulerComputerPolicies.computerId, input.computerId),
      ),
    );
  const agentPolicies = await tx
    .select()
    .from(schedulerAgentPolicies)
    .where(
      and(
        eq(schedulerAgentPolicies.organizationId, ctx.organizationId),
        inArray(schedulerAgentPolicies.agentId, agentIds),
      ),
    );
  const projectEnabled = schedulerCapacityStatus(ctx, input.projectId).project_quota_enabled;
  if (projectEnabled && (!projectPolicy || !computerPolicy || agentPolicies.length !== agentIds.length))
    throw AppError.conflict("Explicit project, Agent and computer capacity policies are required", {
      reason: "scheduler_capacity_missing_policy",
    });
  const projectParsed = projectPolicy && SchedulerProjectPolicyV1Schema.safeParse(projectPolicy.policy);
  const computerParsed = computerPolicy && SchedulerComputerPolicyV1Schema.safeParse(computerPolicy.policy);
  const agentsParsed = agentPolicies.map((row) => ({
    id: row.agentId,
    parsed: SchedulerAgentPolicyV1Schema.safeParse(row.policy),
  }));
  if (
    (projectEnabled && projectParsed && !projectParsed.success) ||
    (computerParsed && !computerParsed.success) ||
    agentsParsed.some((row) => !row.parsed.success)
  )
    throw AppError.conflict("Invalid scheduling capacity policy", { reason: "scheduler_capacity_invalid_policy" });

  const occupants = await collectSchedulerOccupants(ctx, tx);
  const existing = occupants.find((row) => row.key === input.key);
  if (existing) {
    if (
      existing.project_id !== input.projectId ||
      existing.computer_id !== input.computerId ||
      existing.task_id !== (input.taskId ?? null) ||
      !sameIds(existing.agent_ids, agentIds) ||
      !existing.agent_instance_ids ||
      !sameIds(existing.agent_instance_ids, instanceIds)
    )
      throw AppError.conflict("Existing capacity reservation binding changed", {
        reason: "scheduler_capacity_binding",
      });
    // An already counted delivery may be replayed after a quota is lowered.
    // Its owner must still enforce all original start/session/closure fences.
    return;
  }
  const occupancy = schedulerOccupancy(input.projectId, occupants);
  const check = (kind: "project" | "agent" | "computer", id: string, count: number, limit: number) => {
    if (count >= limit)
      throw AppError.conflict(`Scheduling ${kind} capacity is exhausted`, {
        reason: "scheduler_capacity_exceeded",
        kind,
        target_id: id,
        occupied: count,
        limit,
      });
  };
  if (projectEnabled && projectParsed?.success)
    check("project", input.projectId, occupancy.project, projectParsed.data.max_concurrent_runs);
  if (computerParsed?.success)
    check(
      "computer",
      input.computerId,
      occupancy.computers[input.computerId] ?? 0,
      computerParsed.data.max_concurrent_runs,
    );
  for (const row of agentsParsed)
    if (row.parsed.success) check("agent", row.id, occupancy.agents[row.id] ?? 0, row.parsed.data.max_concurrent_runs);
}

/** Single Run insert owner. Authorization, lifecycle and dispatch stay with callers. */
export async function persistRunReservation(ctx: ServerContext, tx: DrizzleDb, values: typeof runs.$inferInsert) {
  if (schedulerCapacityEnabled(ctx)) {
    if (values.organizationId !== ctx.organizationId)
      throw AppError.conflict("Run capacity tenant changed", { reason: "scheduler_capacity_binding" });
    const [task] = await tx
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.id, values.taskId), eq(tasks.organizationId, ctx.organizationId)));
    if (!task) throw AppError.notFound("Run capacity task not found");
    await assertSchedulerCapacity(ctx, tx, {
      key: `run:${values.id}`,
      projectId: task.projectId,
      taskId: values.taskId,
      computerId: values.computerId,
      participantInstanceIds: [values.agentInstanceId],
    });
  }
  return await tx.insert(runs).values(values);
}
