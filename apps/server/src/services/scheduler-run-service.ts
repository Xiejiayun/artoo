import { randomBytes, randomUUID } from "node:crypto";
import { appendEvent, runs, tasks, schedulerExecutionRequests, schedulerExecutionLeases, schedulerRunCredentials, schedulerRunStopIntents, schedulerRequestStopIntents, schedulerStartGrants } from "@artoo/db";
import { SchedulerRunCredentialV1Schema, SchedulerStartGrantV1Schema,
  type SchedulerRunCredentialV1, type SchedulerExecutionLeaseBindingV1, type SchedulerExecutionLeaseV1 } from "@artoo/domain";
import type { SchedulerRunEventMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, sql, type SQLWrapper } from "drizzle-orm";
import { requireCurrentTeamMember } from "../auth/request-auth.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { constantTimeEqualHex, sha256Hex } from "./device-credential.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { prepareSchedulerExecutionClaim, assertSchedulerClaimCurrent, type SchedulerExecutionClaimInput } from "./scheduler-execution-claim-service.js";
import { checkSchedulerExecutionRequestSnapshot } from "./scheduler-execution-request-service.js";
import { withCurrentSchedulerExecutionLease } from "./scheduler-execution-lease-service.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";

const c = schedulerRunCredentials, l = schedulerExecutionLeases, g = schedulerStartGrants;
const utc = (column: SQLWrapper) => sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const returned = { binding: l.binding, state: l.state, claimed_at: utc(l.claimedAt), observed_at: utc(l.observedAt), expires_at: utc(l.expiresAt), closed_at: utc(l.closedAt) };
const hash = (credential: SchedulerRunCredentialV1, leaseId: string) => sha256Hex(JSON.stringify([credential.scope, credential.credential_id, leaseId, credential.secret]));
function requireRollout(ctx: ServerContext, projectId: string) {
  if (!schedulerRolloutEnabled(ctx.schedulerRollout, "attempt_credentials", { organizationId: ctx.organizationId, projectId })) throw AppError.conflict("Scheduler attempt protocol is disabled");
}
const identity = (ctx: ServerContext, binding: SchedulerExecutionLeaseBindingV1) => and(
  eq(l.id, binding.lease_id), eq(l.organizationId, ctx.organizationId),
  sql`${l.binding} = ${JSON.stringify(binding)}::jsonb`,
  sql`NOT EXISTS (SELECT 1 FROM scheduler_execution_leases newer WHERE newer.task_id=${l.taskId} AND newer.epoch>${binding.epoch})`,
);

async function authenticate(tx: DrizzleDb, binding: SchedulerExecutionLeaseBindingV1, credential: SchedulerRunCredentialV1, allowRevoked = false) {
  const [stored] = await tx.select().from(c).where(and(eq(c.id, credential.credential_id), eq(c.leaseId, binding.lease_id))).for("update", { noWait: true });
  if (!stored || (!allowRevoked && stored.revokedAt !== null) || !constantTimeEqualHex(hash(credential, binding.lease_id), stored.secretHash))
    throw AppError.permissionDenied("Scheduler lifecycle credential is not valid for this attempt");
}
async function stopRequested(tx: DrizzleDb, leaseId: string) {
  const [lease] = await tx.select({ requestId: l.requestId }).from(l).where(eq(l.id, leaseId));
  return (await tx.select({ id: schedulerRunStopIntents.leaseId }).from(schedulerRunStopIntents).where(eq(schedulerRunStopIntents.leaseId, leaseId))).length > 0 || !!lease && (await tx.select({ id: schedulerRequestStopIntents.requestId }).from(schedulerRequestStopIntents).where(eq(schedulerRequestStopIntents.requestId, lease.requestId))).length > 0;
}

/** Safe read-model projection. This never exposes a hash or credential. */
export async function schedulerRequestStopRequested(ctx: ServerContext, tx: DrizzleDb, requestId: string, leaseId?: string) {
  const [request] = await tx.select({ id: schedulerExecutionRequests.id }).from(schedulerExecutionRequests).where(and(eq(schedulerExecutionRequests.id, requestId), eq(schedulerExecutionRequests.organizationId, ctx.organizationId)));
  if (!request) return false;
  if ((await tx.select({ id: schedulerRequestStopIntents.requestId }).from(schedulerRequestStopIntents).where(eq(schedulerRequestStopIntents.requestId, requestId))).length) return true;
  if (!leaseId) return false;
  const [lease] = await tx.select({ id: l.id }).from(l).where(and(eq(l.id, leaseId), eq(l.requestId, requestId), eq(l.organizationId, ctx.organizationId)));
  return lease ? stopRequested(tx, leaseId) : false;
}

