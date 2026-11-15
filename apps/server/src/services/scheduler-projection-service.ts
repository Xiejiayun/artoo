import { projects, runs, schedulerReconciliations, schedulerTaskProjections, tasks } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import { requireAdministrator } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

type Source = { id: string; projectId: string; status: string; updatedAt: string; attempts: number };
type Projection = typeof schedulerTaskProjections.$inferSelect;

function matches(source: Source, projection: Projection | undefined): boolean {
  // Both string-mode timestamptz columns use the same transaction/driver format.
  // Parsing through Date would discard PostgreSQL's sub-millisecond precision.
  return (
    projection !== undefined &&
    projection.version === 1 &&
    projection.leaseEpoch === 0 &&
    projection.projectId === source.projectId &&
    projection.legacyStatus === source.status &&
    projection.attemptCount === source.attempts &&
    projection.sourceUpdatedAt === source.updatedAt
  );
}

async function writeProjection(ctx: ServerContext, tx: DrizzleDb, source: Source): Promise<boolean> {
  const values = {
    taskId: source.id,
    organizationId: ctx.organizationId,
    projectId: source.projectId,
    version: 1,
    legacyStatus: source.status,
    attemptCount: source.attempts,
    leaseEpoch: 0,
    sourceUpdatedAt: source.updatedAt,
    syncedAt: ctx.clock.nowIso(),
  };
  const changed = await tx
    .insert(schedulerTaskProjections)
    .values(values)
    .onConflictDoUpdate({
      target: schedulerTaskProjections.taskId,
      set: {
        legacyStatus: values.legacyStatus,
        attemptCount: values.attemptCount,
        sourceUpdatedAt: values.sourceUpdatedAt,
        syncedAt: values.syncedAt,
      },
      // A migration mirror must never overwrite ownership, identity or a newer version.
      setWhere: and(
        eq(schedulerTaskProjections.organizationId, ctx.organizationId),
        eq(schedulerTaskProjections.projectId, source.projectId),
        eq(schedulerTaskProjections.version, 1),
        eq(schedulerTaskProjections.leaseEpoch, 0),
      ),
    })
    .returning({ id: schedulerTaskProjections.taskId });
  return changed.length === 1;
}

/** Called inside the original writer's transaction, never after its commit. */
export async function mirrorSchedulerTask(ctx: ServerContext, tx: DrizzleDb, taskId: string): Promise<void> {
  if (!ctx.schedulerRollout) return;
  const [row] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    .for("update");
  if (!row) throw AppError.notFound("task not found");
  if (
    !schedulerRolloutEnabled(ctx.schedulerRollout, "task_mirror", {
      organizationId: ctx.organizationId,
      projectId: row.projectId,
    })
  )
    return;
  const [existing] = await tx
    .select()
    .from(schedulerTaskProjections)
    .where(eq(schedulerTaskProjections.taskId, taskId));
  // Import open work only. Once mirrored, retain its terminal record and history.
  if (!existing && ["done", "cancelled"].includes(row.status)) return;
  const [attempts] = await tx
    .select({ value: count() })
    .from(runs)
    .where(and(eq(runs.taskId, taskId), eq(runs.organizationId, ctx.organizationId)));
  if (!(await writeProjection(ctx, tx, { ...row, attempts: attempts!.value }))) {
    throw AppError.conflict("scheduler projection has incompatible ownership; legacy write rolled back");
  }
}

