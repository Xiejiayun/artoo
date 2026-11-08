import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { randomUUID } from "node:crypto";
import { appendEvent, eventLog, goals, runs, tasks, goalAutomations,
  nodeRecoveryRegistrations as registrations, nodeRecoveryAvailabilities as availabilities,
  goalSourceRecoveries as recoveries, goalSourceRecoveryDeliveries as deliveries,
  goalSourceRecoveryCheckpoints as checkpoints, goalSourceRecoveryReceipts as receipts, goalSourceRecoverySettlements as settlements,
  goalImportedValidations, goalImportedValidationDeliveries, goalImportedValidationReviews, goalImportedValidationReviewDeliveries,
  goalImportedValidationPublications, productReleases, goalImportedDesignReviews, goalImportedDesignContinuations,
  goalImportedProductReviews, goalProductHandoffs } from "@artoo/db";
import { ProductSourceRecoveryRegistrationV1Schema, ProductSourceRecoveryAvailabilityV1Schema, ProductSourceRecoveryRequestV1Schema,
  RunStatusSchema, productSourceRecoveryRegistrationDigestV1, productSourceRecoveryRequestDigestV1,
  productSourceRecoveryCheckpointDigestV1, inspectProductSourceRecoveryResultV1, importedExecutionAcceptedInputsV1,
  PRODUCT_SOURCE_RECOVERY_FEATURE_V1, canonicalProductSourceTransferValueV1 as canonical,
  type ProductSourceRecoveryAvailabilityV1, type RecoveryOperationRefV1 } from "@artoo/domain";