export type SchedulerRunAcquisition =
  | { status: "issued"; credential: SchedulerRunCredentialV1; lease: SchedulerExecutionLeaseV1; stop_requested: boolean }
  | { status: "retained"; lease: SchedulerExecutionLeaseV1; stop_requested: boolean };

/** Issued once to the exact original grant/session. A lost secret is never recoverable. */
export async function acquireSchedulerRunCredential(ctx: ServerContext, input: SchedulerExecutionClaimInput, raw: unknown): Promise<SchedulerRunAcquisition> {
  const parsed = SchedulerStartGrantV1Schema.safeParse(raw);
  if (!parsed.success) throw AppError.validation("Invalid scheduler lifecycle grant");
  const grant = parsed.data;
  requireRollout(ctx, grant.project_id);
  return ctx.db.db.transaction(async (tx) => {
    const [found] = await tx.select({ binding: l.binding }).from(l).innerJoin(g, eq(g.requestId, l.requestId)).where(and(
      eq(l.organizationId, ctx.organizationId), eq(l.requestId, grant.request_id), eq(g.grantId, grant.grant_id),
      sql`${g.snapshot} = ${JSON.stringify(grant)}::jsonb`,
    ));
    if (!found) throw AppError.conflict("Scheduler lifecycle requires its exact persisted grant");
    return withCurrentSchedulerExecutionLease(ctx, tx, input, found.binding, async ({ lease }) => {
      const [existing] = await tx.select().from(c).where(eq(c.leaseId, lease.binding.lease_id)).for("update", { noWait: true });
      const stop_requested = await stopRequested(tx, lease.binding.lease_id);
      if (existing) {
        if (existing.revokedAt !== null) throw AppError.conflict("Scheduler lifecycle credential has been revoked");
        return { status: "retained" as const, lease, stop_requested };
      }
      const credential = SchedulerRunCredentialV1Schema.parse({ version: 1, scope: "scheduler.attempt-events.v1", credential_id: randomUUID(), secret: randomBytes(32).toString("base64url") });
      await tx.insert(c).values({ id: credential.credential_id, leaseId: lease.binding.lease_id, secretHash: hash(credential, lease.binding.lease_id), createdAt: ctx.clock.nowIso() });
      return { status: "issued" as const, credential: Object.freeze(credential), lease, stop_requested };
    });
  }, { isolationLevel: "read committed" });
}

export async function schedulerRunStatus(ctx: ServerContext, input: SchedulerExecutionClaimInput, binding: SchedulerExecutionLeaseBindingV1, credential: SchedulerRunCredentialV1) {
  requireRollout(ctx, binding.project_id);
  return ctx.db.db.transaction((tx) => withCurrentSchedulerExecutionLease(ctx, tx, input, binding, async ({ lease }) => {
    await authenticate(tx, binding, credential);
    return { lease, stop_requested: await stopRequested(tx, binding.lease_id) };
  }), { isolationLevel: "read committed" });
}

/** Runs inside the existing receipt owner's transaction, before it locks Run.
 * Task -> Run NOWAIT -> lease -> credential avoids waiting in reverse order.
 * Terminal replay is restricted to an already committed exact qualified body. */
