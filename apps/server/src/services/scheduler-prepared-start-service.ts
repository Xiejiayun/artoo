import {
  contextPacks,
  fileLeases,
  runs,
  schedulerDecisions,
  schedulerExecutionRequests,
  schedulerPreparedStarts,
  tasks,
} from "@artoo/db";
import { SchedulerPreparedStartSnapshotV1Schema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq } from "drizzle-orm";
import { auditDigestV1 } from "../audit-signature.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { checkSchedulerExecutionRequestSnapshot } from "./scheduler-execution-request-service.js";
import { captureSchedulerAssignedBindings } from "./scheduler-request-bindings.js";

/** Hash existing persisted records, including bound approvals via assigned bindings. No commands or secrets are copied. */
async function preparedRunDigest(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect) {
  if (!run.contextPackId || !run.schedulerDecisionId)
    throw AppError.conflict("Prepared scheduling start lost its original context or decision");
  const [context] = await tx
    .select()
    .from(contextPacks)
    .where(
      and(
        eq(contextPacks.id, run.contextPackId),
        eq(contextPacks.organizationId, ctx.organizationId),
        eq(contextPacks.taskId, run.taskId),
      ),
    );
  const [decision] = await tx
    .select()
    .from(schedulerDecisions)
    .where(
      and(
        eq(schedulerDecisions.id, run.schedulerDecisionId),
        eq(schedulerDecisions.organizationId, ctx.organizationId),
        eq(schedulerDecisions.taskId, run.taskId),
      ),
    );
  if (!context || !decision || (context.runId !== null && context.runId !== run.id))
    throw AppError.conflict("Prepared scheduling start lost its original context or decision");
  const leases = await tx
    .select()
    .from(fileLeases)
    .where(and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.runId, run.id)))
    .orderBy(asc(fileLeases.id));
  return auditDigestV1({ run, context, decision, leases });
}

async function collect(ctx: ServerContext, tx: DrizzleDb, requestId: string) {
  const [request] = await tx
    .select()
    .from(schedulerExecutionRequests)
    .where(
      and(
        eq(schedulerExecutionRequests.id, requestId),
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
      ),
    );
  if (!request || request.state !== "consumed") throw AppError.conflict("Prepared start requires a consumed request");
  const permission = checkSchedulerExecutionRequestSnapshot(request);
  const [task] = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, request.taskId), eq(tasks.organizationId, ctx.organizationId)));
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, request.consumedRunId!), eq(runs.organizationId, ctx.organizationId)));
  if (
    !task ||
    !run ||
    task.projectId !== request.projectId ||
    run.taskId !== task.id ||
    run.status !== "queued" ||
    run.startedAt !== null ||
    run.endedAt !== null ||
    task.assigneeType !== "agent" ||
    task.assigneeId !== request.agentId ||
    run.requestedByUserId !== request.actorUserId ||
    run.aiDataSharingConsentId !== permission.ai_sharing.consent_id ||
    run.aiDataSharingPolicyVersion !== permission.ai_sharing.policy_version
  )
    throw AppError.conflict("Prepared start lost its original queued assignment");
  return SchedulerPreparedStartSnapshotV1Schema.parse({
    version: 1,
    request_id: request.id,
    request_snapshot_digest: request.snapshotDigest,
    organization_id: ctx.organizationId,
    project_id: request.projectId,
    task_id: task.id,
    actor_user_id: request.actorUserId,
    run_id: run.id,
    agent_instance_id: run.agentInstanceId,
    computer_id: run.computerId,
    device_id: request.consumedDeviceId,
    session_id: request.consumedSessionId,
    assigned: await captureSchedulerAssignedBindings(ctx, tx, task, permission.request),
    prepared_run_digest: await preparedRunDigest(ctx, tx, run),
    execution_authorized: false,
  });
}

/** Called only in the original claim transaction after assignment and consumption audit. No historical backfill. */
export async function recordSchedulerPreparedStart(ctx: ServerContext, tx: DrizzleDb, requestId: string) {
  const snapshot = await collect(ctx, tx, requestId);
  await tx.insert(schedulerPreparedStarts).values({
    requestId,
    runId: snapshot.run_id,
    snapshot,
    snapshotDigest: auditDigestV1(snapshot),
    createdAt: ctx.clock.nowIso(),
  });
}

/** Drift comparison only. The caller must fence writes; this supplies no auth, eligibility, lease or launch permit. */
export async function assertSchedulerPreparedStartUnchanged(ctx: ServerContext, tx: DrizzleDb, requestId: string) {
  const [stored] = await tx
    .select()
    .from(schedulerPreparedStarts)
    .innerJoin(schedulerExecutionRequests, eq(schedulerExecutionRequests.id, schedulerPreparedStarts.requestId))
    .where(
      and(
        eq(schedulerPreparedStarts.requestId, requestId),
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
      ),
    );
  if (!stored)
    throw AppError.conflict("Prepared scheduling start binding is missing; historical requests cannot be upgraded");
  const row = stored.scheduler_prepared_starts;
  const parsed = SchedulerPreparedStartSnapshotV1Schema.safeParse(row.snapshot);
  if (
    !parsed.success ||
    parsed.data.request_id !== row.requestId ||
    parsed.data.run_id !== row.runId ||
    auditDigestV1(parsed.data) !== row.snapshotDigest
  )
    throw AppError.conflict("Prepared scheduling start snapshot integrity changed");
  const current = await collect(ctx, tx, requestId);
  if (auditDigestV1(current) !== row.snapshotDigest)
    throw AppError.conflict("Prepared scheduling start inputs changed; no execution authority is granted");
  return parsed.data;
}
