import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { appendEvent, goals, goalAutomations, goalImportedExecutionReviews as reviews, goalImportedExecutionReviewDeliveries as deliveries,
  goalImportedExecutionReviewReceipts as receipts } from "@artoo/db";
import { ContextPackSchema, RunStartPayloadSchema, ImportedExecutionReviewRequestV1Schema, ImportedExecutionReviewResultV1Schema,
  importedExecutionReviewSubjectV1, importedExecutionReviewRequestDigestV1, inspectImportedExecutionReviewRequestV1, inspectImportedExecutionReviewResultV1,
  canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { importedExecutionReviewAckSchema, importedExecutionReviewResultSchema, type ImportedExecutionReviewAck, type ImportedExecutionReviewResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { transitionTask } from "./transition-service.js";
import { type AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { readImportedExecutionRootFacts, assertImportedImplementationActor as originalActor,
  importedImplementationActorContext as actorContext, assertImportedImplementationCredential as credential,
  readImportedImplementationResearch as researchBytes } from "./imported-execution-service.js";
import { readImportedImplementationSource, reserveImportedImplementationParticipants, type Repair } from "./imported-implementation-source-service.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";

export type ImplementationReview = typeof reviews.$inferSelect;
type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
export function importedImplementationSessions(ctx: ServerContext, input: ReturnType<typeof ImportedExecutionReviewRequestV1Schema.parse>["execution_request"]) {
  const base = input.review_request.continuation_request.review_request.operation.intent.request.byte_request;
  const source = ctx.getPairedNodeSession?.(base.source.node_id), destination = ctx.getPairedNodeSession?.(base.destination.node_id);
  if (!source || !destination) throw AppError.conflict("H6 requires both original paired sessions");
  return { source, destination };
}

export async function readImportedImplementationReviewFacts(ctx: ServerContext, tx: DrizzleDb, executionId: string, own?: ImplementationReview,
  repair?: Repair) {
  const root = await readImportedExecutionRootFacts(ctx, tx, executionId);
  if (!repair && root.task.status !== (own?.acceptedAt ? "done" : "review")) throw AppError.conflict("H6 requires the exact implementation awaiting review");
  const sourceValue = await readImportedImplementationSource(ctx, tx, root, own ? { kind: own.sourceKind, operationId: own.sourceOperationId } : undefined, repair);
  if (own && (own.stopRequested || own.goalId !== root.goal.id || own.planId !== root.plan.id || own.taskId !== root.task.id
    || own.actorUserId !== root.execution.actorUserId || own.sourceDigest !== sourceValue.sourceDigest
    || canonical(own.sessionBindings) !== canonical(root.sessionBindings))) throw AppError.conflict("H6 review ownership/source/session changed");
  const participants = await reserveImportedImplementationParticipants(ctx, tx, root, sourceValue.source,
    { reviewerId: repair ? undefined : own?.reviewerInstanceId, ownReviewId: repair ? undefined : own?.id, repair, repairAdmission: !!repair, settled: !!own?.result });
  if (own && !repair && participants.reviewer?.agentId !== own.reviewerAgentId) throw AppError.conflict("H6 reviewer identity changed");
  return { ...root, ...participants, sourceValue };
}

export async function requireImportedImplementationReviewReceipt(ctx: ServerContext, tx: DrizzleDb, row: ImplementationReview) {
  const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.reviewId, row.id), eq(receipts.organizationId, ctx.organizationId)));
  if (!receipt || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.resultSessionId || receipt.requestDigest !== row.requestDigest
    || receipt.resultDigest !== row.resultDigest || canonical(receipt.sessionBindings) !== canonical(row.sessionBindings))
    throw AppError.conflict("H6 decision requires its exact accepted result receipt");
  return receipt;
}

export async function ensureGoalImportedExecutionReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, executionId: string) {
  originalActor(ctx, automation.actorUserId);
  const root = await readImportedExecutionRootFacts(ctx, tx, executionId);
  if (root.goal.id !== automation.goalId || root.plan.id !== automation.planId) throw AppError.permissionDenied("H6 belongs to another automation");
  const sourceValue = await readImportedImplementationSource(ctx, tx, root);
  const [existing] = await tx.select().from(reviews).where(and(eq(reviews.baseExecutionId, executionId), eq(reviews.sourceKind, sourceValue.source.kind),
    eq(reviews.sourceOperationId, sourceValue.source.operation_id), eq(reviews.organizationId, ctx.organizationId)));
  if (existing) return existing;
  const value = await readImportedImplementationReviewFacts(ctx, tx, executionId), reviewer = value.reviewer!, task = value.task;
  const review_id = ctx.idGen.generate("execution_review"), original = value.sourceValue.source.run_start;
  const common = { version: 1 as const, review_id, execution_request: value.sourceValue.executionRequest, source: value.sourceValue.source,
    reviewer: { instance_id: reviewer.id, agent_id: reviewer.agentId } };
  const subject = importedExecutionReviewSubjectV1(common, sha), reviewTaskId = ctx.idGen.generate("execution_review_task");
  const phase = () => RunStartPayloadSchema.parse({ ...original, run_id: ctx.idGen.generate("implementation_verify_run"),
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify"), expected_subject_digest: subject.subject_digest },
    policy_snapshot: { ...original.policy_snapshot, filesystem_write_scope: [] }, context_pack: { id: ctx.idGen.generate("context"),
      payload: { ...original.context_pack.payload, imported_execution: undefined, imported_execution_repair: undefined,
        imported_execution_review_subject: subject, policy: { ...original.context_pack.payload.policy, filesystem_write_scope: [] } } } });
  const binding = { version: 1, review_id, source_digest: subject.source_digest, subject_digest: subject.subject_digest };
  const prompt = `Independently review this exact implementation against the original requirement, accepted research, design and plan. Read the implementation with protected read-only tools and inspect every declared acceptance case and the sealed before-verification evidence through context.evidence_index and read_evidence. Check behavior, requirement coverage, regressions, correctness and maintainability; a passing verifier is not substantive review. Do not modify files, use the network or run side-effecting commands. This review grants no writing, validation or publication authority.\n\nGoal: ${value.goal.objective}\nTask: ${task.title}\n${task.description}\nCriteria: ${JSON.stringify(task.acceptanceCriteria)}\n\nReturn ONLY JSON with ${JSON.stringify(binding)}, outcome (accepted or rejected), a nonempty summary and findings (severity blocking or nonblocking, description, optional file). Rejected requires a blocking finding; accepted cannot contain one.`;
  const context = ContextPackSchema.parse({ ...original.context_pack.payload, product_development: undefined, imported_execution: undefined,
    imported_execution_repair: undefined, imported_execution_review_subject: subject, conversation: undefined, review_feedback: undefined,
    task: { id: reviewTaskId, title: `Implementation review: ${task.title}`, description: prompt, acceptance_criteria: ["Review the exact implementation and return the bound independent verdict"] },
    policy: { ...original.context_pack.payload.policy, execution_mode: "discussion", filesystem_write_scope: [] } });
  const review_start = RunStartPayloadSchema.parse({ ...phase(), run_id: ctx.idGen.generate("implementation_review_run"), task_id: reviewTaskId,
    agent_instance_id: reviewer.id, runtime: reviewer.runtime, context_pack: { id: ctx.idGen.generate("context"), payload: context }, artifact_rules: { paths: [] } });
  const request = ImportedExecutionReviewRequestV1Schema.parse({ ...common, before_start: phase(), review_start, after_start: phase() });
  inspectImportedExecutionReviewRequestV1(request, value.bytes, sha);
  const [row] = await tx.insert(reviews).values({ id: review_id, baseExecutionId: executionId, sourceKind: common.source.kind,
    sourceOperationId: common.source.operation_id, sourceDigest: value.sourceValue.sourceDigest, organizationId: ctx.organizationId, goalId: value.goal.id,
    planId: value.plan.id, taskId: task.id, authorInstanceId: common.source.author.instance_id, authorAgentId: common.source.author.agent_id,
    reviewerInstanceId: reviewer.id, reviewerAgentId: reviewer.agentId, computerId: value.execution.computerId, workspaceRoot: value.execution.workspaceRoot,
    actorUserId: value.execution.actorUserId, consentId: value.execution.consentId, policyVersion: value.execution.policyVersion,
    sessionBindings: value.sessionBindings, requestDigest: importedExecutionReviewRequestDigestV1(request, sha), request, createdAt: ctx.clock.nowIso() }).returning();
  await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-execution-review.created", actorType: "system", actorId: "goal_runner", correlationId: review_id,
    goalId: value.goal.id, projectId: task.projectId, taskId: task.id, runId: common.source.run_start.run_id,
    payload: { review_id, base_execution_id: executionId, source_digest: row!.sourceDigest, actor_user_id: row!.actorUserId, execution_authorized: false } }));
  return row!;
}

export async function advanceGoalImportedExecutionReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, executionId: string) {
  const row = await ensureGoalImportedExecutionReview(ctx, tx, automation, executionId);
  if (row.acceptedAt) return { review: row, reason: "Implementation accepted by H6; H7 validation and publication remain fenced." };
  const result = ImportedExecutionReviewResultV1Schema.safeParse(row.result).data;
  if (!result) { await ctx.onImportedExecutionReviewQueued?.(row.id, row.stopRequested ? "stop" : "start"); return { review: row, reason: "Waiting for independent implementation review and closure." }; }
  if (row.stopRequested || result.outcome !== "reviewed") return { review: row, reason: `Implementation review ${result.outcome}; no further execution authorized.` };
  await requireImportedImplementationReviewReceipt(ctx, tx, row);
  if (result.verdict.outcome === "rejected") return { review: row, reason: "Implementation changes requested; a separate bounded repair decision is required." };
  const value = await readImportedImplementationReviewFacts(ctx, tx, executionId, row);
  inspectImportedExecutionReviewResultV1(row.request, result, value.bytes, sha);
  const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
  if (!fresh || fresh.stopRequested || fresh.acceptedAt || canonical(fresh.result) !== canonical(result) || fresh.resultDigest !== hash(result)
    || fresh.resultSessionId !== value.sessionBindings.destination.sessionId || fresh.requestDigest !== importedExecutionReviewRequestDigestV1(fresh.request, sha))
    throw AppError.conflict("H6 acceptance provenance changed");
  const now = ctx.clock.nowIso();
  const changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "review", trigger: "accept", now,
    events: status => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: row.id,
      goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, roomId: value.task.roomId, payload: { status, imported_execution_review_id: row.id } })] });
  if (!changed.changed) throw AppError.conflict("Implementation is no longer awaiting acceptance");
  const event = buildEvent(ctx, { type: "goal.imported-execution-review.accepted", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: value.sourceValue.source.run_start.run_id,
    payload: { review_id: row.id, base_execution_id: executionId, actor_user_id: row.actorUserId, result_digest: fresh.resultDigest,
      source_digest: row.sourceDigest, verification_evidence_id: value.sourceValue.evidence.id, subsequent_stage_authorized: false } });
  await appendEvent(tx, event); await tx.update(reviews).set({ acceptedAt: now, acceptanceEventId: event.id }).where(eq(reviews.id, row.id));
  return { review: { ...row, acceptedAt: now, acceptanceEventId: event.id }, reason: "Implementation accepted by H6; H7 validation and publication remain fenced." };
}

export async function stopGoalImportedExecutionReviews(ctx: ServerContext, goalId: string) {
  const rows = await ctx.db.transaction(async tx => {
    await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
    const rows = await tx.select().from(reviews).where(and(eq(reviews.goalId, goalId), eq(reviews.organizationId, ctx.organizationId)));
    for (const row of rows) { originalActor(ctx, row.actorUserId); await tx.update(reviews).set({ stopRequested: true }).where(eq(reviews.id, row.id)); }
    return rows.filter(row => ImportedExecutionReviewResultV1Schema.safeParse(row.result).data?.closed !== true);
  });
  for (const row of rows) await ctx.onImportedExecutionReviewQueued?.(row.id, "stop");
}