export async function authorizeSchedulerRunEvent(ctx: ServerContext, tx: DrizzleDb, message: SchedulerRunEventMessage, duplicate: boolean) {
  const b = message.binding;
  const unused = message.frame.event.type === "scheduler.permit_unused" ? message.frame.event.payload : undefined;
  requireRollout(ctx, b.project_id);
  if (message.node_id !== b.computer_id || message.session_id !== b.session_id || message.frame.node_id !== b.computer_id || message.frame.run_id !== b.run_id)
    throw AppError.permissionDenied("Scheduler lifecycle envelope does not match its original assignment");
  if (unused && (unused.grant_id !== b.grant_id || unused.journal_namespace !== b.journal_namespace || unused.node_attempt_id !== b.node_attempt_id))
    throw AppError.permissionDenied("Unused permit evidence differs from its original journal binding");
  const claim = await prepareSchedulerExecutionClaim(ctx, tx, { taskId: b.task_id, requestId: b.request_id, computerId: b.computer_id, sessionId: b.session_id });
  if (claim.kind !== "replay" || b.organization_id !== ctx.organizationId || b.project_id !== claim.row.projectId || b.task_id !== claim.row.taskId || b.request_id !== claim.row.id || b.run_id !== claim.result.run.id || b.actor_user_id !== claim.row.actorUserId || b.agent_instance_id !== claim.result.run.agent_instance_id || b.device_id !== claim.session.deviceId || b.session_id !== claim.session.sessionId)
    throw AppError.permissionDenied("Scheduler lifecycle requires its exact consumed assignment");
  const permission = checkSchedulerExecutionRequestSnapshot(claim.row);
  // Closing a never-started permit discloses no Provider/task content. Revoked
  // AI-sharing consent must not prevent this original owner from relinquishing it.
  if (!unused) await requireAiSharingAuthorization(claim.original, tx, { consentId: permission.ai_sharing.consent_id, policyVersion: permission.ai_sharing.policy_version });
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, b.run_id), eq(runs.organizationId, ctx.organizationId))).for("update", { noWait: true });
  if (!run || run.taskId !== b.task_id || run.computerId !== b.computer_id || run.agentInstanceId !== b.agent_instance_id || run.requestedByUserId !== b.actor_user_id || run.aiDataSharingConsentId !== permission.ai_sharing.consent_id || run.aiDataSharingPolicyVersion !== permission.ai_sharing.policy_version)
    throw AppError.permissionDenied("Scheduler lifecycle Run differs from its original assignment");
  const [lease] = await tx.select(returned).from(l).where(identity(ctx, b)).for("update", { noWait: true });
  if (!lease) throw AppError.conflict("Scheduler lifecycle epoch is stale");
  await authenticate(tx, b, message.credential, duplicate || unused !== undefined);
  async function assertCurrent() {
    const now = ctx.clock.nowIso();
    // The dedicated unused-permit event may only close its original assignment,
    // even after logical expiry/revocation. No other write gains that exception.
    const [current] = await tx.select({ id: l.id }).from(l).where(and(identity(ctx, b), sql`${l.observedAt}<=${now}::timestamptz`, unused ? undefined : and(eq(l.state, "active"), sql`${l.expiresAt}>${now}::timestamptz`)));
    if (!current) throw AppError.conflict("Scheduler lifecycle lease expired or was fenced");
    assertSchedulerClaimCurrent(ctx, claim.session, claim.credential);
  }
  if (!duplicate) {
    const [task] = await tx.select({ status: tasks.status, assigneeType: tasks.assigneeType, assigneeId: tasks.assigneeId }).from(tasks).where(and(eq(tasks.id, b.task_id), eq(tasks.projectId, b.project_id), eq(tasks.organizationId, ctx.organizationId)));
    if (!task || !["assigned", "running", "awaiting_approval"].includes(task.status) || task.assigneeType !== "agent" || task.assigneeId !== claim.row.agentId) throw AppError.conflict("Scheduler lifecycle Task no longer has its original assignment");
    if (run.endedAt !== null || !["queued", "starting", "running", "paused", "awaiting_input"].includes(run.status)) throw AppError.conflict("Scheduler lifecycle Run is terminal");
    await assertCurrent();
  }
  return async () => {
    // The lifecycle write itself may revoke its credential on terminal state.
    // Unused-permit closure does not renew or restore execution authority, and
    // all lanes still reject a replaced original session or a newer epoch.
    if (!duplicate) await assertCurrent();
    else assertSchedulerClaimCurrent(ctx, claim.session, claim.credential);
  };
}

/** Returns null for a manual Run. Acceptance records intent only, never exit. */
export async function requestSchedulerRunStop(ctx: ServerContext, runId: string) {
  return ctx.db.transaction(async (tx) => {
    await requireCurrentTeamMember(ctx, tx);
    const [request] = await tx.select().from(schedulerExecutionRequests).where(and(eq(schedulerExecutionRequests.organizationId, ctx.organizationId), eq(schedulerExecutionRequests.consumedRunId, runId), eq(schedulerExecutionRequests.state, "consumed")));
    if (!request) return null;
    const [found] = await tx.select({ binding: l.binding }).from(l).where(and(eq(l.organizationId, ctx.organizationId), eq(l.requestId, request.id)));
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))).for("update");
    if (!run) throw AppError.notFound("Run not found");
    if (run.status === "cancelled") return { stop_requested: false as const };
    if (run.endedAt !== null || !["queued", "starting", "running", "paused", "awaiting_input"].includes(run.status)) throw AppError.conflict("Run is already terminal");
    if (!(await schedulerRequestStopRequested(ctx, tx, request.id, found?.binding.lease_id))) {
      await tx.insert(schedulerRequestStopIntents).values({ requestId: request.id, requestedByUserId: ctx.actorUserId, requestedAt: ctx.clock.nowIso() });
      // Retain the original lease projection for mixed-version readers.
      if (found) await tx.insert(schedulerRunStopIntents).values({ leaseId: found.binding.lease_id, requestedByUserId: ctx.actorUserId, requestedAt: ctx.clock.nowIso() });
      await appendEvent(tx, buildEvent(ctx, { type: "scheduler.run.stop_requested", actorType: "user", actorId: ctx.actorUserId, correlationId: request.id, projectId: request.projectId, taskId: request.taskId, runId, payload: { version: 1, request_id: request.id, ...(found ? { binding: found.binding } : {}), process_exit_confirmed: false } }));
    }
    return { stop_requested: true as const };
  });
}
