import { readCurrentResearchHandoff, resolveResearchRevisionOrigin } from "./research-revision-origin-service.js";
import { assertCurrentResearchHandoff } from "./research-handoff-guard.js";
import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { agentInstances, agents, appendEvent, computers, devices, deviceTokens, goalAutomations, goals, plans, runs, tasks,
  goalProductHandoffs as handoffs, goalProductHandoffOperations as operations, goalProductHandoffDeliveries as operationDeliveries,
  goalImportedProductReviews as reviews, goalImportedProductReviewDeliveries as deliveries } from "@artoo/db";
import { AutonomousTeamSchema, ContextPackSchema, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema,
  IMPORTED_PRODUCT_REVIEW_FEATURE_V1, IMPORTED_PRODUCT_REVIEW_MAPPING_INSTRUCTION_V1, ProductSourceOperationV1Schema, ProductSourceOperationResultV1Schema,
  RunStartPayloadSchema, TaskSpecSchema, importedProductReviewRequestDigestV1, importedProductReviewSubjectV1, inspectImportedProductReviewResultV1,
  canonicalProductSourceTransferValueV1 as canonical, type ImportedProductReviewRequestV1, type ProductSourceOperationV1 } from "@artoo/domain";
import { importedProductReviewAckSchema, importedProductReviewResultSchema,
  type ImportedProductReviewAck, type ImportedProductReviewResult, type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { readContentAddressedBlob, requireArtifactStore, type ArtifactStorageOptions } from "../content-addressed-blob.js";
import { assertSemanticCapsuleResearch } from "../product-source-semantic-transfer-routes.js";
import { admitProductSourceSemanticTransferInTransaction, assertMeasurementV2TransferSessions, type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { requireActiveMember } from "./member-status.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { unsettledGoalRunIds, unsettledImportedProductReviews, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { scheduleTask } from "./scheduler.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
type Review = typeof reviews.$inferSelect;
type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
const closed = (value: unknown) => ImportedProductReviewResultV1Schema.safeParse(value).data?.closed === true;
function originalActor(ctx: ServerContext, actorUserId: string): void {
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== actorUserId) throw AppError.permissionDenied("Only the original user's GoalRunner owns imported review");
}
function actorContext(ctx: ServerContext, row: Pick<Review, "actorUserId">): ServerContext {
  return { ...ctx, actorUserId: row.actorUserId, automationActor: { type: "system", id: "goal_runner" } };
}
export function importedProductReviewView(row: Review) {
  const result = ImportedProductReviewResultV1Schema.safeParse(row.result).data;
  const state = row.stopRequested ? "stopped_or_fenced" : !result ? "pending" : result.outcome === "reviewed"
    ? result.verdict.outcome === "accepted" ? "accepted_waiting_writer_authority" : "changes_requested" : result.outcome;
  return { review_id: row.id, transfer_id: row.handoffId, state, closed: result?.closed ?? false,
    execution_authorized: false, design_write_authorized: false } as const;
}

async function handoffRecord(ctx: ServerContext, tx: DrizzleDb, id: string) {
  const [handoff] = await tx.select().from(handoffs).where(and(eq(handoffs.id, id), eq(handoffs.organizationId, ctx.organizationId)));
  if (!handoff) throw AppError.notFound("Imported review handoff not found");
  const [operation] = await tx.select().from(operations).where(and(eq(operations.handoffId, id), eq(operations.kind, "import_verify")));
  if (!operation) throw AppError.conflict("Destination import operation is missing");
  const payload = ProductSourceOperationV1Schema.parse(operation.payload), result = ProductSourceOperationResultV1Schema.parse(operation.result);
  if (!handoff.qualifiedReceipt || handoff.stopRequested || result.outcome !== "verified" || result.fresh.verification.outcome !== "passed"
    || canonical(payload.intent) !== canonical(handoff.intent)) throw AppError.conflict("Imported review requires its qualified destination research receipt");
  return { handoff, operation, payload, result };
}

async function nextTaskAndBudget(ctx: ServerContext, tx: DrizzleDb, operation: ProductSourceOperationV1, currentReviewId?: string) {
  const base = operation.intent.request.byte_request;
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, base.goal_id), eq(goals.organizationId, ctx.organizationId))).for("update");
  if (!goal || goal.status !== "running" || goal.currentPlanId !== base.plan_id) throw AppError.conflict("Imported review requires the current running goal");
  await assertCurrentResearchHandoff(ctx, tx, operation.intent);
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
    throw AppError.conflict("Goal elapsed time budget has been reached");
  if (budgets.max_retries !== null && goal.retryCount > budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded");
  const [next] = await tx.select().from(tasks).where(and(eq(tasks.id, operation.intent.next_task_id), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [source] = await tx.select().from(tasks).where(and(eq(tasks.id, base.source.task_id), eq(tasks.organizationId, ctx.organizationId)));
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, base.plan_id), eq(plans.organizationId, ctx.organizationId)));
  const sourceOrigin = source ? await resolveResearchRevisionOrigin(ctx, tx, source) : undefined;
  const sourceRef = sourceOrigin?.specRef ?? source?.sourcePlanSpecRef;
  const index = Number(next?.sourcePlanSpecRef), sourceIndex = Number(sourceRef);
  const spec = Array.isArray(plan?.taskSpecs) && Number.isSafeInteger(index) ? TaskSpecSchema.safeParse(plan.taskSpecs[index]) : undefined;
  if (!next || next.projectId !== base.project_id || next.goalId !== base.goal_id || next.sourcePlanId !== base.plan_id || next.status !== "ready"
    || next.sourcePlanSpecRef === null || String(index) !== next.sourcePlanSpecRef || !source || sourceRef == null || String(sourceIndex) !== sourceRef
    || !spec?.success || spec.data.development_stage !== "design" || !spec.data.dependencies.some(d => d.ref === sourceRef && ["blocks", "artifact_required"].includes(d.type)))
    throw AppError.conflict("Imported research review requires its ready dependent design task");
  const expectedGoal = { version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria,
    plan: { id: plan!.id, version: plan!.version, rationale: plan!.rationale ?? "", spec_ref: sourceRef } };
  if (canonical(operation.intent.destination_start.context_pack.payload?.goal_context) !== canonical(expectedGoal))
    throw AppError.conflict("Imported handoff context differs from the original goal and accepted plan");
  const standalone = (await unsettledStandaloneExecutions(ctx, tx, { goalId: base.goal_id })).filter(row => row.kind !== "review" || row.id !== currentReviewId);
  if (standalone.some(row => row.result !== null)) throw AppError.conflict("Unconfirmed closure keeps the imported workspace fenced");
  const runIds = new Set(await unsettledGoalRunIds(ctx, tx, base.goal_id));
  for (const operation of standalone) if ("runId" in operation) runIds.add(operation.runId);
  const active = runIds.size + standalone.filter(operation => !("runId" in operation)).length;
  if (budgets.max_concurrent_runs !== null && active >= budgets.max_concurrent_runs) throw AppError.conflict("Goal concurrent run limit has been reached");
  return { goal, next, source };
}

