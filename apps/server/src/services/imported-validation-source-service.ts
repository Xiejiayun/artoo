import { agentInstances, computers, contextPacks, eventLog, goalAutomations, goals, plans, runs, tasks,
  goalImportedExecutionReviews, goalImportedExecutions, goalImportedDesignContinuations, goalImportedDesignReviews,
  goalImportedProductReviews, goalProductHandoffs, goalImportedValidations, goalImportedValidationCompletions,
  goalImportedValidationReceipts, goalImportedValidationReviews, goalImportedValidationReviewReceipts } from "@artoo/db";
import { AutonomousTeamSchema, ContextPackSchema, TaskSpecSchema, ImportedExecutionReviewRequestV1Schema,
  ImportedExecutionReviewResultV1Schema, ImportedValidationOriginV1Schema, ImportedValidationRequestV1Schema,
  ImportedValidationSourceV1Schema,
  IMPORTED_VALIDATION_FEATURE_V1, inspectImportedExecutionReviewResultV1, inspectImportedValidationCompletionV1,
  inspectImportedValidationReviewCompletionV1, canonicalProductSourceTransferValueV1 as canonical,
  type ImportedValidationOriginV1, type ImportedValidationSourceV1, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { assertImportedImplementationActor as originalActor, assertImportedImplementationCredential as credential,
  readImportedExecutionRootFacts, readImportedImplementationResearch as researchBytes } from "./imported-execution-service.js";
import { readImportedImplementationSource } from "./imported-implementation-source-service.js";
import { requireImportedImplementationReviewReceipt } from "./imported-execution-review-service.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { requireActiveMember } from "./member-status.js";
import { assertMeasurementV2TransferSessions, type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { readRunVerificationEvidence, inspectRunVerification } from "./verification-service.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

export type Validation = typeof goalImportedValidations.$inferSelect;
export type ValidationReview = typeof goalImportedValidationReviews.$inferSelect;
type Sessions = { source: AuthenticatedTransferNode & { sessionId: string }; destination: AuthenticatedTransferNode & { sessionId: string } };

/** Historical ancestry is separate from H6's pre-handoff live product check. */
export async function readImportedValidationOrigin(ctx: ServerContext, tx: DrizzleDb, reviewId: string,
  options: { live?: boolean; initial?: boolean } = {}) {
  const [h6] = await tx.select().from(goalImportedExecutionReviews).where(and(eq(goalImportedExecutionReviews.id, reviewId), eq(goalImportedExecutionReviews.organizationId, ctx.organizationId)));
  if (!h6 || !h6.acceptedAt || !h6.acceptanceEventId || h6.stopRequested) throw AppError.conflict("H7 requires an unstopped independently accepted H6 origin");
  const request = ImportedExecutionReviewRequestV1Schema.parse(h6.request), result = ImportedExecutionReviewResultV1Schema.parse(h6.result);
  const [execution] = await tx.select().from(goalImportedExecutions).where(and(eq(goalImportedExecutions.id, h6.baseExecutionId), eq(goalImportedExecutions.organizationId, ctx.organizationId)));
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, h6.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, h6.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, h6.planId), eq(plans.organizationId, ctx.organizationId)));
  const [implementation] = await tx.select().from(tasks).where(and(eq(tasks.id, h6.taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!execution || !goal || !automation || !plan || plan.status !== "accepted" || plan.goalId !== goal.id || !Array.isArray(plan.taskSpecs) || !implementation
    || execution.taskId !== implementation.id || implementation.status !== "done" || implementation.sourcePlanId !== plan.id
    || execution.goalId !== goal.id || execution.planId !== plan.id || automation.actorUserId !== h6.actorUserId
    || automation.consentId !== h6.consentId || automation.policyVersion !== h6.policyVersion || automation.executionMode !== "agent_team"
    || canonical(execution.request) !== canonical(request.execution_request) || result.outcome !== "reviewed" || result.verdict.outcome !== "accepted"
    || h6.requestDigest !== importedValidationOriginV1RequestHash(request) || h6.resultDigest !== hash(result))
    throw AppError.conflict("H7 origin lost its original implementation, task, plan or authorization history");
  const bytes = await researchBytes(ctx, request.execution_request.review_request), sessionBindings = h6.sessionBindings as Sessions;
  const sourceValue = await readImportedImplementationSource(ctx, tx, { execution, bytes, sessionBindings }, { kind: h6.sourceKind, operationId: h6.sourceOperationId });
  inspectImportedExecutionReviewResultV1(request, result, bytes, sha);
  if (canonical(request.source) !== canonical(sourceValue.source) || h6.sourceDigest !== sourceValue.sourceDigest) throw AppError.conflict("Accepted H6 source was superseded");
  await requireImportedImplementationReviewReceipt(ctx, tx, h6);
  const [accepted] = await tx.select().from(eventLog).where(and(eq(eventLog.id, h6.acceptanceEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = accepted?.payload as Record<string, unknown> | undefined;
  if (!accepted || accepted.type !== "goal.imported-execution-review.accepted" || accepted.actorType !== "system" || accepted.actorId !== "goal_runner"
    || accepted.goalId !== goal.id || accepted.taskId !== implementation.id || accepted.runId !== sourceValue.source.run_start.run_id
    || payload?.review_id !== h6.id || payload.result_digest !== h6.resultDigest || payload.source_digest !== h6.sourceDigest
    || payload.actor_user_id !== h6.actorUserId || payload.verification_evidence_id !== sourceValue.evidence.id || payload.subsequent_stage_authorized !== false)
    throw AppError.conflict("H7 origin has no exact immutable H6 acceptance event");
  const origin = ImportedValidationOriginV1Schema.parse({ version: 1, review_id: h6.id, request_digest: h6.requestDigest,
    result_digest: h6.resultDigest, acceptance_event_id: h6.acceptanceEventId, execution_request: request.execution_request, implementation_source: sourceValue.source });
  const siblings = await tx.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, plan.id)));
  const specs = plan.taskSpecs.map(value => TaskSpecSchema.parse(value));
  const team = AutonomousTeamSchema.parse(automation.team), budgets = supportedGoalPolicy(goal.budgets, goal.stopConditions).budgets;
  if (options.live) {
    originalActor(ctx, h6.actorUserId); await requireActiveMember(ctx, h6.actorUserId, tx);
    await requireAiSharingAuthorization(ctx, tx, { consentId: h6.consentId, policyVersion: h6.policyVersion });
    if (goal.status !== "running" || goal.currentPlanId !== plan.id || automation.planId !== plan.id || !["executing", "waiting"].includes(automation.status)) throw AppError.conflict("H7 goal is paused or its original plan changed");
    if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
      throw AppError.conflict("H7 elapsed goal budget reached");
    if (budgets.max_retries !== null && goal.retryCount > budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
    const transfer = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request, base = transfer.byte_request;
    if (canonical({ source: ctx.getPairedNodeSession?.(base.source.node_id), destination: ctx.getPairedNodeSession?.(base.destination.node_id) }) !== canonical(sessionBindings)) throw AppError.conflict("H7 cannot recover execution authority in a new paired session");
    for (const identity of [sessionBindings.source, sessionBindings.destination].sort((a, b) => a.deviceId.localeCompare(b.deviceId))) await credential(ctx, tx, identity);
    assertMeasurementV2TransferSessions(ctx, transfer);
    const [h4] = await tx.select().from(goalImportedDesignReviews).where(eq(goalImportedDesignReviews.id, execution.reviewId));
    const [h3] = h4 ? await tx.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, h4.continuationId)) : [];
    const [h2] = h3 ? await tx.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, h3.reviewId)) : [];
    const [h1] = h2 ? await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, h2.handoffId)) : [];
    if (!h4 || !h3 || !h2 || !h1 || [h4, h3, h2, h1].some(item => item.stopRequested) || !h1.qualifiedReceipt
      || canonical(h4.request) !== canonical(origin.execution_request.review_request)
      || canonical(h3.request) !== canonical(origin.execution_request.review_request.continuation_request)
      || canonical(h2.request) !== canonical(origin.execution_request.review_request.continuation_request.review_request)
      || !team.reviewer_instance_ids.includes(h6.reviewerInstanceId)) throw AppError.conflict("H7 original transfer, design or team was revoked");
    if (ctx.supportsExecutionFeature?.(h6.computerId, IMPORTED_VALIDATION_FEATURE_V1) !== true) throw AppError.conflict("Destination does not support qualified native H7 execution");
  }
  // Only this first admission reuses the H6/H5 live scheduling gate. Later H7 owners have their own reservation.
  if (options.initial) await readImportedExecutionRootFacts(ctx, tx, execution.id);
  return { h6, execution, goal, automation, plan, implementation, bytes, sessionBindings, origin, sourceValue, siblings, specs, team, budgets };
}
// The H6 origin's digest is the existing exact H6 request digest, not a new H7 claim.
function importedValidationOriginV1RequestHash(request: ReturnType<typeof ImportedExecutionReviewRequestV1Schema.parse>) { return hash(request); }
export type ValidationRoot = Awaited<ReturnType<typeof readImportedValidationOrigin>>;

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
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("H7 requires the exact original validation successor and specification");
  assertSupportedPlanTaskControls(spec, Number(task.sourcePlanSpecRef)); return { task, spec };
}

