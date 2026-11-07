import { agentInstances, computers, contextPacks, eventLog, goalAutomations, runs, tasks,
  goalCleanValidations, goalCleanValidationCompletions, goalCleanValidationReceipts,
  goalCleanValidationReviews, goalCleanValidationReviewReceipts } from "@artoo/db";
import { ImportedCleanValidationRequestV1Schema, ImportedCleanValidationReviewRequestV1Schema,
  IMPORTED_CLEAN_VALIDATION_FEATURE_V1, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1, inspectImportedCleanValidationCompletionV1,
  inspectImportedCleanValidationReviewCompletionV1, importedCleanValidationSourceDigestV1,
  importedCleanValidationReviewRequestDigestV1, canonicalProductSourceTransferValueV1 as canonical,
  type ImportedCleanValidationSourceV1, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { readRunVerificationEvidence, inspectRunVerification } from "./verification-service.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { readCleanValidationRoot, assertCleanValidationDispatch } from "./clean-validation-origin-service.js";
export { readCleanValidationRoot } from "./clean-validation-origin-service.js";
export type Validation = typeof goalCleanValidations.$inferSelect;
export type ValidationReview = typeof goalCleanValidationReviews.$inferSelect;
export type ValidationRoot = Awaited<ReturnType<typeof readCleanValidationRoot>>;
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
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("clean-restart requires the exact original validation successor and specification");
  assertSupportedPlanTaskControls(spec, Number(task.sourcePlanSpecRef)); return { task, spec };
}

