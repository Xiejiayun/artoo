import {
  agentInstances,
  agentRuntimes,
  fileLeases,
  goals,
  runs,
  tasks,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
} from "@artoo/db";
import { isActiveRunStatus, isRuntimeStale, SchedulerRankingSnapshotV1Schema } from "@artoo/domain";
import type { SchedulerRankingSnapshotV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { RUNTIME_STALE_AFTER_MS } from "../config/runtime-staleness.js";
import { unconfirmedDisconnectRunIds, unsettledStandaloneExecutions } from "./execution-state.js";
import type { SchedulerCandidate } from "./scheduler.js";
import { readSchedulerQueueMetadata } from "./scheduler-queue-metadata-service.js";

export interface SchedulerOccupant {
  /** Includes its namespace: dedicated operation ids are never Run ids. */
  key: string;
  project_id: string;
  task_id: string | null;
  computer_id: string;
  agent_ids: string[];
  agent_instance_ids?: string[];
  evidence?: string[];
}

/** Observed facts only. Does not lock or reserve real admission capacity. */
export async function collectSchedulerOccupants(ctx: ServerContext, tx: DrizzleDb): Promise<SchedulerOccupant[]> {
  const runRows = await tx
    .select({ run: runs, projectId: tasks.projectId, agentId: agentInstances.agentId })
    .from(runs)
    .innerJoin(tasks, and(eq(tasks.id, runs.taskId), eq(tasks.organizationId, ctx.organizationId)))
    .innerJoin(
      agentInstances,
      and(eq(agentInstances.id, runs.agentInstanceId), eq(agentInstances.organizationId, ctx.organizationId)),
    )
    .where(eq(runs.organizationId, ctx.organizationId));
  const held = await tx
    .select({ runId: fileLeases.runId })
    .from(fileLeases)
    .where(and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.status, "held")));
  const heldIds = new Set(held.map((row) => row.runId));
  const unconfirmedIds = new Set(await unconfirmedDisconnectRunIds(ctx, tx, {}));
  const occupants = new Map<string, SchedulerOccupant>();
  for (const { run, projectId, agentId } of runRows) {
    if (!isActiveRunStatus(run.status) && !heldIds.has(run.id) && !unconfirmedIds.has(run.id)) continue;
    occupants.set(`run:${run.id}`, {
      key: `run:${run.id}`,
      project_id: projectId,
      task_id: run.taskId,
      computer_id: run.computerId,
      agent_ids: [agentId],
      agent_instance_ids: [run.agentInstanceId],
      evidence: [
        ...(isActiveRunStatus(run.status) ? ["active_run"] : []),
        ...(heldIds.has(run.id) ? ["held_file_lease"] : []),
        ...(unconfirmedIds.has(run.id) ? ["unconfirmed_disconnect"] : []),
      ],
    });
  }
  const operations = await unsettledStandaloneExecutions(ctx, tx);
  if (operations.length > 0) {
    const projectRows = await tx
      .select({ id: goals.id, projectId: goals.projectId })
      .from(goals)
      .where(
        and(
          eq(goals.organizationId, ctx.organizationId),
          inArray(goals.id, [...new Set(operations.map((op) => op.goalId))]),
        ),
      );
    const participants = [...new Set(operations.flatMap((op) => op.participantInstanceIds))];
    const instances = await tx
      .select({ id: agentInstances.id, agentId: agentInstances.agentId })
      .from(agentInstances)
      .where(and(eq(agentInstances.organizationId, ctx.organizationId), inArray(agentInstances.id, participants)));
    const agentByInstance = new Map(instances.map((row) => [row.id, row.agentId]));
    const projectByGoal = new Map(projectRows.map((row) => [row.id, row.projectId]));
    for (const op of operations) {
      const projectId = projectByGoal.get(op.goalId);
      const agentIds = op.participantInstanceIds.map((id) => agentByInstance.get(id));
      if (!projectId || agentIds.some((id) => id === undefined))
        throw AppError.conflict("Cannot resolve a dedicated execution's scoped capacity binding");
      const backing = "runId" in op ? runRows.find((row) => row.run.id === op.runId) : undefined;
      if ("runId" in op && !backing) throw AppError.conflict("Cannot resolve a dedicated execution's backing Run");
      if (backing && (backing.projectId !== projectId || backing.run.computerId !== op.computerId))
        throw AppError.conflict("Dedicated execution capacity binding does not match its backing Run");
      const key = backing ? `run:${backing.run.id}` : `${op.kind}:${op.id}`;
      const previous = occupants.get(key);
      occupants.set(key, {
        key,
        project_id: projectId,
        task_id: backing?.run.taskId ?? null,
        computer_id: op.computerId,
        agent_ids: [...new Set([...(previous?.agent_ids ?? []), ...(agentIds as string[])])],
        agent_instance_ids: [...new Set([...(previous?.agent_instance_ids ?? []), ...op.participantInstanceIds])],
        evidence: [...(previous?.evidence ?? []), `dedicated:${op.kind}:${op.id}`],
      });
    }
  }
  return [...occupants.values()];
}