export async function latestValidation(ctx: ServerContext, tx: DrizzleDb, rootId: string) {
  return (await tx.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.rootValidationId, rootId), eq(goalImportedValidations.organizationId, ctx.organizationId)))
    .orderBy(desc(goalImportedValidations.generation)).limit(1))[0];
}
export async function readValidationCompletion(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, input: unknown = row.result) {
  const { request, result, requestDigest, resultDigest, completion, source, sourceDigest } = inspectImportedValidationCompletionV1(row.request, input, root.bytes, sha);
  const { task } = validationTask(root, row.taskId);
  if (row.goalId !== root.goal.id || row.planId !== root.plan.id || row.originReviewId !== root.h6.id || row.id !== request.validation_id
    || row.rootValidationId !== request.root_validation_id || row.generation !== request.generation || row.kind !== request.kind
    || row.requestDigest !== requestDigest || canonical(request.origin) !== canonical(root.origin)
    || request.run_start.run_id !== row.runId || request.run_start.context_pack.id !== row.contextPackId || request.run_start.task_id !== row.taskId
    || request.writer.agent_id !== row.writerAgentId || request.writer.instance_id !== row.writerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.attempt_index !== row.attemptIndex
    || request.authorization.goal_id !== row.goalId || row.actorUserId !== root.h6.actorUserId || row.consentId !== root.h6.consentId || row.policyVersion !== root.h6.policyVersion
    || row.computerId !== root.h6.computerId || row.workspaceRoot !== root.h6.workspaceRoot || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || request.run_start.context_pack.payload.goal_context?.plan?.spec_ref !== task.sourcePlanSpecRef)
    throw AppError.conflict("H7 completion request differs from its persisted author and original authorization");
  if (!completion || !source || !sourceDigest) throw AppError.conflict("Validation has no separately proven closed final source");
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || run.taskId !== row.taskId || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.computerId !== row.computerId || run.agentInstanceId !== row.writerInstanceId || run.runtimeId !== request.run_start.runtime
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload) || canonical(run.verificationRequirement) !== canonical(request.run_start.verification))
    throw AppError.conflict("H7 completion lost its exact actual author/context");
  // The verifier inspector reads the current committed evidence and applies all
  // handoff/input checks. Reuse that same read only within this service call.
  const verification = result.outcome === "finished" && run.status === "completed" ? await inspectRunVerification(ctx, tx, run) : undefined;
  const evidence = result.outcome === "finished" ? verification?.evidence ?? null : await readRunVerificationEvidence(ctx, tx, run.id);
  if (result.outcome === "finished") {
    if (run.status !== "completed" || !verification?.passed || !evidence || canonical(evidence.payload) !== canonical(completion.verification))
      throw AppError.conflict("H7 success requires exact committed passed Node evidence");
  } else if (result.outcome === "failed") {
    const failure = result.closed_failure!;
    if (run.status !== "failed" || run.failureReason === "daemon_disconnect") throw AppError.conflict("H7 failure requires an actual failed author terminal event");
    const terminals = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, run.id), eq(eventLog.type, "run.failed"), eq(eventLog.actorType, "agent"), eq(eventLog.actorId, row.writerInstanceId)));
    if (!terminals.length || (failure.failure_kind === "verification-failed" ? !evidence || canonical(evidence.payload) !== canonical(failure.verification) || evidence.payload.outcome !== "failed" : evidence !== null))
      throw AppError.conflict("H7 repairable failure lacks original failed execution/verification facts");
  }
  // Domain inspected this source in full; the row/root checks above establish
  // the exact same persisted author, request, origin and final measurements.
  return { request, result, completion, run, pack, evidence, source, sourceDigest, resultDigest };
}
export async function requireValidationReceipt(ctx: ServerContext, tx: DrizzleDb, row: Validation) {
  const [receipt] = await tx.select().from(goalImportedValidationReceipts).where(and(eq(goalImportedValidationReceipts.validationId, row.id), eq(goalImportedValidationReceipts.organizationId, ctx.organizationId)));
  if (!receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings)) throw AppError.conflict("H7 source has no exact accepted result receipt");
  return receipt;
}
export async function readValidationSource(ctx: ServerContext, tx: DrizzleDb, row: Validation, root: ValidationRoot, ownSuccessorId?: string) {
  const latest = await latestValidation(ctx, tx, row.rootValidationId);
  if (!latest || latest.id !== (ownSuccessorId ?? row.id) || row.stopRequested || !row.readyAt || !row.readyEventId) throw AppError.conflict("H7 source is not current or ready");
  const measured = await readValidationCompletion(ctx, tx, row, root), receipt = await requireValidationReceipt(ctx, tx, row);
  const [proof] = await tx.select().from(goalImportedValidationCompletions).where(and(eq(goalImportedValidationCompletions.validationId, row.id), eq(goalImportedValidationCompletions.organizationId, ctx.organizationId)));
  const [ready] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.readyEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = ready?.payload as Record<string, unknown> | undefined;
  if (!proof || proof.runId !== row.runId || proof.contextPackId !== row.contextPackId || proof.evidenceId !== (measured.evidence?.id ?? null)
    || proof.sourceDigest !== measured.sourceDigest || canonical(proof.source) !== canonical(measured.source) || proof.completionDigest !== hash(measured.completion)
    || canonical(proof.completion) !== canonical(measured.completion) || proof.outcome !== measured.source.outcome
    || row.readyKind !== (measured.source.outcome === "verified" ? "review" : "repair")
    || proof.resultDigest !== hash(row.result) || row.resultDigest !== hash(row.result) || proof.deliveryId !== row.resultDeliveryId || proof.sessionId !== row.resultSessionId
    || canonical(row.sessionBindings) !== canonical(root.sessionBindings) || !ready || ready.type !== "goal.imported-validation.ready" || ready.actorType !== "system" || ready.actorId !== "goal_runner"
    || ready.goalId !== row.goalId || ready.taskId !== row.taskId || ready.runId !== row.runId || payload?.validation_id !== row.id || payload.result_digest !== row.resultDigest
    || payload.source_digest !== proof.sourceDigest || payload.actor_user_id !== row.actorUserId || payload.ready_kind !== row.readyKind)
    throw AppError.conflict("H7 source lacks original completion, receipt and readiness provenance");
  return { ...measured, receipt, proof };
}
export async function readValidationReview(ctx: ServerContext, tx: DrizzleDb, row: ValidationReview, root: ValidationRoot, source: ImportedValidationSourceV1) {
  const { request, result, requestDigest, resultDigest, sourceDigest } = inspectImportedValidationReviewCompletionV1(row.request, row.result, root.bytes, sha);
  const [receipt] = await tx.select().from(goalImportedValidationReviewReceipts).where(and(eq(goalImportedValidationReviewReceipts.reviewId, row.id), eq(goalImportedValidationReviewReceipts.organizationId, ctx.organizationId)));
  if (!receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest || receipt.resultDigest !== row.resultDigest
    || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings) || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || row.requestDigest !== requestDigest || row.resultDigest !== resultDigest || canonical(request.source) !== canonical(source)
    || row.sourceDigest !== sourceDigest || canonical(request.origin) !== canonical(root.origin)
    || request.review_id !== row.id || request.source.validation_id !== row.validationId
    || request.reviewer.agent_id !== row.reviewerAgentId || request.reviewer.instance_id !== row.reviewerInstanceId
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.goal_id !== row.goalId || request.authorization.attempt_index !== row.attemptIndex
    || row.authorAgentId !== source.author.agent_id || row.authorInstanceId !== source.author.instance_id)
    throw AppError.conflict("H7 review lost its exact original source or receipt");
  return { request, result, receipt };
}

