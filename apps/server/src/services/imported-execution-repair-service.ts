import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { approvals, appendEvent, contextPacks, eventLog, goalAutomations, goals, runs, tasks,
  goalImportedExecutionReviews as reviews, goalImportedExecutionRepairs as repairs, goalImportedExecutionRepairDeliveries as deliveries,
  goalImportedExecutionRepairCompletions as completions, goalImportedExecutionRepairReceipts as receipts } from "@artoo/db";
import { ContextPackSchema, ImportedExecutionRepairRequestV1Schema, ImportedExecutionRepairResultV1Schema, ImportedExecutionReviewRequestV1Schema,
  ImportedExecutionReviewResultV1Schema, importedExecutionRepairContextV1, importedExecutionRepairRequestDigestV1,
  inspectImportedExecutionRepairRequestV1, inspectImportedExecutionRepairResultV1, inspectImportedExecutionReviewResultV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { importedExecutionRepairAckSchema, importedExecutionRepairResultSchema, type ImportedExecutionRepairAck, type ImportedExecutionRepairResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { readImportedExecutionRootFacts, assertImportedImplementationActor as originalActor, importedImplementationActorContext as actorContext,
  assertImportedImplementationCredential as credential, readImportedImplementationResearch as researchBytes } from "./imported-execution-service.js";
import { readImportedImplementationSource, reserveImportedImplementationParticipants, inspectImportedRepairCompletion as inspectCompletion, type Repair } from "./imported-implementation-source-service.js";
import { requireImportedImplementationReviewReceipt } from "./imported-execution-review-service.js";
import { assertExecutionApprovalGranted, bindExecutionApprovalToRun, EXECUTION_GATE_CURRENT, EXECUTION_GATE_SUPERSEDED } from "./approval-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";

type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
const closed = (input: unknown) => ImportedExecutionRepairResultV1Schema.safeParse(input).data?.closed === true;

async function facts(ctx: ServerContext, tx: DrizzleDb, reviewId: string, own?: Repair, completion = false) {
  const [initial] = await tx.select().from(reviews).where(and(eq(reviews.id, reviewId), eq(reviews.organizationId, ctx.organizationId)));
  if (!initial) throw AppError.notFound("Implementation review not found");
  originalActor(ctx, initial.actorUserId);
  const root = await readImportedExecutionRootFacts(ctx, tx, initial.baseExecutionId);
  const [review] = await tx.select().from(reviews).where(eq(reviews.id, reviewId)).for("update");
  if (!review || canonical(review) !== canonical(initial) || review.stopRequested || review.acceptedAt || own?.stopRequested
    || !(own ? completion ? ["running", "review"] : ["assigned"] : ["review"]).includes(root.task.status))
    throw AppError.conflict("Repair requires its original unconsumed rejected review and exact task state");
  const request = ImportedExecutionReviewRequestV1Schema.parse(review.request), result = ImportedExecutionReviewResultV1Schema.parse(review.result);
  if (result.outcome !== "reviewed" || result.verdict.outcome !== "rejected" || review.resultDigest !== hash(result)) throw AppError.conflict("Repair requires a substantive rejected implementation review");
  const sourceValue = await readImportedImplementationSource(ctx, tx, root, { kind: review.sourceKind, operationId: review.sourceOperationId }, own);
  inspectImportedExecutionReviewResultV1(request, result, root.bytes, sha);
  if (canonical(request.source) !== canonical(sourceValue.source) || canonical(request.execution_request) !== canonical(sourceValue.executionRequest)
    || review.sourceDigest !== sourceValue.sourceDigest || canonical(review.sessionBindings) !== canonical(root.sessionBindings)) throw AppError.conflict("Repair source/review changed");
  await requireImportedImplementationReviewReceipt(ctx, tx, review);
  const participants = await reserveImportedImplementationParticipants(ctx, tx, root, sourceValue.source, { repair: own, repairAdmission: true, settled: completion });
  if (!own) {
    if (participants.budgets.max_retries !== null && root.goal.retryCount >= participants.budgets.max_retries)
      throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
    await assertExecutionApprovalGranted(ctx, tx, root.task.id);
  } else {
    const authorization = ImportedExecutionRepairRequestV1Schema.parse(own.request).authorization;
    const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, own.authorizationEventId), eq(eventLog.organizationId, ctx.organizationId)));
    const payload = event?.payload as Record<string, unknown> | undefined;
    if (own.baseExecutionId !== root.execution.id || own.reviewId !== review.id || own.goalId !== root.goal.id || own.planId !== root.plan.id
      || own.taskId !== root.task.id || own.writerInstanceId !== participants.author.id || own.writerAgentId !== participants.author.agentId
      || own.actorUserId !== review.actorUserId || own.consentId !== review.consentId || own.policyVersion !== review.policyVersion
      || canonical(own.sessionBindings) !== canonical(root.sessionBindings) || root.goal.retryCount < own.attemptIndex
      || authorization.event_id !== own.authorizationEventId || authorization.goal_id !== root.goal.id || authorization.attempt_index !== own.attemptIndex
      || !event || event.type !== "goal.imported-execution-repair.authorized" || event.actorType !== "system" || event.actorId !== "goal_runner"
      || event.goalId !== root.goal.id || event.taskId !== root.task.id || event.runId !== own.runId
      || payload?.repair_id !== own.id || payload.review_id !== review.id || payload.review_result_digest !== review.resultDigest
      || payload.actor_user_id !== own.actorUserId || payload.attempt_index !== own.attemptIndex || payload.previous_retry_count !== own.attemptIndex - 1)
      throw AppError.conflict("Repair lost its independent original-goal authorization");
    const gates = await tx.select().from(approvals).where(and(eq(approvals.taskId, root.task.id), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start")));
    const active = gates.filter(gate => gate.payloadRef !== EXECUTION_GATE_SUPERSEDED);
    if (gates.length && (active.length !== 1 || active[0]!.payloadRef !== EXECUTION_GATE_CURRENT || active[0]!.status !== "approved" || active[0]!.runId !== own.runId))
      throw AppError.conflict("Repair execution approval changed");
  }
  return { ...root, ...participants, review, reviewRequest: request, reviewResult: result, sourceValue };
}

export async function ensureGoalImportedExecutionRepair(ctx: ServerContext, tx: DrizzleDb, automation: Automation, reviewId: string) {
  originalActor(ctx, automation.actorUserId);
  // Lock and re-read before checking or consuming retryCount: duplicate decisions spend once.
  await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [existing] = await tx.select().from(repairs).where(and(eq(repairs.reviewId, reviewId), eq(repairs.organizationId, ctx.organizationId)));
  if (existing) {
    if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("Repair belongs to another automation");
    return existing;
  }
  const value = await facts(ctx, tx, reviewId), { review, task, author: writer, goal } = value;
  if (goal.id !== automation.goalId || value.plan.id !== automation.planId) throw AppError.permissionDenied("Rejected review belongs to another automation");
  const repair_id = ctx.idGen.generate("execution_repair"), runId = ctx.idGen.generate("run"), contextId = ctx.idGen.generate("context"), now = ctx.clock.nowIso();
  const attemptIndex = goal.retryCount + 1;
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-execution-repair.authorized", actorType: "system", actorId: "goal_runner", correlationId: repair_id,
    goalId: goal.id, taskId: task.id, projectId: task.projectId, runId, payload: { repair_id, review_id: review.id,
      base_execution_id: value.execution.id, actor_user_id: review.actorUserId, review_request_digest: review.requestDigest,
      review_result_digest: review.resultDigest, source_digest: review.sourceDigest, attempt_index: attemptIndex, previous_retry_count: goal.retryCount,
      summary: value.reviewResult.verdict.summary, findings: value.reviewResult.verdict.findings, subsequent_stage_authorized: false } }));
  const binding = { version: 1 as const, repair_id, execution_request: value.sourceValue.executionRequest, source: value.sourceValue.source,
    review_id: review.id, review_request_digest: review.requestDigest, review_result_digest: review.resultDigest!,
    authorization: { event_id: event.id, goal_id: goal.id, attempt_index: attemptIndex }, writer: { instance_id: writer.id, agent_id: writer.agentId } };
  const original = value.sourceValue.executionRequest.run_start;
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, imported_execution: undefined,
    imported_execution_repair: importedExecutionRepairContextV1(binding),
    review_feedback: { version: 1, entries: [{ event_id: event.id, position: event.position, task_id: task.id, actor: { type: "system", id: "goal_runner" },
      occurred_at: event.occurredAt, comment: JSON.stringify({ review_id: review.id, summary: value.reviewResult.verdict.summary, findings: value.reviewResult.verdict.findings }) }] } });
  const request = ImportedExecutionRepairRequestV1Schema.parse({ ...binding, run_start: { ...original, run_id: runId, agent_instance_id: writer.id, runtime: writer.runtime,
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify") }, context_pack: { id: contextId, payload: context } } });
  inspectImportedExecutionRepairRequestV1(request, value.bytes, sha);
  const changed = await tx.update(goals).set({ retryCount: attemptIndex, updatedAt: now }).where(and(eq(goals.id, goal.id), eq(goals.retryCount, goal.retryCount))).returning({ id: goals.id });
  if (changed.length !== 1) throw AppError.conflict("Original goal retry counter changed");
  const ready = await transitionTask(tx, ctx, { taskId: task.id, from: "review", trigger: "request_changes", now });
  if (!ready.changed) throw AppError.conflict("Implementation review is no longer repairable");
  const assigned = await transitionTask(tx, ctx, { taskId: task.id, from: "ready", trigger: "assign", now });
  if (!assigned.changed) throw AppError.conflict("Repair assignment changed");
  await tx.insert(contextPacks).values({ id: contextId, organizationId: ctx.organizationId, taskId: task.id, runId, payload: context, createdAt: now });
  await tx.insert(runs).values({ id: runId, organizationId: ctx.organizationId, requestedByUserId: review.actorUserId, aiDataSharingConsentId: review.consentId,
    aiDataSharingPolicyVersion: review.policyVersion, taskId: task.id, computerId: writer.computerId, agentInstanceId: writer.id, runtimeId: writer.runtime,
    modelProfileId: value.selected!.model_profile_id, effortProfileId: value.selected!.effort_profile_id, status: "queued", contextPackId: contextId,
    workspaceRoot: value.execution.workspaceRoot, workspaceBranch: null, verificationRequirement: request.run_start.verification, createdAt: now });
  await bindExecutionApprovalToRun(ctx, tx, task.id, runId);
  await tx.update(tasks).set({ assigneeType: "agent", assigneeId: writer.agentId, updatedAt: now }).where(eq(tasks.id, task.id));
  const [row] = await tx.insert(repairs).values({ id: repair_id, reviewId, baseExecutionId: value.execution.id, organizationId: ctx.organizationId, goalId: goal.id,
    planId: value.plan.id, taskId: task.id, runId, contextPackId: contextId, writerInstanceId: writer.id, writerAgentId: writer.agentId, computerId: writer.computerId,
    workspaceRoot: value.execution.workspaceRoot, actorUserId: review.actorUserId, consentId: review.consentId, policyVersion: review.policyVersion,
    authorizationEventId: event.id, attemptIndex, sessionBindings: value.sessionBindings, requestDigest: importedExecutionRepairRequestDigestV1(request, sha), request, createdAt: now }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: repair_id, goalId: goal.id,
    taskId: task.id, projectId: task.projectId, roomId: task.roomId, runId, payload: { status: "assigned", imported_execution_repair_id: repair_id, assignee_type: "agent", assignee_id: writer.agentId } }));
  return row!;
}

