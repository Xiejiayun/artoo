import {
  autonomousReviews, projects, runs, tasks, schedulerDecisions,
  schedulerExecutionLeases, schedulerExecutionRequests, schedulerProjectPolicies,
  schedulerTaskQueueMetadata,
} from "@artoo/db";
import {
  ProjectControlViewV1Schema, RUN_STATUSES, TASK_STATUSES,
  type ProjectControlViewV1,
} from "@artoo/domain";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { schedulerRolloutEnabled, SCHEDULER_ROLLOUT_FLAGS } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { mapRun, mapTask } from "../mappers.js";
import { schedulerCapacityStatus } from "./scheduler-capacity-service.js";
import { collectSchedulerOccupants, schedulerOccupancy } from "./scheduler-shadow-snapshot.js";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().min(1).max(2048).optional(),
  capacity: z.enum(["true", "false"]).optional(),
}).strict();
const cursorSchema = z.object({
  version: z.literal(1), organization_id: z.string(), project_id: z.string(),
  last_task_id: z.string().min(1).max(128),
}).strict();

function readCursor(raw: string | undefined, organizationId: string, projectId: string): string | undefined {
  if (!raw) return;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("Invalid encoding");
    const value = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (value.organization_id !== organizationId || value.project_id !== projectId) throw new Error("Wrong scope");
    return value.last_task_id;
  } catch {
    throw AppError.validation("Invalid project control cursor");
  }
}

/** A read-only repeatable snapshot. No scheduling or physical-closure inference.
 * Page boundaries are immutable task IDs, avoiding timestamp precision loss.
 * Complete occupancy is explicitly requested because it joins all reservation
 * owners; ordinary per-page refreshes retain bounded history result sets. */
