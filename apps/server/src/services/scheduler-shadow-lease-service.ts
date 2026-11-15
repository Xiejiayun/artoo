import { randomUUID } from "node:crypto";
import { schedulerShadowAttempts, schedulerShadowTaskHeads, tasks } from "@artoo/db";
import { rankSchedulerCandidates, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { scheduleTask, type ScheduleOptions } from "./scheduler.js";
import { collectSchedulerRankingSnapshot, schedulerOccupancy } from "./scheduler-shadow-snapshot.js";
import { validateSchedulerIntentForShadow } from "./scheduler-intent-service.js";

const id = z.string().min(1).max(128);
export const ShadowLeaseBindingV1Schema = z
  .object({
    version: z.literal(1),
    project_id: id,
    task_id: id,
    attempt_id: id,
    agent_id: id,
    agent_instance_id: id,
    computer_id: id,
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    execution_authorized: z.literal(false),
  })
  .strict();
export type ShadowLeaseBindingV1 = z.infer<typeof ShadowLeaseBindingV1Schema>;
const leaseDuration = z.number().int().min(1_000).max(300_000);
const intentOptions = z
  .object({
    mode: z.literal("auto"),
    branchBacked: z.literal(true),
    agentInstanceId: z.null().optional(),
  })
  .strict();

const result = <T extends string>(kind: T) => ({ kind, execution_authorized: false as const });

/**
 * Separate advisory namespace from controller ownership. Never wait while holding
 * Task/user/device locks: a busy caller retries its entire shadow transaction.
 * Hash collisions can only cause a conservative busy result across tenants.
 */
async function tryShadowMutex(ctx: ServerContext, tx: DrizzleDb) {
  const rows = await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(1095914312, hashtext(${ctx.organizationId})) AS acquired`,
  );
  return rows.rows[0]?.acquired === true;
}

/**
 * Non-executing kernel. It exercises ownership over real scoped identities, with
 * scheduleTask eligibility and fresh capacity facts. No Run/dispatch, Task state,
 * file lease, verifier or physical-closure evidence is created or changed.
 *
 * The mutex serializes SHADOW admissions only. Existing real admission writers
 * do not acquire it, so this is not enforcement of real three-level capacity.
 * There is intentionally no public node endpoint until the intent/auth protocol.
 */
export async function claimSchedulerShadow(
  ctx: ServerContext,
  input: {
    projectId: string;
    taskId: string;
    /** Optional original-user staging; still cannot authorize execution. */
    intentId?: string;
    options: Omit<ScheduleOptions, "projectId">;
    leaseMs?: number;
  },
) {
  const duration = leaseDuration.parse(input.leaseMs ?? 30_000);
  if (
    !schedulerRolloutEnabled(ctx.schedulerRollout, "claim_shadow", {
      organizationId: ctx.organizationId,
      projectId: input.projectId,
    })
  )
    return result("disabled");
  return ctx.db.transaction(async (tx) => {
    if (!(await tryShadowMutex(ctx, tx))) return result("busy");
    const [task] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, input.taskId),
          eq(tasks.organizationId, ctx.organizationId),
          eq(tasks.projectId, input.projectId),
          eq(tasks.status, "ready"),
        ),
      )
      .for("update", { skipLocked: true });
    if (!task) return result("task_unavailable");
    const intent = input.intentId ? await validateSchedulerIntentForShadow(ctx, tx, task, input.intentId) : undefined;
    if (intent && !intentOptions.safeParse(input.options).success)
      throw AppError.conflict("Shadow options must retain the original pooled scheduling request");
    const [existingHead] = await tx
      .select()
      .from(schedulerShadowTaskHeads)
      .where(eq(schedulerShadowTaskHeads.taskId, task.id))
      .for("update");
    if (
      existingHead &&
      (existingHead.organizationId !== ctx.organizationId ||
        existingHead.projectId !== input.projectId ||
        existingHead.version !== 1)
    )
      throw AppError.conflict("Shadow lease identity/version mismatch");
    const now = ctx.clock.nowIso();
    const [futureHistory] = await tx
      .select({ id: schedulerShadowAttempts.id })
      .from(schedulerShadowAttempts)
      .where(
        and(
          eq(schedulerShadowAttempts.taskId, task.id),
          sql`(${schedulerShadowAttempts.claimedAt} > ${now}::timestamptz
        OR ${schedulerShadowAttempts.startedAt} > ${now}::timestamptz OR ${schedulerShadowAttempts.finishedAt} > ${now}::timestamptz)`,
        ),
      )
      .limit(1);
    if (futureHistory) throw AppError.conflict("Shadow lease server clock regressed");
    // Expiration here is strictly logical. It cannot stop or settle a process.
    await tx
      .update(schedulerShadowAttempts)
      .set({ state: "expired", finishedAt: now })
      .where(
        and(
          eq(schedulerShadowAttempts.organizationId, ctx.organizationId),
          eq(schedulerShadowAttempts.projectId, input.projectId),
          eq(schedulerShadowAttempts.taskId, task.id),
          inArray(schedulerShadowAttempts.state, ["claimed", "running"]),
          sql`${schedulerShadowAttempts.expiresAt} <= ${now}::timestamptz`,
        ),
      );
    const active = await tx
      .select()
      .from(schedulerShadowAttempts)
      .where(
        and(
          eq(schedulerShadowAttempts.organizationId, ctx.organizationId),
          inArray(schedulerShadowAttempts.state, ["claimed", "running"]),
          sql`${schedulerShadowAttempts.expiresAt} > ${now}::timestamptz`,
        ),
      );
    if (active.some((attempt) => attempt.taskId === task.id)) return result("already_claimed");
    const outcome = await scheduleTask(tx, ctx, task.requiredCapabilities as Capability[], {
      ...input.options,
      captureShadow: false,
      projectId: input.projectId,
    });
    const captured = await collectSchedulerRankingSnapshot(ctx, tx, {
      projectId: input.projectId,
      taskId: task.id,
      candidates: intent
        ? outcome.candidates.filter((candidate) => candidate.agent_id === intent.row.agentId)
        : outcome.candidates,
      manualAgentInstanceId: input.options.mode === "manual" ? (input.options.agentInstanceId ?? null) : null,
    });
    // These are point-in-time samples, not an alternate historical schedule.
    // A real execution supersedes an open hypothetical claim of that same Task;
    // it must not be counted again, even if its real contributor differs.
    const realTasks = new Set(captured.occupants.flatMap((occupant) => (occupant.task_id ? [occupant.task_id] : [])));
    const pending = active
      .filter((attempt) => !realTasks.has(attempt.taskId))
      .map((attempt) => ({
        key: `shadow:${attempt.id}`,
        project_id: attempt.projectId,
        task_id: attempt.taskId,
        computer_id: attempt.computerId,
        agent_ids: [attempt.agentId],
      }));
    const snapshot = {
      ...captured.snapshot,
      ...(intent
        ? {
            intent_provenance: {
              version: 1 as const,
              intent_id: intent.row.id,
              task_id: task.id,
              agent_id: intent.row.agentId,
              actor_user_id: intent.row.actorUserId,
              snapshot_digest: intent.row.snapshotDigest,
              execution_authorized: false as const,
            },
          }
        : {}),
      occupancy: schedulerOccupancy(input.projectId, [...captured.occupants, ...pending]),
    };
    const ranking = rankSchedulerCandidates(snapshot);
    const selected = snapshot.candidates.find(
      (candidate) => candidate.agent_instance_id === ranking.selected_agent_instance_id,
    );
    if (!selected) return { ...result("ineligible"), snapshot, ranking };
    await tx
      .insert(schedulerShadowTaskHeads)
      .values({ taskId: task.id, organizationId: ctx.organizationId, projectId: input.projectId })
      .onConflictDoNothing();
    const [head] = await tx
      .select()
      .from(schedulerShadowTaskHeads)
      .where(eq(schedulerShadowTaskHeads.taskId, task.id))
      .for("update");
    if (!head || head.organizationId !== ctx.organizationId || head.projectId !== input.projectId || head.version !== 1)
      throw AppError.conflict("Shadow lease identity/version mismatch");
    if (!Number.isSafeInteger(head.epoch) || head.epoch >= Number.MAX_SAFE_INTEGER)
      throw AppError.conflict("Shadow lease epoch exhausted");
    await tx
      .update(schedulerShadowTaskHeads)
      .set({ epoch: head.epoch + 1 })
      .where(eq(schedulerShadowTaskHeads.taskId, task.id));
    const claimedAt = ctx.clock.nowIso();
    const [attempt] = await tx
      .insert(schedulerShadowAttempts)
      .values({
        id: `shadow_${randomUUID()}`,
        taskId: task.id,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        agentId: selected.agent_id,
        agentInstanceId: selected.agent_instance_id,
        computerId: selected.computer_id,
        epoch: head.epoch + 1,
        state: "claimed",
        claimedAt,
        snapshot,
        ranking,
        expiresAt: sql`${claimedAt}::timestamptz + ${duration} * interval '1 millisecond'`,
      })
      .returning();
    if (!attempt) throw AppError.conflict("Shadow lease was not persisted");
    const binding = ShadowLeaseBindingV1Schema.parse({
      version: 1,
      execution_authorized: false,
      project_id: attempt.projectId,
      task_id: attempt.taskId,
      attempt_id: attempt.id,
      agent_id: attempt.agentId,
      agent_instance_id: attempt.agentInstanceId,
      computer_id: attempt.computerId,
      epoch: attempt.epoch,
    });
    return { ...result("claimed"), binding, expires_at: attempt.expiresAt, snapshot, ranking };
  });
}

/** All mutation identities are checked together in SQL; timestamps retain DB precision. */
async function mutateShadow(
  ctx: ServerContext,
  value: ShadowLeaseBindingV1,
  action: "start" | "renew" | "finish" | "cancel",
  leaseMs: number,
) {
  const binding = ShadowLeaseBindingV1Schema.parse(value),
    duration = leaseDuration.parse(leaseMs);
  if (
    !schedulerRolloutEnabled(ctx.schedulerRollout, "claim_shadow", {
      organizationId: ctx.organizationId,
      projectId: binding.project_id,
    })
  )
    return result("disabled");
  return ctx.db.transaction(async (tx) => {
    if (!(await tryShadowMutex(ctx, tx))) return result("busy");
    const now = ctx.clock.nowIso();
    const a = schedulerShadowAttempts,
      h = schedulerShadowTaskHeads;
    const [updated] = await tx
      .update(a)
      .set(
        action === "start"
          ? { state: "running", startedAt: now }
          : action === "renew"
            ? { expiresAt: sql`greatest(${a.expiresAt}, ${now}::timestamptz + ${duration} * interval '1 millisecond')` }
            : { state: action === "finish" ? "finished" : "cancelled", finishedAt: now },
      )
      .where(
        and(
          eq(a.id, binding.attempt_id),
          eq(a.organizationId, ctx.organizationId),
          eq(a.projectId, binding.project_id),
          eq(a.taskId, binding.task_id),
          eq(a.agentId, binding.agent_id),
          eq(a.agentInstanceId, binding.agent_instance_id),
          eq(a.computerId, binding.computer_id),
          eq(a.epoch, binding.epoch),
          eq(a.executionAuthorized, false),
          action === "start"
            ? eq(a.state, "claimed")
            : action === "finish"
              ? eq(a.state, "running")
              : inArray(a.state, ["claimed", "running"]),
          sql`${a.expiresAt} > ${now}::timestamptz`,
          sql`${a.claimedAt} <= ${now}::timestamptz`,
          sql`(${a.startedAt} IS NULL OR ${a.startedAt} <= ${now}::timestamptz)`,
          sql`EXISTS (SELECT 1 FROM ${h} WHERE ${h.taskId} = ${a.taskId} AND ${h.organizationId} = ${ctx.organizationId}
        AND ${h.projectId} = ${binding.project_id} AND ${h.version} = 1 AND ${h.epoch} = ${binding.epoch})`,
        ),
      )
      .returning();
    return updated ? { ...result("updated"), expires_at: updated.expiresAt } : result("stale");
  });
}

export const startSchedulerShadow = (ctx: ServerContext, binding: ShadowLeaseBindingV1) =>
  mutateShadow(ctx, binding, "start", 30_000);
export const renewSchedulerShadow = (ctx: ServerContext, binding: ShadowLeaseBindingV1, leaseMs = 30_000) =>
  mutateShadow(ctx, binding, "renew", leaseMs);
export const finishSchedulerShadow = (ctx: ServerContext, binding: ShadowLeaseBindingV1) =>
  mutateShadow(ctx, binding, "finish", 30_000);
export const cancelSchedulerShadow = (ctx: ServerContext, binding: ShadowLeaseBindingV1) =>
  mutateShadow(ctx, binding, "cancel", 30_000);