export function schedulerOccupancy(projectId: string, occupants: readonly SchedulerOccupant[]) {
  const agents = new Map<string, number>(),
    computers = new Map<string, number>();
  let project = 0;
  for (const occupant of occupants) {
    if (occupant.project_id === projectId) project++;
    computers.set(occupant.computer_id, (computers.get(occupant.computer_id) ?? 0) + 1);
    for (const id of new Set(occupant.agent_ids)) agents.set(id, (agents.get(id) ?? 0) + 1);
  }
  return { project, agents: Object.fromEntries(agents), computers: Object.fromEntries(computers) };
}

/**
 * Candidates are supplied by scheduleTask's trusted eligibility pass. Additional
 * runtime/policy facts may remove them but never supply a missing candidate.
 */
export async function collectSchedulerRankingSnapshot(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: {
    projectId: string;
    taskId: string;
    candidates: readonly SchedulerCandidate[];
    manualAgentInstanceId: string | null;
  },
): Promise<{
  snapshot: SchedulerRankingSnapshotV1;
  occupants: SchedulerOccupant[];
  collectionStartedAt: string;
  collectionFinishedAt: string;
}> {
  const now = ctx.clock.nowIso();
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.projectId, input.projectId),
        eq(tasks.organizationId, ctx.organizationId),
      ),
    );
  if (!task) throw AppError.notFound("Shadow snapshot task not found in project");
  const queue = await readSchedulerQueueMetadata(ctx, tx, task.id, input.projectId);
  const projectRows = await tx
    .select()
    .from(schedulerProjectPolicies)
    .where(
      and(
        eq(schedulerProjectPolicies.organizationId, ctx.organizationId),
        eq(schedulerProjectPolicies.projectId, input.projectId),
      ),
    );
  const agentRows = await tx
    .select()
    .from(schedulerAgentPolicies)
    .where(eq(schedulerAgentPolicies.organizationId, ctx.organizationId));
  const computerRows = await tx
    .select()
    .from(schedulerComputerPolicies)
    .where(eq(schedulerComputerPolicies.organizationId, ctx.organizationId));
  const inventory = await tx.select().from(agentRuntimes).where(eq(agentRuntimes.organizationId, ctx.organizationId));
  const occupants = await collectSchedulerOccupants(ctx, tx);
  const snapshot = SchedulerRankingSnapshotV1Schema.parse({
    version: 1,
    queue_metadata: queue
      ? { version: 1, task_id: task.id, source: "persisted", revision: queue.revision }
      : { version: 1, task_id: task.id, source: "legacy_default", revision: null },
    policy_revisions: {
      version: 1,
      project_id: input.projectId,
      project: projectRows[0]?.revision ?? null,
      agents: Object.fromEntries(agentRows.map((row) => [row.agentId, row.revision])),
      computers: Object.fromEntries(computerRows.map((row) => [row.computerId, row.revision])),
    },
    observed_at_ms: Date.parse(now),
    not_before_ms: queue?.metadata.not_before_ms ?? 0,
    preferred_computer_id: queue?.metadata.preferred_computer_id ?? null,
    prefer_until_ms: queue?.metadata.prefer_until_ms ?? null,
    manual_agent_instance_id: input.manualAgentInstanceId,
    project_policy: projectRows[0]?.policy ?? null,
    agent_policies: Object.fromEntries(agentRows.map((row) => [row.agentId, row.policy])),
    computer_policies: Object.fromEntries(computerRows.map((row) => [row.computerId, row.policy])),
    occupancy: schedulerOccupancy(input.projectId, occupants),
    candidates: input.candidates.map((candidate) => ({
      agent_instance_id: candidate.agent_instance_id,
      agent_id: candidate.agent_id,
      computer_id: candidate.computer_id,
      runtime: candidate.runtime,
      legacy_score: candidate.score,
      available_runtimes: inventory
        .filter(
          (row) =>
            row.computerId === candidate.computer_id &&
            row.status !== "disabled" &&
            row.status !== "missing" &&
            !isRuntimeStale(row.lastSeenAt, now, RUNTIME_STALE_AFTER_MS),
        )
        .map((row) => row.runtime),
    })),
  });
  return { snapshot, occupants, collectionStartedAt: now, collectionFinishedAt: ctx.clock.nowIso() };
}
