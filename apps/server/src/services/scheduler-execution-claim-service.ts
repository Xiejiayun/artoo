import {
  agentInstances,
  computers,
  devices,
  deviceTokens,
  runs,
  schedulerDecisions,
  schedulerExecutionRequests,
  appendEvent,
} from "@artoo/db";
import { rankSchedulerCandidates, WorkspaceAllocationRecordSchema, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { requireCurrentTeamMember } from "../auth/request-auth.js";
import { schedulerRolloutEnabled } from "../config/scheduler-rollout.js";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun } from "../mappers.js";
import type { AssignResult } from "./lifecycle-service.js";
import { requireActiveMember } from "./member-status.js";
import { lockSchedulerCapacity } from "./scheduler-capacity-service.js";
import { lockSchedulerConfiguration } from "./scheduler-configuration-fence.js";
import {
  checkSchedulerExecutionRequestSnapshot,
  validateSchedulerExecutionRequestSnapshot,
} from "./scheduler-execution-request-service.js";
import { lockSchedulerRequestTask } from "./scheduler-request-bindings.js";
import { collectSchedulerRankingSnapshot } from "./scheduler-shadow-snapshot.js";
import { scheduleTask } from "./scheduler.js";
import { freezeTaskSourceInputs } from "./task-source-input-service.js";
import { recordSchedulerPreparedStart } from "./scheduler-prepared-start-service.js";

const id = z.string().min(1).max(128);
const inputSchema = z.object({ taskId: id, requestId: id, computerId: id, sessionId: id }).strict();
export type SchedulerExecutionClaimInput = z.infer<typeof inputSchema>;
type Session = NonNullable<ReturnType<NonNullable<ServerContext["getPairedNodeSession"]>>>;

/** Transport identities come from the server registry, never task text or a claimed device id. */
function assertSchedulerClaimSession(ctx: ServerContext, session: Session) {
  if (
    !isDeepStrictEqual(ctx.getPairedNodeSession?.(session.computerId), session) ||
    ctx.supportsExecutionFeature?.(session.computerId, "workspace-allocation.per-run-v1") !== true
  )
    throw AppError.conflict("Scheduling claim lost its original paired allocation session");
}

/** Row locks stop credential edits, but cannot stop wall-clock expiry during awaited admission work. */
function assertSchedulerClaimCurrent(
  ctx: ServerContext,
  session: Session,
  credential: { readonly expiresAt: string | null },
) {
  assertSchedulerClaimSession(ctx, session);
  if (credential.expiresAt !== null) {
    const expires = Date.parse(credential.expiresAt),
      now = Date.parse(ctx.clock.nowIso());
    if (!Number.isFinite(expires) || !Number.isFinite(now) || expires <= now)
      throw AppError.permissionDenied("Scheduling claim paired credential is no longer current");
  }
}

async function lockCredential(ctx: ServerContext, tx: DrizzleDb, session: Session) {
  const [observed] = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.id, session.deviceId), eq(devices.organizationId, ctx.organizationId)));
  if (!observed) throw AppError.permissionDenied("Scheduling claims require a paired node");
  // Enrollment/member writers lock the user before the credential rows too.
  await requireActiveMember(ctx, observed.enrolledByUserId, tx);
  const [device] = await tx
    .select()
    .from(devices)
    .where(and(eq(devices.id, session.deviceId), eq(devices.organizationId, ctx.organizationId)))
    .for("update");
  const [token] = await tx
    .select()
    .from(deviceTokens)
    .where(
      and(
        eq(deviceTokens.organizationId, ctx.organizationId),
        eq(deviceTokens.deviceId, session.deviceId),
        eq(deviceTokens.tokenLookup, session.tokenLookup),
        eq(deviceTokens.kind, "node"),
        eq(deviceTokens.status, "active"),
        isNull(deviceTokens.revokedAt),
      ),
    )
    .for("update");
  if (
    !device ||
    device.trust !== "active" ||
    device.revokedAt !== null ||
    device.computerId !== session.computerId ||
    device.enrolledByUserId !== observed.enrolledByUserId ||
    !token
  )
    throw AppError.permissionDenied("Scheduling claim paired credential is no longer current");
  const credential = Object.freeze({ expiresAt: token.expiresAt });
  assertSchedulerClaimCurrent(ctx, session, credential);
  return credential;
}