/** Ignore only the exact H7 operation being reauthorized; ordinary and sibling occupancy still counts. */
export async function reserveValidationParticipants(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot,
  options: { validation?: Validation; review?: ValidationReview; reviewerId?: string; source?: ImportedValidationSourceV1; settled?: boolean } = {}) {
  const { task, spec } = validationTask(root, options.validation?.taskId ?? options.review?.taskId), writerId = root.team.members.find(item => item.stage === "validation")?.agent_instance_id;
  const authorId = options.source?.author.instance_id ?? options.validation?.writerInstanceId ?? writerId;
  if (!writerId || authorId !== writerId) throw AppError.conflict("H7 author differs from the original validation team");
  const scheduleOptions = { branchBacked: false, projectId: task.projectId, allowedRuntimes: root.budgets.allowed_runtimes,
    ...(options.validation ? { importedValidationRunId: options.validation.runId } : {}), ...(options.review ? { importedValidationReviewId: options.review.id } : {}) };
  let reviewerId = options.review?.reviewerInstanceId ?? options.reviewerId;
  if (options.source && !reviewerId) {
    const candidates = await scheduleTask(tx, ctx, ["code.read", "code.review"], { ...scheduleOptions, mode: "auto" });
    reviewerId = candidates.candidates.find(item => item.agent_instance_id !== authorId && item.agent_id !== options.source!.author.agent_id
      && item.computer_id === root.h6.computerId && root.team.reviewer_instance_ids.includes(item.agent_instance_id))?.agent_instance_id;
    if (!reviewerId) throw AppError.conflict("H7 requires an independent configured final-product reviewer");
  }
  const participants = new Map<string, typeof agentInstances.$inferSelect>();
  for (const id of [...new Set([authorId, ...(reviewerId ? [reviewerId] : [])])].sort()) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance) throw AppError.conflict("H7 participant is unavailable"); participants.set(id, instance);
  }
  const author = participants.get(authorId)!, reviewer = reviewerId ? participants.get(reviewerId) : undefined;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, root.h6.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online" || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_VALIDATION_FEATURE_V1) !== true
    || [...participants.values()].some(item => item.computerId !== computer.id || item.workspaceRoot !== root.h6.workspaceRoot || item.runtime === "mock")
    || reviewer && (reviewer.agentId === author.agentId || reviewer.id === author.id || !root.team.reviewer_instance_ids.includes(reviewer.id))
    || options.validation && (author.agentId !== options.validation.writerAgentId || author.runtime !== ImportedValidationRequestV1Schema.parse(options.validation.request).run_start.runtime)) throw AppError.conflict("H7 requires its fixed native Windows author and independent reviewer");
  let selected: Awaited<ReturnType<typeof scheduleTask>>["selected"] | undefined;
  for (const item of participants.values()) {
    const capabilities = item.id === author.id ? [...new Set([...spec.required_capabilities, "code.read", "code.modify"])] as Capability[] : ["code.read", "code.review"] as Capability[];
    const result = await scheduleTask(tx, ctx, capabilities, { ...scheduleOptions, mode: "manual", agentInstanceId: item.id }); if (item.id === author.id) selected = result.selected;
  }
  const ownRun = options.validation?.runId, uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const others = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (others.some(run => run.id !== ownRun && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (participants.has(run.agentInstanceId) || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("H7 workspace has another execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation =>
    !(operation.kind === "validation" && operation.id === options.validation?.id || operation.kind === "validation_review" && operation.id === options.review?.id)
    && (operation.participantInstanceIds.some(id => participants.has(id)) || automationWorkspacesOverlap(operation.workspaceRoot, root.h6.workspaceRoot, computer.os)))) throw AppError.conflict("H7 workspace has an unsettled operation");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(row => row.goalId !== root.goal.id && ['planning', 'executing', 'waiting'].includes(row.status) && row.workspaceRoot
    && automationWorkspacesOverlap(row.workspaceRoot, root.h6.workspaceRoot, computer.os))) throw AppError.conflict("H7 workspace belongs to another autonomous goal");
  const count = await unsettledGoalExecutionCount(ctx, tx, root.goal.id), extra = options.validation || options.review || options.settled ? 0 : 1;
  if (root.budgets.max_concurrent_runs !== null && count + extra > root.budgets.max_concurrent_runs) throw AppError.conflict("H7 concurrent execution budget reached");
  return { task, spec, author, reviewer, selected };
}
