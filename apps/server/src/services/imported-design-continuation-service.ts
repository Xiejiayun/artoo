import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { agentInstances, agents, approvals, appendEvent, computers, contextPacks, devices, deviceTokens, goals, goalAutomations, plans, runs, tasks,
  goalProductHandoffs, goalImportedProductReviews as reviews, goalImportedDesignContinuations as continuations, goalImportedDesignDeliveries as deliveries } from "@artoo/db";
import { AutonomousTeamSchema, ContextPackSchema, TaskSpecSchema, ImportedProductReviewRequestV1Schema, ImportedProductReviewResultV1Schema,
  ImportedDesignContinuationRequestV1Schema, ImportedDesignContinuationResultV1Schema, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1,
  IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1,
  importedProductReviewRequestDigestV1, importedDesignContinuationRequestDigestV1, transferredProductInputV1, productDevelopmentContext,
  inspectImportedDesignContinuationRequestV1, inspectImportedDesignContinuationResultV1, inspectImportedProductReviewResultV1,
  canonicalProductSourceTransferValueV1 as canonical, type Capability } from "@artoo/domain";
import { importedDesignContinuationAckSchema, importedDesignContinuationResultSchema, type ImportedDesignContinuationAck,
  type ImportedDesignContinuationResult, type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import { assertExecutionApprovalGranted, bindExecutionApprovalToRun, EXECUTION_GATE_CURRENT, EXECUTION_GATE_SUPERSEDED } from "./approval-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { goalImportedDesignCompletions } from "@artoo/db";
import { inspectCompletedImportedDesign } from "./imported-design-completion-service.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
type Continuation = typeof continuations.$inferSelect;
type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
const isClosed = (value: unknown) => ImportedDesignContinuationResultV1Schema.safeParse(value).data?.closed === true;
function originalActor(ctx: ServerContext, actor: string) {
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== actor) throw AppError.permissionDenied("Only the original user's GoalRunner owns imported design continuation");
}
const actorContext = (ctx: ServerContext, row: Continuation): ServerContext => ({ ...ctx, actorUserId: row.actorUserId, automationActor: { type: "system", id: "goal_runner" } });
export function importedDesignContinuationView(row: Continuation) {
  const result = ImportedDesignContinuationResultV1Schema.safeParse(row.result).data;
  return { continuation_id: row.id, run_id: row.runId, state: row.stopRequested ? "stopped_or_fenced" : result?.outcome ?? "pending",
    closed: result?.closed ?? false, acceptance_authorized: false, subsequent_stage_authorized: false } as const;
}
async function researchBytes(ctx: ServerContext, review: ReturnType<typeof ImportedProductReviewRequestV1Schema.parse>) {
  if (!ctx.productSourceArtifactDir) throw AppError.conflict("Imported design requires the configured source artifact store");
  const source = review.operation.intent.request.byte_request.source;
  const bytes = await readContentAddressedBlob(ctx.productSourceArtifactDir, source.capsule_digest, source.capsule_bytes);
  assertSemanticCapsuleResearch(bytes, review.operation.intent.request);
  const capsule = JSON.parse(bytes.toString("utf8")) as { files: { path: string; base64: string }[] };
  return Buffer.from(capsule.files.find(file => file.path === ".artoo/product/research.json")!.base64, "base64");
}