async function sourceAuthor(ctx: ServerContext, tx: DrizzleDb, operation: ProductSourceOperationV1) {
  const source = operation.intent.request.byte_request.source;
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, source.run_id), eq(runs.organizationId, ctx.organizationId)));
  const [author] = run ? await tx.select().from(agentInstances).where(and(eq(agentInstances.id, run.agentInstanceId), eq(agentInstances.organizationId, ctx.organizationId))) : [];
  if (!run || !author || run.computerId !== source.node_id || author.computerId !== source.node_id) throw AppError.conflict("Original source author is no longer identifiable");
  return { instance_id: author.id, agent_id: author.agentId };
}

async function reviewerAdmission(ctx: ServerContext, tx: DrizzleDb, request: ImportedProductReviewRequestV1) {
  const base = request.operation.intent.request.byte_request;
  const author = await sourceAuthor(ctx, tx, request.operation);
  const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, request.reviewer.instance_id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
  // Ordinary assignTask takes this same instance -> computer ordering and repeats its imported occupancy query afterwards.
  const [computer] = instance ? await tx.select().from(computers).where(and(eq(computers.id, instance.computerId), eq(computers.organizationId, ctx.organizationId))).for("update") : [];
  const [agent] = instance ? await tx.select().from(agents).where(and(eq(agents.id, instance.agentId), eq(agents.organizationId, ctx.organizationId))) : [];
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, base.goal_id), eq(goalAutomations.organizationId, ctx.organizationId)));
  const team = AutonomousTeamSchema.safeParse(automation?.team);
  const currentResearch = await readCurrentResearchHandoff(ctx, tx, base.goal_id, base.plan_id, request.operation.intent.next_task_id);
  const fixedReviewer = currentResearch?.snapshot.members[currentResearch.revision?.generation ?? 0]?.reviewer;
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, base.goal_id), eq(goals.organizationId, ctx.organizationId)));
  const allowed = goal ? supportedGoalPolicy(goal.budgets, goal.stopConditions).budgets.allowed_runtimes : [];
  if (canonical(author) !== canonical(request.source_author) || !instance || !computer || computer.status !== "online" || !agent || !team.success || !team.data.reviewer_instance_ids.includes(instance.id)
    || currentResearch && (!fixedReviewer || currentResearch.handoffId !== base.transfer_id
      || instance.id !== fixedReviewer.instance_id || instance.agentId !== fixedReviewer.agent_id || instance.runtime !== fixedReviewer.runtime
      || instance.modelProfileId !== fixedReviewer.model_profile_id || instance.effortProfileId !== fixedReviewer.effort_profile_id)
    || instance.agentId !== request.reviewer.agent_id || author.agent_id === instance.agentId || author.instance_id === instance.id
    || instance.computerId !== base.destination.node_id || instance.runtime !== request.review_start.runtime || instance.runtime === "mock"
    || allowed !== null && !allowed.includes(instance.runtime)
    || ["disabled", "failed", "stopping"].includes(instance.status) || instance.workspaceRoot !== base.destination.workspace_root
    || !["code.read", "code.review"].every(cap => (agent.capabilities as string[]).includes(cap))
    || ctx.supportsExecutionFeature?.(base.destination.node_id, IMPORTED_PRODUCT_REVIEW_FEATURE_V1) !== true)
    throw AppError.conflict("Imported research requires a current distinct team reviewer on the destination computer");
  const uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: instance.computerId }));
  const neighboringRuns = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, instance.computerId)));
  if (neighboringRuns.some(run => (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (run.agentInstanceId === instance.id || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, base.destination.workspace_root, computer.os))))
    throw AppError.conflict("Imported reviewer or workspace already owns an ordinary execution");
  const active = await unsettledStandaloneExecutions(ctx, tx, { computerId: instance.computerId });
  if (active.some(row => (row.kind !== "review" || row.id !== request.review_id) && (row.participantInstanceIds.includes(instance.id) || automationWorkspacesOverlap(row.workspaceRoot, base.destination.workspace_root, computer.os))))
    throw AppError.conflict("Imported reviewer or workspace has another unsettled review");
}