/** Internal database kernel only. No HTTP/WS handler calls this until the node attempt protocol exists. */
export async function prepareSchedulerExecutionClaim(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw AppError.validation("Invalid scheduling claim binding");
  input = parsed.data;
  // Both mutexes are non-waiting and require an actual read-committed transaction.
  if (!(await lockSchedulerConfiguration(ctx, tx)) || !(await lockSchedulerCapacity(ctx, tx)))
    throw AppError.conflict("Scheduling execution claim admission is disabled");
  const task = await lockSchedulerRequestTask(ctx, tx, input.taskId);
  for (const flag of ["daemon_claim", "isolated_workspaces", "capacity_admission", "execution_requests"] as const)
    if (
      !schedulerRolloutEnabled(ctx.schedulerRollout, flag, {
        organizationId: ctx.organizationId,
        projectId: task.projectId,
      })
    )
      throw AppError.conflict("Scheduling execution claim admission is disabled");
  const [row] = await tx
    .select()
    .from(schedulerExecutionRequests)
    .where(
      and(
        eq(schedulerExecutionRequests.id, input.requestId),
        eq(schedulerExecutionRequests.taskId, task.id),
        eq(schedulerExecutionRequests.organizationId, ctx.organizationId),
        eq(schedulerExecutionRequests.projectId, task.projectId),
      ),
    );
  if (!row) throw AppError.notFound("Scheduling execution request not found");
  checkSchedulerExecutionRequestSnapshot(row);
  const original: ServerContext = { ...ctx, actorUserId: row.actorUserId, automationActor: undefined };
  await requireCurrentTeamMember(original, tx);
  const observedSession = ctx.getPairedNodeSession?.(input.computerId);
  if (
    !observedSession ||
    observedSession.computerId !== input.computerId ||
    observedSession.sessionId !== input.sessionId
  )
    throw AppError.permissionDenied("Scheduling claims require their current paired node session");
  const session = structuredClone(observedSession);
  const credential = await lockCredential(original, tx, session);
  if (row.state === "consumed") {
    const [run] = await tx
      .select()
      .from(runs)
      .where(
        and(eq(runs.id, row.consumedRunId!), eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, task.id)),
      );
    if (
      !run ||
      run.computerId !== session.computerId ||
      row.consumedDeviceId !== session.deviceId ||
      row.consumedSessionId !== session.sessionId ||
      run.requestedByUserId !== row.actorUserId
    )
      throw AppError.conflict("A consumed scheduling request cannot move to another attempt or session");
    const [decision] = await tx
      .select()
      .from(schedulerDecisions)
      .where(eq(schedulerDecisions.id, run.schedulerDecisionId!));
    if (!decision || decision.organizationId !== ctx.organizationId || decision.taskId !== task.id)
      throw AppError.conflict("Consumed scheduling decision is missing");
    assertSchedulerClaimCurrent(ctx, session, credential);
    return {
      kind: "replay" as const,
      result: {
        run: mapRun(run),
        scheduler_decision: { id: decision.id, reason: decision.reason, score: decision.score },
      },
    };
  }
  await freezeTaskSourceInputs(original, tx, task.id);
  const validated = await validateSchedulerExecutionRequestSnapshot(original, tx, task, row.id);
  const rank = async () => {
    const outcome = await scheduleTask(tx, original, task.requiredCapabilities as Capability[], {
      mode: "auto",
      projectId: task.projectId,
      branchBacked: true,
    });
    const candidates = outcome.candidates.filter(
      (candidate) => candidate.agent_id === row.agentId && candidate.runtime !== "mock",
    );
    const captured = await collectSchedulerRankingSnapshot(original, tx, {
      projectId: task.projectId,
      taskId: task.id,
      manualAgentInstanceId: null,
      candidates,
    });
    const ranking = rankSchedulerCandidates(captured.snapshot);
    const selected = candidates.find((candidate) => candidate.agent_instance_id === ranking.selected_agent_instance_id);
    if (!selected || selected.computer_id !== session.computerId)
      throw AppError.conflict("This node has no selected eligible scheduling candidate");
    return { selected, candidates, captured, ranking };
  };
  const first = await rank();
  // Keep the legacy instance -> computer order, then refresh facts after BOTH waits.
  await tx
    .select({ id: agentInstances.id })
    .from(agentInstances)
    .where(eq(agentInstances.id, first.selected.agent_instance_id))
    .for("update");
  await tx
    .select({ id: computers.id })
    .from(computers)
    .where(eq(computers.id, first.selected.computer_id))
    .for("update");
  await validateSchedulerExecutionRequestSnapshot(original, tx, task, row.id);
  const fresh = await rank();
  if (!isDeepStrictEqual(fresh.selected, first.selected))
    throw AppError.conflict("Scheduling candidate changed while awaiting its resource locks");
  assertSchedulerClaimCurrent(ctx, session, credential);
  return {
    kind: "new" as const,
    original,
    row: validated.row,
    snapshot: validated.snapshot,
    session,
    credential,
    ...fresh,
  };
}

