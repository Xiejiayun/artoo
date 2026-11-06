import { agentInstances, computers, contextPacks, eventLog, goalImportedExecutionCompletions, goalImportedExecutionReceipts,
  goalImportedExecutionRepairs as repairs, goalImportedExecutionRepairCompletions, goalImportedExecutionRepairReceipts, runs } from "@artoo/db";
import { AutonomousTeamSchema, ImportedExecutionRequestV1Schema, ImportedExecutionRepairRequestV1Schema, ImportedExecutionRepairResultV1Schema,
  IMPORTED_EXECUTION_REVIEW_FEATURE_V1, inspectImportedCompletedExecutionRepairV1, inspectImportedImplementationSourceV1,
  importedImplementationSourceDigestV1, canonicalProductSourceTransferValueV1 as canonical, type ImportedImplementationSourceV1, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readImportedExecutionRootFacts, inspectImportedExecutionCompletion } from "./imported-execution-service.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { inspectRunVerification } from "./verification-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

export type Repair = typeof repairs.$inferSelect;
export type RootFacts = Awaited<ReturnType<typeof readImportedExecutionRootFacts>>;

export async function inspectImportedRepairCompletion(ctx: ServerContext, tx: DrizzleDb, row: Repair, input: unknown) {
  const request = ImportedExecutionRepairRequestV1Schema.parse(row.request), result = ImportedExecutionRepairResultV1Schema.parse(input);
  if (result.outcome !== "finished" || !result.verified_repair) throw AppError.conflict("Repair lifecycle alone cannot authorize review readiness");
  const completed = inspectImportedCompletedExecutionRepairV1(request, result.verified_repair, sha);
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.status !== "completed" || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId
    || run.runtimeId !== request.run_start.runtime || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification))
    throw AppError.conflict("Repair completion lost its exact author/context");
  const measured = await inspectRunVerification(ctx, tx, run);
  if (!measured.passed || !measured.evidence || canonical(measured.evidence.payload) !== canonical(completed.verification))
    throw AppError.conflict("Repair lacks exact committed passed node evidence");
  return { request, result, completed, run, evidence: measured.evidence };
}

