import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { agentInstances, appendEvent, computers, devices, deviceTokens, goalAutomations, goals, plans, runs, tasks,
  goalImportedDesignContinuations as continuations, goalImportedDesignReviews as reviews, goalImportedDesignReviewDeliveries as deliveries,
  goalImportedProductReviews, goalProductHandoffs } from "@artoo/db";
import { AutonomousTeamSchema, ContextPackSchema, RunStartPayloadSchema, TaskSpecSchema, ImportedDesignContinuationRequestV1Schema, ImportedDesignReviewRequestV1Schema,
  ImportedDesignReviewResultV1Schema, IMPORTED_DESIGN_REVIEW_FEATURE_V1, importedDesignReviewSubjectV1,
  importedDesignReviewRequestDigestV1, inspectImportedDesignReviewRequestV1, inspectImportedDesignReviewResultV1,
  canonicalProductSourceTransferValueV1 as canonical, type ImportedDesignReviewRequestV1 } from "@artoo/domain";
import { importedDesignReviewAckSchema, importedDesignReviewResultSchema, type ImportedDesignReviewAck, type ImportedDesignReviewResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { readContentAddressedBlob } from "../content-addressed-blob.js";
import { assertSemanticCapsuleResearch } from "../product-source-semantic-transfer-routes.js";
import { admitProductSourceSemanticTransferInTransaction, assertMeasurementV2TransferSessions, type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { requireActiveMember } from "./member-status.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { transitionTask } from "./transition-service.js";
import { readCompletedImportedDesign, importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { goalImportedDesignReviewReceipts } from "@artoo/db";

type Review = typeof reviews.$inferSelect;
type Automation = typeof goalAutomations.$inferSelect;
type Session = NonNullable<ReturnType<NonNullable<ServerContext["getPairedNodeSession"]>>>;
type Control = "start" | "stop" | "status";
const actorContext = (ctx: ServerContext, actorUserId: string): ServerContext => ({ ...ctx, actorUserId, automationActor: { type: "system", id: "goal_runner" } });
function originalActor(ctx: ServerContext, actor: string) {
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== actor) throw AppError.permissionDenied("Only the original user's GoalRunner owns H4 design acceptance");
}
async function researchBytes(ctx: ServerContext, request: ImportedDesignReviewRequestV1["continuation_request"]) {
  if (!ctx.productSourceArtifactDir) throw AppError.conflict("H4 requires the configured source artifact store");
  const transfer = request.review_request.operation.intent.request, source = transfer.byte_request.source;
  const bytes = await readContentAddressedBlob(ctx.productSourceArtifactDir, source.capsule_digest, source.capsule_bytes);
  assertSemanticCapsuleResearch(bytes, transfer);
  const capsule = JSON.parse(bytes.toString("utf8")) as { files: { path: string; base64: string }[] };
  return Buffer.from(capsule.files.find(file => file.path === ".artoo/product/research.json")!.base64, "base64");
}
async function credential(ctx: ServerContext, tx: DrizzleDb, identity: AuthenticatedTransferNode) {
  const [observed] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId)));
  if (!observed) throw AppError.permissionDenied("H4 requires a paired device");
  await requireActiveMember(ctx, observed.enrolledByUserId, tx);
  const [device] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
  const [token] = await tx.select().from(deviceTokens).where(and(eq(deviceTokens.deviceId, identity.deviceId), eq(deviceTokens.organizationId, ctx.organizationId),
    eq(deviceTokens.tokenLookup, identity.tokenLookup), eq(deviceTokens.kind, "node"), eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
  if (!device || device.trust !== "active" || device.revokedAt !== null || device.computerId !== identity.computerId || device.enrolledByUserId !== observed.enrolledByUserId
    || !token || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso())) throw AppError.permissionDenied("H4 paired credential is no longer current");
}
function sessions(ctx: ServerContext, request: ImportedDesignReviewRequestV1["continuation_request"]) {
  const base = request.review_request.operation.intent.request.byte_request;
  const source = ctx.getPairedNodeSession?.(base.source.node_id), destination = ctx.getPairedNodeSession?.(base.destination.node_id);
  if (!source || !destination || source.computerId !== base.source.node_id || destination.computerId !== base.destination.node_id)
    throw AppError.conflict("H4 requires current qualified paired source and destination sessions");
  return { source, destination };
}