export function createImportedExecutionReviewBinding(ctx: ServerContext, options: {
  identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send">;
}) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("H6 node session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("H6 belongs to another node");
    return row;
  }
  async function startFence(tx: DrizzleDb, row: ImplementationReview) {
    const value = await readImportedImplementationReviewFacts(actorContext(ctx, row.actorUserId), tx, row.baseExecutionId, row);
    await qualify(tx);
    const session = { ...identity, sessionId: options.sessionId };
    if (canonical(value.sessionBindings.destination) !== canonical(session)) throw AppError.conflict("H6 admission belongs to another destination session");
    const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
    if (!fresh || fresh.stopRequested || fresh.result !== null || fresh.requestDigest !== importedExecutionReviewRequestDigestV1(fresh.request, sha)) throw AppError.conflict("Stopped or settled H6 permits only status or stop");
    const request = inspectImportedExecutionReviewRequestV1(fresh.request, value.bytes, sha);
    if (canonical(request.execution_request) !== canonical(value.sourceValue.executionRequest) || canonical(request.source) !== canonical(value.sourceValue.source)
      || request.review_start.runtime !== value.reviewer!.runtime) throw AppError.conflict("H6 no longer matches its exact completed author and reviewer");
    const prior = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
    if (prior.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("Exposed H6 cannot start in a new session");
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
    current(); return fresh;
  }
  return {
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id);
        if (control === "start") await startFence(tx, row);
        else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist H6 stop before sending"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("execution_review_delivery"), reviewId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.execution-review.v1", payload: ImportedExecutionReviewRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.execution-review.stop.v1" : "product.source.execution-review.status.v1", payload: { version: 1, review_id: id, request_digest: record.row.requestDigest } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx);
        current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedExecutionReviewAck) {
      const ack = importedExecutionReviewAckSchema.parse(input); current();
      if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("H6 ACK node differs");
      await ctx.db.transaction(async tx => {
        await qualify(tx); const row = await load(tx, ack.payload.review_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("H6 ACK lacks its immutable issued delivery");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id));
        await qualify(tx);
      });
    },
    async receive(input: ImportedExecutionReviewResult) {
      const message = importedExecutionReviewResultSchema.parse(input); current();
      if (message.node_id !== identity.computerId) throw AppError.permissionDenied("H6 result node differs");
      await ctx.db.transaction(async tx => {
        const row = await load(tx, message.payload.review_id);
        // The goal/member/device order matches admission. Closure still records after pause.
        await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
        await qualify(tx);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("H6 result has no exact issued command");
        const request = ImportedExecutionReviewRequestV1Schema.parse(row.request);
        const result = inspectImportedExecutionReviewResultV1(request, message.payload, await researchBytes(ctx, request.execution_request.review_request), sha);
        if (result.outcome === "reviewed") {
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId) throw AppError.conflict("H6 reviewed result requires its original issued start");
          if (canonical(importedImplementationSessions(ctx, request.execution_request)) !== canonical(row.sessionBindings)) throw AppError.conflict("H6 success cannot reuse an earlier paired admission");
          const bound = row.sessionBindings as { destination: AuthenticatedTransferNode & { sessionId: string } };
          if (canonical(bound.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H6 success belongs to its original paired session");
        }
        const [locked] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("H6 result is immutable");
        if (locked!.result === null) await tx.update(reviews).set({ result, resultDigest: hash(result), resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(reviews.id, row.id));
        await qualify(tx);
      });
      await ctx.db.transaction(async tx => { await qualify(tx); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`,
        type: "product.source.execution-review.receipt.v1", payload: { version: 1, review_id: message.payload.review_id, request_digest: message.payload.request_digest }, result_digest: hash(message.payload), status: "accepted" }); current();
        if (message.payload.outcome === "reviewed") {
          const row = await load(tx, message.payload.review_id);
          // This records transport.send completion, not a remote acknowledgement or H6 plan acceptance.
          await tx.insert(receipts).values({ reviewId: row.id, organizationId: ctx.organizationId,
            deliveryId: row.resultDeliveryId!, sessionId: options.sessionId, sessionBindings: row.sessionBindings,
            requestDigest: row.requestDigest, resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
        }
      });
    },
  };
}