import { productSourceRecoveryRegisterSchema, productSourceRecoveryAvailableSchema, productSourceRecoveryAckSchema, productSourceRecoveryResultSchema,
  type ProductSourceRecoveryRegister, type ProductSourceRecoveryAvailable, type ProductSourceRecoveryAck, type ProductSourceRecoveryResult,
  type NodeTransport, type ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { assertImportedImplementationActor as originalActor, assertImportedImplementationCredential as credential,
  importedImplementationActorContext as actorContext } from "./imported-execution-service.js";
import { readImportedValidationOrigin, type ValidationRoot } from "./imported-validation-source-service.js";
import type { AuthenticatedTransferNode } from "./product-source-transfer-service.js";
import { requireActiveMember } from "./member-status.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { releaseRunLeases } from "./lease-service.js";

type Registration = typeof registrations.$inferSelect;
export type SourceRecovery = typeof recoveries.$inferSelect;
type Control = "start" | "stop" | "status";
type CurrentNode = AuthenticatedTransferNode & { sessionId: string };
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

function currentNode(ctx: ServerContext, registration: Registration, sessionId: string): CurrentNode {
  const current = ctx.getPairedNodeSession?.(registration.computerId);
  if (!current || current.computerId !== registration.computerId || current.deviceId !== registration.deviceId || current.sessionId !== sessionId)
    throw AppError.conflict("Recovery requires the current authenticated session on its original device");
  return current;
}
function inspectAvailability(registration: Registration, value: ProductSourceRecoveryAvailabilityV1, sessionId: string) {
  const original = ProductSourceRecoveryRegistrationV1Schema.parse(registration.registration), epoch = value.previous_epoch;
  if (value.registration_id !== registration.id || !same(value.binding, original.binding) || epoch.epoch_id !== original.epoch.epoch_id
    || epoch.generation !== original.epoch.generation || epoch.session_id !== original.epoch.session_id || epoch.roster_revision < original.epoch.roster_revision
    || value.current_session_id !== sessionId || sessionId === registration.sessionId
    || epoch.roster_revision === original.epoch.roster_revision && epoch.roster_digest !== original.epoch.roster_digest)
    throw AppError.conflict("Recovery availability changed its original registered epoch");
}

/** Re-read history without turning the historical H7 reader into current authority. */
export async function readLiveSourceRecoveryOrigin(ctx: ServerContext, tx: DrizzleDb, reviewId: string, registration: Registration, sessionId: string) {
  const root = await readImportedValidationOrigin(ctx, tx, reviewId);
  originalActor(ctx, root.h6.actorUserId); await requireActiveMember(ctx, root.h6.actorUserId, tx);
  await requireAiSharingAuthorization(ctx, tx, { consentId: root.h6.consentId, policyVersion: root.h6.policyVersion });
  if (root.goal.status !== "running" || root.goal.currentPlanId !== root.plan.id || root.automation.planId !== root.plan.id
    || !["executing", "waiting"].includes(root.automation.status) || root.h6.computerId !== registration.computerId || root.h6.workspaceRoot !== registration.workspaceRoot
    || root.sessionBindings.destination.computerId !== registration.computerId || root.sessionBindings.destination.deviceId !== registration.deviceId
    || root.sessionBindings.destination.sessionId !== registration.sessionId)
    throw AppError.conflict("Recovery goal, original accepted source or destination epoch changed");
  if (root.budgets.max_elapsed_ms !== null && root.goal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(root.goal.runningSince)) >= root.budgets.max_elapsed_ms)
    throw AppError.conflict("Recovery elapsed goal budget reached");
  if (root.budgets.max_retries !== null && root.goal.retryCount > root.budgets.max_retries) throw AppError.conflict("Recovery original goal retry budget reached");
  const destination = currentNode(ctx, registration, sessionId);
  const source = root.sessionBindings.source.computerId === destination.computerId ? destination : root.sessionBindings.source;
  if (!same(ctx.getPairedNodeSession?.(source.computerId), source)) throw AppError.conflict("Recovery cannot replace the original research source session");
  for (const identity of [source, destination].sort((a, b) => a.deviceId.localeCompare(b.deviceId))) await credential(ctx, tx, identity);
  const [h4] = await tx.select().from(goalImportedDesignReviews).where(eq(goalImportedDesignReviews.id, root.execution.reviewId));
  const [h3] = h4 ? await tx.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, h4.continuationId)) : [];
  const [h2] = h3 ? await tx.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, h3.reviewId)) : [];
  const [h1] = h2 ? await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, h2.handoffId)) : [];
  if (!h4 || !h3 || !h2 || !h1 || [h4, h3, h2, h1].some(row => row.stopRequested) || !h1.qualifiedReceipt
    || !same(h4.request, root.origin.execution_request.review_request)
    || !same(h3.request, root.origin.execution_request.review_request.continuation_request)
    || !same(h2.request, root.origin.execution_request.review_request.continuation_request.review_request)
    || !root.team.reviewer_instance_ids.includes(root.h6.reviewerInstanceId)) throw AppError.conflict("Recovery original transfer, design or team was revoked");
  if (ctx.supportsExecutionFeature?.(registration.computerId, PRODUCT_SOURCE_RECOVERY_FEATURE_V1) !== true)
    throw AppError.conflict("Current node does not advertise the qualified native recovery contract");
  return { ...root, currentSessionBindings: { source, destination } };
}

