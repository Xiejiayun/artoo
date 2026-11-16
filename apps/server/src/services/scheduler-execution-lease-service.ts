import { randomUUID } from "node:crypto";
import { appendEvent, runs, schedulerExecutionLeases, tasks } from "@artoo/db";
import {
  SchedulerExecutionLeaseBindingV1Schema,
  SchedulerExecutionLeaseV1Schema,
  type SchedulerExecutionLeaseBindingV1,
  type SchedulerExecutionLeaseV1,
  type SchedulerStartGrantV1,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import {
  assertSchedulerClaimCurrent,
  prepareSchedulerExecutionClaim,
  type SchedulerExecutionClaimInput,
} from "./scheduler-execution-claim-service.js";
import { checkSchedulerExecutionRequestSnapshot } from "./scheduler-execution-request-service.js";

const leaseDuration = z.number().int().min(1000).max(300_000);
const a = schedulerExecutionLeases;
const utc = (column: SQLWrapper) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const returned = {
  binding: a.binding,
  state: a.state,
  claimed_at: utc(a.claimedAt),
  observed_at: utc(a.observedAt),
  expires_at: utc(a.expiresAt),
  closed_at: utc(a.closedAt),
};

function rethrowLeaseContention(error: unknown): never {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if ((cause as { code?: string } | null)?.code === "55P03")
    throw AppError.conflict("Execution lease evidence is changing; retry the complete operation", {
      reason: "scheduler_execution_lease_busy",
    });
  throw error;
}

async function auditLease(
  ctx: ServerContext,
  tx: DrizzleDb,
  binding: SchedulerExecutionLeaseBindingV1,
  action: "created" | "renewed" | "expired" | "revoked",
  now: string,
) {
  await appendEvent(
    tx,
    buildEvent(ctx, {
      type: `scheduler.execution_lease.${action}`,
      actorType: "system",
      actorId: "scheduler",
      correlationId: binding.request_id,
      projectId: binding.project_id,
      taskId: binding.task_id,
      runId: binding.run_id,
      payload: { version: 1, binding, observed_at: now },
    }),
  );
}

/** Called only while creating a NEW immutable start grant, inside the existing
 * fenced admission transaction. No historic grant is backfilled and replay must
 * never advance an epoch. This is not a physical node-admission receipt. */
export async function recordSchedulerExecutionLease(
  ctx: ServerContext,
  tx: DrizzleDb,
  grant: SchedulerStartGrantV1,
  credentialExpiresAt: string | null,
) {
  const [next] = await tx
    .select({ epoch: sql<string>`(coalesce(max(${a.epoch}),0) + 1)::text` })
    .from(a)
    .where(eq(a.taskId, grant.task_id));
  const binding = SchedulerExecutionLeaseBindingV1Schema.parse({
    version: 1,
    scope: "scheduler.execution-lease.v1",
    lease_id: randomUUID(),
    epoch: Number(next?.epoch),
    request_id: grant.request_id,
    organization_id: grant.organization_id,
    project_id: grant.project_id,
    task_id: grant.task_id,
    run_id: grant.run_id,
    actor_user_id: grant.actor_user_id,
    agent_instance_id: grant.agent_instance_id,
    computer_id: grant.computer_id,
    device_id: grant.device_id,
    session_id: grant.session_id,
    grant_id: grant.grant_id,
    journal_namespace: grant.journal_namespace,
    node_attempt_id: grant.node_attempt_id,
  });
  const now = ctx.clock.nowIso();
  await tx.insert(a).values({
    id: binding.lease_id,
    requestId: binding.request_id,
    organizationId: binding.organization_id,
    projectId: binding.project_id,
    taskId: binding.task_id,
    epoch: binding.epoch,
    binding,
    state: "active",
    claimedAt: now,
    observedAt: now,
    expiresAt: sql`least(${now}::timestamptz + interval '30 seconds', coalesce(${credentialExpiresAt}::timestamptz, 'infinity'::timestamptz))`,
  });
  await auditLease(ctx, tx, binding, "created", now);
}

/** v1 grants predating this migration remain unchanged. A persisted lease,
 * however, cannot be bypassed by replaying its still-unexpired start grant. */
export async function assertSchedulerExecutionLeaseForGrant(
  ctx: ServerContext,
  tx: DrizzleDb,
  grant: SchedulerStartGrantV1,
) {
  const now = ctx.clock.nowIso();
  const [lease] = await tx
    .select({
      current: sql<boolean>`${a.state} = 'active' AND ${a.observedAt} <= ${now}::timestamptz AND ${a.expiresAt} > ${now}::timestamptz`,
    })
    .from(a)
    .where(and(eq(a.requestId, grant.request_id), eq(a.organizationId, ctx.organizationId)))
    .for("share", { noWait: true })
    .catch(rethrowLeaseContention);
  if (lease && !lease.current)
    throw AppError.conflict("Scheduler execution lease is closed, expired or its clock continuity is unknown");
}

function identity(ctx: ServerContext, binding: SchedulerExecutionLeaseBindingV1) {
  return and(
    eq(a.id, binding.lease_id),
    eq(a.organizationId, ctx.organizationId),
    eq(a.projectId, binding.project_id),
    eq(a.taskId, binding.task_id),
    eq(a.requestId, binding.request_id),
    eq(a.epoch, binding.epoch),
    sql`${a.binding} = ${JSON.stringify(binding)}::jsonb`,
    eq(a.state, "active"),
    sql`NOT EXISTS (SELECT 1 FROM scheduler_execution_leases newer WHERE newer.task_id = ${a.taskId} AND newer.epoch > ${binding.epoch})`,
  );
}

/** Shared internal transaction guard for ownership operations. It retains the
 * original paired identity through all awaited callback work. The callback is
 * trusted server code; no callback, DB handle or renewal function crosses wire. */
export async function withCurrentSchedulerExecutionLease<T>(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
  raw: SchedulerExecutionLeaseBindingV1,
  complete: (current: {
    lease: SchedulerExecutionLeaseV1;
    renew(leaseMs?: number): Promise<SchedulerExecutionLeaseV1>;
  }) => Promise<T>,
): Promise<T> {
  const binding = SchedulerExecutionLeaseBindingV1Schema.parse(raw);
  const claim = await prepareSchedulerExecutionClaim(ctx, tx, input);
  if (
    claim.kind !== "replay" ||
    binding.organization_id !== ctx.organizationId ||
    binding.project_id !== claim.row.projectId ||
    binding.task_id !== claim.row.taskId ||
    binding.request_id !== claim.row.id ||
    binding.run_id !== claim.result.run.id ||
    binding.computer_id !== claim.session.computerId ||
    binding.device_id !== claim.session.deviceId ||
    binding.session_id !== claim.session.sessionId ||
    binding.actor_user_id !== claim.row.actorUserId ||
    binding.agent_instance_id !== claim.result.run.agent_instance_id
  )
    throw AppError.conflict("Execution lease requires its exact original consumed assignment");
  const permission = checkSchedulerExecutionRequestSnapshot(claim.row);
  await requireAiSharingAuthorization(claim.original, tx, {
    consentId: permission.ai_sharing.consent_id,
    policyVersion: permission.ai_sharing.policy_version,
  });
  // Lifecycle can lock Run -> Task. We already hold Task; never wait in reverse.
  const [run] = await tx
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.id, binding.run_id),
        eq(runs.organizationId, ctx.organizationId),
        inArray(runs.status, ["queued", "starting", "running", "paused", "awaiting_input"]),
      ),
    )
    .for("share", { noWait: true })
    .catch(rethrowLeaseContention);
  if (
    !run ||
    run.endedAt !== null ||
    run.taskId !== binding.task_id ||
    run.computerId !== binding.computer_id ||
    run.agentInstanceId !== binding.agent_instance_id ||
    run.requestedByUserId !== binding.actor_user_id ||
    run.aiDataSharingConsentId !== permission.ai_sharing.consent_id ||
    run.aiDataSharingPolicyVersion !== permission.ai_sharing.policy_version
  )
    throw AppError.conflict("Execution lease Run is no longer its original active assignment");
  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, binding.task_id),
        eq(tasks.organizationId, ctx.organizationId),
        eq(tasks.projectId, binding.project_id),
        inArray(tasks.status, ["assigned", "running", "awaiting_approval"]),
        eq(tasks.assigneeType, "agent"),
        eq(tasks.assigneeId, claim.row.agentId),
      ),
    );
  if (!task) throw AppError.conflict("Execution lease Task no longer has its original active assignment");

  const now = ctx.clock.nowIso();
  const [locked] = await tx
    .select(returned)
    .from(a)
    .where(
      and(
        identity(ctx, binding),
        sql`${a.observedAt} <= ${now}::timestamptz AND ${a.expiresAt} > ${now}::timestamptz`,
        sql`(${claim.credential.expiresAt}::timestamptz IS NULL OR ${a.expiresAt} <= ${claim.credential.expiresAt}::timestamptz)`,
      ),
    )
    .for("update", { noWait: true })
    .catch(rethrowLeaseContention);
  if (!locked) throw AppError.conflict("Execution lease is stale, expired or its clock regressed");
  let renewed = false;
  const result = await complete({
    lease: SchedulerExecutionLeaseV1Schema.parse({ version: 1, ...locked }),
    async renew(leaseMs = 30_000) {
      if (renewed) throw AppError.conflict("One renewal per execution lease operation is required");
      renewed = true;
      const duration = leaseDuration.parse(leaseMs),
        now = ctx.clock.nowIso();
      const [updated] = await tx
        .update(a)
        .set({
          observedAt: now,
          expiresAt: sql`greatest(${a.expiresAt}, least(${now}::timestamptz + ${duration} * interval '1 millisecond', coalesce(${claim.credential.expiresAt}::timestamptz, 'infinity'::timestamptz)))`,
        })
        .where(
          and(
            identity(ctx, binding),
            sql`${a.observedAt} <= ${now}::timestamptz AND ${a.expiresAt} > ${now}::timestamptz`,
            sql`(${claim.credential.expiresAt}::timestamptz IS NULL OR ${a.expiresAt} <= ${claim.credential.expiresAt}::timestamptz)`,
          ),
        )
        .returning(returned);
      if (!updated) throw AppError.conflict("Execution lease is stale, expired or its clock regressed");
      await auditLease(ctx, tx, binding, "renewed", now);
      return SchedulerExecutionLeaseV1Schema.parse({ version: 1, ...updated });
    },
  });
  const finalNow = ctx.clock.nowIso();
  const [current] = await tx
    .select({ id: a.id })
    .from(a)
    .where(
      and(
        identity(ctx, binding),
        sql`${a.observedAt} <= ${finalNow}::timestamptz AND ${a.expiresAt} > ${finalNow}::timestamptz`,
      ),
    );
  if (!current) throw AppError.conflict("Execution lease expired during renewal");
  assertSchedulerClaimCurrent(ctx, claim.session, claim.credential);
  return result;
}