export async function advanceGoalImportedExecutionRepair(ctx: ServerContext, tx: DrizzleDb, automation: Automation, reviewId: string) {
  const row = await ensureGoalImportedExecutionRepair(ctx, tx, automation, reviewId), result = ImportedExecutionRepairResultV1Schema.safeParse(row.result).data;
  if (row.reviewReadyAt) return { repair: row, reason: "Repaired implementation awaits a fresh independent H6 review." };
  if (!result) { await ctx.onImportedExecutionRepairQueued?.(row.id, row.stopRequested ? "stop" : "start"); return { repair: row, reason: "Waiting for the separately authorized repair and confirmed closure." }; }
  if (row.stopRequested || result.outcome !== "finished" || !result.verified_repair) return { repair: row, reason: `Repair ${result.outcome}; another review or write permit remains fenced.` };
  const value = await facts(ctx, tx, reviewId, row, true), completed = await inspectCompletion(ctx, tx, row, result);
  const [proof] = await tx.select().from(completions).where(and(eq(completions.repairId, row.id), eq(completions.organizationId, ctx.organizationId)));
  const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.repairId, row.id), eq(receipts.organizationId, ctx.organizationId)));
  const [fresh] = await tx.select().from(repairs).where(eq(repairs.id, row.id)).for("update");
  if (!fresh || fresh.stopRequested || fresh.reviewReadyAt || canonical(fresh.result) !== canonical(result) || fresh.resultDigest !== hash(result)
    || !proof || proof.evidenceId !== completed.evidence.id || proof.resultDigest !== fresh.resultDigest || proof.completedRepairDigest !== hash(completed.completed)
    || proof.sessionId !== value.sessionBindings.destination.sessionId || proof.deliveryId !== fresh.resultDeliveryId || proof.sessionId !== fresh.resultSessionId
    || !receipt || receipt.deliveryId !== proof.deliveryId || receipt.sessionId !== proof.sessionId || receipt.requestDigest !== row.requestDigest
    || receipt.resultDigest !== fresh.resultDigest || canonical(receipt.sessionBindings) !== canonical(value.sessionBindings)) throw AppError.conflict("Repair review readiness provenance changed");
  const now = ctx.clock.nowIso();
  const changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "running", trigger: "run_completed", now,
    events: status => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: row.id,
      goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, roomId: value.task.roomId, payload: { status, imported_execution_repair_id: row.id } })] });
  if (!changed.changed) throw AppError.conflict("Repair task is no longer awaiting verified completion");
  const event = buildEvent(ctx, { type: "goal.imported-execution-repair.review-ready", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: row.runId,
    payload: { repair_id: row.id, result_digest: fresh.resultDigest, actor_user_id: row.actorUserId, verification_evidence_id: proof.evidenceId, subsequent_stage_authorized: false } });
  await appendEvent(tx, event); await tx.update(repairs).set({ reviewReadyAt: now, reviewReadyEventId: event.id }).where(eq(repairs.id, row.id));
  return { repair: { ...row, reviewReadyAt: now, reviewReadyEventId: event.id }, reason: "Repaired implementation awaits a fresh independent H6 review." };
}