export async function latestValidation(ctx: ServerContext, tx: DrizzleDb, rootId: string) {
  return (await tx.select().from(goalCleanValidations).where(and(eq(goalCleanValidations.rootValidationId, rootId), eq(goalCleanValidations.organizationId, ctx.organizationId)))
    .orderBy(desc(goalCleanValidations.generation)).limit(1))[0];
}
export async function readValidationCompletion(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, input: unknown = row.result) {
  const { request, result, requestDigest, resultDigest, completion, source, sourceDigest } = inspectImportedCleanValidationCompletionV1(row.request, input, root.bytes, sha);
  const { task } = validationTask(root, row.taskId);
  if (row.cleanGenerationId !== root.cleanGeneration.id || request.clean_generation_id !== row.cleanGenerationId || canonical(request.restart) !== canonical(root.restart)
    || row.goalId !== root.goal.id || row.planId !== root.plan.id || row.originReviewId !== root.h6.id || row.id !== request.validation_id
    || row.rootValidationId !== request.root_validation_id || row.generation !== request.generation || row.kind !== request.kind
    || row.requestDigest !== requestDigest || canonical(request.origin) !== canonical(root.origin)
    || request.run_start.run_id !== row.runId || request.run_start.context_pack.id !== row.contextPackId || request.run_start.task_id !== row.taskId
    || request.writer.agent_id !== row.writerAgentId || request.writer.instance_id !== row.writerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.attempt_index !== row.attemptIndex
    || request.authorization.goal_id !== row.goalId || row.actorUserId !== root.h6.actorUserId || row.consentId !== root.h6.consentId || row.policyVersion !== root.h6.policyVersion
    || row.computerId !== root.h6.computerId || row.workspaceRoot !== root.h6.workspaceRoot || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || request.run_start.context_pack.payload.goal_context?.plan?.spec_ref !== task.sourcePlanSpecRef)
    throw AppError.conflict("clean-restart completion request differs from its persisted author and original authorization");
  if (!completion || !source || !sourceDigest) throw AppError.conflict("Validation has no separately proven closed final source");
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.taskId !== row.taskId || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.computerId !== row.computerId || run.agentInstanceId !== row.writerInstanceId || run.runtimeId !== request.run_start.runtime
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification))
    throw AppError.conflict("clean-restart completion lost its exact actual author/context");
  // The verifier inspector reads the current committed evidence and applies all
  // handoff/input checks. Reuse that same read only within this service call.
  const verification = result.outcome === "finished" && run.status === "completed" ? await inspectRunVerification(ctx, tx, run) : undefined;
  const evidence = result.outcome === "finished" ? verification?.evidence ?? null : await readRunVerificationEvidence(ctx, tx, run.id);
  if (result.outcome === "finished") {
    if (run.status !== "completed" || !verification?.passed || !evidence || canonical(evidence.payload) !== canonical(completion.verification))
      throw AppError.conflict("clean-restart success requires exact committed passed Node evidence");
  } else if (result.outcome === "failed") {
    const failure = result.closed_failure!;
    if (run.status !== "failed" || run.failureReason === "daemon_disconnect") throw AppError.conflict("clean-restart failure requires an actual failed author terminal event");
    const terminals = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id), eq(eventLog.type, "run.failed"), eq(eventLog.actorType, "agent"), eq(eventLog.actorId, row.writerInstanceId)));
    if (!terminals.length || (failure.failure_kind === "verification-failed" ? !evidence || canonical(evidence.payload) !== canonical(failure.verification) || evidence.payload.outcome !== "failed" : evidence !== null))
      throw AppError.conflict("clean-restart repairable failure lacks original failed execution/verification facts");
  }
  // Domain inspected this source in full; the row/root checks above establish
  // the exact same persisted author, request, origin and final measurements.
  return { request, result, completion, run, pack, evidence, source, sourceDigest, resultDigest };
}
export async function requireValidationReceipt(ctx: ServerContext, tx: DrizzleDb, row: Validation) {
  const [receipt] = await tx.select().from(goalCleanValidationReceipts).where(and(eq(goalCleanValidationReceipts.validationId, row.id), eq(goalCleanValidationReceipts.organizationId, ctx.organizationId)));
  if (!receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings)) throw AppError.conflict("clean-restart source has no exact accepted result receipt");
  return receipt;
}
export async function readValidationSource(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, ownSuccessorId?: string) {
  const latest = await latestValidation(ctx, tx, row.rootValidationId);
  if (!latest || latest.id !== (ownSuccessorId ?? row.id) || row.stopRequested || !row.readyAt || !row.readyEventId) throw AppError.conflict("clean-restart source is not current or ready");
  const measured = await readValidationCompletion(ctx, tx, row, root), receipt = await requireValidationReceipt(ctx, tx, row);
  const [proof] = await tx.select().from(goalCleanValidationCompletions).where(and(eq(goalCleanValidationCompletions.validationId, row.id), eq(goalCleanValidationCompletions.organizationId, ctx.organizationId)));
  const [ready] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.readyEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = ready?.payload as Record<string, unknown> | undefined;
  if (!proof || proof.runId !== row.runId || proof.contextPackId !== row.contextPackId || proof.evidenceId !== (measured.evidence?.id ?? null)
    || proof.sourceDigest !== measured.sourceDigest || canonical(proof.source) !== canonical(measured.source) || proof.completionDigest !== hash(measured.completion)
    || canonical(proof.completion) !== canonical(measured.completion) || proof.outcome !== measured.source.outcome
    || row.readyKind !== (measured.source.outcome === "verified" ? "review" : "repair")
    || proof.resultDigest !== hash(row.result) || row.resultDigest !== hash(row.result) || proof.deliveryId !== row.resultDeliveryId || proof.sessionId !== row.resultSessionId
    || canonical(row.sessionBindings) !== canonical(root.sessionBindings) || !ready || ready.type !== "goal.clean-validation.ready" || ready.actorType !== "system" || ready.actorId !== "goal_runner"
    || ready.goalId !== row.goalId || ready.taskId !== row.taskId || ready.runId !== row.runId || payload?.validation_id !== row.id || payload.result_digest !== row.resultDigest
    || payload.source_digest !== proof.sourceDigest || payload.actor_user_id !== row.actorUserId || payload.ready_kind !== row.readyKind)
    throw AppError.conflict("clean-restart source lacks original completion, receipt and readiness provenance");
  return { ...measured, receipt, proof };
}
export async function readValidationReview(ctx: ServerContext, tx: DrizzleDb, row: ValidationReview, root: ValidationRoot, source: ImportedCleanValidationSourceV1) {
  const { request, result, requestDigest, resultDigest, sourceDigest } = inspectImportedCleanValidationReviewCompletionV1(row.request, row.result, root.bytes, sha);
  const [receipt] = await tx.select().from(goalCleanValidationReviewReceipts).where(and(eq(goalCleanValidationReviewReceipts.reviewId, row.id), eq(goalCleanValidationReviewReceipts.organizationId, ctx.organizationId)));
  if (row.cleanGenerationId !== root.cleanGeneration.id || request.clean_generation_id !== row.cleanGenerationId || canonical(request.restart) !== canonical(root.restart)
    || !receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings) || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || row.requestDigest !== requestDigest || row.resultDigest !== resultDigest || canonical(request.source) !== canonical(source)
    || row.sourceDigest !== sourceDigest || canonical(request.origin) !== canonical(root.origin)
    || request.review_id !== row.id || request.source.validation_id !== row.validationId
    || request.reviewer.agent_id !== row.reviewerAgentId || request.reviewer.instance_id !== row.reviewerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.goal_id !== row.goalId || request.authorization.attempt_index !== row.attemptIndex
    || row.authorAgentId !== source.author.agent_id || row.authorInstanceId !== source.author.instance_id)
    throw AppError.conflict("clean-restart review lost its exact original source or receipt");
  return { request, result, receipt };
}