/** Current DB/configuration facts, not fields chosen by the incoming command or a model. */
async function facts(ctx: ServerContext, tx: DrizzleDb, reviewId: string, own?: Continuation) {
  const [review] = await tx.select().from(reviews).where(and(eq(reviews.id, reviewId), eq(reviews.organizationId, ctx.organizationId)));
  if (!review) throw AppError.notFound("Imported research review not found");
  originalActor(ctx, review.actorUserId);
  const request = ImportedProductReviewRequestV1Schema.parse(review.request), result = ImportedProductReviewResultV1Schema.parse(review.result);
  if (review.stopRequested || result.outcome !== "reviewed" || result.verdict.outcome !== "accepted"
    || review.requestDigest !== importedProductReviewRequestDigestV1(request, sha)) throw AppError.conflict("Imported design requires its exact accepted independent review");
  await admitProductSourceSemanticTransferInTransaction(ctx, tx, request.operation.intent.request);
  const base = request.operation.intent.request.byte_request, root = base.destination.workspace_root;
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, review.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, review.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, review.nextTaskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, review.planId), eq(plans.organizationId, ctx.organizationId)));
  const [source] = await tx.select().from(tasks).where(and(eq(tasks.id, base.source.task_id), eq(tasks.organizationId, ctx.organizationId)));
  const index = Number(task?.sourcePlanSpecRef), parsed = Array.isArray(plan?.taskSpecs) && Number.isSafeInteger(index) ? TaskSpecSchema.safeParse(plan.taskSpecs[index]) : undefined;
  if (!goal || goal.status !== "running" || goal.currentPlanId !== review.planId || !automation || automation.actorUserId !== review.actorUserId
    || automation.planId !== review.planId || !["executing", "waiting"].includes(automation.status) || automation.executionMode !== "agent_team"
    || automation.consentId !== review.consentId || automation.policyVersion !== review.policyVersion
    || !task || !plan || task.goalId !== goal.id || task.projectId !== base.project_id || task.sourcePlanId !== plan.id || plan.status !== "accepted"
    || task.sourcePlanSpecRef === null || String(index) !== task.sourcePlanSpecRef || task.status !== (own ? "assigned" : "ready")
    || task.executionPolicyTaskId !== null || task.parentTaskId !== null || !source || source.status !== "done" || source.sourcePlanSpecRef === null
    || !parsed?.success || parsed.data.development_stage !== "design") throw AppError.conflict("Imported design requires the current ready exact design task and accepted plan");
  const spec = parsed.data;
  assertSupportedPlanTaskControls(spec, index);
  const hard = spec.dependencies.filter(edge => edge.type !== "soft_context");
  if (hard.length !== 1 || hard[0]!.ref !== source.sourcePlanSpecRef || !["blocks", "artifact_required"].includes(hard[0]!.type)
    || task.title !== spec.title || task.description !== spec.description || canonical(task.acceptanceCriteria) !== canonical(spec.acceptance_criteria)
    || canonical(task.requiredCapabilities) !== canonical(spec.required_capabilities)) throw AppError.conflict("Imported design task differs from its exact accepted specification or research dependency");
  const expectedGoal = { version: 1, goal_id: goal.id, objective: goal.objective, acceptance_criteria: goal.acceptanceCriteria,
    plan: { id: plan.id, version: plan.version, rationale: plan.rationale ?? "", spec_ref: source.sourcePlanSpecRef } };
  if (canonical(request.operation.intent.destination_start.context_pack.payload?.goal_context) !== canonical(expectedGoal))
    throw AppError.conflict("Imported design original goal or accepted plan context changed");
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
    throw AppError.conflict("Goal elapsed time budget has been reached");
  if (budgets.max_retries !== null && goal.retryCount > budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded");
  const count = await unsettledGoalExecutionCount(ctx, tx, goal.id);
  if (budgets.max_concurrent_runs !== null && (own ? count > budgets.max_concurrent_runs : count >= budgets.max_concurrent_runs))
    throw AppError.conflict("Goal concurrent run limit has been reached");
  const team = AutonomousTeamSchema.parse(automation.team), writerId = team.members.find(member => member.stage === "design")!.agent_instance_id;
  const options = { mode: "manual" as const, projectId: task.projectId, agentInstanceId: writerId, branchBacked: false,
    allowedRuntimes: budgets.allowed_runtimes, ...(own ? { importedDesignRunId: own.runId } : {}) };
  const required = [...new Set([...spec.required_capabilities, "code.read", "code.modify"])] as Capability[];
  const selected = (await scheduleTask(tx, ctx, required, options)).selected;
  const [writer] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, selected.agent_instance_id), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
  const [computer] = writer ? await tx.select().from(computers).where(and(eq(computers.id, writer.computerId), eq(computers.organizationId, ctx.organizationId))).for("update") : [];
  const current = (await scheduleTask(tx, ctx, required, options)).selected;
  if (!writer || !computer || !["windows", "win32"].includes(computer.os) || writer.computerId !== base.destination.node_id || writer.workspaceRoot !== root || writer.runtime === "mock"
    || canonical(current) !== canonical(selected) || own && (writer.id !== own.writerInstanceId || writer.agentId !== own.writerAgentId)
    || ctx.supportsExecutionFeature?.(computer.id, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1) !== true)
    throw AppError.conflict("Imported design needs its configured native Windows writer on the imported workspace");
  const uncertain = new Set(await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id }));
  const neighbors = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  if (neighbors.some(run => run.id !== own?.runId && (!['completed', 'failed', 'cancelled'].includes(run.status) || uncertain.has(run.id))
    && (run.agentInstanceId === writer.id || !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, root, computer.os))))
    throw AppError.conflict("Imported design writer or workspace already has another execution");
  if ((await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id })).some(operation => (operation.kind !== "design" || operation.id !== own?.id)
    && (operation.participantInstanceIds.includes(writer.id) || automationWorkspacesOverlap(operation.workspaceRoot, root, computer.os))))
    throw AppError.conflict("Imported design workspace has an unsettled source operation");
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId), eq(goalAutomations.computerId, computer.id)));
  if (reservations.some(reservation => reservation.goalId !== goal.id && ["planning", "executing", "waiting"].includes(reservation.status)
    && reservation.workspaceRoot && automationWorkspacesOverlap(reservation.workspaceRoot, root, computer.os)))
    throw AppError.conflict("Imported design workspace is reserved for another autonomous goal");
  if (!own) await assertExecutionApprovalGranted(ctx, tx, task.id);
  else {
    const gates = await tx.select().from(approvals).where(and(eq(approvals.taskId, task.id), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start")));
    const active = gates.filter(gate => gate.payloadRef !== EXECUTION_GATE_SUPERSEDED);
    if (gates.length && (active.length !== 1 || active[0]!.payloadRef !== EXECUTION_GATE_CURRENT || active[0]!.status !== "approved" || active[0]!.runId !== own.runId))
      throw AppError.conflict("Imported design execution approval changed");
  }
  const bytes = await researchBytes(ctx, request);
  inspectImportedProductReviewResultV1(request, result, bytes, sha);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
    throw AppError.conflict("Goal elapsed time budget has been reached");
  const [handoff] = await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, review.handoffId)).for("update");
  if (!handoff || handoff.stopRequested || !handoff.qualifiedReceipt) throw AppError.conflict("Imported handoff was stopped");
  assertMeasurementV2TransferSessions(ctx, request.operation.intent.request);
  return { review, request, result, goal, automation, task, plan, spec, writer, selected, root, bytes, expectedGoal };
}

