import { agentInstances, computers, contextPacks, eventLog, goalAutomations, runs, tasks,
  goalRecoveryValidations, goalRecoveryValidationCompletions, goalRecoveryValidationReceipts,
  goalRecoveryValidationReviews, goalRecoveryValidationReviewReceipts, goalSourceRecoveries,
  goalSourceRecoveryCheckpoints, goalSourceRecoveryReceipts, goalSourceRecoverySettlements, nodeRecoveryRegistrations } from "@artoo/db";
import { ImportedRecoveryValidationRequestV1Schema, ImportedRecoveryValidationReviewRequestV1Schema,
  IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1, inspectImportedRecoveryValidationCompletionV1,
  inspectImportedRecoveryValidationReviewCompletionV1, importedRecoveryValidationSourceDigestV1,
  importedRecoveryValidationReviewRequestDigestV1, ProductSourceRecoveryCheckpointV1Schema, ProductSourceRecoveryRequestV1Schema,
  inspectProductSourceRecoveryResultV1,
  productSourceRecoveryCheckpointDigestV1, canonicalProductSourceTransferValueV1 as canonical,
  type ImportedRecoveryValidationSourceV1, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readImportedValidationOrigin } from "./imported-validation-source-service.js";
import { readLiveSourceRecoveryOrigin } from "./source-recovery-service.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { readRunVerificationEvidence, inspectRunVerification } from "./verification-service.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

