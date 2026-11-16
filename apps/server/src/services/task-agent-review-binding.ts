import { isDeepStrictEqual } from "node:util";
import { agentInstances, artifacts, computers, contextPacks, eventLog, runs, taskAgentReviews, tasks } from "@artoo/db";
import {
  ContextPackSchema,
  TaskAgentReviewSubjectV1Schema,
  TaskAgentReviewV1Schema,
  type TaskAgentReviewV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { projectSquadInstanceMembership } from "./project-squad-membership.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

export type TaskAgentReviewRow = typeof taskAgentReviews.$inferSelect;
export function mapTaskAgentReview(row: TaskAgentReviewRow): TaskAgentReviewV1 {
  return TaskAgentReviewV1Schema.parse({
    version: row.version,
    id: row.id,
    project_id: row.projectId,
    source_task_id: row.sourceTaskId,
    source_run_id: row.sourceRunId,
    source_agent_id: row.sourceAgentId,
    review_task_id: row.reviewTaskId,
    reviewer_agent_id: row.reviewerAgentId,
    artifacts: row.artifacts,
    requested_by_user_id: row.requestedByUserId,
    created_at: row.createdAt,
  });
}
export function taskAgentReviewSubject(row: TaskAgentReviewRow) {
  return TaskAgentReviewSubjectV1Schema.parse({
    version: 1,
    review_id: row.id,
    source_task_id: row.sourceTaskId,
    source_run_id: row.sourceRunId,
    reviewer_agent_id: row.reviewerAgentId,
    artifacts: row.artifacts,
  });
}
export async function taskAgentReviewForTask(ctx: ServerContext, tx: DrizzleDb, taskId: string) {
  return (
    await tx
      .select()
      .from(taskAgentReviews)
      .where(and(eq(taskAgentReviews.organizationId, ctx.organizationId), eq(taskAgentReviews.reviewTaskId, taskId)))
      .limit(1)
  )[0];
}

/** Caller may own the review Task. Never wait backwards for its source Task:
 * conflicting author actions reject the complete admission instead. */
export async function assertTaskAgentReviewCurrent(
  ctx: ServerContext,
  tx: DrizzleDb,
  review: TaskAgentReviewRow,
  options: { lockSource?: boolean; checkConsent?: boolean } = {},
) {
  const query = tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, review.sourceTaskId),
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.projectId, review.projectId),
      ),
    );
  let source: typeof tasks.$inferSelect | undefined;
  try {
    [source] = await (options.lockSource ? query.for("share", { noWait: true }) : query);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    if ((cause as { code?: string } | null)?.code === "55P03")
      throw AppError.conflict("Author task is changing; retry the complete operation");
    throw error;
  }
  const [latest] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, review.sourceTaskId)))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(1);
  const [leftReview] = await tx
    .select({ id: eventLog.id })
    .from(eventLog)
    .where(
      and(
        eq(eventLog.organizationId, ctx.organizationId),
        eq(eventLog.taskId, review.sourceTaskId),
        eq(eventLog.type, "review.completed"),
        gt(eventLog.position, review.sourceEventPosition),
      ),
    )
    .limit(1);
  if (
    review.organizationId !== ctx.organizationId ||
    review.version !== 1 ||
    !source ||
    source.status !== "review" ||
    source.updatedAt !== review.sourceUpdatedAt ||
    !latest ||
    latest.id !== review.sourceRunId ||
    latest.status !== "completed" ||
    leftReview
  ) {
    throw AppError.conflict("The author has left this exact review candidate; this Agent review is stale");
  }
  const [author] = await tx
    .select()
    .from(agentInstances)
    .where(and(eq(agentInstances.id, latest.agentInstanceId), eq(agentInstances.organizationId, ctx.organizationId)));
  if (!author || author.agentId !== review.sourceAgentId || review.reviewerAgentId === review.sourceAgentId) {
    throw AppError.conflict("The Agent review author identity changed");
  }
  const frozen = mapTaskAgentReview(review).artifacts;
  const expectedById = new Map(frozen.map((item) => [item.id, item]));
  const current = await tx
    .select()
    .from(artifacts)
    .where(
      and(
        eq(artifacts.organizationId, ctx.organizationId),
        eq(artifacts.taskId, source.id),
        eq(artifacts.runId, latest.id),
        inArray(
          artifacts.id,
          frozen.map((item) => item.id),
        ),
      ),
    )
    .orderBy(asc(artifacts.id));
  if (
    current.length !== frozen.length ||
    current.some((item) => {
      const expected = expectedById.get(item.id);
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      return (
        !expected ||
        item.type !== expected.type ||
        item.checksum !== expected.checksum ||
        item.runId !== expected.run_id ||
        metadata.storage_key !== expected.checksum.slice(7) ||
        typeof metadata.size !== "number" ||
        !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 ||
        metadata.size > 10 * 1024 * 1024
      );
    }) ||
    current.reduce((sum, item) => sum + Number((item.metadata as Record<string, unknown>).size), 0) > 10 * 1024 * 1024
  ) {
    throw AppError.conflict("The frozen Agent review artifacts changed or are unavailable");
  }
  if (options.checkConsent !== false)
    await requireAiSharingAuthorization({ ...ctx, actorUserId: review.requestedByUserId }, tx, {
      consentId: review.aiDataSharingConsentId,
      policyVersion: review.aiDataSharingPolicyVersion,
    });
  return { source, run: latest, artifacts: current };
}