type NewClaim = Extract<Awaited<ReturnType<typeof prepareSchedulerExecutionClaim>>, { kind: "new" }>;

export async function consumeSchedulerExecutionClaim(
  ctx: ServerContext,
  tx: DrizzleDb,
  claim: NewClaim,
  result: AssignResult,
) {
  const [run] = await tx.select().from(runs).where(eq(runs.id, result.run.id));
  const allocation = WorkspaceAllocationRecordSchema.safeParse(run?.workspaceAllocation);
  if (
    !run ||
    run.computerId !== claim.session.computerId ||
    run.agentInstanceId !== claim.selected.agent_instance_id ||
    !allocation.success ||
    !run.workspaceRoot ||
    run.workspaceBranch !== `artoo/run-${run.id}` ||
    run.runtimeId === "mock" ||
    run.requestedByUserId !== claim.row.actorUserId ||
    run.aiDataSharingConsentId !== claim.snapshot.ai_sharing.consent_id ||
    run.aiDataSharingPolicyVersion !== claim.snapshot.ai_sharing.policy_version
  )
    throw AppError.conflict("Scheduling execution requires its exact isolated Run and original authorization");
  await tx
    .update(schedulerDecisions)
    .set({ mode: "auto", reason: "scheduler_execution_request", candidates: claim.candidates })
    .where(eq(schedulerDecisions.id, result.scheduler_decision.id));
  const now = ctx.clock.nowIso();
  const [consumed] = await tx
    .update(schedulerExecutionRequests)
    .set({
      state: "consumed",
      consumedRunId: run.id,
      consumedDeviceId: claim.session.deviceId,
      consumedSessionId: claim.session.sessionId,
      consumedAt: now,
    })
    .where(and(eq(schedulerExecutionRequests.id, claim.row.id), eq(schedulerExecutionRequests.state, "pending")))
    .returning();
  if (!consumed) throw AppError.conflict("Scheduling execution request was already consumed");
  await appendEvent(
    tx,
    buildEvent(ctx, {
      type: "scheduler.execution_request.consumed",
      actorType: "system",
      actorId: "scheduler",
      correlationId: claim.row.id,
      projectId: claim.row.projectId,
      taskId: claim.row.taskId,
      runId: run.id,
      payload: {
        version: 1,
        request_id: claim.row.id,
        actor_user_id: claim.row.actorUserId,
        snapshot_digest: claim.row.snapshotDigest,
        device_id: claim.session.deviceId,
        session_id: claim.session.sessionId,
        ranking: claim.ranking,
        ranking_snapshot: claim.captured.snapshot,
      },
    }),
  );
  await recordSchedulerPreparedStart(ctx, tx, claim.row.id);
  // No await after this comparison: a registry replacement during admission rolls everything back.
  assertSchedulerClaimCurrent(ctx, claim.session, claim.credential);
  return { ...result, scheduler_decision: { ...result.scheduler_decision, reason: "scheduler_execution_request" } };
}