/** Snapshot repair never takes Task locks in addition to a legacy writer's lock set. */
export async function reconcileSchedulerProject(
  ctx: ServerContext,
  projectId: string,
  repair: boolean,
  requireAdmin = false,
) {
  return ctx.db.db.transaction(
    async (tx) => {
      if (requireAdmin) await requireAdministrator(ctx, tx);
      const [project] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
      if (!project) throw AppError.notFound("project not found");
      if (
        !schedulerRolloutEnabled(ctx.schedulerRollout, "task_mirror", { organizationId: ctx.organizationId, projectId })
      ) {
        throw AppError.conflict("task mirror is disabled for this project");
      }
      const rows = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, projectId)))
        .orderBy(tasks.id);
      // Legacy workflows can update several tasks in their own established order.
      // Taking all Task locks here would add an inverse lock order and deadlocks.
      // Under repeatable read, a projection changed after this snapshot makes
      // PostgreSQL reject repair with a serialization error; the next scan retries.
      // Source and projection changes commit together in every enabled writer.
      const projections = await tx
        .select()
        .from(schedulerTaskProjections)
        .where(
          and(
            eq(schedulerTaskProjections.organizationId, ctx.organizationId),
            eq(schedulerTaskProjections.projectId, projectId),
          ),
        );
      const byId = new Map(projections.map((row) => [row.taskId, row]));
      const attempts = await tx
        .select({ taskId: runs.taskId, value: count() })
        .from(runs)
        .innerJoin(tasks, and(eq(tasks.id, runs.taskId), eq(tasks.organizationId, runs.organizationId)))
        .where(and(eq(runs.organizationId, ctx.organizationId), eq(tasks.projectId, projectId)))
        .groupBy(runs.taskId);
      const counts = new Map(attempts.map((row) => [row.taskId, row.value]));
      const sources: Source[] = rows
        .filter((row) => !["done", "cancelled"].includes(row.status) || byId.has(row.id))
        .map((row) => ({ ...row, attempts: counts.get(row.id) ?? 0 }));
      const sourceIds = new Set(sources.map((row) => row.id));
      const extras = projections.filter((row) => !sourceIds.has(row.taskId)).length;
      const mismatches = sources.filter((row) => !matches(row, byId.get(row.id)));
      let repaired = 0;
      if (repair)
        for (const source of mismatches) {
          if (await writeProjection(ctx, tx, source)) repaired += 1;
        }
      const [report] = await tx
        .insert(schedulerReconciliations)
        .values({
          organizationId: ctx.organizationId,
          projectId,
          observedAt: ctx.clock.nowIso(),
          sourceCount: sources.length,
          projectionCount: projections.length,
          mismatchesBefore: mismatches.length + extras,
          mismatchesAfter: mismatches.length + extras - repaired,
          repaired,
          repairRequested: repair,
        })
        .returning();
      return report!;
    },
    { isolationLevel: "repeatable read" },
  );
}

export async function listSchedulerReconciliations(ctx: ServerContext, projectId: string) {
  const [project] = await ctx.db.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, ctx.organizationId)));
  if (!project) throw AppError.notFound("project not found");
  return ctx.db.db
    .select()
    .from(schedulerReconciliations)
    .where(
      and(
        eq(schedulerReconciliations.organizationId, ctx.organizationId),
        eq(schedulerReconciliations.projectId, projectId),
      ),
    )
    .orderBy(desc(schedulerReconciliations.id))
    .limit(50);
}

/** Only startup-configured scopes are scanned; stop waits for the current transaction. */
export function startSchedulerProjectionMonitor(
  ctx: ServerContext,
  options: { intervalMs?: number; onError: (error: unknown) => void },
) {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647)
    throw new RangeError("invalid projection scan interval");
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const scan = async () => {
    const organizations = Object.entries(ctx.schedulerRollout?.workspaces ?? {})
      .filter(
        ([, workspace]) =>
          workspace.flags?.task_mirror === true ||
          Object.values(workspace.projects ?? {}).some((flags) => flags.task_mirror === true),
      )
      .map(([id]) => id);
    if (!organizations.length) return;
    const scopes = await ctx.db.db
      .select({ id: projects.id, organizationId: projects.organizationId })
      .from(projects)
      .where(inArray(projects.organizationId, organizations))
      .orderBy(projects.id);
    for (const scope of scopes) {
      if (stopped) break;
      if (
        !schedulerRolloutEnabled(ctx.schedulerRollout, "task_mirror", {
          organizationId: scope.organizationId,
          projectId: scope.id,
        })
      )
        continue;
      try {
        const report = await reconcileSchedulerProject(
          { ...ctx, organizationId: scope.organizationId },
          scope.id,
          true,
        );
        if (report.mismatchesBefore > 0)
          options.onError(
            new Error(
              `scheduler projection drift: ${scope.organizationId}/${scope.id}, before=${report.mismatchesBefore}, after=${report.mismatchesAfter}`,
            ),
          );
      } catch (error) {
        options.onError(error);
      }
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = scan()
        .catch(options.onError)
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, intervalMs);
    timer.unref();
  };
  schedule();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