/** Ignore only the exact clean-restart operation being reauthorized; ordinary and sibling occupancy still counts. */
export async function reserveValidationParticipants(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot,
  options: { validation?: Validation; review?: ValidationReview; reviewerId?: string; source?: ImportedCleanValidationSourceV1; settled?: boolean } = {}) {
  const { task, spec } = validationTask(root, options.validation?.taskId ?? options.review?.taskId), writerId = root.team.members.find(item => item.stage === "validation")?.agent_instance_id;
  const authorId = options.source?.author.instance_id ?? options.validation?.writerInstanceId ?? writerId;
  if (!writerId || authorId !== writerId) throw AppError.conflict("clean-restart author differs from the original validation team");
  const scheduleOptions = { branchBacked: false, projectId: task.projectId, allowedRuntimes: root.budgets.allowed_runtimes,
    ...(options.validation ? { cleanValidationRunId: options.validation.runId } : {}), ...(options.review ? { cleanValidationReviewId: options.review.id } : {}) };
  let reviewerId = options.review?.reviewerInstanceId ?? options.reviewerId;
  if (options.source && !reviewerId) {
    const candidates = await scheduleTask(tx, ctx, ["code.read", "code.review"], { ...scheduleOptions, mode: "auto" });
    reviewerId = candidates.candidates.find(item => item.agent_instance_id !== authorId && item.agent_id !== options.source!.author.agent_id
      && item.computer_id === root.h6.computerId && root.team.reviewer_instance_ids.includes(item.agent_instance_id))?.agent_instance_id;
    if (!reviewerId) throw AppError.conflict("clean-restart requires an independent configured final-product reviewer");
  }
  const participants = new Map<string, typeof agentInstances.$inferSelect>();
  for (const id of [...new Set([authorId, ...(reviewerId ? [reviewerId] : [])])].sort()) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance) throw AppError.conflict("clean-restart participant is unavailable"); participants.set(id, instance);
  }
  const author = participants.get(authorId)!, reviewer = reviewerId ? participants.get(reviewerId) : undefined;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, root.h6.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  await assertCleanValidationDispatch(ctx, tx, root);
  if (!computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online" || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_CLEAN_VALIDATION_FEATURE_V1) !== true
    || (options.source || options.review || reviewerId) && ctx.supportsExecutionFeature?.(computer.id, IMPORTED_CLEAN_VALIDATION_REVIEW_FEATURE_V1) !== true
    || [...participants.values()].some(item => item.computerId !== computer.id || item.workspaceRoot !== root.h6.workspaceRoot || item.runtime === "mock")
    || reviewer && (reviewer.agentId === author.agentId || reviewer.id === author.id || !root.team.reviewer_instance_ids.includes(reviewer.id))
    || options.validation && (author.agentId !== options.validation.writerAgentId || author.runtime !== ImportedCleanValidationRequestV1Schema.parse(options.validation.request).run_start.runtime)) throw AppError.conflict("clean-restart requires its fixed native Windows author and independent reviewer");
  let selected: Awaited<ReturnType<typeof scheduleTask>>["selected"] | undefined;
  for (const item of participants.values()) {
    const capabilities = item.id === author.id ? [...new Set([...spec.required_capabilities, "code.read", "code.modify"])] as Capability[] : ["code.read", "code.review"] as Capability[];
    const result = await scheduleTask(tx, ctx, capabilities, { ...scheduleOptions, mode: "manual", agentInstanceId: item.id }); if (item.id === author.id) selected = result.selected;
  }
  const ownRun = options.validation?.runId, uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const others = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (others.some(run => run.id !== ownRun && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (participants.has(run.agentInstanceId) || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("clean-restart workspace has another execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation =>
    !(operation.kind === "clean_validation" && operation.id === options.validation?.id || operation.kind === "clean_validation_review" && operation.id === options.review?.id)
    && (operation.participantInstanceIds.some(id => participants.has(id)) || automationWorkspacesOverlap(operation.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("clean-restart workspace has an unsettled operation");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(row => row.goalId !== root.goal.id && ['planning', 'executing', 'waiting'].includes(row.status) && row.workspaceRoot
    && automationWorkspacesOverlap(row.workspaceRoot, root.h6.workspaceRoot, computer.os))) throw AppError.conflict("clean-restart workspace belongs to another autonomous goal");
  const count = await unsettledGoalExecutionCount(ctx, tx, root.goal.id), extra = options.validation || options.review || options.settled ? 0 : 1;
  if (root.budgets.max_concurrent_runs !== null && count + extra > root.budgets.max_concurrent_runs) throw AppError.conflict("clean-restart concurrent execution budget reached");
  return { task, spec, author, reviewer, selected };
}