/** Reuses source authorization, then locks the completed design and both participant reservations. */
async function facts(ctx: ServerContext, tx: DrizzleDb, continuationId: string, own?: Review) {
  const [continuation] = await tx.select().from(continuations).where(and(eq(continuations.id, continuationId), eq(continuations.organizationId, ctx.organizationId)));
  if (!continuation) throw AppError.notFound("Imported design continuation not found");
  originalActor(ctx, continuation.actorUserId);
  const original = ImportedDesignContinuationRequestV1Schema.parse(continuation.request), transfer = original.review_request.operation.intent.request, base = transfer.byte_request;
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, transfer);
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, continuation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, continuation.taskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
  // The initial observation may precede a competing stop's goal lock. Re-read after
  // acquiring that fence; never let an old completed snapshot bypass a stop.
  const [currentContinuation] = await tx.select().from(continuations).where(and(eq(continuations.id, continuation.id), eq(continuations.organizationId, ctx.organizationId))).for("update");
  if (!currentContinuation || currentContinuation.stopRequested || canonical(currentContinuation) !== canonical(continuation))
    throw AppError.conflict("H4 original continuation changed or stopped during admission");
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, continuation.planId), eq(plans.organizationId, ctx.organizationId)));
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, continuation.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const index = Number(task?.sourcePlanSpecRef), parsed = Array.isArray(plan?.taskSpecs) && Number.isSafeInteger(index) ? TaskSpecSchema.safeParse(plan.taskSpecs[index]) : undefined;
  if (!goal || goal.status !== "running" || goal.currentPlanId !== continuation.planId || !task || !plan || plan.status !== "accepted"
    || task.goalId !== goal.id || task.projectId !== base.project_id || task.sourcePlanId !== plan.id || task.sourcePlanSpecRef === null || String(index) !== task.sourcePlanSpecRef
    || task.executionPolicyTaskId !== null || task.parentTaskId !== null || task.status !== (own?.acceptedAt ? "done" : "review")
    || !automation || automation.actorUserId !== continuation.actorUserId || automation.consentId !== continuation.consentId || automation.policyVersion !== continuation.policyVersion
    || automation.planId !== plan.id || automation.executionMode !== "agent_team" || !["executing", "waiting"].includes(automation.status)
    || !parsed?.success || parsed.data.development_stage !== "design") throw AppError.conflict("H4 requires the current exact completed design task and accepted plan");
  const spec = parsed.data; assertSupportedPlanTaskControls(spec, index);
  const [sourceTask] = await tx.select().from(tasks).where(and(eq(tasks.id, base.source.task_id), eq(tasks.organizationId, ctx.organizationId)));
  const hard = spec.dependencies.filter(edge => edge.type !== "soft_context");
  if (!sourceTask || sourceTask.status !== "done" || hard.length !== 1 || hard[0]!.ref !== sourceTask.sourcePlanSpecRef || !["blocks", "artifact_required"].includes(hard[0]!.type)
    || task.title !== spec.title || task.description !== spec.description || canonical(task.acceptanceCriteria) !== canonical(spec.acceptance_criteria)
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("H4 design differs from its accepted specification or research dependency");
  const expectedGoal = { version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria,
    plan: { id: plan.id, version: plan.version, rationale: plan.rationale ?? "", spec_ref: task.sourcePlanSpecRef } };
  if (canonical(original.run_start.context_pack.payload.goal_context) !== canonical(expectedGoal)) throw AppError.conflict("H4 original goal or plan context changed");
  const completed = await readCompletedImportedDesign(ctx, tx, continuation);
  if (continuation.stopRequested || completed.completed.scope !== "all-declared-workspace-design-cases") throw AppError.conflict("H4 requires unstopped all-case verified design");
  const relatedRuns = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, task.id), eq(runs.organizationId, ctx.organizationId)));
  if (relatedRuns.length !== 1 || relatedRuns[0]!.id !== continuation.runId) throw AppError.conflict("H4 author execution has been superseded");
  const currentSessions = sessions(ctx, original);
  if (currentSessions.destination.sessionId !== completed.provenance.sessionId || own && canonical(own.sessionBindings) !== canonical(currentSessions))
    throw AppError.conflict("A new session cannot reuse an earlier H4 admission or H3 completion authority");
  // Transfer admission already locks all participating members before their devices.
  for (const identity of [currentSessions.source, currentSessions.destination].sort((a, b) => a.deviceId.localeCompare(b.deviceId))) await credential(ctx, tx, identity);
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms
    || budgets.max_retries !== null && goal.retryCount > budgets.max_retries) throw AppError.conflict("H4 goal budget has been reached");
  const count = await unsettledGoalExecutionCount(ctx, tx, goal.id);
  const ownUnsettled = own && ImportedDesignReviewResultV1Schema.safeParse(own.result).data?.closed !== true;
  if (budgets.max_concurrent_runs !== null && count + (ownUnsettled || own?.result ? 0 : 1) > budgets.max_concurrent_runs) throw AppError.conflict("H4 concurrent execution budget has been reached");
  const team = AutonomousTeamSchema.parse(automation.team);
  if (team.members.find(member => member.stage === "design")?.agent_instance_id !== continuation.writerInstanceId) throw AppError.conflict("H4 author is no longer the configured design participant");
  const options = { branchBacked: false, projectId: task.projectId, allowedRuntimes: budgets.allowed_runtimes };
  let reviewerId = own?.reviewerInstanceId;
  if (!reviewerId) {
    const choices = await scheduleTask(tx, ctx, ["code.read", "code.review"], { ...options, mode: "auto" });
    reviewerId = choices.candidates.find(choice => choice.agent_id !== continuation.writerAgentId && choice.agent_instance_id !== continuation.writerInstanceId
      && choice.computer_id === continuation.computerId && choice.runtime !== "mock" && team.reviewer_instance_ids.includes(choice.agent_instance_id))?.agent_instance_id;
  }
  if (!reviewerId || !team.reviewer_instance_ids.includes(reviewerId)) throw AppError.conflict("H4 needs an independent team reviewer on the destination computer");
  const participants = new Map<string, typeof agentInstances.$inferSelect>();
  for (const id of [continuation.writerInstanceId, reviewerId].sort()) {
    const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
    if (!instance) throw AppError.conflict("H4 participant is unavailable"); participants.set(id, instance);
  }
  const author = participants.get(continuation.writerInstanceId)!, reviewer = participants.get(reviewerId)!;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, continuation.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!computer || !["windows", "win32"].includes(computer.os) || computer.status !== "online" || author.agentId !== continuation.writerAgentId
    || author.runtime !== original.run_start.runtime || reviewer.agentId === author.agentId || reviewer.id === author.id || own && reviewer.agentId !== own.reviewerAgentId
    || [author, reviewer].some(instance => instance.computerId !== computer.id || instance.workspaceRoot !== continuation.workspaceRoot || instance.runtime === "mock")
    || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_DESIGN_REVIEW_FEATURE_V1) !== true) throw AppError.conflict("H4 requires its current native Windows author and independent reviewer");
  for (const instance of [author, reviewer]) await scheduleTask(tx, ctx, instance.id === author.id ? ["code.read", "code.modify"] : ["code.read", "code.review"],
    { ...options, mode: "manual", agentInstanceId: instance.id, ...(own ? { importedDesignReviewId: own.id } : {}) });
  const uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const neighboring = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (neighboring.some(run => (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (participants.has(run.agentInstanceId) || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, continuation.workspaceRoot, computer.os))))
    throw AppError.conflict("H4 participant or workspace has an ordinary execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation => (operation.kind !== "design_review" || operation.id !== own?.id)
    && (operation.participantInstanceIds.some(id => participants.has(id)) || automationWorkspacesOverlap(operation.workspaceRoot, continuation.workspaceRoot, computer.os))))
    throw AppError.conflict("H4 participant or workspace has another dedicated execution");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(row => row.goalId !== goal.id && ["planning", "executing", "waiting"].includes(row.status) && row.workspaceRoot
    && automationWorkspacesOverlap(row.workspaceRoot, continuation.workspaceRoot, computer.os))) throw AppError.conflict("H4 workspace is reserved by another goal");
  const [h2] = await tx.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, continuation.reviewId)).for("update");
  const [h1] = h2 ? await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, h2.handoffId)).for("update") : [];
  if (!h2 || !h1 || h2.stopRequested || h1.stopRequested || !h1.qualifiedReceipt || canonical(h2.request) !== canonical(original.review_request)
    || canonical(h2.result) !== canonical(original.review_result)) throw AppError.conflict("H4 imported source review or handoff changed");
  const bytes = await researchBytes(ctx, original);
  assertMeasurementV2TransferSessions(ctx, transfer);
  if (canonical(sessions(ctx, original)) !== canonical(currentSessions)) throw AppError.conflict("H4 paired sessions changed during admission");
  return { continuation, ...completed, goal, task, automation, author, reviewer, currentSessions, bytes };
}

export async function ensureGoalImportedDesignReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, continuationId: string) {
  originalActor(ctx, automation.actorUserId);
  const [existing] = await tx.select().from(reviews).where(and(eq(reviews.continuationId, continuationId), eq(reviews.organizationId, ctx.organizationId)));
  if (existing) {
    if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("H4 belongs to another automation");
    return existing;
  }
  const value = await facts(ctx, tx, continuationId), { continuation, request: continuation_request, result: continuation_result, reviewer, task } = value;
  if (automation.goalId !== continuation.goalId || automation.planId !== continuation.planId) throw AppError.permissionDenied("H4 belongs to another plan");
  const review_id = ctx.idGen.generate("design_review"), original = continuation_request.run_start;
  const common = { version: 1 as const, review_id, continuation_request, continuation_result, reviewer: { instance_id: reviewer.id, agent_id: reviewer.agentId } };
  const subject = importedDesignReviewSubjectV1(common, sha), reviewTaskId = ctx.idGen.generate("design_review_task");
  const phase = () => RunStartPayloadSchema.parse({ ...original, run_id: ctx.idGen.generate("design_verify_run"),
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify"), expected_subject_digest: subject.subject_digest },
    policy_snapshot: { ...original.policy_snapshot, filesystem_write_scope: [] }, context_pack: { ...original.context_pack,
      payload: { ...original.context_pack.payload, imported_design_review_subject: subject, policy: { ...original.context_pack.payload.policy, filesystem_write_scope: [] } } } });
  const binding = { version: 1, review_id, continuation_id: continuation.id, completed_design_digest: subject.completed_design_digest, subject_digest: subject.subject_digest };
  const prompt = `Independently review the completed design against the original requirement, accepted research and plan. Read the exact design files using protected read-only tools. Inspect the sealed before-verification evidence listed in full or paged context.evidence_index.bundles; use each bundle reference with read_evidence. Check requirement coverage, interaction flows, feasibility, omissions, and declared acceptance cases. Verifier evidence does not replace substantive review. Do not modify files, run side-effecting commands or use the network. This review grants no implementation or release authority.\n\nGoal: ${value.goal.objective}\nDesign task: ${task.title}\n${task.description}\nCriteria: ${JSON.stringify(task.acceptanceCriteria)}\n\nReturn ONLY JSON with ${JSON.stringify(binding)}, outcome (accepted or changes_requested), a nonempty summary, and findings (severity blocking or nonblocking, description, optional file). Blocking findings require changes_requested.`;
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, product_development: undefined, review_subject: undefined, imported_review_subject: undefined,
    conversation: undefined, review_feedback: undefined, imported_design_review_subject: subject,
    task: { id: reviewTaskId, title: `Imported design review: ${task.title}`, description: prompt, acceptance_criteria: ["Independently review the exact design and return its bound verdict"] },
    policy: { ...original.context_pack.payload.policy, execution_mode: "discussion", filesystem_write_scope: [] } });
  const review_start = RunStartPayloadSchema.parse({ ...phase(), run_id: ctx.idGen.generate("design_review_run"), task_id: reviewTaskId, agent_instance_id: reviewer.id,
    runtime: reviewer.runtime, context_pack: { id: ctx.idGen.generate("context"), payload: context }, artifact_rules: { paths: [] } });
  const request = ImportedDesignReviewRequestV1Schema.parse({ ...common, before_start: phase(), review_start, after_start: phase() });
  inspectImportedDesignReviewRequestV1(request, value.bytes, sha);
  const [row] = await tx.insert(reviews).values({ id: review_id, continuationId, organizationId: ctx.organizationId, goalId: continuation.goalId, planId: continuation.planId,
    taskId: continuation.taskId, authorInstanceId: continuation.writerInstanceId, authorAgentId: continuation.writerAgentId, reviewerInstanceId: reviewer.id, reviewerAgentId: reviewer.agentId,
    computerId: continuation.computerId, workspaceRoot: continuation.workspaceRoot, actorUserId: continuation.actorUserId, consentId: continuation.consentId, policyVersion: continuation.policyVersion,
    sessionBindings: value.currentSessions, requestDigest: importedDesignReviewRequestDigestV1(request, sha), request, createdAt: ctx.clock.nowIso() }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-design-review.created", actorType: "system", actorId: "goal_runner", correlationId: review_id,
    goalId: continuation.goalId, projectId: task.projectId, taskId: task.id, runId: continuation.runId,
    payload: { review_id, continuation_id: continuationId, actor_user_id: continuation.actorUserId, completed_design_digest: subject.completed_design_digest, execution_authorized: false } }));
  return row!;
}

export async function advanceGoalImportedDesignReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, continuationId: string) {
  const row = await ensureGoalImportedDesignReview(ctx, tx, automation, continuationId);
  if (row.acceptedAt) return { reason: "Imported design accepted; waiting for separate H5 implementation authority. No implementation or release can start." };
  const result = ImportedDesignReviewResultV1Schema.safeParse(row.result).data;
  if (!result) { await ctx.onImportedDesignReviewQueued?.(row.id, row.stopRequested ? "stop" : "start"); return { reason: "Waiting for the independent destination design review." }; }
  if (row.stopRequested || result.outcome !== "reviewed" || result.verdict.outcome !== "accepted") return { reason: `Imported design review ${result.outcome === "reviewed" ? result.verdict.outcome : result.outcome}; implementation remains fenced.` };
  const value = await facts(ctx, tx, continuationId, row);
  inspectImportedDesignReviewResultV1(row.request, result, value.bytes, sha);
  const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
  if (!fresh || fresh.stopRequested || fresh.acceptedAt || canonical(fresh.result) !== canonical(result) || fresh.resultDigest !== hash(result)
    || fresh.resultSessionId !== value.currentSessions.destination.sessionId || fresh.requestDigest !== importedDesignReviewRequestDigestV1(fresh.request, sha)) throw AppError.conflict("H4 acceptance provenance changed");
  const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, fresh.resultDeliveryId!), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, fresh.resultSessionId!)));
  if (!delivery) throw AppError.conflict("H4 acceptance lacks its exact result delivery");
  const now = ctx.clock.nowIso();
  const changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "review", trigger: "accept", now,
    events: status => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: row.id,
      goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, roomId: value.task.roomId,
      payload: { status, imported_design_review_id: row.id } })] });
  if (!changed.changed) throw AppError.conflict("H4 design is no longer awaiting acceptance");
  const event = buildEvent(ctx, { type: "goal.imported-design-review.accepted", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: value.run.id,
    payload: { review_id: row.id, continuation_id: continuationId, actor_user_id: row.actorUserId, result_digest: fresh.resultDigest,
      completed_design_digest: value.provenance.completedDesignDigest, verification_evidence_id: value.evidence.id, subsequent_stage_authorized: false } });
  await appendEvent(tx, event);
  await tx.update(reviews).set({ acceptedAt: now, acceptanceEventId: event.id }).where(eq(reviews.id, row.id));
  // Deliberately no DAG unlock: this milestone ends at H4 acceptance.
  return { reason: "Imported design accepted; waiting for separate H5 implementation authority. No implementation or release can start." };
}

