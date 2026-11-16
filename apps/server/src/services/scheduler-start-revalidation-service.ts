import { agentInstances, computers, contextPacks, fileLeases, runs, schedulerDecisions } from "@artoo/db";
import { rankSchedulerCandidates, type SchedulerPreparedStartSnapshotV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import {
  assertSchedulerClaimCurrent,
  prepareSchedulerExecutionClaim,
  type SchedulerExecutionClaimInput,
} from "./scheduler-execution-claim-service.js";
import { checkSchedulerExecutionRequestSnapshot } from "./scheduler-execution-request-service.js";
import { assertSchedulerPreparedStartUnchanged } from "./scheduler-prepared-start-service.js";
import { collectSchedulerRankingSnapshot, schedulerOccupancy } from "./scheduler-shadow-snapshot.js";
import { revalidateSchedulerPreparedCandidate } from "./scheduler.js";
import { freezeTaskSourceInputs } from "./task-source-input-service.js";

/** Current database admission evidence only. No transport calls this and no
 * node/journal/physical launch permit is issued. A later start must revalidate
 * in its own admission transaction rather than reuse this returned observation. */
export async function revalidateSchedulerPreparedStart(ctx: ServerContext, input: SchedulerExecutionClaimInput) {
  return ctx.db.db.transaction((tx) => revalidateSchedulerPreparedStartInTransaction(ctx, tx, input), {
    isolationLevel: "read committed",
  });
}

/** Same comparison inside a caller-owned admission transaction. No nested
 * transaction or post-commit observation can stand in for physical admission. */
export async function revalidateSchedulerPreparedStartInTransaction(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
) {
  return withRevalidatedSchedulerPreparedStart(ctx, tx, input, async (prepared) => ({
    version: 1 as const,
    request_id: prepared.request_id,
    run_id: prepared.run_id,
    agent_instance_id: prepared.agent_instance_id,
    computer_id: prepared.computer_id,
    observed_at: ctx.clock.nowIso(),
    execution_authorized: false as const,
  }));
}

/** Internal database-only completion under the same fences. Keep credential
 * identity private and check it after ALL awaited completion work. The callback
 * must not send transport frames or start physical work before commit. */
export async function withRevalidatedSchedulerPreparedStart<T>(
  ctx: ServerContext,
  tx: DrizzleDb,
  input: SchedulerExecutionClaimInput,
  complete: (prepared: SchedulerPreparedStartSnapshotV1) => Promise<T>,
): Promise<T> {
  // Reuse configuration/capacity/Task/user/device/token lock order and all
  // startup scopes. Replay never consumes another permission or creates work.
  const claim = await prepareSchedulerExecutionClaim(ctx, tx, input);
  if (claim.kind !== "replay") throw AppError.conflict("Start revalidation requires an already consumed request");
  const permission = checkSchedulerExecutionRequestSnapshot(claim.row);
  await requireAiSharingAuthorization(claim.original, tx, {
    consentId: permission.ai_sharing.consent_id,
    policyVersion: permission.ai_sharing.policy_version,
  });
  const initial = await assertSchedulerPreparedStartUnchanged(claim.original, tx, claim.row.id);
  await tx
    .select({ id: agentInstances.id })
    .from(agentInstances)
    .where(eq(agentInstances.id, initial.agent_instance_id))
    .for("update");
  await tx.select({ id: computers.id }).from(computers).where(eq(computers.id, initial.computer_id)).for("update");
  // Run-event ingestion can lock Run -> Task. Never wait in the opposite
  // order while holding Task; reject a busy lifecycle/evidence writer instead.
  // All waiting resource locks precede these non-waiting evidence locks.
  try {
    await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, claim.result.run.id), eq(runs.organizationId, ctx.organizationId)))
      .for("share", { noWait: true });
    if (!claim.result.run.context_pack_id)
      throw AppError.conflict("Prepared scheduling start lost its original context");
    await tx
      .select({ id: contextPacks.id })
      .from(contextPacks)
      .where(
        and(eq(contextPacks.id, claim.result.run.context_pack_id), eq(contextPacks.organizationId, ctx.organizationId)),
      )
      .for("share", { noWait: true });
    await tx
      .select({ id: schedulerDecisions.id })
      .from(schedulerDecisions)
      .where(
        and(
          eq(schedulerDecisions.id, claim.result.scheduler_decision.id),
          eq(schedulerDecisions.organizationId, ctx.organizationId),
        ),
      )
      .for("share", { noWait: true });
    await tx
      .select({ id: fileLeases.id })
      .from(fileLeases)
      .where(and(eq(fileLeases.runId, claim.result.run.id), eq(fileLeases.organizationId, ctx.organizationId)))
      .for("share", { noWait: true });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    if ((cause as { code?: string } | null)?.code === "55P03")
      throw AppError.conflict("Prepared scheduling execution is changing; retry the complete operation", {
        reason: "scheduler_prepared_execution_busy",
      });
    throw error;
  }
  await freezeTaskSourceInputs(claim.original, tx, initial.task_id);
  // Refresh all prepared bindings and eligibility after both resource waits.
  const { prepared, outcome } = await revalidateSchedulerPreparedCandidate(tx, claim.original, claim.row.id);
  const captured = await collectSchedulerRankingSnapshot(claim.original, tx, {
    projectId: prepared.project_id,
    taskId: prepared.task_id,
    candidates: outcome.candidates,
    manualAgentInstanceId: prepared.agent_instance_id,
  });
  const ownKey = `run:${prepared.run_id}`;
  const own = captured.occupants.find((occupant) => occupant.key === ownKey);
  if (
    !own ||
    own.project_id !== prepared.project_id ||
    own.task_id !== prepared.task_id ||
    own.computer_id !== prepared.computer_id ||
    own.agent_ids.length !== 1 ||
    own.agent_ids[0] !== claim.row.agentId ||
    own.agent_instance_ids?.length !== 1 ||
    own.agent_instance_ids[0] !== prepared.agent_instance_id ||
    !own.evidence?.includes("active_run") ||
    own.evidence.some((item) => item !== "active_run" && item !== "held_file_lease")
  )
    throw AppError.conflict("Prepared scheduling start lost its exact ordinary reservation");
  const ranking = rankSchedulerCandidates({
    ...captured.snapshot,
    // Revalidate the existing reservation; no other Run or dedicated owner
    // can be subtracted and the durable reservation itself is never released.
    occupancy: schedulerOccupancy(
      prepared.project_id,
      captured.occupants.filter((occupant) => occupant.key !== ownKey),
    ),
  });
  if (ranking.selected_agent_instance_id !== prepared.agent_instance_id)
    throw AppError.conflict("Prepared scheduling start no longer meets current scheduling policy");
  const result = await complete(prepared);
  assertSchedulerClaimCurrent(ctx, claim.session, claim.credential);
  return result;
}