async function admit(ctx: ServerContext, tx: DrizzleDb, record: Review, allowResult = false, beforeRowLock?: () => Promise<void>) {
  originalActor(ctx, record.actorUserId);
  const request = ImportedProductReviewRequestV1Schema.parse(record.request);
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, request.operation.intent.request);
  const current = await handoffRecord(ctx, tx, record.handoffId);
  const [lockedHandoff] = await tx.select().from(handoffs).where(eq(handoffs.id, record.handoffId)).for("update");
  if (!lockedHandoff || lockedHandoff.stopRequested || !lockedHandoff.qualifiedReceipt || canonical(request.operation) !== canonical(current.payload) || canonical(request.result) !== canonical(current.result))
    throw AppError.conflict("Imported review no longer matches its exact admitted transfer");
  await nextTaskAndBudget(ctx, tx, request.operation, record.id);
  await reviewerAdmission(ctx, tx, request);
  await beforeRowLock?.();
  // Goal/device fences precede the row lock; receive locks devices then this same row.
  const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, record.id)).for("update");
  if (!fresh || fresh.stopRequested || !allowResult && fresh.result !== null) throw AppError.conflict("Settled or stopped review permits only status or stop");
  if (fresh.result !== null && !closed(fresh.result)) throw AppError.conflict("Unconfirmed review closure keeps its workspace fenced");
  if (fresh.requestDigest !== importedProductReviewRequestDigestV1(request, sha)) throw AppError.conflict("Imported request digest differs");
  assertMeasurementV2TransferSessions(ctx, request.operation.intent.request);
  return fresh;
}

