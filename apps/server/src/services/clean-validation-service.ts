import { approvals, appendEvent, contextPacks, eventLog, goalAutomations, goals, runs, tasks,
  goalCleanValidations as validations, goalCleanValidationDeliveries as deliveries,
  goalCleanValidationCompletions as completions, goalCleanValidationReceipts as receipts,
  goalCleanValidationReviews as reviews, productReleases } from "@artoo/db";
import { ContextPackSchema, ImportedCleanValidationRequestV1Schema, ImportedCleanValidationResultV1Schema,
  importedCleanValidationContextV1, importedCleanValidationRequestDigestV1, importedCleanValidationSourceDigestV1,
  inspectImportedCleanValidationRequestV1, inspectImportedCleanValidationResultV1, productDevelopmentContext,
  importedExecutionAcceptedInputsV1, canonicalProductSourceTransferValueV1 as canonical, type ImportedCleanValidationRequestV1, type ImportedCleanValidationResultV1 } from "@artoo/domain";
import { importedCleanValidationAckSchema, importedCleanValidationResultSchema, type ImportedCleanValidationAck, type ImportedCleanValidationResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { assertImportedImplementationActor as originalActor, importedImplementationActorContext as actorContext,
  assertImportedImplementationCredential as credential } from "./imported-execution-service.js";
import { readCleanValidationRoot, reserveValidationParticipants, validationTask, latestValidation, readValidationCompletion,
  readValidationSource, readValidationReview, requireValidationReceipt, type Validation, type ValidationRoot } from "./clean-validation-source-service.js";
import { assertExecutionApprovalGranted, bindExecutionApprovalToRun, EXECUTION_GATE_CURRENT, EXECUTION_GATE_SUPERSEDED } from "./approval-service.js";
import type { AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { transitionTask, transitionRun } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";

type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
const closed = (value: unknown) => ImportedCleanValidationResultV1Schema.safeParse(value).data?.closed === true;

async function predecessorFacts(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot, kind: "review" | "failure", id: string, own?: Validation) {
  const review = kind === "review" ? (await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, ctx.organizationId))))[0] : undefined;
  const [parent] = await tx.select().from(validations).where(and(eq(validations.id, kind === "failure" ? id : review?.validationId ?? ""), eq(validations.organizationId, ctx.organizationId)));
  if (!parent || parent.cleanGenerationId !== root.cleanGeneration.id || parent.originReviewId !== root.h6.id || own !== undefined && parent.taskId !== own.taskId) throw AppError.conflict("clean-restart repair predecessor differs from its original validation lineage");
  const measured = await readValidationSource(ctx, tx, parent, root, own?.id);
  let predecessor: NonNullable<ImportedCleanValidationRequestV1["predecessor"]>, feedback: unknown;
  if (kind === "review") {
    if (!review || review.stopRequested || review.acceptedAt) throw AppError.conflict("clean-restart repair needs an unconsumed rejected final-product review");
    const [current] = await tx.select().from(reviews).where(and(eq(reviews.validationId, parent.id), eq(reviews.organizationId, ctx.organizationId))).orderBy(desc(reviews.sequence)).limit(1);
    const inspected = await readValidationReview(ctx, tx, review, root, measured.source);
    if (current?.id !== review.id || inspected.result.outcome !== "reviewed" || inspected.result.verdict.outcome !== "rejected" || measured.source.outcome !== "verified") throw AppError.conflict("clean-restart repair requires the current substantive rejected review");
    predecessor = { kind: "review", review_id: review.id, request_digest: review.requestDigest, result_digest: review.resultDigest! };
    feedback = { review_id: review.id, summary: inspected.result.verdict.summary, findings: inspected.result.verdict.findings };
  } else {
    if (parent.readyKind !== "repair" || measured.source.outcome !== "closed-failure" || measured.result.outcome !== "failed" || !measured.result.closed_failure) throw AppError.conflict("clean-restart retry requires a typed closed source and original failure evidence");
    predecessor = { kind: "failure", validation_id: parent.id, request_digest: parent.requestDigest, result_digest: parent.resultDigest! };
    feedback = { validation_id: parent.id, failure_kind: measured.source.failure_kind, reason: measured.source.failure_reason };
  }
  return { parent, measured, predecessor, feedback };
}