export async function ensureGoalImportedDesignContinuation(ctx: ServerContext, tx: DrizzleDb, automation: Automation, reviewId: string) {
  originalActor(ctx, automation.actorUserId);
  const [existing] = await tx.select().from(continuations).where(and(eq(continuations.reviewId, reviewId), eq(continuations.organizationId, ctx.organizationId)));
  if (existing) {
    if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("Imported continuation belongs to another goal");
    return existing;
  }
  const value = await facts(ctx, tx, reviewId), { review, request: review_request, result: review_result, task, writer, selected, spec, root } = value;
  if (review.goalId !== automation.goalId || review.planId !== automation.planId) throw AppError.permissionDenied("Imported review belongs to another automation");
  const continuation_id = ctx.idGen.generate("imported_design"), runId = ctx.idGen.generate("run"), contextId = ctx.idGen.generate("context");
  const original = review_request.operation.intent.destination_start, source = review_request.operation.intent.request.byte_request.source;
  const descriptor = transferredProductInputV1({ continuation_id, review_request, review_result }, sha);
  const development = productDevelopmentContext("design", review_request.operation.intent.request.byte_request.destination.capabilities,
    review_request.operation.intent.request.measurement_v2?.destination_release);
  const requiredApproval = [...new Set([...original.policy_snapshot.requires_approval, "git.push", "external.post"])];
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, review_subject: undefined, imported_review_subject: undefined,
    conversation: undefined, review_feedback: undefined, transferred_product_input: descriptor,
    task: { id: task.id, title: task.title, description: task.description, acceptance_criteria: task.acceptanceCriteria },
    goal_context: { ...value.expectedGoal, plan: { ...value.expectedGoal.plan, spec_ref: task.sourcePlanSpecRef } },
    policy: { filesystem_write_scope: [root], requires_approval: requiredApproval },
    product_development: { ...development, instructions: [...development.instructions, IMPORTED_DESIGN_CONTEXT_INSTRUCTION_V1], accepted_inputs: { version: 1, files: [{
        ...review_request.operation.intent.request.source_export.research_provenance.research, source_task_id: source.task_id, source_run_id: source.run_id, evidence_id: source.evidence_id }] } },
    artifacts: { expected: spec.expected_artifacts.map(artifact => artifact.description ?? artifact.type) },
  });
  const { expected_subject_digest: _initialOnly, ...verification } = original.verification!;
  const request = ImportedDesignContinuationRequestV1Schema.parse({ version: 1, continuation_id, review_request, review_result,
    writer: { instance_id: writer.id, agent_id: writer.agentId }, run_start: { run_id: runId, task_id: task.id, agent_instance_id: writer.id, runtime: writer.runtime,
      workspace: { root, branch: null }, verification: { ...verification, request_id: ctx.idGen.generate("verify") }, context_pack: { id: contextId, payload: context },
      policy_snapshot: { filesystem_write_scope: [root], requires_approval: requiredApproval }, artifact_rules: { paths: [".artoo/product/**", "artifacts/**"] } } });
  inspectImportedDesignContinuationRequestV1(request, value.bytes, sha);
  const [lockedReview] = await tx.select().from(reviews).where(eq(reviews.id, review.id)).for("update");
  if (!lockedReview || lockedReview.stopRequested || canonical(lockedReview.result) !== canonical(review_result)) throw AppError.conflict("Imported review changed before its one-use writer reservation");
  const now = ctx.clock.nowIso();
  await transitionTask(tx, ctx, { taskId: task.id, from: "ready", trigger: "assign", now });
  await tx.insert(contextPacks).values({ id: contextId, organizationId: ctx.organizationId, taskId: task.id, runId, payload: context, createdAt: now });
  await tx.insert(runs).values({ id: runId, organizationId: ctx.organizationId, requestedByUserId: review.actorUserId,
    aiDataSharingConsentId: review.consentId, aiDataSharingPolicyVersion: review.policyVersion, taskId: task.id, computerId: writer.computerId,
    agentInstanceId: writer.id, runtimeId: writer.runtime, modelProfileId: selected.model_profile_id, effortProfileId: selected.effort_profile_id,
    status: "queued", contextPackId: contextId, workspaceRoot: root, workspaceBranch: null, verificationRequirement: request.run_start.verification, createdAt: now });
  await bindExecutionApprovalToRun(ctx, tx, task.id, runId);
  await tx.update(tasks).set({ assigneeType: "agent", assigneeId: writer.agentId, updatedAt: now }).where(eq(tasks.id, task.id));
  const [row] = await tx.insert(continuations).values({ id: continuation_id, reviewId, organizationId: ctx.organizationId, goalId: review.goalId, planId: review.planId,
    taskId: task.id, runId, contextPackId: contextId, writerInstanceId: writer.id, writerAgentId: writer.agentId, computerId: writer.computerId, workspaceRoot: root,
    actorUserId: review.actorUserId, consentId: review.consentId, policyVersion: review.policyVersion, requestDigest: importedDesignContinuationRequestDigestV1(request, sha), request, createdAt: now }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-design.created", actorType: "system", actorId: "goal_runner", correlationId: continuation_id,
    goalId: review.goalId, projectId: task.projectId, taskId: task.id, runId, payload: { continuation_id, imported_review_id: reviewId, actor_user_id: review.actorUserId, run_id: runId } }));
  return row!;
}