export async function assertTaskAgentReviewAdmission(ctx: ServerContext, tx: DrizzleDb, review: TaskAgentReviewRow) {
  if (ctx.automationActor || ctx.actorUserId !== review.requestedByUserId) {
    throw AppError.permissionDenied("This opinion task retains its requesting user and chosen reviewer");
  }
  return assertTaskAgentReviewCurrent(ctx, tx, review, { lockSource: true });
}

/** No serialized subject can create a relation. Check its original persisted
 * Task/Run/ContextPack plus logical reviewer every time it supplies feedback. */
export async function assertTaskAgentReviewRun(
  ctx: ServerContext,
  tx: DrizzleDb,
  review: TaskAgentReviewRow,
  run: typeof runs.$inferSelect,
) {
  const [reviewTask] = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.id, review.reviewTaskId),
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.projectId, review.projectId),
      ),
    );
  const [instance] = await tx
    .select()
    .from(agentInstances)
    .where(
      and(
        eq(agentInstances.id, run.agentInstanceId),
        projectSquadInstanceMembership(ctx.organizationId, review.projectId),
      ),
    );
  const [pack] = run.contextPackId
    ? await tx
        .select()
        .from(contextPacks)
        .where(
          and(
            eq(contextPacks.id, run.contextPackId),
            eq(contextPacks.organizationId, ctx.organizationId),
            eq(contextPacks.runId, run.id),
            eq(contextPacks.taskId, review.reviewTaskId),
          ),
        )
    : [];
  const parsed = ContextPackSchema.safeParse(pack?.payload);
  if (
    !reviewTask ||
    run.organizationId !== ctx.organizationId ||
    run.taskId !== review.reviewTaskId ||
    instance?.agentId !== review.reviewerAgentId ||
    run.requestedByUserId !== review.requestedByUserId ||
    run.aiDataSharingConsentId !== review.aiDataSharingConsentId ||
    run.aiDataSharingPolicyVersion !== review.aiDataSharingPolicyVersion ||
    !parsed.success ||
    parsed.data.task.id !== review.reviewTaskId ||
    parsed.data.project.id !== review.projectId ||
    !isDeepStrictEqual(parsed.data.agent_review_subject, taskAgentReviewSubject(review))
  ) {
    throw AppError.conflict("Agent review Run lost its exact reviewer, source or consent binding");
  }
  const [source] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, review.sourceRunId), eq(runs.organizationId, ctx.organizationId)));
  const [computer] = await tx
    .select({ os: computers.os })
    .from(computers)
    .where(and(eq(computers.id, run.computerId), eq(computers.organizationId, ctx.organizationId)));
  if (
    !source ||
    !computer ||
    !taskAgentReviewWorkspaceIsolated(source, run.computerId, run.workspaceRoot, computer.os)
  ) {
    throw AppError.conflict("The opinion workspace overlaps or cannot be separated from the author's workspace");
  }
  return parsed.data;
}

/** code.read is a capability match, not a sandbox. Never give an ordinary
 * adapter the same machine's author directory, its ancestor or descendant. */
export function taskAgentReviewWorkspaceIsolated(
  source: Pick<typeof runs.$inferSelect, "computerId" | "workspaceRoot">,
  computerId: string,
  workspaceRoot: string | null,
  os: string,
): boolean {
  if (source.computerId !== computerId) return true;
  if (!source.workspaceRoot || !workspaceRoot) return false;
  try {
    return !automationWorkspacesOverlap(source.workspaceRoot, workspaceRoot, os);
  } catch {
    return false;
  }
}

/** Scheduler eligibility is derived from the durable relation, never assignee
 * display fields. Prepared admission recovers the same Task from its Run. */
export async function schedulerTaskAgentReview(
  ctx: ServerContext,
  tx: DrizzleDb,
  taskId: string | undefined,
  preparedRunId?: string,
) {
  if (!taskId && preparedRunId) {
    const [run] = await tx
      .select({ taskId: runs.taskId })
      .from(runs)
      .where(and(eq(runs.id, preparedRunId), eq(runs.organizationId, ctx.organizationId)));
    taskId = run?.taskId;
  }
  const review = taskId ? await taskAgentReviewForTask(ctx, tx, taskId) : undefined;
  if (review) await assertTaskAgentReviewAdmission(ctx, tx, review);
  return review;
}