/** Creation is one transaction. A subsequent author always consumes the original goal counter. */
async function createValidation(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot,
  previous?: Awaited<ReturnType<typeof predecessorFacts>>) {
  const [publication] = await tx.select({ id: productReleases.id }).from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, root.goal.id), eq(productReleases.status, "queued")));
  if (publication) throw AppError.conflict("Recovery validation requires actual settlement of every pending publication");
  const participants = await reserveValidationParticipants(ctx, tx, root), { task, spec, author, selected } = participants;
  if (!selected || (previous ? !["review", "blocked", "ready"].includes(task.status) : !["backlog", "ready", "blocked", "review", "done"].includes(task.status))) throw AppError.conflict("Validation task is not ready for this dedicated author");
  if (previous && previous.parent.taskId !== task.id) throw AppError.conflict("Validation repair changed its original task");
  await assertExecutionApprovalGranted(ctx, tx, task.id);
  if (root.budgets.max_retries !== null && root.goal.retryCount >= root.budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
  const id = ctx.idGen.generate("clean_validation"), runId = ctx.idGen.generate("run"), contextId = ctx.idGen.generate("context"), now = ctx.clock.nowIso();
  const attemptIndex = root.goal.retryCount + 1, source = previous?.measured.source ?? root.restart;
  const generation = previous ? previous.parent.generation + 1 : 0, rootId = previous?.parent.rootValidationId ?? id, kind = previous ? "repair" as const : "initial" as const;
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.clean-validation.authorized", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: root.goal.id, taskId: task.id, projectId: task.projectId, runId, payload: { validation_id: id, root_validation_id: rootId, generation, kind,
      origin_review_id: root.h6.id, actor_user_id: root.h6.actorUserId, predecessor: previous?.predecessor ?? null, source_digest: hash(source),
      attempt_index: attemptIndex, previous_retry_count: root.goal.retryCount, ...(previous ? { feedback: previous.feedback } : {}), publication_authorized: false } }));
  const fields = { version: 1 as const, validation_id: id, root_validation_id: rootId, generation, kind, origin: root.origin,
    clean_generation_id: root.cleanGeneration.id, restart: root.restart,
    ...(previous ? { previous_source: previous.measured.source, predecessor: previous.predecessor } : {}),
    authorization: { event_id: event.id, goal_id: root.goal.id, attempt_index: attemptIndex }, writer: { agent_id: author.agentId, instance_id: author.id } };
  const original = previous?.measured.request.run_start ?? root.origin.execution_request.run_start;
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, imported_execution: undefined, imported_execution_repair: undefined,
    imported_execution_review_subject: undefined, imported_validation_review_subject: undefined, imported_validation: undefined,
    imported_clean_validation_review_subject: undefined, imported_clean_validation: importedCleanValidationContextV1(fields, sha),
    conversation: undefined, review_feedback: previous ? { version: 1, entries: [{ event_id: event.id, position: event.position, task_id: task.id,
      actor: { type: "system", id: "goal_runner" }, occurred_at: event.occurredAt, comment: JSON.stringify(previous.feedback) }] } : undefined,
    task: { id: task.id, title: task.title, description: task.description, acceptance_criteria: task.acceptanceCriteria },
    goal_context: { ...original.context_pack.payload.goal_context!, plan: { ...original.context_pack.payload.goal_context!.plan!, spec_ref: task.sourcePlanSpecRef! } },
    product_development: { ...productDevelopmentContext("validation", original.context_pack.payload.verification_capabilities, original.context_pack.payload.release_capabilities),
      accepted_inputs: importedExecutionAcceptedInputsV1(root.origin.execution_request) }, artifacts: { expected: spec.expected_artifacts.map(item => item.description ?? item.type) } });
  const request = ImportedCleanValidationRequestV1Schema.parse({ ...fields, run_start: { ...original, run_id: runId, task_id: task.id, agent_instance_id: author.id, runtime: author.runtime,
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify") }, context_pack: { id: contextId, payload: context } } });
  inspectImportedCleanValidationRequestV1(request, root.bytes, sha);
  {
    const changed = await tx.update(goals).set({ retryCount: attemptIndex, updatedAt: now }).where(and(eq(goals.id, root.goal.id), eq(goals.retryCount, root.goal.retryCount))).returning({ id: goals.id });
    if (changed.length !== 1) throw AppError.conflict("Original retry counter changed");
  }
  if (task.status === "backlog") await transitionTask(tx, ctx, { taskId: task.id, from: "backlog", trigger: "triage", now });
  if (task.status === "review") await transitionTask(tx, ctx, { taskId: task.id, from: "review", trigger: "request_changes", now });
  if (task.status === "blocked") await transitionTask(tx, ctx, { taskId: task.id, from: "blocked", trigger: "retry", now });
  if (task.status === "done") await transitionTask(tx, ctx, { taskId: task.id, from: "done", trigger: "recovery_requested", now });
  const assigned = await transitionTask(tx, ctx, { taskId: task.id, from: "ready", trigger: "assign", now });
  if (!assigned.changed) throw AppError.conflict("clean-restart task assignment changed");
  await tx.insert(contextPacks).values({ id: contextId, organizationId: ctx.organizationId, taskId: task.id, runId, payload: context, createdAt: now });
  await tx.insert(runs).values({ id: runId, organizationId: ctx.organizationId, requestedByUserId: root.h6.actorUserId, aiDataSharingConsentId: root.h6.consentId,
    aiDataSharingPolicyVersion: root.h6.policyVersion, taskId: task.id, computerId: author.computerId, agentInstanceId: author.id, runtimeId: author.runtime,
    modelProfileId: selected.model_profile_id, effortProfileId: selected.effort_profile_id, status: "queued", contextPackId: contextId, workspaceRoot: root.h6.workspaceRoot,
    workspaceBranch: null, verificationRequirement: request.run_start.verification, createdAt: now });
  await bindExecutionApprovalToRun(ctx, tx, task.id, runId);
  await tx.update(tasks).set({ assigneeType: "agent", assigneeId: author.agentId, updatedAt: now }).where(eq(tasks.id, task.id));
  return (await tx.insert(validations).values({ id, cleanGenerationId: root.cleanGeneration.id, rootValidationId: rootId, originReviewId: root.h6.id, parentValidationId: previous?.parent.id ?? null, kind, generation,
    predecessorKind: previous?.predecessor.kind ?? "initial", predecessorId: previous ? previous.predecessor.kind === "review" ? previous.predecessor.review_id : previous.predecessor.validation_id : root.cleanGeneration.id,
    organizationId: ctx.organizationId, goalId: root.goal.id, planId: root.plan.id, taskId: task.id, runId, contextPackId: contextId, writerInstanceId: author.id, writerAgentId: author.agentId,
    computerId: author.computerId, workspaceRoot: root.h6.workspaceRoot, actorUserId: root.h6.actorUserId, consentId: root.h6.consentId, policyVersion: root.h6.policyVersion,
    authorizationEventId: event.id, attemptIndex, sessionBindings: root.sessionBindings, initialSourceDigest: hash(source), requestDigest: importedCleanValidationRequestDigestV1(request, sha), request, createdAt: now }).returning())[0]!;
}
export async function ensureGoalCleanValidation(ctx: ServerContext, tx: DrizzleDb, automation: Automation, cleanGenerationId: string) {
  originalActor(ctx, automation.actorUserId);
  await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [existing] = await tx.select().from(validations).where(and(eq(validations.cleanGenerationId, cleanGenerationId), eq(validations.kind, "initial"), eq(validations.organizationId, ctx.organizationId)));
  if (existing) { if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("clean-restart belongs to another automation"); return existing; }
  const root = await readCleanValidationRoot(ctx, tx, cleanGenerationId, { live: true });
  if (root.goal.id !== automation.goalId || root.plan.id !== automation.planId) throw AppError.permissionDenied("H6 origin belongs to another automation");
  return createValidation(ctx, tx, root);
}
export async function ensureGoalCleanValidationRepair(ctx: ServerContext, tx: DrizzleDb, automation: Automation, predecessorId: string, kind: "review" | "failure" = "review") {
  originalActor(ctx, automation.actorUserId);
  await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [existing] = await tx.select().from(validations).where(and(eq(validations.predecessorKind, kind), eq(validations.predecessorId, predecessorId), eq(validations.organizationId, ctx.organizationId)));
  if (existing) { if (existing.goalId !== automation.goalId || existing.planId !== automation.planId || existing.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("clean-restart repair belongs to another automation"); return existing; }
  const review = kind === "review" ? (await tx.select().from(reviews).where(and(eq(reviews.id, predecessorId), eq(reviews.organizationId, ctx.organizationId))))[0] : undefined;
  const [parent] = await tx.select().from(validations).where(and(eq(validations.id, kind === "failure" ? predecessorId : review?.validationId ?? ""), eq(validations.organizationId, ctx.organizationId)));
  if (!parent || parent.goalId !== automation.goalId || parent.planId !== automation.planId) throw AppError.permissionDenied("clean-restart predecessor belongs to another automation");
  const root = await readCleanValidationRoot(ctx, tx, parent.cleanGenerationId, { live: true });
  return createValidation(ctx, tx, root, await predecessorFacts(ctx, tx, root, kind, predecessorId));
}

export async function assertValidationAssignment(ctx: ServerContext, tx: DrizzleDb, row: Validation, start = false) {
  const root = await readCleanValidationRoot(ctx, tx, row.cleanGenerationId, { live: true }), request = inspectImportedCleanValidationRequestV1(row.request, root.bytes, sha);
  const latest = await latestValidation(ctx, tx, row.rootValidationId), { task } = validationTask(root, row.taskId);
  if (latest?.id !== row.id || row.stopRequested || request.validation_id !== row.id || request.root_validation_id !== row.rootValidationId || request.generation !== row.generation
    || request.kind !== row.kind || canonical(request.origin) !== canonical(root.origin) || row.requestDigest !== importedCleanValidationRequestDigestV1(request, sha)
    || row.cleanGenerationId !== root.cleanGeneration.id || request.clean_generation_id !== root.cleanGeneration.id || canonical(request.restart) !== canonical(root.restart)
    || row.initialSourceDigest !== hash(request.previous_source ?? request.restart) || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || row.goalId !== root.goal.id || row.planId !== root.plan.id || row.actorUserId !== root.h6.actorUserId || row.consentId !== root.h6.consentId || row.policyVersion !== root.h6.policyVersion
    || request.run_start.context_pack.payload.goal_context?.plan?.spec_ref !== task.sourcePlanSpecRef
    || canonical(request.run_start.context_pack.payload.task) !== canonical({ id: task.id, title: task.title, description: task.description, acceptance_criteria: task.acceptanceCriteria })) throw AppError.conflict("clean-restart assignment, source, task or session changed");
  if (row.kind === "repair") {
    const prior = await predecessorFacts(ctx, tx, root, row.predecessorKind as "review" | "failure", row.predecessorId, row);
    if (canonical(request.previous_source) !== canonical(prior.measured.source) || canonical(request.predecessor) !== canonical(prior.predecessor)) throw AppError.conflict("clean-restart repair predecessor changed");
  } else if (request.previous_source !== undefined) throw AppError.conflict("Initial recovery validation cannot borrow an older verified source");
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.authorizationEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (!event || event.type !== "goal.clean-validation.authorized" || event.actorType !== "system" || event.actorId !== "goal_runner" || event.goalId !== row.goalId || event.taskId !== row.taskId || event.runId !== row.runId
    || payload?.validation_id !== row.id || payload.source_digest !== row.initialSourceDigest || payload.actor_user_id !== row.actorUserId || payload.attempt_index !== row.attemptIndex
    || payload.previous_retry_count !== row.attemptIndex - 1 || root.goal.retryCount < row.attemptIndex
    || request.authorization.event_id !== event.id || request.authorization.attempt_index !== row.attemptIndex) throw AppError.conflict("clean-restart original goal authorization changed");
  const participants = await reserveValidationParticipants(ctx, tx, root, { validation: row, settled: row.result !== null });
  if (start && (task.status !== "assigned" || row.result !== null)) throw AppError.conflict("clean-restart author permits only status or stop after starting/settling");
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [pack] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, row.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)));
  if (!run || !pack || start && run.status !== "queued" || run.taskId !== row.taskId || run.contextPackId !== pack.id || pack.runId !== run.id || pack.taskId !== row.taskId
    || run.agentInstanceId !== row.writerInstanceId || run.computerId !== row.computerId || run.runtimeId !== participants.author.runtime
    || run.modelProfileId !== participants.selected!.model_profile_id || run.effortProfileId !== participants.selected!.effort_profile_id
    || run.requestedByUserId !== row.actorUserId || run.aiDataSharingConsentId !== row.consentId || run.aiDataSharingPolicyVersion !== row.policyVersion
    || run.workspaceRoot !== row.workspaceRoot || run.workspaceBranch !== null || run.workspaceAllocation !== null
    || canonical(run.verificationRequirement) !== canonical(request.run_start.verification) || canonical(pack.payload) !== canonical(request.run_start.context_pack.payload)) throw AppError.conflict("clean-restart actual writer binding changed");
  const gates = await tx.select().from(approvals).where(and(eq(approvals.taskId, row.taskId), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start")));
  const active = gates.filter(gate => gate.payloadRef !== EXECUTION_GATE_SUPERSEDED);
  if (gates.length && (active.length !== 1 || active[0]!.payloadRef !== EXECUTION_GATE_CURRENT || active[0]!.status !== "approved" || active[0]!.runId !== row.runId)) throw AppError.conflict("clean-restart execution approval changed");
  return { root, request, run, pack, ...participants };
}
export async function advanceGoalCleanValidation(ctx: ServerContext, tx: DrizzleDb, automation: Automation, validationId: string) {
  const [row] = await tx.select().from(validations).where(and(eq(validations.id, validationId), eq(validations.organizationId, ctx.organizationId)));
  if (!row || row.goalId !== automation.goalId || row.planId !== automation.planId) throw AppError.permissionDenied("Validation belongs to another goal");
  if (row.readyAt) return { validation: row, reason: row.readyKind === "review" ? "Final product is awaiting independent clean-restart review." : "Confirmed validation failure is ready for a bounded repair." };
  const result = ImportedCleanValidationResultV1Schema.safeParse(row.result).data;
  if (!result) { const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, row.runId));
    await ctx.onCleanValidationQueued?.(row.id, row.stopRequested ? "stop" : run?.status === "queued" ? "start" : "status"); return { validation: row, reason: "Waiting for validation author, final measurements and actual closure." }; }
  if (row.stopRequested || result.outcome !== "finished" && !(result.outcome === "failed" && result.closed_failure)) return { validation: row, reason: `Validation ${result.outcome}; no closed-source continuation is authorized.` };
  const value = await assertValidationAssignment(ctx, tx, row), measured = await readValidationCompletion(ctx, tx, row, value.root);
  const [proof] = await tx.select().from(completions).where(and(eq(completions.validationId, row.id), eq(completions.organizationId, ctx.organizationId)));
  await requireValidationReceipt(ctx, tx, row);
  if (!proof || proof.sourceDigest !== measured.sourceDigest || proof.resultDigest !== row.resultDigest || proof.completionDigest !== hash(measured.completion)
    || proof.sessionId !== value.root.sessionBindings.destination.sessionId || proof.deliveryId !== row.resultDeliveryId || proof.sessionId !== row.resultSessionId) throw AppError.conflict("clean-restart readiness lacks its original completion and receipt");
  const readyKind = result.outcome === "finished" ? "review" : "repair", now = ctx.clock.nowIso();
  if (readyKind === "review") {
    const changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "running", trigger: "run_completed", now });
    if (!changed.changed) throw AppError.conflict("clean-restart task is no longer running its completed validation");
  } else if (!["blocked", "ready"].includes(value.task.status)) throw AppError.conflict("Failed clean-restart task is not at its actual failure state");
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.clean-validation.ready", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: row.runId,
    payload: { validation_id: row.id, result_digest: row.resultDigest, source_digest: measured.sourceDigest, actor_user_id: row.actorUserId, ready_kind: readyKind,
      verification_evidence_id: measured.evidence?.id ?? null, publication_authorized: false } }));
  const [updated] = await tx.update(validations).set({ readyAt: now, readyEventId: event.id, readyKind }).where(eq(validations.id, row.id)).returning();
  return { validation: updated!, reason: readyKind === "review" ? "Final product is awaiting independent clean-restart review." : "Confirmed validation failure is ready for a bounded repair." };
}
export async function stopGoalCleanValidations(ctx: ServerContext, goalId: string) {
  const rows = await ctx.db.transaction(async tx => {
    const rows = await tx.select().from(validations).where(and(eq(validations.goalId, goalId), eq(validations.organizationId, ctx.organizationId)));
    for (const row of rows.filter(row => !closed(row.result))) await tx.update(validations).set({ stopRequested: true }).where(eq(validations.id, row.id));
    return rows.filter(row => !closed(row.result));
  });
  for (const row of rows) await ctx.onCleanValidationQueued?.(row.id, "stop");
}