export async function stopGoalImportedDesignReviews(ctx: ServerContext, goalId: string) {
  const ids = await ctx.db.transaction(async tx => {
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    const rows = await tx.select().from(reviews).where(and(eq(reviews.goalId, goalId), eq(reviews.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); await tx.update(reviews).set({ stopRequested: true }).where(eq(reviews.id, row.id)); }
    return rows.filter(row => ImportedDesignReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => row.id);
  });
  for (const id of ids) await ctx.onImportedDesignReviewQueued?.(id, "stop");
  return ids;
}

export function createImportedDesignReviewBinding(ctx: ServerContext, options: {
  identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send">;
}) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("H4 node session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("H4 belongs to another node");
    return row;
  }
  async function startFence(tx: DrizzleDb, row: Review) {
    const value = await facts(actorContext(ctx, row.actorUserId), tx, row.continuationId, row);
    await qualify(tx);
    const session: Session = { ...identity, sessionId: options.sessionId };
    if (canonical(value.currentSessions.destination) !== canonical(session)) throw AppError.conflict("H4 admission belongs to another destination session");
    const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
    if (!fresh || fresh.stopRequested || fresh.result !== null || fresh.requestDigest !== importedDesignReviewRequestDigestV1(fresh.request, sha)) throw AppError.conflict("Stopped or settled H4 permits only status or stop");
    const request = inspectImportedDesignReviewRequestV1(fresh.request, value.bytes, sha);
    if (canonical(request.continuation_request) !== canonical(value.request) || canonical(request.continuation_result) !== canonical(value.result)
      || request.review_start.runtime !== value.reviewer.runtime) throw AppError.conflict("H4 no longer matches its exact completed author and reviewer");
    const prior = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
    if (prior.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("Exposed H4 cannot start in a new session");
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
    current(); return fresh;
  }
  // Shared with ordinary receive: its actual command_id remains the reply ID.
  async function sendResultReceipt(tx: DrizzleDb, message: ImportedDesignReviewResult) { await qualify(tx); current(); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`,
    type: "product.source.design-review.receipt.v1", payload: { version: 1, review_id: message.payload.review_id, request_digest: message.payload.request_digest }, result_digest: hash(message.payload), status: "accepted" }); current();
    if (message.payload.outcome === "reviewed" && message.payload.verdict.outcome === "accepted") {
      const row = await load(tx, message.payload.review_id);
      // This records transport.send completion, not a remote acknowledgement or H4 plan acceptance.
      await tx.insert(goalImportedDesignReviewReceipts).values({ reviewId: row.id, organizationId: ctx.organizationId,
        deliveryId: row.resultDeliveryId!, sessionId: options.sessionId, sessionBindings: row.sessionBindings,
        requestDigest: row.requestDigest, resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
    }
    current();
  }
  return {
    /** Re-send only an immutable result's original same-session receipt; never starts work. */
    async redeliverCommittedReceipt(id: string): Promise<void> {
      await ctx.db.transaction(async tx => {
        await qualify(tx); const row = await load(tx, id);
        const request = ImportedDesignReviewRequestV1Schema.parse(row.request), result = ImportedDesignReviewResultV1Schema.parse(row.result);
        if (!(result.outcome === "reviewed" && result.verdict.outcome === "accepted")) throw AppError.conflict("Committed design-review result has no receipt marker obligation");
        const bound = row.sessionBindings as { destination?: AuthenticatedTransferNode & { sessionId: string } };
        if (request.review_id !== row.id || result.review_id !== row.id || row.requestDigest !== importedDesignReviewRequestDigestV1(request, sha)
          || result.request_digest !== row.requestDigest || row.resultDigest !== hash(result) || !row.resultDeliveryId
          || row.resultSessionId !== options.sessionId || canonical(bound.destination ?? null) !== canonical({ ...identity, sessionId: options.sessionId }))
          throw AppError.conflict("Committed design-review receipt differs from its original result, request or destination session");
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, row.resultDeliveryId), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        const starts = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
        if (!delivery || starts.length !== 1 || starts[0]!.sessionId !== options.sessionId)
          throw AppError.conflict("Committed design-review receipt lost its original issuing delivery");
        const readMarker = async () => {
          const [marker] = await tx.select().from(goalImportedDesignReviewReceipts).where(and(eq(goalImportedDesignReviewReceipts.reviewId, row.id), eq(goalImportedDesignReviewReceipts.organizationId, ctx.organizationId)));
          if (marker && (marker.deliveryId !== row.resultDeliveryId || marker.sessionId !== row.resultSessionId
            || marker.requestDigest !== row.requestDigest || marker.resultDigest !== row.resultDigest || canonical(marker.sessionBindings) !== canonical(row.sessionBindings)))
            throw AppError.conflict("Committed design-review receipt marker differs from its original result");
          return marker;
        };
        if (await readMarker()) { current(); return; }
        // The original result may have arrived under status/stop; do not substitute its start ID.
        await sendResultReceipt(tx, { kind: "product.source.design-review.result.v1", node_id: identity.computerId, command_id: delivery.id, payload: result });
        if (!await readMarker()) throw AppError.conflict("Committed design-review receipt marker was not recorded after send");
        current();
      });
    },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        if (control === "start") await startFence(tx, row);
        else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist H4 stop before sending"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("design_review_delivery"), reviewId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.design-review.v1", payload: ImportedDesignReviewRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.design-review.stop.v1" : "product.source.design-review.status.v1", payload: { version: 1, review_id: id, request_digest: record.row.requestDigest } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx);
        current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedDesignReviewAck) {
      const ack = importedDesignReviewAckSchema.parse(input); current();
      if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("H4 ACK node differs");
      await ctx.db.transaction(async tx => {
        await qualify(tx); const row = await load(tx, ack.payload.review_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("H4 ACK lacks its immutable issued delivery");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id));
        await qualify(tx);
      });
    },
    async receive(input: ImportedDesignReviewResult) {
      const message = importedDesignReviewResultSchema.parse(input); current();
      if (message.node_id !== identity.computerId) throw AppError.permissionDenied("H4 result node differs");
      await ctx.db.transaction(async tx => {
        const row = await load(tx, message.payload.review_id);
        // The goal/member/device order matches admission. Closure still records after pause.
        await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
        await qualify(tx);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("H4 result has no exact issued command");
        const request = ImportedDesignReviewRequestV1Schema.parse(row.request);
        const result = inspectImportedDesignReviewResultV1(request, message.payload, await researchBytes(ctx, request.continuation_request), sha);
        if (result.outcome === "reviewed") {
          if (canonical(sessions(ctx, request.continuation_request)) !== canonical(row.sessionBindings)) throw AppError.conflict("H4 success cannot reuse an earlier paired admission");
          const bound = row.sessionBindings as { destination: Session };
          if (canonical(bound.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H4 success belongs to its original paired session");
        }
        const [locked] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("H4 result is immutable");
        if (locked!.result === null) await tx.update(reviews).set({ result, resultDigest: hash(result), resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(reviews.id, row.id));
        await qualify(tx);
      });
      await ctx.db.transaction(tx => sendResultReceipt(tx, message));
    },
  };
}
