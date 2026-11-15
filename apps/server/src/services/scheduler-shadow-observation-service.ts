import { projects, schedulerDecisions, schedulerShadowObservations } from "@artoo/db";
import { rankSchedulerCandidates } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import type { SchedulerOutcome } from "./scheduler.js";

/** Persist the original inputs, not a resnapshot after the real Run was created. */
export async function recordSchedulerShadowObservation(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: {
    projectId: string;
    taskId: string;
    decisionId: string;
    outcome: SchedulerOutcome;
    revalidation: { selected_agent_instance_id: string; observed_at: string };
  },
) {
  const captured = input.outcome.shadowCapture;
  if (!captured) return;
  await tx.insert(schedulerShadowObservations).values({
    decisionId: input.decisionId,
    organizationId: ctx.organizationId,
    projectId: input.projectId,
    taskId: input.taskId,
    collectionStartedAt: captured.collectionStartedAt,
    collectionFinishedAt: captured.collectionFinishedAt,
    recordedAt: ctx.clock.nowIso(),
    snapshot: captured.snapshot,
    ranking: rankSchedulerCandidates(captured.snapshot),
    occupants: captured.occupants,
    revalidation: input.revalidation,
  });
}

export async function listSchedulerShadowObservations(ctx: ServerContext, projectId: string) {
  const [project] = await ctx.db.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
  if (!project) throw AppError.notFound("project not found");
  const rows = await ctx.db.db
    .select({ observation: schedulerShadowObservations, actualInstanceId: schedulerDecisions.selectedAgentInstanceId })
    .from(schedulerShadowObservations)
    .innerJoin(
      schedulerDecisions,
      and(
        eq(schedulerDecisions.id, schedulerShadowObservations.decisionId),
        eq(schedulerDecisions.organizationId, ctx.organizationId),
        eq(schedulerDecisions.taskId, schedulerShadowObservations.taskId),
      ),
    )
    .where(
      and(
        eq(schedulerShadowObservations.organizationId, ctx.organizationId),
        eq(schedulerShadowObservations.projectId, projectId),
      ),
    )
    .orderBy(desc(schedulerShadowObservations.recordedAt), desc(schedulerShadowObservations.decisionId))
    .limit(50);
  return rows.map(({ observation, actualInstanceId }) => ({
    ...observation,
    execution_authorized: false as const,
    actual_agent_instance_id: actualInstanceId,
    differs: actualInstanceId !== observation.ranking.selected_agent_instance_id,
  }));
}