export async function stopGoalImportedDesignContinuations(ctx: ServerContext, goalId: string) {
  const ids = await ctx.db.transaction(async tx => {
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    const rows = await tx.select().from(continuations).where(and(eq(continuations.goalId, goalId), eq(continuations.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); await tx.update(continuations).set({ stopRequested: true }).where(eq(continuations.id, row.id)); }
    return rows.filter(row => !isClosed(row.result)).map(row => row.id);
  });
  for (const id of ids) await ctx.onImportedDesignContinuationQueued?.(id, "stop");
  return ids;
}

/** A real paired session owns delivery and result admission; serialized context alone grants nothing. */
export function createImportedDesignContinuationBinding(ctx: ServerContext, options: {
  identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send">;
}) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("Imported design node session is no longer current"); };
  async function credential(tx: DrizzleDb) {
    current();
    const [observed] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId)));
    if (!observed) throw AppError.permissionDenied("Imported design node is no longer paired");
    await requireActiveMember(ctx, observed.enrolledByUserId, tx);
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
    const [token] = await tx.select().from(deviceTokens).where(and(eq(deviceTokens.deviceId, identity.deviceId), eq(deviceTokens.organizationId, ctx.organizationId),
      eq(deviceTokens.tokenLookup, identity.tokenLookup), eq(deviceTokens.kind, "node"), eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
    current();
    if (!device || device.trust !== "active" || device.revokedAt !== null || device.computerId !== identity.computerId || device.enrolledByUserId !== observed.enrolledByUserId
      || !token || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso())) throw AppError.permissionDenied("Imported design node credential is no longer current");
  }
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(continuations).where(and(eq(continuations.id, id), eq(continuations.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("Imported continuation belongs to another node");
    return row;
  }
  async function startFence(tx: DrizzleDb, row: Continuation) {
    const value = await facts(actorContext(ctx, row), tx, row.reviewId, row), request = ImportedDesignContinuationRequestV1Schema.parse(row.request);
    await credential(tx);
    const [review] = await tx.select().from(reviews).where(eq(reviews.id, row.reviewId)).for("update");
    const [fresh] = await tx.select().from(continuations).where(eq(continuations.id, row.id)).for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, row.runId)).for("update");
    const [pack] = await tx.select().from(contextPacks).where(eq(contextPacks.id, row.contextPackId));
    if (!review || review.stopRequested || canonical(review.request) !== canonical(request.review_request) || canonical(review.result) !== canonical(request.review_result)
      || !fresh || fresh.stopRequested || fresh.result !== null || fresh.requestDigest !== importedDesignContinuationRequestDigestV1(request, sha)
      || !run || run.status !== "queued" || run.taskId !== row.taskId || run.agentInstanceId !== value.writer.id || run.computerId !== value.writer.computerId
      || run.runtimeId !== value.writer.runtime || run.modelProfileId !== value.selected.model_profile_id || run.effortProfileId !== value.selected.effort_profile_id
      || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
      || run.contextPackId !== row.contextPackId || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
      || !pack || pack.runId !== run.id || pack.taskId !== row.taskId || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload)
      || canonical(run.verificationRequirement) !== canonical(request.run_start.verification)
      || canonical(request.run_start.context_pack.payload.task) !== canonical({ id: value.task.id, title: value.task.title, description: value.task.description, acceptance_criteria: value.task.acceptanceCriteria })
      || canonical(request.run_start.context_pack.payload.goal_context) !== canonical({ ...value.expectedGoal, plan: { ...value.expectedGoal.plan, spec_ref: value.task.sourcePlanSpecRef } })
      || request.run_start.runtime !== value.writer.runtime) throw AppError.conflict("Imported design no longer matches its exact unused writer assignment");
    const prior = await tx.select().from(deliveries).where(and(eq(deliveries.continuationId, row.id), eq(deliveries.control, "start")));
    if (prior.some(delivery => delivery.sessionId !== options.sessionId)) throw AppError.conflict("Exposed imported design permits only dedicated status or stop in a new session");
    inspectImportedDesignContinuationRequestV1(request, value.bytes, sha);
    await credential(tx); assertMeasurementV2TransferSessions(ctx, request.review_request.operation.intent.request); current();
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
    current(); return fresh;
  }
  return {
    async requestStop(id: string) {
      await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        await tx.select().from(goals).where(eq(goals.id, row.goalId)).for("update");
        await credential(tx); await tx.update(continuations).set({ stopRequested: true }).where(eq(continuations.id, id));
      });
    },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        if (control === "start") await startFence(tx, row);
        else { await credential(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist imported design stop before sending it"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.continuationId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("design_delivery"), continuationId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.design.v1", payload: ImportedDesignContinuationRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.design.stop.v1" : "product.source.design.status.v1",
          payload: { version: 1, continuation_id: id, request_digest: record.row.requestDigest, run_id: record.row.runId } };
      await ctx.db.transaction(async tx => {
        const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await credential(tx);
        current(); await options.transport.send(command); current();
      });
      return command;
    },
    async acknowledge(input: ImportedDesignContinuationAck) {
      const ack = importedDesignContinuationAckSchema.parse(input); current();
      if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("Imported design ACK node differs");
      await ctx.db.transaction(async tx => {
        await credential(tx); const row = await load(tx, ack.payload.continuation_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.continuationId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || row.runId !== ack.payload.run_id) throw AppError.conflict("Imported design ACK has no matching delivery");
        if (delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("Imported design ACK is immutable");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id));
        await credential(tx);
      });
    },
    async receive(input: ImportedDesignContinuationResult) {
      const message = importedDesignContinuationResultSchema.parse(input); current();
      if (message.node_id !== identity.computerId) throw AppError.permissionDenied("Imported design result node differs");
      await ctx.db.transaction(async tx => {
        const initial = await load(tx, message.payload.continuation_id);
        // Admission/stop take goal -> task before credentials. Closure follows the same order,
        // including the pre-start cancellation path that updates the real queued task.
        await tx.select().from(goals).where(and(eq(goals.id, initial.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
        await tx.select().from(tasks).where(and(eq(tasks.id, initial.taskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
        await credential(tx); const row = await load(tx, message.payload.continuation_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.continuationId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("Imported design result has no matching issued command");
        const result = inspectImportedDesignContinuationResultV1(row.request, message.payload, sha);
        const [locked] = await tx.select().from(continuations).where(eq(continuations.id, row.id)).for("update");
        const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
        if (!run || run.computerId !== identity.computerId || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId) throw AppError.conflict("Imported design result lost its exact run");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("Imported design result is immutable");
        if (result.outcome === "finished" || result.outcome === "failed") {
          if (!["completed", "failed", "cancelled"].includes(run.status)) throw AppError.conflict("Imported design closure requires its ordered ordinary terminal event");
        } else if (result.outcome === "cancelled_before_start" && run.status !== "cancelled") {
          if (run.status !== "queued") throw AppError.conflict("A started design cannot be cancelled as never started");
          const now = ctx.clock.nowIso();
          await transitionRun(tx, actorContext(ctx, row), { runId: row.runId, from: "queued", trigger: "cancel", patch: { endedAt: now } });
          const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskId));
          if (task?.status === "assigned") await transitionTask(tx, actorContext(ctx, row), { taskId: row.taskId, from: "assigned", trigger: "cancel", now });
          await releaseRunLeases(ctx, tx, row.runId);
          await appendEvent(tx, buildEvent(ctx, { type: "run.cancelled", actorType: "system", actorId: identity.computerId, correlationId: row.id, runId: row.runId, taskId: row.taskId,
            goalId: row.goalId, projectId: task?.projectId, payload: { run_id: row.runId, continuation_id: row.id, cancelled_before_start: true, process_exit_confirmed: true } }));
        }
        if (result.outcome === "finished" && result.verified_design) {
          const completed = await inspectCompletedImportedDesign(ctx, tx, row, result);
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.continuationId, row.id), eq(deliveries.control, "start")));
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId) throw AppError.conflict("Verified completion requires its original author session");
          if (locked!.result === null) {
            await tx.update(continuations).set({ result }).where(eq(continuations.id, row.id));
            await tx.insert(goalImportedDesignCompletions).values({ continuationId: row.id, organizationId: ctx.organizationId, runId: row.runId,
              evidenceId: completed.evidence.id, contextPackId: row.contextPackId, deliveryId: delivery.id, sessionId: options.sessionId,
              resultDigest: hash(result), completedDesignDigest: hash(completed.completed), verifiedDesign: completed.completed, createdAt: ctx.clock.nowIso() });
          }
        } else if (locked!.result === null) await tx.update(continuations).set({ result }).where(eq(continuations.id, row.id));
        await credential(tx);
      });
      await ctx.db.transaction(async tx => {
        await credential(tx); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`, type: "product.source.design.receipt.v1",
          payload: { version: 1, continuation_id: message.payload.continuation_id, request_digest: message.payload.request_digest, run_id: message.payload.run_id }, result_digest: hash(message.payload), status: "accepted" }); current();
        // A failed send/transaction leaves this unset; replay may acknowledge only the same original session.
        await tx.update(goalImportedDesignCompletions).set({ receiptSentAt: ctx.clock.nowIso() }).where(and(
          eq(goalImportedDesignCompletions.continuationId, message.payload.continuation_id), eq(goalImportedDesignCompletions.organizationId, ctx.organizationId),
          eq(goalImportedDesignCompletions.sessionId, options.sessionId), eq(goalImportedDesignCompletions.resultDigest, hash(message.payload)), isNull(goalImportedDesignCompletions.receiptSentAt)));
      });
    },
    async inspect(id: string) { return ctx.db.transaction(async tx => { await credential(tx); return importedDesignContinuationView(await load(tx, id)); }); },
  };
}