/** Native slots and database operations differ: only existing exact Server IDs enter this set. */
async function originalOperations(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot, registration: Registration): Promise<RecoveryOperationRefV1[]> {
  const authors = await tx.select({ row: goalImportedValidations }).from(goalImportedValidations)
    .innerJoin(goalImportedValidationDeliveries, eq(goalImportedValidationDeliveries.validationId, goalImportedValidations.id))
    .where(and(eq(goalImportedValidations.organizationId, ctx.organizationId), eq(goalImportedValidations.originReviewId, root.h6.id),
      eq(goalImportedValidationDeliveries.sessionId, registration.sessionId), eq(goalImportedValidationDeliveries.control, "start")));
  const authorRows = [...new Map(authors.map(({ row }) => [row.id, row])).values()];
  const reviewers = authorRows.length ? await tx.select({ row: goalImportedValidationReviews }).from(goalImportedValidationReviews)
    .innerJoin(goalImportedValidationReviewDeliveries, eq(goalImportedValidationReviewDeliveries.reviewId, goalImportedValidationReviews.id))
    .where(and(eq(goalImportedValidationReviews.organizationId, ctx.organizationId), inArray(goalImportedValidationReviews.validationId, authorRows.map(row => row.id)),
      eq(goalImportedValidationReviewDeliveries.sessionId, registration.sessionId), eq(goalImportedValidationReviewDeliveries.control, "start"))) : [];
  const publications = await tx.select({ row: productReleases }).from(productReleases)
    .innerJoin(goalImportedValidationPublications, eq(goalImportedValidationPublications.releaseId, productReleases.id))
    .where(and(eq(productReleases.organizationId, ctx.organizationId), eq(goalImportedValidationPublications.originReviewId, root.h6.id)));
  const values: RecoveryOperationRefV1[] = [];
  for (const row of authorRows) {
    if (row.computerId !== registration.computerId || row.workspaceRoot !== registration.workspaceRoot || Date.parse(row.createdAt) < Date.parse(registration.createdAt))
      throw AppError.conflict("An H7 author predates native recovery registration or belongs to another workspace");
    values.push({ kind: "validation", operation_id: row.id, request_digest: row.requestDigest, run_id: row.runId });
  }
  for (const row of [...new Map(reviewers.map(({ row }) => [row.id, row])).values()]) {
    if (row.computerId !== registration.computerId || row.workspaceRoot !== registration.workspaceRoot || Date.parse(row.createdAt) < Date.parse(registration.createdAt))
      throw AppError.conflict("An H7 review predates native recovery registration or belongs to another workspace");
    values.push({ kind: "validation_review", operation_id: row.id, request_digest: row.requestDigest });
  }
  for (const { row } of publications) {
    if (row.computerId !== registration.computerId || Date.parse(row.createdAt) < Date.parse(registration.createdAt))
      throw AppError.conflict("A publication predates native recovery registration");
    values.push({ kind: "release", operation_id: row.id, request_digest: hash(row.request) });
  }
  return values.sort((a, b) => { const left = a.kind + ":" + a.operation_id, right = b.kind + ":" + b.operation_id; return left < right ? -1 : left > right ? 1 : 0; });
}

async function readRequest(ctx: ServerContext, tx: DrizzleDb, row: SourceRecovery, live: boolean) {
  const [registration] = await tx.select().from(registrations).where(and(eq(registrations.id, row.registrationId), eq(registrations.organizationId, ctx.organizationId)));
  const [availability] = await tx.select().from(availabilities).where(and(eq(availabilities.id, row.availabilityId), eq(availabilities.organizationId, ctx.organizationId)));
  if (!registration || !availability) throw AppError.conflict("Recovery registration or availability is missing");
  const request = ProductSourceRecoveryRequestV1Schema.parse(row.request), value = ProductSourceRecoveryAvailabilityV1Schema.parse(availability.availability);
  inspectAvailability(registration, value, row.currentSessionId);
  const root = live ? await readLiveSourceRecoveryOrigin(ctx, tx, row.originReviewId, registration, row.currentSessionId)
    : await readImportedValidationOrigin(ctx, tx, row.originReviewId);
  if (row.goalId !== root.goal.id || row.planId !== root.plan.id || row.actorUserId !== root.h6.actorUserId || row.consentId !== root.h6.consentId
    || row.policyVersion !== root.h6.policyVersion || request.recovery_id !== row.id || request.registration_id !== registration.id
    || request.origin_review_id !== root.h6.id || !same(request.origin, root.origin) || request.goal_id !== root.goal.id || request.plan_id !== root.plan.id
    || request.current_session_id !== row.currentSessionId || value.state !== "recoverable" || !same(request.binding, value.binding)
    || !same(request.previous_epoch, value.previous_epoch) || !same(request.operations, value.operations)
    || request.new_daemon_identity_digest !== value.new_daemon_identity_digest || row.requestDigest !== productSourceRecoveryRequestDigestV1(request, sha)
    || !same(request.authorization, { event_id: row.authorizationEventId, actor_user_id: root.h6.actorUserId, consent_id: root.h6.consentId, policy_version: root.h6.policyVersion })
    || !same(request.operations, await originalOperations(ctx, tx, root, registration))) throw AppError.conflict("Recovery request changed its registered source or exact old operations");
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, row.authorizationEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (!event || event.type !== "goal.source-recovery.authorized" || event.actorType !== "system" || event.actorId !== "goal_runner" || event.goalId !== row.goalId
    || payload?.recovery_id !== row.id || payload.actor_user_id !== row.actorUserId || payload.registration_id !== registration.id || payload.availability_digest !== availability.availabilityDigest)
    throw AppError.conflict("Recovery has no current GoalRunner authorization record");
  if (live) {
    if (row.stopRequested) throw AppError.conflict("Recovery is stopped");
    const [latest] = await tx.select().from(availabilities).where(and(eq(availabilities.registrationId, registration.id), eq(availabilities.sessionId, row.currentSessionId))).orderBy(desc(availabilities.createdAt), desc(availabilities.id)).limit(1);
    if (latest?.availabilityDigest !== availability.availabilityDigest) throw AppError.conflict("Recovery availability was superseded");
  }
  return { root, registration, availability, request };
}