export function createCleanValidationBinding(ctx: ServerContext, options: { identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send"> }) {
  const identity = Object.freeze({ ...options.identity }), current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("clean-restart node session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) { const [row] = await tx.select().from(validations).where(and(eq(validations.id, id), eq(validations.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("clean-restart author belongs to another node"); return row; }
  async function startFence(tx: DrizzleDb, row: Validation) {
    const value = await assertValidationAssignment(actorContext(ctx, row.actorUserId), tx, row, true); await qualify(tx);
    if (canonical(value.root.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("clean-restart author belongs to its original destination session");
    const starts = await tx.select().from(deliveries).where(and(eq(deliveries.validationId, row.id), eq(deliveries.control, "start")));
    if (starts.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("clean-restart author cannot restart in a new session"); return value;
  }
  return {
    async requestStop(id: string) { await ctx.db.transaction(async tx => { const row = await load(tx, id); await qualify(tx); await tx.update(validations).set({ stopRequested: true }).where(eq(validations.id, row.id)); }); },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id); if (control === "start") await startFence(tx, row); else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist clean-restart stop before sending"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.validationId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("validation_delivery"), validationId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.clean-validation.v1", payload: ImportedCleanValidationRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.clean-validation.stop.v1" : "product.source.clean-validation.status.v1", payload: { version: 1, validation_id: id, request_digest: record.row.requestDigest, run_id: record.row.runId } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx); current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedCleanValidationAck) {
      const ack = importedCleanValidationAckSchema.parse(input); current(); if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("clean-restart ACK node differs");
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, ack.payload.validation_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.validationId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || ack.payload.request_digest !== row.requestDigest || ack.payload.run_id !== row.runId || delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("clean-restart ACK lacks its exact immutable issuing delivery");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id)); await qualify(tx); });
    },
    async receive(input: ImportedCleanValidationResult) {
      const message = importedCleanValidationResultSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("clean-restart result node differs");
      await ctx.db.transaction(async tx => {
        const row = await load(tx, message.payload.validation_id); await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId))).for("update"); await qualify(tx);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.validationId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("clean-restart result has no exact issuing delivery");
        // Every reception rereads the origin and research bytes. Typed completion
        // inspection happens once below, inside the full persisted-fact check.
        const root = await readCleanValidationRoot(ctx, tx, row.cleanGenerationId);
        const typed = message.payload.outcome === "finished" || message.payload.outcome === "failed" && message.payload.closed_failure;
        let result: ImportedCleanValidationResultV1;
        let measured: Awaited<ReturnType<typeof readValidationCompletion>> | undefined;
        if (typed) {
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.validationId, row.id), eq(deliveries.control, "start")));
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId || canonical(root.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("clean-restart typed completion requires its original paired start");
          measured = await readValidationCompletion(ctx, tx, row, root, message.payload);
          result = measured.result;
        } else result = inspectImportedCleanValidationResultV1(row.request, message.payload, root.bytes, sha);
        if (!typed && result.closed) {
          const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId))).for("update");
          if (!run) throw AppError.conflict("clean-restart closure lost its actual run");
          if (result.outcome === "cancelled_before_start") {
            if (run.status !== "queued" && run.status !== "cancelled") throw AppError.conflict("A started clean-restart author cannot be reported unstarted");
            if (run.status === "queued") {
              const now = ctx.clock.nowIso(); await transitionRun(tx, ctx, { runId: run.id, from: "queued", trigger: "cancel", patch: { endedAt: now } });
              const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, row.taskId), eq(tasks.organizationId, ctx.organizationId)));
              if (task?.status === "assigned") await transitionTask(tx, ctx, { taskId: task.id, from: "assigned", trigger: "cancel", now });
              await releaseRunLeases(ctx, tx, run.id); await appendEvent(tx, buildEvent(ctx, { type: "run.cancelled", actorType: "system", actorId: identity.computerId, correlationId: row.id,
                runId: run.id, taskId: row.taskId, goalId: row.goalId, payload: { validation_id: row.id, process_exit_confirmed: true, before_start: true } }));
            }
          }
          else if (!["completed", "failed", "cancelled"].includes(run.status)) throw AppError.conflict("clean-restart closure awaits its ordered actual terminal event");
        }
        const [locked] = await tx.select().from(validations).where(eq(validations.id, row.id)).for("update");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("clean-restart result is immutable");
        if (locked!.result === null) {
          const resultDigest = measured?.resultDigest ?? hash(result);
          await tx.update(validations).set({ result, resultDigest, resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(validations.id, row.id));
          if (measured) await tx.insert(completions).values({ validationId: row.id, organizationId: ctx.organizationId, runId: row.runId, contextPackId: row.contextPackId,
            evidenceId: measured.evidence?.id ?? null, deliveryId: delivery.id, sessionId: options.sessionId, outcome: measured.source.outcome, resultDigest, completionDigest: hash(measured.completion),
            completion: measured.completion, sourceDigest: measured.sourceDigest, source: measured.source, createdAt: ctx.clock.nowIso() });
        }
        await qualify(tx);
      });
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, message.payload.validation_id);
        await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`, type: "product.source.clean-validation.receipt.v1",
          payload: { version: 1, validation_id: row.id, request_digest: row.requestDigest, run_id: row.runId }, result_digest: hash(message.payload), status: "accepted" }); current();
        if (message.payload.outcome === "finished" || message.payload.outcome === "failed" && message.payload.closed_failure) await tx.insert(receipts).values({ validationId: row.id, organizationId: ctx.organizationId,
          deliveryId: row.resultDeliveryId!, sessionId: options.sessionId, sessionBindings: row.sessionBindings, requestDigest: row.requestDigest, resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
      });
    },
  };
}