export type Validation = typeof goalRecoveryValidations.$inferSelect;
export type ValidationReview = typeof goalRecoveryValidationReviews.$inferSelect;
/** Fresh current sessions are confined to H9; the H6/H7 history reader stays unchanged. */
export async function readRecoveryValidationRoot(ctx: ServerContext, tx: DrizzleDb, recoveryId: string, options: { live?: boolean } = {}) {
  const [recovery] = await tx.select().from(goalSourceRecoveries).where(and(eq(goalSourceRecoveries.id, recoveryId), eq(goalSourceRecoveries.organizationId, ctx.organizationId)));
  const [stored] = await tx.select().from(goalSourceRecoveryCheckpoints).where(and(eq(goalSourceRecoveryCheckpoints.recoveryId, recoveryId), eq(goalSourceRecoveryCheckpoints.organizationId, ctx.organizationId)));
  const [receipt] = await tx.select().from(goalSourceRecoveryReceipts).where(and(eq(goalSourceRecoveryReceipts.recoveryId, recoveryId), eq(goalSourceRecoveryReceipts.organizationId, ctx.organizationId)));
  const [registration] = recovery ? await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.id, recovery.registrationId), eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId))) : [];
  if (!recovery || !stored || !receipt || !registration || !recovery.settledAt || !recovery.settlementEventId
    || stored.resultDigest !== recovery.resultDigest || receipt.resultDigest !== recovery.resultDigest || receipt.requestDigest !== recovery.requestDigest
    || receipt.deliveryId !== recovery.resultDeliveryId || receipt.sessionId !== recovery.currentSessionId)
    throw AppError.conflict("Fresh validation requires original committed recovery checkpoint, receipt and settlement");
  const checkpoint = ProductSourceRecoveryCheckpointV1Schema.parse(stored.checkpoint);
  const request = ProductSourceRecoveryRequestV1Schema.parse(recovery.request), result = inspectProductSourceRecoveryResultV1(request, recovery.result, sha);
  const [settled] = await tx.select().from(eventLog).where(and(eq(eventLog.id, recovery.settlementEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = settled?.payload as Record<string, unknown> | undefined;
  const operations = await tx.select().from(goalSourceRecoverySettlements).where(and(eq(goalSourceRecoverySettlements.recoveryId, recovery.id), eq(goalSourceRecoverySettlements.organizationId, ctx.organizationId)));
  if (stored.checkpointDigest !== productSourceRecoveryCheckpointDigestV1(checkpoint, sha) || checkpoint.recovery_id !== recovery.id
    || result.outcome !== "recovered" || canonical(result.checkpoint) !== canonical(checkpoint) || hash(request) !== recovery.requestDigest || hash(result) !== recovery.resultDigest
    || request.registration_id !== registration.id || request.origin_review_id !== recovery.originReviewId || request.goal_id !== recovery.goalId || request.plan_id !== recovery.planId
    || request.current_session_id !== recovery.currentSessionId || checkpoint.current_session_id !== recovery.currentSessionId
    || !settled || settled.type !== "goal.source-recovery.settled" || settled.actorType !== "system" || settled.actorId !== "goal_runner" || settled.goalId !== recovery.goalId
    || payload?.recovery_id !== recovery.id || payload.actor_user_id !== recovery.actorUserId || payload.result_digest !== recovery.resultDigest
    || payload.checkpoint_digest !== stored.checkpointDigest || payload.source_state !== "unverified" || payload.publication_authorized !== false
    || operations.length !== request.operations.length || request.operations.some(ref => !operations.some(operation => operation.kind === ref.kind
      && operation.operationId === ref.operation_id && operation.requestDigest === ref.request_digest && operation.runId === (ref.run_id ?? null)
      && operation.eventId === settled.id && operation.goalId === recovery.goalId && operation.computerId === recovery.computerId)))
    throw AppError.conflict("Recovery checkpoint identity changed");
  const [registered] = await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.epochId, checkpoint.new_epoch_id), eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId)));
  if (!registered || registered.sessionId !== recovery.currentSessionId || canonical(registered.registration && (registered.registration as { binding?: unknown }).binding) !== canonical(checkpoint.binding))
    throw AppError.conflict("Recovery validation requires a separately registered fresh epoch");
  const root = options.live ? await readLiveSourceRecoveryOrigin(ctx, tx, recovery.originReviewId, registration, recovery.currentSessionId)
    : await readImportedValidationOrigin(ctx, tx, recovery.originReviewId);
  if (canonical(request.origin) !== canonical(root.origin)) throw AppError.conflict("Recovery checkpoint lost its original accepted source");
  const destination = { computerId: registered.computerId, deviceId: registered.deviceId, tokenLookup: registered.tokenLookup, sessionId: registered.sessionId };
  const source = root.sessionBindings.source.computerId === destination.computerId ? destination : root.sessionBindings.source;
  if (options.live && (recovery.stopRequested || canonical(ctx.getPairedNodeSession?.(registered.computerId)) !== canonical(destination)))
    throw AppError.conflict("Recovery validation cannot recreate local authority in another session");
  if (recovery.goalId !== root.goal.id || recovery.planId !== root.plan.id || recovery.actorUserId !== root.h6.actorUserId)
    throw AppError.conflict("Recovery original goal lineage changed");
  return { ...root, sessionBindings: { source, destination }, recovery, checkpoint, checkpointDigest: stored.checkpointDigest, registration: registered };
}
export type ValidationRoot = Awaited<ReturnType<typeof readRecoveryValidationRoot>>;
export function validationTask(root: ValidationRoot, expectedId?: string) {
  const candidates = root.siblings.filter(task => {
    const index = Number(task.sourcePlanSpecRef), spec = root.specs[index];
    return task.sourcePlanSpecRef !== null && String(index) === task.sourcePlanSpecRef && spec?.development_stage === "validation"
      && spec.dependencies.some(edge => edge.ref === root.implementation.sourcePlanSpecRef && edge.type !== "soft_context")
      && spec.dependencies.filter(edge => edge.type !== "soft_context").every(edge => root.siblings.some(prior => prior.sourcePlanSpecRef === edge.ref && prior.status === "done"));
  }).sort((a, b) => Number(a.sourcePlanSpecRef) - Number(b.sourcePlanSpecRef));
  const task = expectedId ? candidates.find(item => item.id === expectedId) : candidates[0], spec = task && root.specs[Number(task.sourcePlanSpecRef)];
  if (!task || !spec || task.projectId !== root.implementation.projectId || task.parentTaskId !== null || task.executionPolicyTaskId !== null
    || task.title !== spec.title || task.description !== spec.description || canonical(task.acceptanceCriteria) !== canonical(spec.acceptance_criteria)
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("H9 requires the exact original validation successor and specification");
  assertSupportedPlanTaskControls(spec, Number(task.sourcePlanSpecRef)); return { task, spec };
}

export async function latestValidation(ctx: ServerContext, tx: DrizzleDb, rootId: string) {
  return (await tx.select().from(goalRecoveryValidations).where(and(eq(goalRecoveryValidations.rootValidationId, rootId), eq(goalRecoveryValidations.organizationId, ctx.organizationId)))
    .orderBy(desc(goalRecoveryValidations.generation)).limit(1))[0];
}
export async function readValidationCompletion(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, input: unknown = row.result) {
  const { request, result, requestDigest, resultDigest, completion, source, sourceDigest } = inspectImportedRecoveryValidationCompletionV1(row.request, input, root.bytes, sha);
  const { task } = validationTask(root, row.taskId);
  if (row.recoveryId !== root.recovery.id || request.recovery_id !== row.recoveryId || canonical(request.checkpoint) !== canonical(root.checkpoint)
    || row.goalId !== root.goal.id || row.planId !== root.plan.id || row.originReviewId !== root.h6.id || row.id !== request.validation_id
    || row.rootValidationId !== request.root_validation_id || row.generation !== request.generation || row.kind !== request.kind
    || row.requestDigest !== requestDigest || canonical(request.origin) !== canonical(root.origin)
    || request.run_start.run_id !== row.runId || request.run_start.context_pack.id !== row.contextPackId || request.run_start.task_id !== row.taskId
    || request.writer.agent_id !== row.writerAgentId || request.writer.instance_id !== row.writerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.attempt_index !== row.attemptIndex
    || request.authorization.goal_id !== row.goalId || row.actorUserId !== root.h6.actorUserId || row.consentId !== root.h6.consentId || row.policyVersion !== root.h6.policyVersion
    || row.computerId !== root.h6.computerId || row.workspaceRoot !== root.h6.workspaceRoot || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || request.run_start.context_pack.payload.goal_context?.plan?.spec_ref !== task.sourcePlanSpecRef)
    throw AppError.conflict("H9 completion request differs from its persisted author and original authorization");
  if (!completion || !source || !sourceDigest) throw AppError.conflict("Validation has no separately proven closed final source");
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.taskId !== row.taskId || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.computerId !== row.computerId || run.agentInstanceId !== row.writerInstanceId || run.runtimeId !== request.run_start.runtime
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification))
    throw AppError.conflict("H9 completion lost its exact actual author/context");
  // The verifier inspector reads the current committed evidence and applies all
  // handoff/input checks. Reuse that same read only within this service call.
  const verification = result.outcome === "finished" && run.status === "completed" ? await inspectRunVerification(ctx, tx, run) : undefined;
  const evidence = result.outcome === "finished" ? verification?.evidence ?? null : await readRunVerificationEvidence(ctx, tx, run.id);
  if (result.outcome === "finished") {
    if (run.status !== "completed" || !verification?.passed || !evidence || canonical(evidence.payload) !== canonical(completion.verification))
      throw AppError.conflict("H9 success requires exact committed passed Node evidence");
  } else if (result.outcome === "failed") {
    const failure = result.closed_failure!;
    if (run.status !== "failed" || run.failureReason === "daemon_disconnect") throw AppError.conflict("H9 failure requires an actual failed author terminal event");
    const terminals = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id), eq(eventLog.type, "run.failed"), eq(eventLog.actorType, "agent"), eq(eventLog.actorId, row.writerInstanceId)));
    if (!terminals.length || (failure.failure_kind === "verification-failed" ? !evidence || canonical(evidence.payload) !== canonical(failure.verification) || evidence.payload.outcome !== "failed" : evidence !== null))
      throw AppError.conflict("H9 repairable failure lacks original failed execution/verification facts");
  }
  // Domain inspected this source in full; the row/root checks above establish
  // the exact same persisted author, request, origin and final measurements.
  return { request, result, completion, run, pack, evidence, source, sourceDigest, resultDigest };
}
export async function requireValidationReceipt(ctx: ServerContext, tx: DrizzleDb, row: Validation) {
  const [receipt] = await tx.select().from(goalRecoveryValidationReceipts).where(and(eq(goalRecoveryValidationReceipts.validationId, row.id), eq(goalRecoveryValidationReceipts.organizationId, ctx.organizationId)));
  if (!receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings)) throw AppError.conflict("H9 source has no exact accepted result receipt");
  return receipt;
}
export async function readValidationSource(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, ownSuccessorId?: string) {
  const latest = await latestValidation(ctx, tx, row.rootValidationId);
  if (!latest || latest.id !== (ownSuccessorId ?? row.id) || row.stopRequested || !row.readyAt || !row.readyEventId) throw AppError.conflict("H9 source is not current or ready");
  const measured = await readValidationCompletion(ctx, tx, row, root), receipt = await requireValidationReceipt(ctx, tx, row);
  const [proof] = await tx.select().from(goalRecoveryValidationCompletions).where(and(eq(goalRecoveryValidationCompletions.validationId, row.id), eq(goalRecoveryValidationCompletions.organizationId, ctx.organizationId)));
  const [ready] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.readyEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = ready?.payload as Record<string, unknown> | undefined;
  if (!proof || proof.runId !== row.runId || proof.contextPackId !== row.contextPackId || proof.evidenceId !== (measured.evidence?.id ?? null)
    || proof.sourceDigest !== measured.sourceDigest || canonical(proof.source) !== canonical(measured.source) || proof.completionDigest !== hash(measured.completion)
    || canonical(proof.completion) !== canonical(measured.completion) || proof.outcome !== measured.source.outcome
    || row.readyKind !== (measured.source.outcome === "verified" ? "review" : "repair")
    || proof.resultDigest !== hash(row.result) || row.resultDigest !== hash(row.result) || proof.deliveryId !== row.resultDeliveryId || proof.sessionId !== row.resultSessionId
    || canonical(row.sessionBindings) !== canonical(root.sessionBindings) || !ready || ready.type !== "goal.recovery-validation.ready" || ready.actorType !== "system" || ready.actorId !== "goal_runner"
    || ready.goalId !== row.goalId || ready.taskId !== row.taskId || ready.runId !== row.runId || payload?.validation_id !== row.id || payload.result_digest !== row.resultDigest
    || payload.source_digest !== proof.sourceDigest || payload.actor_user_id !== row.actorUserId || payload.ready_kind !== row.readyKind)
    throw AppError.conflict("H9 source lacks original completion, receipt and readiness provenance");
  return { ...measured, receipt, proof };
}
export async function readValidationReview(ctx: ServerContext, tx: DrizzleDb, row: ValidationReview, root: ValidationRoot, source: ImportedRecoveryValidationSourceV1) {
  const { request, result, requestDigest, resultDigest, sourceDigest } = inspectImportedRecoveryValidationReviewCompletionV1(row.request, row.result, root.bytes, sha);
  const [receipt] = await tx.select().from(goalRecoveryValidationReviewReceipts).where(and(eq(goalRecoveryValidationReviewReceipts.reviewId, row.id), eq(goalRecoveryValidationReviewReceipts.organizationId, ctx.organizationId)));
  if (row.recoveryId !== root.recovery.id || request.recovery_id !== row.recoveryId || canonical(request.checkpoint) !== canonical(root.checkpoint)
    || !receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings) || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || row.requestDigest !== requestDigest || row.resultDigest !== resultDigest || canonical(request.source) !== canonical(source)
    || row.sourceDigest !== sourceDigest || canonical(request.origin) !== canonical(root.origin)
    || request.review_id !== row.id || request.source.validation_id !== row.validationId
    || request.reviewer.agent_id !== row.reviewerAgentId || request.reviewer.instance_id !== row.reviewerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.goal_id !== row.goalId || request.authorization.attempt_index !== row.attemptIndex
    || row.authorAgentId !== source.author.agent_id || row.authorInstanceId !== source.author.instance_id)
    throw AppError.conflict("H9 review lost its exact original source or receipt");
  return { request, result, receipt };
}