/** Internal logical ownership only. Network callers additionally require their
 * independently scoped attempt credential; this function is not a wire handler. */
export async function renewSchedulerExecutionLease(
  ctx: ServerContext,
  input: SchedulerExecutionClaimInput,
  raw: SchedulerExecutionLeaseBindingV1,
  leaseMs = 30_000,
) {
  const duration = leaseDuration.parse(leaseMs),
    binding = SchedulerExecutionLeaseBindingV1Schema.parse(raw);
  return ctx.db.db.transaction(
    (tx) => withCurrentSchedulerExecutionLease(ctx, tx, input, binding, (current) => current.renew(duration)),
    { isolationLevel: "read committed" },
  );
}

/** Server-owned fencing only, also usable when the original node is unreachable.
 * It changes no Task/Run status, file lease, reservation or physical-exit fact.
 * No reaper, takeover, retry or process Stop is installed by this kernel. */
export async function closeSchedulerExecutionLease(
  ctx: ServerContext,
  raw: SchedulerExecutionLeaseBindingV1,
  reason: "expired" | "revoked",
) {
  return ctx.db.db.transaction((tx) => closeSchedulerExecutionLeaseInTransaction(ctx, tx, raw, reason));
}

/** Internal owner composition only. A caller must separately authenticate any
 * node evidence before using this fence in its receipt transaction. */
export async function closeSchedulerExecutionLeaseInTransaction(
  ctx: ServerContext,
  tx: DrizzleDb,
  raw: SchedulerExecutionLeaseBindingV1,
  reason: "expired" | "revoked",
) {
  const binding = SchedulerExecutionLeaseBindingV1Schema.parse(raw);
  if (reason !== "expired" && reason !== "revoked") throw AppError.validation("Invalid execution lease closure reason");
  const now = ctx.clock.nowIso();
  const [updated] = await tx
    .update(a)
    .set({ state: reason, observedAt: now, closedAt: now })
    .where(
      and(
        identity(ctx, binding),
        eq(a.state, "active"),
        sql`${a.observedAt} <= ${now}::timestamptz`,
        reason === "expired" ? sql`${a.expiresAt} <= ${now}::timestamptz` : undefined,
      ),
    )
    .returning(returned);
  if (!updated) throw AppError.conflict("Execution lease closure is stale or not yet eligible");
  await auditLease(ctx, tx, binding, reason, now);
  return SchedulerExecutionLeaseV1Schema.parse({ version: 1, ...updated });
}
