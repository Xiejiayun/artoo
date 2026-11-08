import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { appendEvent, eventLog, goalAutomations, goals, goalImportedValidations as validations,
  goalImportedValidationReviews as reviews, goalImportedValidationReviewDeliveries as deliveries, goalImportedValidationReviewReceipts as receipts } from "@artoo/db";
import { ContextPackSchema, ImportedValidationReviewRequestV1Schema, ImportedValidationReviewResultV1Schema,
  importedValidationReviewRequestDigestV1, importedValidationReviewSubjectV1, inspectImportedValidationReviewRequestV1,
  inspectImportedValidationReviewResultV1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { importedValidationReviewAckSchema, importedValidationReviewResultSchema, type ImportedValidationReviewAck, type ImportedValidationReviewResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { assertImportedImplementationActor as originalActor, importedImplementationActorContext as actorContext, assertImportedImplementationCredential as credential } from "./imported-execution-service.js";
import { readImportedValidationOrigin, readValidationSource, readValidationCompletion, requireValidationReceipt,
  readValidationReview, reserveValidationParticipants, validationTask, type ValidationReview } from "./imported-validation-source-service.js";
import type { AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { transitionTask } from "./transition-service.js";

type Automation = typeof goalAutomations.$inferSelect;
type Control = "start" | "stop" | "status";
export async function ensureGoalImportedValidationReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, validationId: string) {
  originalActor(ctx, automation.actorUserId);
  await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [author] = await tx.select().from(validations).where(and(eq(validations.id, validationId), eq(validations.organizationId, ctx.organizationId)));
  if (!author || author.goalId !== automation.goalId || author.planId !== automation.planId) throw AppError.permissionDenied("H7 review belongs to another automation");
  const root = await readImportedValidationOrigin(ctx, tx, author.originReviewId, { live: true }), measured = await readValidationSource(ctx, tx, author, root);
  if (author.readyKind !== "review" || measured.source.outcome !== "verified") throw AppError.conflict("Only a verified H7 final product can enter independent review");
  const [existing] = await tx.select().from(reviews).where(and(eq(reviews.validationId, validationId), eq(reviews.organizationId, ctx.organizationId))).orderBy(desc(reviews.sequence)).limit(1);
  const priorResult = existing && ImportedValidationReviewResultV1Schema.safeParse(existing.result).data;
  if (existing && (existing.stopRequested || existing.acceptedAt || priorResult?.outcome !== "failed")) return existing;
  if (existing) {
    await readValidationReview(ctx, tx, existing, root, measured.source);
    if (root.budgets.max_retries !== null && root.goal.retryCount >= root.budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
  }
  const participants = await reserveValidationParticipants(ctx, tx, root, { source: measured.source, reviewerId: existing?.reviewerInstanceId }), { task, reviewer } = participants;
  if (!reviewer || task.status !== "review") throw AppError.conflict("H7 final-product review requires its original validation task awaiting acceptance");
  const reviewId = ctx.idGen.generate("validation_review"), attemptIndex = root.goal.retryCount + (existing ? 1 : 0), now = ctx.clock.nowIso();
  const retryOf = existing ? { review_id: existing.id, request_digest: existing.requestDigest, result_digest: existing.resultDigest! } : undefined;
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-validation-review.authorized", actorType: "system", actorId: "goal_runner", correlationId: reviewId,
    goalId: author.goalId, taskId: author.taskId, projectId: task.projectId, runId: author.runId, payload: { review_id: reviewId, validation_id: author.id,
      source_digest: measured.sourceDigest, actor_user_id: author.actorUserId, attempt_index: attemptIndex, previous_retry_count: root.goal.retryCount,
      retry_of: retryOf ?? null, execution_authorized: false } }));
  const common = { version: 1 as const, review_id: reviewId, origin: root.origin, source: measured.source,
    authorization: { event_id: event.id, goal_id: author.goalId, attempt_index: attemptIndex }, reviewer: { instance_id: reviewer.id, agent_id: reviewer.agentId }, ...(retryOf ? { retry_of: retryOf } : {}) };
  const subject = importedValidationReviewSubjectV1(common, sha), original = measured.request.run_start;
  const phase = () => ({ ...original, run_id: ctx.idGen.generate("validation_verify_run"),
    verification: { ...original.verification, request_id: ctx.idGen.generate("verify"), expected_subject_digest: measured.source.subject_digest },
    policy_snapshot: { ...original.policy_snapshot, filesystem_write_scope: [] }, context_pack: { id: ctx.idGen.generate("context"),
      payload: { ...original.context_pack.payload, imported_validation: undefined, imported_validation_review_subject: subject,
        policy: { ...original.context_pack.payload.policy, filesystem_write_scope: [] } } } });
  const reviewTaskId = ctx.idGen.generate("validation_review_task"), verdictBinding = { version: 1, review_id: reviewId, validation_id: author.id, source_digest: measured.sourceDigest, subject_digest: measured.source.subject_digest };
  const prompt = `Independently review the COMPLETE final product against the original requirement, accepted research and design, every acceptance criterion and declared case. Read final product source and actual behavior, inspect the protected retained initial-source baseline and source changes. Read the workspace evidence index baseline.directories and baseline.files[].reference through read_evidence to inspect actual files before these changes; do not infer old source from the validation report, and check regressions, correctness, maintainability, omitted requirements and report truthfulness. The validation author was explicitly allowed to repair product code; old H6 acceptance does not approve these changes. Reviewing only validation.json or a change summary is insufficient. Inspect the node-bound full case, viewport, program and measurement-plan outcomes, using protected read_evidence for relevant baseline bytes, raw traces and screenshots. A passed verifier is not substantive review. Unseen or unrun evidence is not a pass. Release criteria remain pending until the configured publisher separately measures them. Do not change files, weaken accepted inputs, use the network or run side-effecting commands.\n\nOriginal goal and accepted plan: ${root.goal.objective}; plan ${root.plan.id} version ${root.plan.version}\nTask: ${task.title}\n${task.description}\nCriteria: ${JSON.stringify(task.acceptanceCriteria)}\n\nReturn ONLY JSON with ${JSON.stringify(verdictBinding)}, outcome (accepted or rejected), a nonempty summary and findings (severity blocking or nonblocking, description, optional file). Reject every blocking finding. This verdict grants no writer or publisher permission.`;
  const context = ContextPackSchema.parse({ ...phase().context_pack.payload, product_development: undefined, conversation: undefined, review_feedback: undefined,
    task: { id: reviewTaskId, title: `Final product review: ${task.title}`, description: prompt, acceptance_criteria: ["Independently review the complete final product, its changes and every requirement against exact node measurements"] },
    policy: { ...original.context_pack.payload.policy, execution_mode: "discussion", filesystem_write_scope: [] } });
  const request = ImportedValidationReviewRequestV1Schema.parse({ ...common, before_start: phase(),
    review_start: { ...phase(), run_id: ctx.idGen.generate("validation_review_run"), task_id: reviewTaskId, agent_instance_id: reviewer.id, runtime: reviewer.runtime,
      context_pack: { id: ctx.idGen.generate("context"), payload: context }, artifact_rules: { paths: [] } }, after_start: phase() });
  inspectImportedValidationReviewRequestV1(request, root.bytes, sha);
  if (existing) {
    const changed = await tx.update(goals).set({ retryCount: attemptIndex, updatedAt: now }).where(and(eq(goals.id, root.goal.id), eq(goals.retryCount, root.goal.retryCount))).returning({ id: goals.id });
    if (changed.length !== 1) throw AppError.conflict("Original retry counter changed during H7 reviewer retry");
  }
  return (await tx.insert(reviews).values({ id: reviewId, validationId: author.id, retryOf: existing?.id ?? null, sequence: existing ? existing.sequence + 1 : 0,
    sourceDigest: measured.sourceDigest, organizationId: ctx.organizationId, goalId: author.goalId, planId: author.planId, taskId: author.taskId,
    authorInstanceId: measured.source.author.instance_id, authorAgentId: measured.source.author.agent_id, reviewerInstanceId: reviewer.id, reviewerAgentId: reviewer.agentId,
    computerId: author.computerId, workspaceRoot: author.workspaceRoot, actorUserId: author.actorUserId, consentId: author.consentId, policyVersion: author.policyVersion,
    authorizationEventId: event.id, attemptIndex, sessionBindings: root.sessionBindings, requestDigest: importedValidationReviewRequestDigestV1(request, sha), request, createdAt: now }).returning())[0]!;
}