/** Ignore only the exact H9 operation being reauthorized; ordinary and sibling occupancy still counts. */
export async function reserveValidationParticipants(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot,
  options: { validation?: Validation; review?: ValidationReview; reviewerId?: string; source?: ImportedRecoveryValidationSourceV1; settled?: boolean } = {}) {
  const { task, spec } = validationTask(root, options.validation?.taskId ?? options.review?.taskId), writerId = root.team.members.find(item => item.stage === "validation")?.agent_instance_id;
  const authorId = options.source?.author.instance_id ?? options.validation?.writerInstanceId ?? writerId;
  if (!writerId || authorId !== writerId) throw AppError.conflict("H9 author differs from the original validation team");
  const scheduleOptions = { branchBacked: false, projectId: task.projectId, allowedRuntimes: root.budgets.allowed_runtimes,
    ...(options.validation ? { recoveryValidationRunId: options.validation.runId } : {}), ...(options.review ? { recoveryValidationReviewId: options.review.id } : {}) };
  let reviewerId = options.review?.reviewerInstanceId ?? options.reviewerId;
  if (options.source && !reviewerId) {
    const candidates = await scheduleTask(tx, ctx, ["code.read", "code.review"], { ...scheduleOptions, mode: "auto" });
    reviewerId = candidates.candidates.find(item => item.agent_instance_id !== authorId && item.agent_id !== options.source!.author.agent_id
      && item.computer_id === root.h6.computerId && root.team.reviewer_instance_ids.includes(item.agent_instance_id))?.agent_instance_id;
    if (!reviewerId) throw AppError.conflict("H9 requires an independent configured final-product reviewer");
  }
  const participants = new Map<string, typeof agentInstances.$inferSelect>();
  for (const id of [...new Set([authorId, ...(reviewerId ? [reviewerId] : [])])].sort()) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance) throw AppError.conflict("H9 participant is unavailable"); participants.set(id, instance);
  }
  const author = participants.get(authorId)!, reviewer = reviewerId ? participants.get(reviewerId) : undefined;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, root.h6.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online" || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1) !== true
    || (options.source || options.review || reviewerId) && ctx.supportsExecutionFeature?.(computer.id, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1) !== true
    || [...participants.values()].some(item => item.computerId !== computer.id || item.workspaceRoot !== root.h6.workspaceRoot || item.runtime === "mock")
    || reviewer && (reviewer.agentId === author.agentId || reviewer.id === author.id || !root.team.reviewer_instance_ids.includes(reviewer.id))
    || options.validation && (author.agentId !== options.validation.writerAgentId || author.runtime !== ImportedRecoveryValidationRequestV1Schema.parse(options.validation.request).run_start.runtime)) throw AppError.conflict("H9 requires its fixed native Windows author and independent reviewer");
  let selected: Awaited<ReturnType<typeof scheduleTask>>["selected"] | undefined;
  for (const item of participants.values()) {
    const capabilities = item.id === author.id ? [...new Set([...spec.required_capabilities, "code.read", "code.modify"])] as Capability[] : ["code.read", "code.review"] as Capability[];
    const result = await scheduleTask(tx, ctx, capabilities, { ...scheduleOptions, mode: "manual", agentInstanceId: item.id }); if (item.id === author.id) selected = result.selected;
  }
  const ownRun = options.validation?.runId, uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const others = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (others.some(run => run.id !== ownRun && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (participants.has(run.agentInstanceId) || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("H9 workspace has another execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation =>
    !(operation.kind === "recovery_validation" && operation.id === options.validation?.id || operation.kind === "recovery_validation_review" && operation.id === options.review?.id)
    && (operation.participantInstanceIds.some(id => participants.has(id)) || automationWorkspacesOverlap(operation.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("H9 workspace has an unsettled operation");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(row => row.goalId !== root.goal.id && ['planning', 'executing', 'waiting'].includes(row.status) && row.workspaceRoot
    && automationWorkspacesOverlap(row.workspaceRoot, root.h6.workspaceRoot, computer.os))) throw AppError.conflict("H9 workspace belongs to another autonomous goal");
  const count = await unsettledGoalExecutionCount(ctx, tx, root.goal.id), extra = options.validation || options.review || options.settled ? 0 : 1;
  if (root.budgets.max_concurrent_runs !== null && count + extra > root.budgets.max_concurrent_runs) throw AppError.conflict("H9 concurrent execution budget reached");
  return { task, spec, author, reviewer, selected };
}
