import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { appendEvent, messages, projects, taskEnqueueEvents, taskEnqueueSources, tasks } from "@artoo/db";
import { canonicalReleaseJson, ID_PREFIXES } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireContentAllowed } from "./content-moderation-service.js";
import { mirrorSchedulerTask } from "./scheduler-projection-service.js";
import { readTaskSourceInputs } from "./task-source-input-service.js";

type TaskValues = typeof tasks.$inferInsert;
type TaskRow = typeof tasks.$inferSelect;
export interface TaskEnqueueProvenance {
  kind:
    | "manual"
    | "assistant"
    | "discussion"
    | "plan"
    | "independent-review"
    | "research-revision"
    | "external-manual"
    | "external-issue";
  key: string;
  eventId: string;
  targetKey?: string;
  /** Only the public source adapter permits active reuse; business workflows keep their own replay guards. */
  deduplicate?: boolean;
  comment?: string;
}
export function enqueueDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalReleaseJson(value)).digest("hex")}`;
}
function intent(values: TaskValues) {
  // Generated identities/time and the manual room are not part of source intent.
  // Every execution, policy, attribution and immutable provenance field is.
  return {
    projectId: values.projectId,
    parentTaskId: values.parentTaskId ?? null,
    executionPolicyTaskId: values.executionPolicyTaskId ?? null,
    goalId: values.goalId ?? null,
    sourcePlanId: values.sourcePlanId ?? null,
    sourcePlanSpecRef: values.sourcePlanSpecRef ?? null,
    title: values.title,
    description: values.description ?? "",
    status: values.status,
    priority: values.priority ?? "p2",
    requiredCapabilities: values.requiredCapabilities ?? [],
    acceptanceCriteria: values.acceptanceCriteria ?? [],
    assigneeType: values.assigneeType ?? null,
    assigneeId: values.assigneeId ?? null,
    preferredModelProfileId: values.preferredModelProfileId ?? null,
    preferredEffort: values.preferredEffort ?? null,
    createdByType: values.createdByType,
    createdById: values.createdById,
  };
}

/** The sole production Task insert. Caller-owned business writes remain in this transaction. */
export async function enqueueTask(
  ctx: ServerContext,
  tx: DrizzleDb,
  values: TaskValues,
  source: TaskEnqueueProvenance,
  onCreated?: (task: TaskRow) => Promise<void>,
): Promise<{ task: TaskRow; created: boolean }> {
  if (values.organizationId !== ctx.organizationId)
    throw AppError.permissionDenied("Task enqueue cannot cross organizations");
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, values.projectId), eq(projects.organizationId, ctx.organizationId)));
  if (!project) throw AppError.notFound("Task project not found");
  if (values.parentTaskId) {
    const [parent] = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.id, values.parentTaskId),
          eq(tasks.organizationId, ctx.organizationId),
          eq(tasks.projectId, values.projectId),
        ),
      );
    if (!parent) throw AppError.validation("Parent task must belong to the same project");
  }
  const enabled = schedulerRolloutEnabled(ctx.schedulerRollout, "unified_enqueue", {
    organizationId: ctx.organizationId,
    projectId: values.projectId,
  });
  if (source.deduplicate && !enabled) throw AppError.conflict("Source deduplication is not enabled for this project");
  // Match membership revocation's user -> work lock order before source/Task locks.
  if (enabled && source.comment) await requireContentAllowed(ctx, source.comment, tx);
  const scope = {
    organizationId: ctx.organizationId,
    projectId: values.projectId,
    actorUserId: ctx.actorUserId,
    kind: source.kind,
    sourceKey: source.key,
    targetKey: source.targetKey ?? "default",
  };
  const sourceId = enqueueDigest(scope),
    intentDigest = enqueueDigest(intent(values));
  const requestDigest = enqueueDigest({ intentDigest, comment: source.comment ?? null });
  let created = true;
  let task: TaskRow | undefined;
  if (enabled) {
    await tx
      .insert(taskEnqueueSources)
      .values({ id: sourceId, ...scope, createdAt: values.createdAt })
      .onConflictDoNothing();
    const [head] = await tx.select().from(taskEnqueueSources).where(eq(taskEnqueueSources.id, sourceId)).for("update");
    if (
      !head ||
      head.version !== 1 ||
      !isDeepStrictEqual(scope, {
        organizationId: head.organizationId,
        projectId: head.projectId,
        actorUserId: head.actorUserId,
        kind: head.kind,
        sourceKey: head.sourceKey,
        targetKey: head.targetKey,
      })
    ) {
      throw AppError.conflict("Task source identity differs from its persisted scope");
    }
    const [replay] = await tx
      .select()
      .from(taskEnqueueEvents)
      .where(and(eq(taskEnqueueEvents.sourceId, sourceId), eq(taskEnqueueEvents.eventKey, source.eventId)));
    if (replay) {
      if (replay.version !== 1) throw AppError.conflict("Source event version is incompatible");
      if (replay.requestDigest !== requestDigest)
        throw AppError.conflict("Source event was already used for different task intent or content");
      if (!source.deduplicate)
        throw AppError.conflict("Business task creation replay must use its original operation guard");
      [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, replay.taskId),
            eq(tasks.organizationId, ctx.organizationId),
            eq(tasks.projectId, values.projectId),
          ),
        );
      if (!task) throw AppError.conflict("Replayed source task is missing");
      return { task, created: false };
    }
    if (head.activeTaskId) {
      [task] = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.id, head.activeTaskId),
            eq(tasks.organizationId, ctx.organizationId),
            eq(tasks.projectId, values.projectId),
          ),
        )
        .for("update");
      if (!task) throw AppError.conflict("Active source task is missing");
      if (!["done", "cancelled"].includes(task.status)) {
        if (!source.deduplicate || head.intentDigest !== intentDigest)
          throw AppError.conflict("Active source task has different intent; use a distinct source or finish it first");
        created = false;
      } else task = undefined;
    }
    if (source.comment) {
      const current = task ? await readTaskSourceInputs(ctx, tx, task.id) : undefined;
      if (
        (current?.entries.length ?? 0) >= 100 ||
        (current?.entries.reduce((sum, entry) => sum + entry.body.length, 0) ?? 0) + source.comment.length > 200000
      )
        throw AppError.rateLimited("Source input exceeds the frozen context limit; split the task explicitly");
    }
  }
  if (!task) {
    // Default-off rollback uses exactly this legacy persistence operation.
    [task] = await tx.insert(tasks).values(values).returning();
    if (!task) throw new Error("Task missing after enqueue insert");
    await mirrorSchedulerTask(ctx, tx, task.id);
    await onCreated?.(task);
  }
  if (enabled) {
    await tx
      .update(taskEnqueueSources)
      .set({ activeTaskId: task.id, intentDigest })
      .where(eq(taskEnqueueSources.id, sourceId));
    let messageId: string | undefined;
    if (source.comment) {
      if (!task.roomId) throw AppError.conflict("Source comments require a task room");
      messageId = ctx.idGen.generate(ID_PREFIXES.message);
      await tx.insert(messages).values({
        id: messageId,
        organizationId: ctx.organizationId,
        roomId: task.roomId,
        taskId: task.id,
        actorType: "user",
        actorId: ctx.actorUserId,
        kind: "comment",
        body: source.comment,
        payload: {},
        createdAt: ctx.clock.nowIso(),
      });
      await appendEvent(
        tx,
        buildEvent(ctx, {
          type: "message.created",
          actorType: "user",
          actorId: ctx.actorUserId,
          correlationId: task.id,
          projectId: task.projectId,
          taskId: task.id,
          roomId: task.roomId,
          payload: { message_id: messageId, kind: "comment" },
        }),
      );
    }
    await tx.insert(taskEnqueueEvents).values({
      sourceId,
      eventKey: source.eventId,
      taskId: task.id,
      requestDigest,
      messageId: messageId ?? null,
      createdAt: ctx.clock.nowIso(),
    });
  }
  return { task, created };
}