/** Reconstruct from original DB objects, never from a remote source projection. */
export async function readImportedImplementationSource(ctx: ServerContext, tx: DrizzleDb, root: Pick<RootFacts, "execution" | "sessionBindings" | "bytes">,
  expected?: { kind: string; operationId: string }, ownRepair?: Repair) {
  const base = root.execution, executionRequest = ImportedExecutionRequestV1Schema.parse(base.request);
  const all = await tx.select().from(repairs).where(and(eq(repairs.baseExecutionId, base.id), eq(repairs.organizationId, ctx.organizationId)));
  const candidates = all.filter(row => row.id !== ownRepair?.id).sort((a, b) => b.attemptIndex - a.attemptIndex);
  const latest = candidates[0], kind = latest ? "repair" : "execution", operationId = latest?.id ?? base.id;
  if (expected && (expected.kind !== kind || expected.operationId !== operationId)) throw AppError.conflict("Implementation source was superseded");
  if (ownRepair && (all.filter(row => row.id === ownRepair.id).length !== 1 || all.some(row => row.attemptIndex > ownRepair.attemptIndex)))
    throw AppError.conflict("Repair admission was superseded");
  const relatedRuns = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, base.taskId), eq(runs.organizationId, ctx.organizationId)));
  const allowedRuns = new Set([base.runId, ...all.map(row => row.runId)]);
  if (relatedRuns.length !== allowedRuns.size || relatedRuns.some(run => !allowedRuns.has(run.id))) throw AppError.conflict("Implementation has an unrelated author execution");
  const row = latest ?? base;
  if (!row.reviewReadyAt || !row.reviewReadyEventId || row.stopRequested || row.goalId !== base.goalId || row.planId !== base.planId || row.taskId !== base.taskId
    || row.actorUserId !== base.actorUserId || row.consentId !== base.consentId || row.policyVersion !== base.policyVersion
    || row.computerId !== base.computerId || row.workspaceRoot !== base.workspaceRoot || canonical(row.sessionBindings) !== canonical(root.sessionBindings))
    throw AppError.conflict("Implementation source is not the exact current review-ready author");
  const measured = latest ? await inspectImportedRepairCompletion(ctx, tx, latest, latest.result) : await inspectImportedExecutionCompletion(ctx, tx, base, base.result);
  const [proof] = latest
    ? await tx.select().from(goalImportedExecutionRepairCompletions).where(and(eq(goalImportedExecutionRepairCompletions.repairId, row.id), eq(goalImportedExecutionRepairCompletions.organizationId, ctx.organizationId)))
    : await tx.select().from(goalImportedExecutionCompletions).where(and(eq(goalImportedExecutionCompletions.executionId, row.id), eq(goalImportedExecutionCompletions.organizationId, ctx.organizationId)));
  const [receipt] = latest
    ? await tx.select().from(goalImportedExecutionRepairReceipts).where(and(eq(goalImportedExecutionRepairReceipts.repairId, row.id), eq(goalImportedExecutionRepairReceipts.organizationId, ctx.organizationId)))
    : await tx.select().from(goalImportedExecutionReceipts).where(and(eq(goalImportedExecutionReceipts.executionId, row.id), eq(goalImportedExecutionReceipts.organizationId, ctx.organizationId)));
  const [ready] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.reviewReadyEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = ready?.payload as Record<string, unknown> | undefined;
  const proofDigest = proof && ("completedRepairDigest" in proof ? proof.completedRepairDigest : proof.completedExecutionDigest);
  if (!proof || !receipt || proof.evidenceId !== measured.evidence.id || proofDigest !== hash(measured.completed) || proof.resultDigest !== hash(row.result)
    || row.resultDigest !== hash(row.result) || proof.deliveryId !== row.resultDeliveryId || proof.sessionId !== row.resultSessionId
    || receipt.deliveryId !== proof.deliveryId || receipt.sessionId !== proof.sessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(root.sessionBindings) || proof.sessionId !== root.sessionBindings.destination.sessionId
    || !ready || ready.type !== (latest ? "goal.imported-execution-repair.review-ready" : "goal.imported-execution.review-ready")
    || ready.actorType !== "system" || ready.actorId !== "goal_runner" || ready.goalId !== base.goalId || ready.taskId !== base.taskId || ready.runId !== row.runId
    || payload?.[latest ? "repair_id" : "execution_id"] !== row.id || payload.result_digest !== row.resultDigest
    || payload.actor_user_id !== row.actorUserId || payload.verification_evidence_id !== measured.evidence.id)
    throw AppError.conflict("Implementation source lacks original completion/receipt/readiness provenance");
  if (latest && canonical(ImportedExecutionRepairRequestV1Schema.parse(latest.request).execution_request) !== canonical(executionRequest))
    throw AppError.conflict("Repair changed original implementation inputs");
  const source: ImportedImplementationSourceV1 = inspectImportedImplementationSourceV1(executionRequest, {
    version: 1, kind, operation_id: operationId, request_digest: row.requestDigest, result_digest: row.resultDigest,
    author: { agent_id: row.writerAgentId, instance_id: row.writerInstanceId }, run_start: measured.request.run_start,
    subject_digest: measured.completed.subject_digest, verification: measured.completed.verification,
  }, root.bytes, sha);
  return { ...measured, source, sourceDigest: importedImplementationSourceDigestV1(source, sha), executionRequest, receipt };
}