export async function stopGoalImportedExecutionRepairs(ctx: ServerContext, goalId: string) {
  const rows = await ctx.db.transaction(async tx => {
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    const rows = await tx.select().from(repairs).where(and(eq(repairs.goalId, goalId), eq(repairs.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); if (!closed(row.result)) await tx.update(repairs).set({ stopRequested: true }).where(eq(repairs.id, row.id)); }
    return rows.filter(row => !closed(row.result));
  });
  for (const row of rows) await ctx.onImportedExecutionRepairQueued?.(row.id, "stop");
}

export function createImportedExecutionRepairBinding(ctx: ServerContext, options: { identity: AuthenticatedTransferNode; sessionId: string; transport: NodeTransport; isCurrent: () => boolean }) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("H6 repair node session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(repairs).where(and(eq(repairs.id, id), eq(repairs.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("H6 repair belongs to another node"); return row;
  }
  async function startFence(tx: DrizzleDb, row: Repair) {
    const value = await facts(actorContext(ctx, row.actorUserId), tx, row.reviewId, row), request = ImportedExecutionRepairRequestV1Schema.parse(row.request);
    await qualify(tx);
    const [fresh] = await tx.select().from(repairs).where(eq(repairs.id, row.id)).for("update");
    const [run] = await tx.select().from(runs).where(eq(runs.id, row.runId)).for("update");
    const [pack] = await tx.select().from(contextPacks).where(eq(contextPacks.id, row.contextPackId));
    if (!fresh || fresh.stopRequested || fresh.result !== null || canonical(fresh) !== canonical(row) || row.requestDigest !== importedExecutionRepairRequestDigestV1(request, sha)
      || canonical(request.execution_request) !== canonical(value.sourceValue.executionRequest) || canonical(request.source) !== canonical(value.sourceValue.source)
      || request.review_request_digest !== value.review.requestDigest || request.review_result_digest !== value.review.resultDigest
      || request.authorization.event_id !== row.authorizationEventId || request.authorization.attempt_index !== row.attemptIndex
      || canonical(value.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })
      || !run || run.status !== "queued" || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId
      || run.runtimeId !== value.author.runtime || run.modelProfileId !== value.selected!.model_profile_id || run.effortProfileId !== value.selected!.effort_profile_id
      || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
      || run.contextPackId !== row.contextPackId || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
      || !pack || pack.runId !== row.runId || pack.taskId !== row.taskId || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload)
      || canonical(run.verificationRequirement) !== canonical(request.run_start.verification)) throw AppError.conflict("H6 repair unused writer binding changed");
    const starts = await tx.select().from(deliveries).where(and(eq(deliveries.repairId, row.id), eq(deliveries.control, "start")));
    if (starts.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("Exposed H6 repair cannot restart in another session");
    inspectImportedExecutionRepairRequestV1(request, value.bytes, sha); current();
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
  }
  return {
    async requestStop(id: string) { await ctx.db.transaction(async tx => { const row = await load(tx, id);
      await tx.select().from(goals).where(eq(goals.id, row.goalId)).for("update"); await qualify(tx);
      await tx.update(repairs).set({ stopRequested: true }).where(eq(repairs.id, id)); }); },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id); if (control === "start") await startFence(tx, row); else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist H6 repair stop before sending it"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.repairId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("repair_delivery"), repairId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.execution-repair.v1", payload: ImportedExecutionRepairRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.execution-repair.stop.v1" : "product.source.execution-repair.status.v1", payload: { version: 1, repair_id: id, request_digest: record.row.requestDigest, run_id: record.row.runId } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx); current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedExecutionRepairAck) {
      const ack = importedExecutionRepairAckSchema.parse(input); current(); if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("H6 repair ACK node differs");
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, ack.payload.repair_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.repairId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || row.runId !== ack.payload.run_id) throw AppError.conflict("H6 repair ACK lacks exact issued delivery");
        if (delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("H6 repair ACK is immutable");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id)); await qualify(tx); });
    },
    async receive(input: ImportedExecutionRepairResult) {
      const message = importedExecutionRepairResultSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("H6 repair result node differs");
      await ctx.db.transaction(async tx => {
        const initial = await load(tx, message.payload.repair_id);
        await tx.select().from(goals).where(and(eq(goals.id, initial.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
        await tx.select().from(tasks).where(and(eq(tasks.id, initial.taskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
        await qualify(tx); const row = await load(tx, initial.id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.repairId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("H6 repair result lacks its issued command");
        const request = ImportedExecutionRepairRequestV1Schema.parse(row.request), result = inspectImportedExecutionRepairResultV1(request, message.payload, await researchBytes(ctx, request.execution_request.review_request), sha);
        const [locked] = await tx.select().from(repairs).where(eq(repairs.id, row.id)).for("update");
        const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
        if (!run || run.computerId !== identity.computerId || run.taskId !== row.taskId || run.agentInstanceId !== row.writerInstanceId) throw AppError.conflict("H6 repair result lost its real run");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("H6 repair result is immutable");
        if (result.outcome === "finished" || result.outcome === "failed") {
          if (!["completed", "failed", "cancelled"].includes(run.status)) throw AppError.conflict("H6 repair closure requires committed ordered terminal events");
        } else if (result.outcome === "cancelled_before_start" && run.status !== "cancelled") {
          if (run.status !== "queued") throw AppError.conflict("A started H6 repair cannot be reported unstarted");
          const now = ctx.clock.nowIso(); await transitionRun(tx, actorContext(ctx, row.actorUserId), { runId: row.runId, from: "queued", trigger: "cancel", patch: { endedAt: now } });
          const [task] = await tx.select().from(tasks).where(eq(tasks.id, row.taskId));
          if (task?.status === "assigned") await transitionTask(tx, actorContext(ctx, row.actorUserId), { taskId: row.taskId, from: "assigned", trigger: "cancel", now });
          await releaseRunLeases(ctx, tx, row.runId);
          await appendEvent(tx, buildEvent(ctx, { type: "run.cancelled", actorType: "system", actorId: identity.computerId, correlationId: row.id, runId: row.runId,
            taskId: row.taskId, goalId: row.goalId, projectId: task?.projectId, payload: { run_id: row.runId, repair_id: row.id, cancelled_before_start: true, process_exit_confirmed: true } }));
        }
        let verified: Awaited<ReturnType<typeof inspectCompletion>> | undefined;
        if (result.outcome === "finished" && result.verified_repair) {
          verified = await inspectCompletion(ctx, tx, row, result);
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.repairId, row.id), eq(deliveries.control, "start")));
          const bindings = row.sessionBindings as { destination: AuthenticatedTransferNode & { sessionId: string } };
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId || canonical(bindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H6 repair verified completion requires its original session");
        }
        if (locked!.result === null) {
          await tx.update(repairs).set({ result, resultDigest: hash(result), resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(repairs.id, row.id));
          if (verified) await tx.insert(completions).values({ repairId: row.id, organizationId: ctx.organizationId, runId: row.runId, evidenceId: verified.evidence.id,
            contextPackId: row.contextPackId, deliveryId: delivery.id, sessionId: options.sessionId, resultDigest: hash(result), completedRepairDigest: hash(verified.completed), verifiedRepair: verified.completed, createdAt: ctx.clock.nowIso() });
        }
        await qualify(tx);
      });
      await ctx.db.transaction(async tx => { await qualify(tx); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`,
        type: "product.source.execution-repair.receipt.v1", payload: { version: 1, repair_id: message.payload.repair_id, request_digest: message.payload.request_digest, run_id: message.payload.run_id }, result_digest: hash(message.payload), status: "accepted" }); current();
        if (message.payload.outcome === "finished" && message.payload.verified_repair) {
          const row = await load(tx, message.payload.repair_id);
          await tx.insert(receipts).values({ repairId: row.id, organizationId: ctx.organizationId, deliveryId: row.resultDeliveryId!,
            sessionId: options.sessionId, sessionBindings: row.sessionBindings, requestDigest: row.requestDigest,
            resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
        }
      });
    },
  };
}