/** Called by GoalRunner; reconciliation itself consumes no new author retry. */
export async function ensureGoalSourceRecovery(ctx: ServerContext, tx: DrizzleDb, automation: typeof goalAutomations.$inferSelect, originReviewId: string) {
  originalActor(ctx, automation.actorUserId);
  const root = await readImportedValidationOrigin(ctx, tx, originReviewId), current = ctx.getPairedNodeSession?.(root.h6.computerId);
  if (root.goal.id !== automation.goalId || root.plan.id !== automation.planId) throw AppError.permissionDenied("Recovery origin belongs to another automation");
  if (!current || current.sessionId === root.sessionBindings.destination.sessionId) return undefined;
  const [registration] = await tx.select().from(registrations).where(and(eq(registrations.organizationId, ctx.organizationId), eq(registrations.computerId, root.h6.computerId),
    eq(registrations.deviceId, root.sessionBindings.destination.deviceId), eq(registrations.workspaceRoot, root.h6.workspaceRoot), eq(registrations.sessionId, root.sessionBindings.destination.sessionId)))
    .orderBy(desc(registrations.generation)).limit(1);
  if (!registration) return undefined; // Uninstrumented old owners remain fenced.
  const [existing] = await tx.select().from(recoveries).where(eq(recoveries.registrationId, registration.id));
  if (existing) { if (existing.organizationId !== ctx.organizationId || existing.goalId !== root.goal.id || existing.originReviewId !== root.h6.id) throw AppError.conflict("Registered epoch belongs to another recovery"); return existing; }
  const [availability] = await tx.select().from(availabilities).where(and(eq(availabilities.registrationId, registration.id), eq(availabilities.sessionId, current.sessionId)))
    .orderBy(desc(availabilities.createdAt), desc(availabilities.id)).limit(1);
  if (!availability) return undefined;
  const value = ProductSourceRecoveryAvailabilityV1Schema.parse(availability.availability);
  if (value.state !== "recoverable") return undefined;
  inspectAvailability(registration, value, current.sessionId);
  await readLiveSourceRecoveryOrigin(ctx, tx, root.h6.id, registration, current.sessionId);
  if (!same(value.operations, await originalOperations(ctx, tx, root, registration))) throw AppError.conflict("Native recovery roster does not cover the exact dispatched operation set");
  const id = ctx.idGen.generate("source_recovery"), now = ctx.clock.nowIso();
  const event = await appendEvent(tx, buildEvent(ctx, { type: "goal.source-recovery.authorized", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: root.goal.id, projectId: root.implementation.projectId, payload: { recovery_id: id, actor_user_id: root.h6.actorUserId,
      registration_id: registration.id, availability_digest: availability.availabilityDigest, execution_authorized: false, publication_authorized: false } }));
  const request = ProductSourceRecoveryRequestV1Schema.parse({ version: 1, recovery_id: id, registration_id: registration.id, origin_review_id: root.h6.id,
    goal_id: root.goal.id, plan_id: root.plan.id, origin: root.origin, binding: value.binding, previous_epoch: value.previous_epoch, current_session_id: current.sessionId,
    new_daemon_identity_digest: value.new_daemon_identity_digest, challenge_id: randomUUID(), operations: value.operations,
    authorization: { event_id: event.id, actor_user_id: root.h6.actorUserId, consent_id: root.h6.consentId, policy_version: root.h6.policyVersion } });
  return (await tx.insert(recoveries).values({ id, registrationId: registration.id, availabilityId: availability.id, originReviewId: root.h6.id,
    organizationId: ctx.organizationId, goalId: root.goal.id, planId: root.plan.id, computerId: registration.computerId, actorUserId: root.h6.actorUserId,
    consentId: root.h6.consentId, policyVersion: root.h6.policyVersion, authorizationEventId: event.id, currentSessionId: current.sessionId,
    requestDigest: productSourceRecoveryRequestDigestV1(request, sha), request, createdAt: now }).returning())[0]!;
}