export async function getProjectControlView(
  ctx: ServerContext, projectId: string, rawQuery: unknown,
): Promise<ProjectControlViewV1> {
  const parsed = querySchema.safeParse(rawQuery);
  if (!parsed.success) throw AppError.validation("Invalid project control query");
  const limit = parsed.data.limit ?? 50;
  const after = readCursor(parsed.data.after, ctx.organizationId, projectId);
  const observedAt = ctx.clock.nowIso();
  return ctx.db.db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId),
    ));
    if (!project) throw AppError.notFound("Project not found");
    const scope = and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, projectId));
    const candidates = await tx.select().from(tasks).where(and(scope, after ? lt(tasks.id, after) : undefined))
      .orderBy(desc(tasks.id)).limit(limit + 1);
    const pageRows = candidates.slice(0, limit), ids = pageRows.map((row) => row.id);
    const taskCounts = await tx.select({ status: tasks.status, count: sql<number>`count(*)::integer` })
      .from(tasks).where(scope).groupBy(tasks.status);
    const runCounts = await tx.select({ status: runs.status, count: sql<number>`count(*)::integer` })
      .from(runs).innerJoin(tasks, and(eq(tasks.id, runs.taskId), eq(tasks.organizationId, ctx.organizationId)))
      .where(and(scope, eq(runs.organizationId, ctx.organizationId))).groupBy(runs.status);
    const [leaseCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(schedulerExecutionLeases)
      .where(and(eq(schedulerExecutionLeases.organizationId, ctx.organizationId), eq(schedulerExecutionLeases.projectId, projectId),
        eq(schedulerExecutionLeases.state, "active"), sql`${schedulerExecutionLeases.expiresAt} > ${observedAt}::timestamptz`));
    const [requestCount] = await tx.select({ count: sql<number>`count(*)::integer` }).from(schedulerExecutionRequests)
      .where(and(eq(schedulerExecutionRequests.organizationId, ctx.organizationId), eq(schedulerExecutionRequests.projectId, projectId),
        eq(schedulerExecutionRequests.state, "pending")));
    const latestRuns = ids.length ? await tx.selectDistinctOn([runs.taskId]).from(runs)
      .where(and(eq(runs.organizationId, ctx.organizationId), inArray(runs.taskId, ids)))
      .orderBy(runs.taskId, desc(runs.createdAt), desc(runs.id)) : [];
    const leases = ids.length ? await tx.selectDistinctOn([schedulerExecutionLeases.taskId]).from(schedulerExecutionLeases)
      .where(and(eq(schedulerExecutionLeases.organizationId, ctx.organizationId), eq(schedulerExecutionLeases.projectId, projectId), inArray(schedulerExecutionLeases.taskId, ids)))
      .orderBy(schedulerExecutionLeases.taskId, desc(schedulerExecutionLeases.epoch)) : [];
    const requests = ids.length ? await tx.selectDistinctOn([schedulerExecutionRequests.taskId]).from(schedulerExecutionRequests)
      .where(and(eq(schedulerExecutionRequests.organizationId, ctx.organizationId), eq(schedulerExecutionRequests.projectId, projectId), inArray(schedulerExecutionRequests.taskId, ids)))
      .orderBy(schedulerExecutionRequests.taskId, desc(schedulerExecutionRequests.createdAt), desc(schedulerExecutionRequests.id)) : [];
    const metadata = ids.length ? await tx.select().from(schedulerTaskQueueMetadata)
      .where(and(eq(schedulerTaskQueueMetadata.organizationId, ctx.organizationId), eq(schedulerTaskQueueMetadata.projectId, projectId), inArray(schedulerTaskQueueMetadata.taskId, ids))) : [];
    const decisionIds = latestRuns.map((row) => row.schedulerDecisionId).filter((id): id is string => id !== null);
    const decisions = decisionIds.length ? await tx.select().from(schedulerDecisions)
      .where(and(eq(schedulerDecisions.organizationId, ctx.organizationId), inArray(schedulerDecisions.id, decisionIds))) : [];
    const reviewLinks = ids.length ? await tx.select({ taskId: autonomousReviews.reviewTaskId, goalId: autonomousReviews.goalId, planId: tasks.sourcePlanId })
      .from(autonomousReviews).innerJoin(tasks, and(eq(tasks.id, autonomousReviews.taskId), eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, projectId)))
      .where(and(eq(autonomousReviews.organizationId, ctx.organizationId), inArray(autonomousReviews.reviewTaskId, ids))) : [];
    const [policy] = await tx.select().from(schedulerProjectPolicies)
      .where(and(eq(schedulerProjectPolicies.organizationId, ctx.organizationId), eq(schedulerProjectPolicies.projectId, projectId)));
    const occupancy = parsed.data.capacity === "true" ? schedulerOccupancy(projectId, await collectSchedulerOccupants(ctx, tx)).project : null;
    const runByTask = new Map(latestRuns.map((row) => [row.taskId, row]));
    const leaseByTask = new Map(leases.map((row) => [row.taskId, row]));
    const requestByTask = new Map(requests.map((row) => [row.taskId, row]));
    const queueByTask = new Map(metadata.map((row) => [row.taskId, row]));
    const decisionById = new Map(decisions.map((row) => [row.id, row]));
    const reviewByTask = new Map(reviewLinks.map((row) => [row.taskId, row]));
    const taskTotals = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    const runTotals = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0]));
    for (const row of taskCounts) taskTotals[row.status] = Number(row.count);
    for (const row of runCounts) runTotals[row.status] = Number(row.count);
    const hasMore = candidates.length > limit;
    const capacity = schedulerCapacityStatus(ctx, projectId);
    return ProjectControlViewV1Schema.parse({
      version: 1, project_id: projectId, observed_at: observedAt,
      tasks: pageRows.map((row) => {
        const run = runByTask.get(row.id), lease = leaseByTask.get(row.id), request = requestByTask.get(row.id);
        const queue = queueByTask.get(row.id), decision = run?.schedulerDecisionId ? decisionById.get(run.schedulerDecisionId) : undefined, review = reviewByTask.get(row.id);
        const task = mapTask(row);
        return {
          task: review && !row.goalId ? { ...task, goal_id: review.goalId, source_plan_id: review.planId } : task,
          latest_run: run ? mapRun(run) : null,
          execution_lease: lease ? { id: lease.id, run_id: lease.binding.run_id, computer_id: lease.binding.computer_id,
            epoch: lease.epoch, state: lease.state, claimed_at: new Date(lease.claimedAt).toISOString(), observed_at: new Date(lease.observedAt).toISOString(), expires_at: new Date(lease.expiresAt).toISOString(), closed_at: lease.closedAt ? new Date(lease.closedAt).toISOString() : null } : null,
          execution_request: request ? { id: request.id, state: request.state, consumed_run_id: request.consumedRunId, created_at: new Date(request.createdAt).toISOString() } : null,
          queue_metadata: queue ? { revision: queue.revision, metadata: { version: queue.version, not_before_ms: queue.notBeforeMs,
            preferred_computer_id: queue.preferredComputerId, prefer_until_ms: queue.preferUntilMs } } : null,
          last_assignment: run && decision ? { run_id: run.id, reason: decision.reason, mode: decision.mode, created_at: new Date(decision.createdAt).toISOString() } : null,
        };
      }),
      page: { limit, has_more: hasMore, order: "task_id_desc", next_after: hasMore ? Buffer.from(JSON.stringify({ version: 1,
        organization_id: ctx.organizationId, project_id: projectId, last_task_id: pageRows.at(-1)!.id })).toString("base64url") : null },
      summary: { total_tasks: taskCounts.reduce((sum, row) => sum + Number(row.count), 0), tasks_by_status: taskTotals,
        runs_by_status: runTotals, active_execution_leases: Number(leaseCount?.count ?? 0), pending_execution_requests: Number(requestCount?.count ?? 0) },
      project_policy: policy?.policy ?? null,
      capacity: { shared_quotas_enabled: capacity.shared_quotas_enabled, project_quota_enabled: capacity.project_quota_enabled,
        occupied: occupancy, source: occupancy === null ? "not_requested" : "reservation_snapshot" },
      rollout: Object.fromEntries(SCHEDULER_ROLLOUT_FLAGS.map((flag) => [flag, schedulerRolloutEnabled(ctx.schedulerRollout, flag, { organizationId: ctx.organizationId, projectId })])),
      cost_budget_enabled: false,
    });
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