/** Dedicated reservations exclude exactly their own slot/run; no broad scheduler bypass. */
export async function reserveImportedImplementationParticipants(ctx: ServerContext, tx: DrizzleDb, root: RootFacts,
  source: ImportedImplementationSourceV1, options: { reviewerId?: string; ownReviewId?: string; repair?: Repair; repairAdmission?: boolean; settled?: boolean }) {
  const { budgets } = supportedGoalPolicy(root.goal.budgets, root.goal.stopConditions), team = AutonomousTeamSchema.parse(root.automation.team);
  const scheduleOptions = { branchBacked: false, projectId: root.task.projectId, allowedRuntimes: budgets.allowed_runtimes,
    ...(options.ownReviewId ? { importedExecutionReviewId: options.ownReviewId } : {}),
    ...(options.repair ? { importedExecutionRepairRunId: options.repair.runId } : {}) };
  let reviewerId = options.reviewerId;
  if (!options.repairAdmission && !reviewerId) {
    const choices = await scheduleTask(tx, ctx, ["code.read", "code.review"], { ...scheduleOptions, mode: "auto" });
    reviewerId = choices.candidates.find(choice => choice.agent_id !== source.author.agent_id && choice.agent_instance_id !== source.author.instance_id
      && choice.computer_id === root.execution.computerId && choice.runtime !== "mock" && team.reviewer_instance_ids.includes(choice.agent_instance_id))?.agent_instance_id;
  }
  if (!options.repairAdmission && (!reviewerId || !team.reviewer_instance_ids.includes(reviewerId))) throw AppError.conflict("H6 needs an independent configured destination reviewer");
  const ids = [...new Set([source.author.instance_id, ...(reviewerId ? [reviewerId] : [])])].sort(), participants = new Map<string, typeof agentInstances.$inferSelect>();
  for (const id of ids) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance) throw AppError.conflict("H6 participant is unavailable"); participants.set(id, instance);
  }
  const author = participants.get(source.author.instance_id)!, reviewer = reviewerId ? participants.get(reviewerId)! : undefined;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, root.execution.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online"
    || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_EXECUTION_REVIEW_FEATURE_V1) !== true
    || author.agentId !== source.author.agent_id || author.runtime !== source.run_start.runtime || author.id !== root.writer.id
    || reviewer && (reviewer.id === author.id || reviewer.agentId === author.agentId)
    || [...participants.values()].some(item => item.computerId !== computer.id || item.workspaceRoot !== root.execution.workspaceRoot || item.runtime === "mock"))
    throw AppError.conflict("H6 requires its exact native Windows author and independent reviewer");
  let selected: Awaited<ReturnType<typeof scheduleTask>>["selected"] | undefined;
  for (const item of participants.values()) {
    const caps = item.id === author.id ? [...new Set([...root.spec.required_capabilities, "code.read", "code.modify"])] as Capability[] : ["code.read", "code.review"] as Capability[];
    const schedule = await scheduleTask(tx, ctx, caps, { ...scheduleOptions, mode: "manual", agentInstanceId: item.id });
    if (item.id === author.id) selected = schedule.selected;
  }
  const uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const neighbors = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (neighbors.some(run => run.id !== options.repair?.runId && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (participants.has(run.agentInstanceId) || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, root.execution.workspaceRoot, computer.os))))
    throw AppError.conflict("H6 participant/workspace has an ordinary execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation =>
    !(operation.kind === "execution_review" && operation.id === options.ownReviewId || operation.kind === "execution_repair" && operation.id === options.repair?.id)
    && (operation.participantInstanceIds.some(id => participants.has(id)) || automationWorkspacesOverlap(operation.workspaceRoot, root.execution.workspaceRoot, computer.os))))
    throw AppError.conflict("H6 participant/workspace has another dedicated execution");
  const count = await unsettledGoalExecutionCount(ctx, tx, root.goal.id), extra = options.ownReviewId || options.repair || options.settled ? 0 : 1;
  if (budgets.max_concurrent_runs !== null && count + extra > budgets.max_concurrent_runs) throw AppError.conflict("H6 concurrent execution budget reached");
  return { author, reviewer, selected, budgets };
}