/** Constructed from trusted DB rows by GoalRunner; no caller supplies a claimed source author or model verdict. */
export async function ensureGoalImportedProductReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, handoffId: string) {
  originalActor(ctx, automation.actorUserId);
  const { handoff, payload: operation, result } = await handoffRecord(ctx, tx, handoffId);
  if (handoff.actorUserId !== automation.actorUserId || handoff.goalId !== automation.goalId || handoff.planId !== automation.planId) throw AppError.permissionDenied("Imported review belongs to another automation");
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, operation.intent.request);
  await tx.select().from(handoffs).where(eq(handoffs.id, handoffId)).for("update");
  const [existing] = await tx.select().from(reviews).where(eq(reviews.handoffId, handoffId));
  if (existing) { await admit(ctx, tx, existing, true); return existing; }
  const { goal, source } = await nextTaskAndBudget(ctx, tx, operation);
  const source_author = await sourceAuthor(ctx, tx, operation), base = operation.intent.request.byte_request;
  const choices = await scheduleTask(tx, ctx, ["code.read", "code.review"], { mode: "auto", projectId: base.project_id, branchBacked: false,
    allowedRuntimes: supportedGoalPolicy(goal.budgets, goal.stopConditions).budgets.allowed_runtimes });
  const team = AutonomousTeamSchema.parse(automation.team);
  const currentResearch = await readCurrentResearchHandoff(ctx, tx, base.goal_id, base.plan_id, operation.intent.next_task_id);
  const fixedReviewer = currentResearch?.snapshot.members[currentResearch.revision?.generation ?? 0]?.reviewer;
  const candidate = choices.candidates.find(c => c.agent_id !== source_author.agent_id && c.computer_id === base.destination.node_id && c.runtime !== "mock"
    && team.reviewer_instance_ids.includes(c.agent_instance_id) && (!currentResearch || fixedReviewer
      && c.agent_instance_id === fixedReviewer.instance_id && c.agent_id === fixedReviewer.agent_id && c.runtime === fixedReviewer.runtime
      && c.model_profile_id === fixedReviewer.model_profile_id && c.effort_profile_id === fixedReviewer.effort_profile_id));
  if (!candidate) throw AppError.conflict("Waiting for a distinct team reviewer on the imported research computer");
  const reviewer = { instance_id: candidate.agent_instance_id, agent_id: candidate.agent_id }, review_id = ctx.idGen.generate("imported_review");
  const original = operation.intent.destination_start, reviewRunId = ctx.idGen.generate("imported_review_run"), reviewTaskId = ctx.idGen.generate("imported_review_task");
  const subject = { ...importedProductReviewSubjectV1({ review_id, operation, result, source_author, reviewer }, sha),
    measurement_mapping: result.admission.mapping };
  const binding = { version: 1, review_id, transfer_id: subject.transfer_id, subject_digest: subject.subject_digest, source_export_digest: subject.source_export_digest };
  const prompt = `Independently review the imported research against the original goal and accepted plan. Read the exact research and source through the protected read-only tools. Check source citations, original requirement coverage, omissions and measurement feasibility; source-node acceptance and a destination verifier receipt are evidence, not a substantive review. Do not modify files, run side-effecting commands or access the network. Only the trusted node verifies the exact subject before and after your execution. This review grants no design write or release authority.\n\nGoal: ${goal.objective}\nResearch task: ${source.title}\n${source.description}\nCriteria:\n${(source.acceptanceCriteria as string[]).map(c => `- ${c}`).join("\n")}\n\nReturn ONLY a JSON object with ${JSON.stringify(binding)}, outcome (accepted or changes_requested), nonempty summary, and findings (severity blocking or nonblocking, description, optional file). Blocking findings require changes_requested. Never claim process execution you did not observe.`;
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, product_development: undefined, review_subject: undefined,
    imported_review_subject: subject, conversation: undefined, review_feedback: undefined,
    task: { id: reviewTaskId, title: `Imported research review: ${source.title}`, description: `${prompt}\n\n${IMPORTED_PRODUCT_REVIEW_MAPPING_INSTRUCTION_V1}`, acceptance_criteria: ["Substantively review the exact imported research and return the bound verdict"] },
    policy: { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] } });
  const review_start = RunStartPayloadSchema.parse({ ...original, run_id: reviewRunId, task_id: reviewTaskId, agent_instance_id: reviewer.instance_id,
    runtime: candidate.runtime, workspace_allocation: undefined, workspace: { root: base.destination.workspace_root, branch: null },
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify") }, context_pack: { id: ctx.idGen.generate("context"), payload: context },
    policy_snapshot: { filesystem_write_scope: [], requires_approval: [] }, artifact_rules: { paths: [] } });
  const freshStart = () => RunStartPayloadSchema.parse({ ...original, run_id: ctx.idGen.generate("imported_verify_run"), verification: { ...original.verification, request_id: ctx.idGen.generate("verify") } });
  const request = ImportedProductReviewRequestV1Schema.parse({ version: 1, review_id, operation, result, source_author, reviewer, review_start, before_start: freshStart(), after_start: freshStart() });
  await reviewerAdmission(ctx, tx, request);
  const [row] = await tx.insert(reviews).values({ id: review_id, handoffId, operationId: operation.operation_id, organizationId: ctx.organizationId,
    goalId: base.goal_id, planId: base.plan_id, nextTaskId: operation.intent.next_task_id, sourceRunId: base.source.run_id, sourceInstanceId: source_author.instance_id,
    sourceAgentId: source_author.agent_id, reviewerInstanceId: reviewer.instance_id, reviewerAgentId: reviewer.agent_id, computerId: base.destination.node_id,
    actorUserId: handoff.actorUserId, consentId: handoff.consentId, policyVersion: handoff.policyVersion, reviewRunId, reviewTaskId,
    requestDigest: importedProductReviewRequestDigestV1(request, sha), request, createdAt: ctx.clock.nowIso() }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-review.created", actorType: "system", actorId: "goal_runner", correlationId: review_id,
    goalId: base.goal_id, projectId: base.project_id, taskId: operation.intent.next_task_id,
    payload: { review_id, transfer_id: handoffId, source_agent_id: source_author.agent_id, reviewer_agent_id: reviewer.agent_id, execution_authorized: false } }));
  return row!;
}