export async function assertValidationReviewAssignment(ctx: ServerContext, tx: DrizzleDb, row: ValidationReview, start = false) {
  const [validation] = await tx.select().from(validations).where(and(eq(validations.id, row.validationId), eq(validations.organizationId, ctx.organizationId)));
  if (!validation) throw AppError.conflict("H7 reviewed author no longer exists");
  const root = await readImportedValidationOrigin(ctx, tx, validation.originReviewId, { live: true }), measured = await readValidationSource(ctx, tx, validation, root);
  const request = inspectImportedValidationReviewRequestV1(row.request, root.bytes, sha), { task } = validationTask(root, row.taskId);
  const [latest] = await tx.select().from(reviews).where(and(eq(reviews.validationId, validation.id), eq(reviews.organizationId, ctx.organizationId))).orderBy(desc(reviews.sequence)).limit(1);
  if (latest?.id !== row.id || row.stopRequested || row.validationId !== validation.id || validation.readyKind !== "review" || row.goalId !== validation.goalId || row.planId !== validation.planId || row.taskId !== validation.taskId
    || row.actorUserId !== validation.actorUserId || row.consentId !== validation.consentId || row.policyVersion !== validation.policyVersion
    || canonical(request.origin) !== canonical(root.origin) || canonical(request.source) !== canonical(measured.source) || row.sourceDigest !== measured.sourceDigest
    || row.requestDigest !== importedValidationReviewRequestDigestV1(request, sha) || canonical(row.sessionBindings) !== canonical(root.sessionBindings)
    || row.authorInstanceId !== measured.source.author.instance_id || row.authorAgentId !== measured.source.author.agent_id
    || request.reviewer.instance_id !== row.reviewerInstanceId || request.reviewer.agent_id !== row.reviewerAgentId
    || task.status !== (row.acceptedAt ? "done" : "review") || start && (row.result !== null || row.acceptedAt !== null)) throw AppError.conflict("H7 final-product reviewer or current source changed");
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.authorizationEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (!event || event.type !== "goal.imported-validation-review.authorized" || event.actorType !== "system" || event.actorId !== "goal_runner"
    || event.goalId !== row.goalId || event.taskId !== row.taskId || event.runId !== validation.runId || payload?.review_id !== row.id || payload.validation_id !== validation.id
    || payload.source_digest !== row.sourceDigest || payload.actor_user_id !== row.actorUserId || payload.attempt_index !== row.attemptIndex
    || payload.previous_retry_count !== row.attemptIndex - (row.retryOf ? 1 : 0) || root.goal.retryCount < row.attemptIndex
    || request.authorization.event_id !== row.authorizationEventId || request.authorization.attempt_index !== row.attemptIndex) throw AppError.conflict("H7 review lost its original goal authorization");
  if (row.retryOf) {
    const [prior] = await tx.select().from(reviews).where(and(eq(reviews.id, row.retryOf), eq(reviews.organizationId, ctx.organizationId)));
    if (!prior || prior.validationId !== validation.id || prior.sequence + 1 !== row.sequence || prior.stopRequested || prior.acceptedAt) throw AppError.conflict("H7 reviewer retry source changed");
    const previous = await readValidationReview(ctx, tx, prior, root, measured.source);
    if (previous.result.outcome !== "failed" || canonical(request.retry_of) !== canonical({ review_id: prior.id, request_digest: prior.requestDigest, result_digest: prior.resultDigest })) throw AppError.conflict("Only an original closed failed H7 review can retry without an author repair");
  } else if (request.retry_of) throw AppError.conflict("Unexpected H7 review retry reference");
  const participants = await reserveValidationParticipants(ctx, tx, root, { source: measured.source, review: row, settled: row.result !== null });
  if (participants.reviewer?.runtime !== request.review_start.runtime || participants.reviewer.agentId !== row.reviewerAgentId) throw AppError.conflict("H7 reviewer runtime changed");
  return { root, validation, measured, request, ...participants };
}
export async function advanceGoalImportedValidationReview(ctx: ServerContext, tx: DrizzleDb, automation: Automation, validationId: string) {
  const row = await ensureGoalImportedValidationReview(ctx, tx, automation, validationId);
  if (row.acceptedAt) return { review: row, reason: "Final product independently accepted; configured publication requires its separate immutable request." };
  const result = ImportedValidationReviewResultV1Schema.safeParse(row.result).data;
  if (!result) { await ctx.onImportedValidationReviewQueued?.(row.id, row.stopRequested ? "stop" : "start"); return { review: row, reason: "Waiting for independent full-product validation review and closure." }; }
  if (row.stopRequested || result.outcome !== "reviewed") return { review: row, reason: `Final product review ${result.outcome}; publication remains fenced.` };
  const value = await assertValidationReviewAssignment(ctx, tx, row), qualified = await readValidationReview(ctx, tx, row, value.root, value.measured.source);
  if (qualified.result.outcome !== "reviewed" || qualified.result.verdict.outcome === "rejected") return { review: row, reason: "Final product changes requested; a separate bounded H7 repair decision is required." };
  const [fresh] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
  if (!fresh || fresh.stopRequested || fresh.acceptedAt || canonical(fresh.result) !== canonical(result) || fresh.resultDigest !== hash(result)
    || fresh.resultSessionId !== value.root.sessionBindings.destination.sessionId) throw AppError.conflict("H7 final acceptance provenance changed");
  const now = ctx.clock.nowIso(), changed = await transitionTask(tx, ctx, { taskId: row.taskId, from: "review", trigger: "accept", now,
    events: status => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: row.id, goalId: row.goalId,
      taskId: row.taskId, projectId: value.task.projectId, roomId: value.task.roomId, payload: { status, imported_validation_review_id: row.id } })] });
  if (!changed.changed) throw AppError.conflict("H7 final validation no longer awaits acceptance");
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.imported-validation-review.accepted", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, taskId: row.taskId, projectId: value.task.projectId, runId: value.validation.runId, payload: { review_id: row.id, validation_id: value.validation.id,
      actor_user_id: row.actorUserId, result_digest: row.resultDigest, source_digest: row.sourceDigest, subject_digest: value.measured.source.subject_digest,
      verification_evidence_id: value.measured.evidence!.id, publication_authorized: false } }));
  await tx.update(reviews).set({ acceptedAt: now, acceptanceEventId: event.id }).where(eq(reviews.id, row.id));
  return { review: { ...row, acceptedAt: now, acceptanceEventId: event.id }, reason: "Final product independently accepted; configured publication requires its separate immutable request." };
}
export async function stopGoalImportedValidationReviews(ctx: ServerContext, goalId: string) {
  const rows = await ctx.db.transaction(async tx => {
    const rows = await tx.select().from(reviews).where(and(eq(reviews.goalId, goalId), eq(reviews.organizationId, ctx.organizationId)));
    const pending = rows.filter(row => ImportedValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true);
    for (const row of pending) await tx.update(reviews).set({ stopRequested: true }).where(eq(reviews.id, row.id)); return pending;
  });
  for (const row of rows) await ctx.onImportedValidationReviewQueued?.(row.id, "stop");
}
export function createImportedValidationReviewBinding(ctx: ServerContext, options: { identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send"> }) {
  const identity = Object.freeze({ ...options.identity }), current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("H7 review session is no longer current"); };
  const qualify = async (tx: DrizzleDb) => { current(); await credential(ctx, tx, identity); current(); };
  async function load(tx: DrizzleDb, id: string) { const [row] = await tx.select().from(reviews).where(and(eq(reviews.id, id), eq(reviews.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId) throw AppError.permissionDenied("H7 review belongs to another node"); return row; }
  async function startFence(tx: DrizzleDb, row: ValidationReview) {
    const value = await assertValidationReviewAssignment(actorContext(ctx, row.actorUserId), tx, row, true); await qualify(tx);
    if (canonical(value.root.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H7 review belongs to its original paired session");
    const starts = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
    if (starts.some(item => item.sessionId !== options.sessionId)) throw AppError.conflict("H7 review cannot restart in another session");
    await assertSourceLineageDispatch(ctx, tx, row.computerId, row.workspaceRoot);
  }
  // Shared with ordinary receive: its actual command_id remains the reply ID.
  async function sendResultReceipt(tx: DrizzleDb, message: ImportedValidationReviewResult) { await qualify(tx); const row = await load(tx, message.payload.review_id);
    current(); await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`, type: "product.source.validation-review.receipt.v1",
      payload: { version: 1, review_id: row.id, request_digest: row.requestDigest }, result_digest: hash(message.payload), status: "accepted" }); current();
    if (message.payload.outcome === "reviewed" || message.payload.outcome === "failed") await tx.insert(receipts).values({ reviewId: row.id, organizationId: ctx.organizationId,
      deliveryId: row.resultDeliveryId!, sessionId: options.sessionId, sessionBindings: row.sessionBindings, requestDigest: row.requestDigest, resultDigest: hash(message.payload), sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
    current();
  }
  return {
    /** Re-send only an immutable result's original same-session receipt; never starts work. */
    async redeliverCommittedReceipt(id: string): Promise<void> {
      await ctx.db.transaction(async tx => {
        await qualify(tx); const row = await load(tx, id);
        const request = ImportedValidationReviewRequestV1Schema.parse(row.request), result = ImportedValidationReviewResultV1Schema.parse(row.result);
        if (!(result.outcome === "reviewed" || result.outcome === "failed")) throw AppError.conflict("Committed validation-review result has no receipt marker obligation");
        const bound = row.sessionBindings as { destination?: AuthenticatedTransferNode & { sessionId: string } };
        if (request.review_id !== row.id || result.review_id !== row.id || row.requestDigest !== importedValidationReviewRequestDigestV1(request, sha)
          || result.request_digest !== row.requestDigest || row.resultDigest !== hash(result) || !row.resultDeliveryId
          || row.resultSessionId !== options.sessionId || canonical(bound.destination ?? null) !== canonical({ ...identity, sessionId: options.sessionId }))
          throw AppError.conflict("Committed validation-review receipt differs from its original result, request or destination session");
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, row.resultDeliveryId), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        const starts = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
        if (!delivery || starts.length !== 1 || starts[0]!.sessionId !== options.sessionId)
          throw AppError.conflict("Committed validation-review receipt lost its original issuing delivery");
        const readMarker = async () => {
          const [marker] = await tx.select().from(receipts).where(and(eq(receipts.reviewId, row.id), eq(receipts.organizationId, ctx.organizationId)));
          if (marker && (marker.deliveryId !== row.resultDeliveryId || marker.sessionId !== row.resultSessionId
            || marker.requestDigest !== row.requestDigest || marker.resultDigest !== row.resultDigest || canonical(marker.sessionBindings) !== canonical(row.sessionBindings)))
            throw AppError.conflict("Committed validation-review receipt marker differs from its original result");
          return marker;
        };
        if (await readMarker()) { current(); return; }
        // The original result may have arrived under status/stop; do not substitute its start ID.
        await sendResultReceipt(tx, { kind: "product.source.validation-review.result.v1", node_id: identity.computerId, command_id: delivery.id, payload: result });
        if (!await readMarker()) throw AppError.conflict("Committed validation-review receipt marker was not recorded after send");
        current();
      });
    },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row);
        else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist H7 review stop before sending"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        const delivery = prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("validation_review_delivery"), reviewId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        return { row, delivery }; });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.validation-review.v1", payload: ImportedValidationReviewRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.validation-review.stop.v1" : "product.source.validation-review.status.v1", payload: { version: 1, review_id: id, request_digest: record.row.requestDigest } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx); current(); await options.transport.send(command); current(); });
      return command;
    },
    async acknowledge(input: ImportedValidationReviewAck) {
      const ack = importedValidationReviewAckSchema.parse(input); current(); if (ack.node_id !== identity.computerId) throw AppError.permissionDenied("H7 review ACK node differs");
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, ack.payload.review_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, ack.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || row.requestDigest !== ack.payload.request_digest || delivery.ack !== null && canonical(delivery.ack) !== canonical(ack)) throw AppError.conflict("H7 review ACK lacks its exact immutable delivery");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack }).where(eq(deliveries.id, delivery.id)); await qualify(tx); });
    },
    async receive(input: ImportedValidationReviewResult) {
      const message = importedValidationReviewResultSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("H7 review result node differs");
      await ctx.db.transaction(async tx => { const row = await load(tx, message.payload.review_id);
        await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId))).for("update"); await qualify(tx);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.reviewId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("H7 review result has no exact issuing command");
        const [author] = await tx.select().from(validations).where(and(eq(validations.id, row.validationId), eq(validations.organizationId, ctx.organizationId)));
        if (!author) throw AppError.conflict("H7 review lost its original author");
        const root = await readImportedValidationOrigin(ctx, tx, author.originReviewId), measured = await readValidationCompletion(ctx, tx, author, root);
        await requireValidationReceipt(ctx, tx, author);
        const request = ImportedValidationReviewRequestV1Schema.parse(row.request), result = inspectImportedValidationReviewResultV1(request, message.payload, root.bytes, sha);
        if (canonical(request.source) !== canonical(measured.source) || canonical(request.origin) !== canonical(root.origin)) throw AppError.conflict("H7 review changed its original completed product");
        if (result.outcome === "reviewed" || result.outcome === "failed") {
          const starts = await tx.select().from(deliveries).where(and(eq(deliveries.reviewId, row.id), eq(deliveries.control, "start")));
          if (starts.length !== 1 || starts[0]!.sessionId !== options.sessionId || canonical(root.sessionBindings.destination) !== canonical({ ...identity, sessionId: options.sessionId })) throw AppError.conflict("H7 review completion requires its original paired start");
        }
        const [locked] = await tx.select().from(reviews).where(eq(reviews.id, row.id)).for("update");
        if (locked!.result !== null && canonical(locked!.result) !== canonical(result)) throw AppError.conflict("H7 review result is immutable");
        if (locked!.result === null) await tx.update(reviews).set({ result, resultDigest: hash(result), resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(reviews.id, row.id)); await qualify(tx);
      });
      await ctx.db.transaction(tx => sendResultReceipt(tx, message));
    },
  };
}