/** Only GoalRunner releases old occupancy; a receipt alone never advances a goal. */
export async function advanceGoalSourceRecovery(ctx: ServerContext, tx: DrizzleDb, row: SourceRecovery) {
  const facts = await readRequest(ctx, tx, row, true), result = row.result === null ? undefined : inspectProductSourceRecoveryResultV1(facts.request, row.result, sha);
  if (!result) return { state: "waiting" as const, recovery: row };
  if (result.outcome !== "recovered") return { state: "unknown" as const, recovery: row };
  const [checkpoint] = await tx.select().from(checkpoints).where(and(eq(checkpoints.recoveryId, row.id), eq(checkpoints.organizationId, ctx.organizationId)));
  const [receipt] = await tx.select().from(receipts).where(and(eq(receipts.recoveryId, row.id), eq(receipts.organizationId, ctx.organizationId)));
  if (!checkpoint || !receipt || checkpoint.checkpointDigest !== productSourceRecoveryCheckpointDigestV1(result.checkpoint, sha) || !same(checkpoint.checkpoint, result.checkpoint)
    || checkpoint.resultDigest !== row.resultDigest || receipt.resultDigest !== row.resultDigest || receipt.deliveryId !== row.resultDeliveryId || receipt.sessionId !== row.currentSessionId)
    throw AppError.conflict("Recovery requires exact immutable checkpoint and result receipt before settlement");
  if (row.settledAt) return { state: "unverified" as const, recovery: row, checkpoint: result.checkpoint };
  const now = ctx.clock.nowIso(), event = await appendEvent(tx, buildEvent(ctx, { type: "goal.source-recovery.settled", actorType: "system", actorId: "goal_runner", correlationId: row.id,
    goalId: row.goalId, projectId: facts.root.implementation.projectId, payload: { recovery_id: row.id, result_digest: row.resultDigest,
      checkpoint_digest: checkpoint.checkpointDigest, actor_user_id: row.actorUserId, source_state: "unverified", publication_authorized: false } }));
  for (const operation of facts.request.operations) {
    await tx.insert(settlements).values({ id: ctx.idGen.generate("source_settlement"), recoveryId: row.id, organizationId: ctx.organizationId, goalId: row.goalId,
      computerId: row.computerId, kind: operation.kind, operationId: operation.operation_id, requestDigest: operation.request_digest,
      runId: operation.run_id ?? null, eventId: event.id, createdAt: now });
    if (operation.kind !== "validation") continue;
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, operation.run_id!), eq(runs.organizationId, ctx.organizationId))).for("update");
    if (!run) throw AppError.conflict("Recovery author lost its actual persisted run");
    if (!["completed", "failed", "cancelled"].includes(run.status)) {
      const status = RunStatusSchema.parse(run.status);
      const changed = await transitionRun(tx, ctx, { runId: run.id, from: status,
        trigger: status === "queued" ? "cancel" : status === "starting" ? "start_failed" : "run_failed", patch: { endedAt: now, failureReason: "daemon_disconnect" } });
      if (!changed.changed) throw AppError.conflict("Recovery could not settle the old author's actual lifecycle");
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId)));
      if (task?.status === "assigned") await transitionTask(tx, ctx, { taskId: task.id, from: "assigned", trigger: "assign_failed_retryable", now });
      if (task?.status === "running" || task?.status === "awaiting_approval") await transitionTask(tx, ctx, { taskId: task.id, from: task.status, trigger: "run_failed", now });
    }
    await releaseRunLeases(ctx, tx, run.id);
    await appendEvent(tx, buildEvent(ctx, { type: "run.reconciled", actorType: "system", actorId: "goal_runner", correlationId: row.id, goalId: row.goalId,
      taskId: run.taskId, runId: run.id, payload: { recovery_id: row.id, checkpoint_digest: checkpoint.checkpointDigest, process_exit_confirmed: true, source_state: "unverified" } }));
  }
  const [updated] = await tx.update(recoveries).set({ settledAt: now, settlementEventId: event.id }).where(eq(recoveries.id, row.id)).returning();
  return { state: "unverified" as const, recovery: updated!, checkpoint: result.checkpoint };
}