/** A positive imported review still stops at the single-use writer-authority boundary. Ordinary assignments never consume it. */
export async function advanceGoalImportedProductReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, nextTaskId: string) {
  const current = await readCurrentResearchHandoff(ctx, tx, automation.goalId, automation.planId!, nextTaskId);
  if (current && current.handoffId === null) return { reason: "Research revision is awaiting independently accepted source work before its next transfer." };
  const matches = await tx.select().from(handoffs).where(and(eq(handoffs.organizationId, ctx.organizationId), eq(handoffs.goalId, automation.goalId),
    current ? eq(handoffs.id, current.handoffId!) : undefined,
    eq(handoffs.planId, automation.planId!), eq(handoffs.nextTaskId, nextTaskId)));
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw AppError.conflict("Multiple imported subjects require explicit reconciliation");
  const handoff = matches[0]!;
  originalActor(ctx, handoff.actorUserId);
  if (!handoff.qualifiedReceipt || handoff.stopRequested) {
    // Advance only an already-admitted immutable H1. Node IO is queued for after the GoalRunner transaction commits.
    const sourceOperations = await tx.select().from(operations).where(eq(operations.handoffId, handoff.id));
    const upload = sourceOperations.find(item => item.kind === "upload"), imported = sourceOperations.find(item => item.kind === "import_verify");
    if (!upload || !imported) throw AppError.conflict("Imported handoff operations are incomplete");
    const uploaded = ProductSourceOperationResultV1Schema.safeParse(upload.result).data;
    const verified = ProductSourceOperationResultV1Schema.safeParse(imported.result).data;
    if (handoff.stopRequested) {
      for (const operation of sourceOperations) if (ProductSourceOperationResultV1Schema.safeParse(operation.result).data?.closed !== true)
        await ctx.onProductSourceOperationQueued?.(operation.id, "stop");
    } else if (upload.result === null) await ctx.onProductSourceOperationQueued?.(upload.id, "start");
    else if (uploaded?.closed === false) await ctx.onProductSourceOperationQueued?.(upload.id, "status");
    else if (uploaded?.outcome === "uploaded") {
      if (imported.result === null) await ctx.onProductSourceOperationQueued?.(imported.id, "start");
      else if (verified?.closed === false) await ctx.onProductSourceOperationQueued?.(imported.id, "status");
      else if (verified?.outcome === "verified" && verified.fresh.verification.outcome === "passed")
        await ctx.onProductSourceOperationQueued?.(imported.id, "qualify");
    }
    return { reason: "Waiting for the exact destination research verification; design remains fenced" };
  }
  const row = await ensureGoalImportedProductReview(ctx, tx, automation, handoff.id), view = importedProductReviewView(row);
  if (row.result === null) await ctx.onImportedProductReviewQueued?.(row.id, "start");
  return { ...view, reason: view.state === "accepted_waiting_writer_authority"
    ? "Destination research review accepted; a separate single-use design writer authorization is still required"
    : `Imported research review ${view.state}; design remains fenced` };
}