export function createSourceRecoveryBinding(ctx: ServerContext, options: { identity: AuthenticatedTransferNode; sessionId: string; isCurrent: () => boolean; transport: Pick<NodeTransport, "send"> }) {
  const identity = Object.freeze({ ...options.identity });
  const current = () => { if (!options.isCurrent()) throw AppError.permissionDenied("Recovery node session is no longer current"); };
  async function qualify(tx: DrizzleDb) { current(); await credential(ctx, tx, identity); current(); }
  async function load(tx: DrizzleDb, id: string) {
    const [row] = await tx.select().from(recoveries).where(and(eq(recoveries.id, id), eq(recoveries.organizationId, ctx.organizationId)));
    if (!row || row.computerId !== identity.computerId || row.currentSessionId !== options.sessionId) throw AppError.permissionDenied("Recovery belongs to another node session"); return row;
  }
  async function startFence(tx: DrizzleDb, row: SourceRecovery) {
    await qualify(tx); if (row.result !== null) throw AppError.conflict("Settled recovery permits only status or stop");
    await readRequest(actorContext(ctx, row.actorUserId), tx, row, true); await qualify(tx);
    await assertSourceLineageDispatch(ctx, tx, row.computerId, ProductSourceRecoveryRequestV1Schema.parse(row.request).binding.workspace_root);
    current();
  }
  return {
    async register(input: ProductSourceRecoveryRegister) {
      const message = productSourceRecoveryRegisterSchema.parse(input), value = message.payload, registrationDigest = productSourceRecoveryRegistrationDigestV1(value, sha);
      current();
      if (message.node_id !== identity.computerId || value.binding.node_id !== identity.computerId || value.binding.device_id !== identity.deviceId || value.epoch.session_id !== options.sessionId)
        throw AppError.permissionDenied("Recovery registration changed its authenticated original node");
      await ctx.db.transaction(async tx => {
        await qualify(tx);
        const [prior] = await tx.select().from(registrations).where(eq(registrations.id, value.registration_id));
        if (prior && (prior.organizationId !== ctx.organizationId || prior.registrationDigest !== registrationDigest || !same(prior.registration, value)))
          throw AppError.conflict("Recovery registration is immutable");
        if (!prior) await tx.insert(registrations).values({ id: value.registration_id, organizationId: ctx.organizationId, computerId: identity.computerId, deviceId: identity.deviceId,
          tokenLookup: identity.tokenLookup, sessionId: options.sessionId, epochId: value.epoch.epoch_id, generation: value.epoch.generation, guardianInstanceId: value.binding.guardian_instance_id,
          storeIdentityDigest: value.binding.store_identity_digest, configurationDigest: value.binding.configuration_digest, workspaceIdentityDigest: value.binding.workspace_identity_digest,
          workspaceRoot: value.binding.workspace_root, registrationDigest, registration: value, createdAt: ctx.clock.nowIso() });
        await qualify(tx);
      });
      // The first transaction has committed before the node may activate any target.
      await ctx.db.transaction(async tx => { await qualify(tx); await options.transport.send({ kind: "command", id: value.registration_id,
        idempotency_key: `registered:${value.registration_id}:${registrationDigest}`, type: "product.source.recovery.registered.v1",
        payload: { version: 1, registration_id: value.registration_id, registration_digest: registrationDigest, session_id: options.sessionId, status: "accepted" } }); current(); });
    },
    async available(input: ProductSourceRecoveryAvailable) {
      const message = productSourceRecoveryAvailableSchema.parse(input), value = message.payload; current();
      if (message.node_id !== identity.computerId || value.binding.node_id !== identity.computerId || value.binding.device_id !== identity.deviceId || value.current_session_id !== options.sessionId)
        throw AppError.permissionDenied("Recovery availability changed its current authenticated node");
      return ctx.db.transaction(async tx => {
        await qualify(tx); const [registration] = await tx.select().from(registrations).where(and(eq(registrations.id, value.registration_id), eq(registrations.organizationId, ctx.organizationId))).for("update");
        if (!registration) throw AppError.conflict("Recovery cannot invent a historical epoch"); inspectAvailability(registration, value, options.sessionId);
        const availabilityDigest = hash(value), [prior] = await tx.select().from(availabilities).where(and(eq(availabilities.registrationId, registration.id), eq(availabilities.sessionId, options.sessionId), eq(availabilities.availabilityDigest, availabilityDigest)));
        const row = prior ?? (await tx.insert(availabilities).values({ id: ctx.idGen.generate("recovery_availability"), registrationId: registration.id, organizationId: ctx.organizationId,
          tokenLookup: identity.tokenLookup, sessionId: options.sessionId, availabilityDigest, availability: value, createdAt: ctx.clock.nowIso() }).returning())[0]!;
        await qualify(tx); return row;
      });
    },
    async requestStop(id: string) { await ctx.db.transaction(async tx => { const row = await load(tx, id); await qualify(tx); await tx.update(recoveries).set({ stopRequested: true }).where(eq(recoveries.id, row.id)); }); },
    async dispatch(id: string, control: Control = "start") {
      const record = await ctx.db.transaction(async tx => {
        const row = await load(tx, id); if (control === "start") await startFence(tx, row); else { await qualify(tx); if (control === "stop" && !row.stopRequested) throw AppError.conflict("Persist recovery stop before sending"); }
        const [prior] = await tx.select().from(deliveries).where(and(eq(deliveries.recoveryId, id), eq(deliveries.sessionId, options.sessionId), eq(deliveries.control, control)));
        return { row, delivery: prior ?? (await tx.insert(deliveries).values({ id: ctx.idGen.generate("recovery_delivery"), recoveryId: id, sessionId: options.sessionId, control, createdAt: ctx.clock.nowIso() }).returning())[0]! };
      });
      const common = { kind: "command" as const, id: record.delivery.id, idempotency_key: `${id}:${control}:${record.row.requestDigest}` };
      const command: ServerToNodeMessage = control === "start" ? { ...common, type: "product.source.recovery.v1", payload: ProductSourceRecoveryRequestV1Schema.parse(record.row.request) }
        : { ...common, type: control === "stop" ? "product.source.recovery.stop.v1" : "product.source.recovery.status.v1", payload: { version: 1, recovery_id: id, request_digest: record.row.requestDigest } };
      await ctx.db.transaction(async tx => { const row = await load(tx, id); if (control === "start") await startFence(tx, row); else await qualify(tx); current(); await options.transport.send(command); current(); }); return command;
    },
    async acknowledge(input: ProductSourceRecoveryAck) {
      const message = productSourceRecoveryAckSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("Recovery ACK node changed");
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, message.payload.recovery_id);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.recoveryId, row.id), eq(deliveries.sessionId, options.sessionId))).for("update");
        if (!delivery || message.payload.request_digest !== row.requestDigest || delivery.ack !== null && !same(delivery.ack, message)) throw AppError.conflict("Recovery ACK lacks its exact immutable delivery");
        if (delivery.ack === null) await tx.update(deliveries).set({ ack: message }).where(eq(deliveries.id, delivery.id)); await qualify(tx); });
    },
    async receive(input: ProductSourceRecoveryResult) {
      const message = productSourceRecoveryResultSchema.parse(input); current(); if (message.node_id !== identity.computerId) throw AppError.permissionDenied("Recovery result node changed");
      await ctx.db.transaction(async tx => {
        const row = await load(tx, message.payload.recovery_id); await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId))).for("update"); await qualify(tx);
        const [delivery] = await tx.select().from(deliveries).where(and(eq(deliveries.id, message.command_id), eq(deliveries.recoveryId, row.id), eq(deliveries.sessionId, options.sessionId)));
        if (!delivery) throw AppError.conflict("Recovery result has no exact issuing delivery");
        const facts = await readRequest(ctx, tx, row, false), result = inspectProductSourceRecoveryResultV1(facts.request, message.payload, sha), resultDigest = hash(result);
        if (result.outcome === "recovered" && !same(result.checkpoint.accepted_inputs, importedExecutionAcceptedInputsV1(facts.root.origin.execution_request)))
          throw AppError.conflict("Recovered unverified source changed the original accepted research or design");
        const [locked] = await tx.select().from(recoveries).where(eq(recoveries.id, row.id)).for("update");
        if (locked!.result !== null && (!same(locked!.result, result) || locked!.resultDigest !== resultDigest)) throw AppError.conflict("Recovery result is immutable");
        if (locked!.result === null) {
          await tx.update(recoveries).set({ result, resultDigest, resultDeliveryId: delivery.id, resultSessionId: options.sessionId }).where(eq(recoveries.id, row.id));
          if (result.outcome === "recovered") await tx.insert(checkpoints).values({ recoveryId: row.id, organizationId: ctx.organizationId, registrationId: row.registrationId,
            oldEpochId: result.checkpoint.old_epoch_id, newEpochId: result.checkpoint.new_epoch_id, generation: result.checkpoint.generation,
            deliveryId: delivery.id, sessionId: options.sessionId, requestDigest: row.requestDigest, resultDigest,
            checkpointDigest: productSourceRecoveryCheckpointDigestV1(result.checkpoint, sha), checkpoint: result.checkpoint, createdAt: ctx.clock.nowIso() });
        }
        await qualify(tx);
      });
      await ctx.db.transaction(async tx => { await qualify(tx); const row = await load(tx, message.payload.recovery_id);
        await options.transport.send({ kind: "command", id: message.command_id, idempotency_key: `receipt:${message.command_id}`, type: "product.source.recovery.receipt.v1",
          payload: { version: 1, recovery_id: row.id, request_digest: row.requestDigest }, result_digest: hash(message.payload), status: "accepted" }); current();
        await tx.insert(receipts).values({ recoveryId: row.id, organizationId: ctx.organizationId, deliveryId: row.resultDeliveryId!, sessionId: options.sessionId,
          requestDigest: row.requestDigest, resultDigest: row.resultDigest!, sentAt: ctx.clock.nowIso() }).onConflictDoNothing();
      });
    },
  };
}

export async function stopGoalSourceRecoveries(ctx: ServerContext, goalId: string) {
  const pending = await ctx.db.transaction(async tx => {
    const rows = await tx.select().from(recoveries).where(and(eq(recoveries.goalId, goalId), eq(recoveries.organizationId, ctx.organizationId)));
    const pending = rows.filter(row => row.result === null);
    for (const row of pending) await tx.update(recoveries).set({ stopRequested: true }).where(eq(recoveries.id, row.id));
    return pending;
  });
  for (const row of pending) await ctx.onSourceRecoveryQueued?.(row.id, "stop");
}