export async function stopGoalImportedProductReviews(ctx: ServerContext, goalId: string) {
  const ids = await ctx.db.transaction(async tx => {
    const [goal] = await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    if (!goal) return [];
    const rows = await tx.select().from(reviews).where(and(eq(reviews.goalId, goalId), eq(reviews.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); await tx.update(reviews).set({ stopRequested: true }).where(eq(reviews.id, row.id)); }
    return rows.filter(row => !closed(row.result)).map(row => row.id);
  });
  for (const id of ids) await ctx.onImportedProductReviewQueued?.(id, "stop");
  return ids;
}

/** The authenticated transport supplies identity/session; no frame can choose either or the initiating user. */
export function createGoalImportedProductReviewBinding(ctx: ServerContext, options: ArtifactStorageOptions & {
  identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send">;
}) {
  const artifactStore = requireArtifactStore(options);
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("Imported review node session is no longer current"); };
  async function credential(tx: DrizzleDb) {
    current();
    const [observed] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId)));
    if (!observed) throw AppError.permissionDenied("Imported reviewer device is no longer paired");
    await requireActiveMember(ctx, observed.enrolledByUserId, tx);
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
    const [token] = await tx.select().from(deviceTokens).where(and(eq(deviceTokens.deviceId, identity.deviceId), eq(deviceTokens.organizationId, ctx.organizationId),
      eq(deviceTokens.tokenLookup, identity.tokenLookup), eq(deviceTokens.kind, "node"), eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
    current();
    if (!device || device.trust !== "active" || device.revokedAt !== null || device.computerId !== identity.computerId || device.enrolledByUserId !== observed.enrolledByUserId
      || !token || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso())) throw AppError.permissionDenied("Imported reviewer credential is no longer current");
  }
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("Imported review belongs to another node");
    return row;
  }
  async function startFence(tx: DrizzleDb, row: Review) {
    const fresh = await admit(actorContext(ctx, row), tx, row, false, () => credential(tx)); await credential(tx);
    await assertSourceLineageDispatch(ctx, tx, row.computerId,
      ImportedProductReviewRequestV1Schema.parse(row.request).operation.intent.request.byte_request.destination.workspace_root);
    current(); return fresh;
  }
  return {
    async dispatch(id: string, control: Control = "start") {
      current();
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        if (control === "start") await startFence(tx, row);
        else { await credential(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist review stop before dispatch"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("imported_review_delivery"), reviewId: id,
          sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.review.v1", payload: ImportedProductReviewRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.review.stop.v1" : "product.source.review.status.v1", payload: { version: 1, review_id: id, request_digest: record.row.requestDigest } };
      // Revalidate after committing the immutable delivery; a competing result or pause may have arrived.
      await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        if (control === "start") await startFence(tx, row); else await credential(tx);
        current(); await options.transport.send(command); current();
      });
      return command;
    },
    async acknowledge(input: ImportedProductReviewAck) {
      const ack = importedProductReviewAckSchema.parse(input); current();
      if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("Imported ACK node differs");
      await ctx.db.transaction(async tx => {
        await credential(tx); const row = await load(tx, ack.payload.review_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        await credential(tx);
        if (!delivery || row.requestDigest !== ack.payload.request_digest) throw AppError.conflict("Imported ACK has no matching delivery");
        if (delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("Imported ACK is immutable");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id));
        await credential(tx);
      });
    },
    async receive(input: ImportedProductReviewResult) {
      const message = importedProductReviewResultSchema.parse(input); current();
      if (message.node_id !== identity.computerId) throw AppError.permissionDenied("Imported result node differs");
      await ctx.db.transaction(async tx => {
        await credential(tx); const row = await load(tx, message.payload.review_id), request = ImportedProductReviewRequestV1Schema.parse(row.request);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery || message.payload.request_digest !== row.requestDigest) throw AppError.conflict("Imported result has no matching issued command");
        const source = request.operation.intent.request.byte_request.source;
        const bytes = await readContentAddressedBlob(artifactStore, source.capsule_digest, source.capsule_bytes);
        assertSemanticCapsuleResearch(bytes, request.operation.intent.request);
        const capsule = JSON.parse(bytes.toString("utf8")) as { files: { path: string; base64: string }[] };
        const research = Buffer.from(capsule.files.find(file => file.path === ".artoo/product/research.json")!.base64, "base64");
        const result = inspectImportedProductReviewResultV1(request, message.payload, research, sha);
        // A paused goal may still record closure; recording never grants continuation authority.
        await credential(tx);
        const [locked] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
        await credential(tx);
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("Imported review result is immutable");
        if (locked!.result === null) await tx.update(reviews).set({ result }).where(eq(reviews.id, row.id));
        await credential(tx);
      });
      await ctx.db.transaction(async tx => {
        await credential(tx); current();
        await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`, type: "product.source.review.receipt.v1",
          payload: { version: 1, review_id: message.payload.review_id, request_digest: message.payload.request_digest }, result_digest: hash(message.payload), status: "accepted" });
        current();
      });
    },
    async inspect(id: string) {
      current(); return ctx.db.transaction(async tx => {
        const row = await load(tx, id), fresh = await admit(actorContext(ctx, row), tx, row, true, () => credential(tx));
        await credential(tx); return importedProductReviewView(fresh);
      });
    },
  };
}
