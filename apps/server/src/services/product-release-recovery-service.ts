import { appendEvent, eventLog, goalAutomations, goals, productReleases, goalImportedValidations,
  goalImportedValidationPublications, goalSourceRecoveries, goalSourceRecoveryCheckpoints, goalSourceRecoveryReceipts,
  goalSourceRecoverySettlements, nodeRecoveryRegistrations } from "@artoo/db";
import { ProductReleaseRequestSchema, ProductSourceRecoveryRequestV1Schema, inspectProductSourceRecoveryResultV1,
  productSourceRecoveryCheckpointDigestV1, canonicalProductSourceTransferValueV1 as canonical, type ProductReleaseRequest } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignSha as sha, importedDesignHash as hash } from "./imported-design-completion-service.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { importedImplementationActorContext } from "./imported-execution-service.js";
import { readRecoveryValidationRoot } from "./recovery-validation-source-service.js";
import { bindRecoveryValidationPublication, recoveryReleaseSourceOrigin } from "./recovery-validation-release-service.js";
import type { AcceptedReleaseSource, ReleaseAcceptanceAutomation } from "./release-acceptance.js";
import { assertProductReleaseRetryDispatch, assertProductReleaseRetryHistory, type ProductReleasePairedSession } from "./product-release-retry-service.js";

type ReleaseRow = typeof productReleases.$inferSelect;

/** Re-read the exact closed result, checkpoint, receipt and system settlement; a checkpoint alone has no authority. */
async function readSettledRecovery(ctx: ServerContext, tx: DrizzleDb, recoveryId: string) {
  const [recovery] = await tx.select().from(goalSourceRecoveries).where(and(eq(goalSourceRecoveries.id, recoveryId),
    eq(goalSourceRecoveries.organizationId, ctx.organizationId))).for("update");
  const [stored] = await tx.select().from(goalSourceRecoveryCheckpoints).where(and(eq(goalSourceRecoveryCheckpoints.recoveryId, recoveryId),
    eq(goalSourceRecoveryCheckpoints.organizationId, ctx.organizationId)));
  const [receipt] = await tx.select().from(goalSourceRecoveryReceipts).where(and(eq(goalSourceRecoveryReceipts.recoveryId, recoveryId),
    eq(goalSourceRecoveryReceipts.organizationId, ctx.organizationId)));
  if (!recovery || !stored || !receipt || !recovery.settledAt || !recovery.settlementEventId)
    throw AppError.conflict("Publication interruption requires committed recovery closure and settlement");
  const request = ProductSourceRecoveryRequestV1Schema.parse(recovery.request);
  const result = inspectProductSourceRecoveryResultV1(request, recovery.result, sha);
  const [registration] = await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.id, recovery.registrationId),
    eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId)));
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, recovery.settlementEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (result.outcome !== "recovered" || !registration || !event || hash(request) !== recovery.requestDigest || hash(result) !== recovery.resultDigest
    || canonical(stored.checkpoint) !== canonical(result.checkpoint) || stored.checkpointDigest !== productSourceRecoveryCheckpointDigestV1(result.checkpoint, sha)
    || stored.resultDigest !== recovery.resultDigest || stored.requestDigest !== recovery.requestDigest || stored.registrationId !== registration.id
    || stored.deliveryId !== recovery.resultDeliveryId || stored.sessionId !== recovery.currentSessionId
    || receipt.requestDigest !== recovery.requestDigest || receipt.resultDigest !== recovery.resultDigest
    || receipt.deliveryId !== recovery.resultDeliveryId || receipt.sessionId !== recovery.currentSessionId
    || request.recovery_id !== recovery.id || request.goal_id !== recovery.goalId || request.plan_id !== recovery.planId
    || request.registration_id !== registration.id || request.current_session_id !== recovery.currentSessionId
    || event.type !== "goal.source-recovery.settled" || event.actorType !== "system" || event.actorId !== "goal_runner"
    || event.goalId !== recovery.goalId || payload?.recovery_id !== recovery.id || payload.result_digest !== recovery.resultDigest
    || payload.checkpoint_digest !== stored.checkpointDigest || payload.actor_user_id !== recovery.actorUserId
    || payload.source_state !== "unverified" || payload.publication_authorized !== false)
    throw AppError.conflict("Publication interruption lost its exact guardian result, receipt or settlement event");
  return { recovery, request, checkpoint: result.checkpoint, checkpointDigest: stored.checkpointDigest, registration, event };
}

async function requireReleaseSettlement(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow, recoveryId: string) {
  const facts = await readSettledRecovery(ctx, tx, recoveryId);
  const [settlement] = await tx.select().from(goalSourceRecoverySettlements).where(and(
    eq(goalSourceRecoverySettlements.recoveryId, recoveryId), eq(goalSourceRecoverySettlements.organizationId, ctx.organizationId),
    eq(goalSourceRecoverySettlements.kind, "release"), eq(goalSourceRecoverySettlements.operationId, release.id)));
  const [publication] = await tx.select().from(goalImportedValidationPublications).where(and(
    eq(goalImportedValidationPublications.releaseId, release.id), eq(goalImportedValidationPublications.organizationId, ctx.organizationId)));
  const [author] = publication ? await tx.select().from(goalImportedValidations).where(and(
    eq(goalImportedValidations.id, publication.validationId), eq(goalImportedValidations.organizationId, ctx.organizationId))) : [];
  const destination = (author?.sessionBindings as { destination?: ProductReleasePairedSession } | null)?.destination;
  const reference = facts.checkpoint.operations.find(item => item.kind === "release" && item.operation_id === release.id);
  const request = ProductReleaseRequestSchema.parse(release.request);
  if (!settlement || !reference || !publication || !author || !destination || !request.imported_validation || request.imported_recovery
    || publication.originReviewId !== facts.recovery.originReviewId || author.originReviewId !== facts.recovery.originReviewId
    || publication.goalId !== release.goalId || publication.runId !== release.runId || publication.evidenceId !== release.evidenceId
    || author.runId !== release.runId || author.computerId !== release.computerId
    || destination.computerId !== facts.registration.computerId || destination.deviceId !== facts.registration.deviceId
    || destination.tokenLookup !== facts.registration.tokenLookup || destination.sessionId !== facts.registration.sessionId
    || facts.recovery.goalId !== release.goalId || facts.recovery.computerId !== release.computerId
    || settlement.goalId !== release.goalId || settlement.computerId !== release.computerId || settlement.runId !== null
    || settlement.eventId !== facts.event.id || settlement.requestDigest !== hash(request) || reference.request_digest !== hash(request))
    throw AppError.conflict("Publication interruption requires the exact old published operation and original destination session");
  return facts;
}

/** GoalRunner calls this only after its source recovery settlement, in the same locked transaction. */
export async function settleRecoveryPublications(ctx: ServerContext, tx: DrizzleDb, recoveryId: string): Promise<void> {
  const facts = await readSettledRecovery(ctx, tx, recoveryId);
  for (const operation of facts.checkpoint.operations.filter(item => item.kind === "release")) {
    const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.id, operation.operation_id),
      eq(productReleases.organizationId, ctx.organizationId))).for("update");
    if (!release) throw AppError.conflict("Recovery release operation is missing");
    await requireReleaseSettlement(ctx, tx, release, recoveryId);
    if (release.status === "interrupted") {
      if (release.interruptedRecoveryId !== recoveryId || release.interruptionEventId !== facts.event.id
        || release.interruptionCheckpointDigest !== facts.checkpointDigest || release.receipt !== null)
        throw AppError.conflict("Publication interruption is immutable");
      continue;
    }
    // Already received publication/health facts remain immutable history.
    if (release.status !== "queued") continue;
    if (release.receipt !== null) throw AppError.conflict("Queued publication unexpectedly has a receipt");
    const changed = await tx.update(productReleases).set({ status: "interrupted", interruptedRecoveryId: recoveryId,
      interruptionEventId: facts.event.id, interruptionCheckpointDigest: facts.checkpointDigest, updatedAt: ctx.clock.nowIso() })
      .where(and(eq(productReleases.id, release.id), eq(productReleases.status, "queued"))).returning({ id: productReleases.id });
    if (changed.length !== 1) throw AppError.conflict("Publication changed before qualified interruption");
  }
}

async function currentAuthorization(ctx: ServerContext, tx: DrizzleDb, source: AcceptedReleaseSource) {
  const refs = source.recoveryOrigin;
  if (!refs) throw AppError.conflict("Recovery publication has no accepted source");
  if (!source.run.requestedByUserId) throw AppError.conflict("Recovery author has no initiating user");
  const acting = importedImplementationActorContext(ctx, source.run.requestedByUserId);
  const root = await readRecoveryValidationRoot(acting, tx, refs.recoveryId, { live: true });
  const [currentGoal] = await tx.select().from(goals).where(and(eq(goals.id, root.goal.id),
    eq(goals.organizationId, ctx.organizationId))).for("update");
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, root.goal.id),
    eq(goalAutomations.organizationId, ctx.organizationId)));
  if (!currentGoal || !automation || currentGoal.status !== "running" || currentGoal.currentPlanId !== source.binding.plan.id
    || automation.planId !== source.binding.plan.id || !["executing", "waiting"].includes(automation.status)
    || source.run.requestedByUserId !== automation.actorUserId || source.run.aiDataSharingConsentId !== automation.consentId
    || source.run.aiDataSharingPolicyVersion !== automation.policyVersion || source.run.status !== "completed")
    throw AppError.conflict("Recovery publication lost its original current goal or initiating authorization");
  await requireAiSharingAuthorization({ ...ctx, actorUserId: automation.actorUserId }, tx,
    { consentId: automation.consentId, policyVersion: automation.policyVersion });
  const { budgets } = supportedGoalPolicy(currentGoal.budgets, currentGoal.stopConditions);
  if (budgets.max_elapsed_ms !== null && currentGoal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(currentGoal.runningSince)) >= budgets.max_elapsed_ms
    || budgets.max_retries !== null && currentGoal.retryCount > budgets.max_retries)
    throw AppError.conflict("Recovery publication reached the original cumulative goal budget");
  return { root, goal: currentGoal, automation, budgets, session: root.sessionBindings.destination };
}

/** Exact-source retries keep the initial recovery decision on their immutable root, never duplicate its unique predecessor columns. */
async function recoveryPublicationDecision(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow): Promise<ReleaseRow> {
  const request = ProductReleaseRequestSchema.parse(release.request);
  if (!request.retry) return release;
  const [root] = await tx.select().from(productReleases).where(and(eq(productReleases.id, request.retry.root_release_id),
    eq(productReleases.organizationId, ctx.organizationId)));
  const initial = root && ProductReleaseRequestSchema.parse(root.request);
  const immutable = ({ release_id: _id, retry: _retry, ...source }: ProductReleaseRequest) => source;
  if (!root || !initial?.imported_recovery || initial.retry || !["failed", "rolled_back"].includes(root.status) || root.receipt === null
    || root.goalId !== release.goalId || root.projectId !== release.projectId || root.computerId !== release.computerId
    || root.runId !== release.runId || root.evidenceId !== release.evidenceId || root.recoveryId !== release.recoveryId
    || root.rootReleaseId !== null || root.retryOfReleaseId !== null || root.retryAuthorizationEventId !== null
    || release.recoveryOfReleaseId !== null || release.recoveryAuthorizationEventId !== null
    || release.rootReleaseId !== root.id || release.retryOfReleaseId !== request.retry.previous_release_id
    || release.retryAuthorizationEventId !== request.retry.authorization.event_id
    || canonical(immutable(request)) !== canonical(immutable(initial)))
    throw AppError.conflict("Recovery publication retry lost its immutable initial recovery decision and source");
  return root;
}

/** History binds both decisions; live dispatch additionally rechecks current consent, sessions and budget. */
export async function assertRecoveryPublicationAuthorization(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow,
  source: AcceptedReleaseSource, live: boolean): Promise<void> {
  const request = ProductReleaseRequestSchema.parse(release.request), origin = request.imported_recovery, refs = source.recoveryOrigin;
  const decision = await recoveryPublicationDecision(ctx, tx, release);
  if (!origin || !refs || decision.recoveryId !== origin.recovery_id || decision.recoveryOfReleaseId !== origin.recovery_of_release_id
    || decision.recoveryAuthorizationEventId !== origin.authorization.event_id || decision.rootReleaseId !== null
    || decision.retryOfReleaseId !== null || decision.retryAuthorizationEventId !== null
    || canonical(recoveryReleaseSourceOrigin(origin)) !== canonical(refs.releaseOrigin))
    throw AppError.conflict("Recovery publication lost its original separate recovery lineage");
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, origin.authorization.event_id), eq(eventLog.organizationId, ctx.organizationId)));
  const [recovery] = await tx.select().from(goalSourceRecoveries).where(and(eq(goalSourceRecoveries.id, origin.recovery_id),
    eq(goalSourceRecoveries.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  const cost = origin.recovery_of_release_id === null ? 0 : 1;
  if (!event || !recovery || event.type !== "product.release.recovery-authorized" || event.actorType !== "system" || event.actorId !== "goal_runner"
    || event.goalId !== release.goalId || event.projectId !== release.projectId || event.runId !== release.runId || event.correlationId !== decision.id
    || origin.authorization.goal_id !== release.goalId || origin.authorization.actor_user_id !== recovery.actorUserId
    || payload?.release_id !== decision.id || payload.recovery_id !== refs.recoveryId || payload.recovery_of_release_id !== decision.recoveryOfReleaseId
    || payload.generation !== decision.publicationGeneration || payload.source_digest !== refs.sourceDigest
    || payload.checkpoint_digest !== refs.checkpointDigest || payload.actor_user_id !== origin.authorization.actor_user_id
    || canonical(payload.session) !== canonical(refs.session)
    || payload.attempt_index !== origin.authorization.attempt_index || payload.previous_retry_count !== origin.authorization.attempt_index - cost)
    throw AppError.conflict("Recovery publication lost its exact independent authorization event");
  if (origin.recovery_of_release_id) {
    const [previous] = await tx.select().from(productReleases).where(and(eq(productReleases.id, origin.recovery_of_release_id),
      eq(productReleases.organizationId, ctx.organizationId)));
    if (!previous || previous.status !== "interrupted" || previous.receipt !== null || previous.interruptedRecoveryId !== refs.recoveryId
      || previous.goalId !== release.goalId || previous.projectId !== release.projectId || previous.computerId !== release.computerId
      || decision.publicationGeneration !== previous.publicationGeneration + 1 || previous.runId === release.runId || previous.evidenceId === release.evidenceId)
      throw AppError.conflict("Recovery publication must use a new author and evidence after its exact interrupted predecessor");
    await requireReleaseSettlement(ctx, tx, previous, refs.recoveryId);
  } else if (decision.publicationGeneration !== 0) throw AppError.conflict("First recovery publication has an unexpected predecessor");
  if (request.retry) await assertProductReleaseRetryHistory(ctx, tx, release);
  if (live) {
    const current = await currentAuthorization(ctx, tx, source);
    const [head] = await tx.select({ id: productReleases.id }).from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId),
      eq(productReleases.goalId, release.goalId))).orderBy(desc(productReleases.publicationGeneration)).limit(1);
    if (release.status !== "queued" || head?.id !== release.id || current.goal.retryCount < origin.authorization.attempt_index
      || canonical(payload.session) !== canonical(current.session))
      throw AppError.conflict("Recovery publication budget or original new session changed");
    if (request.retry) await assertProductReleaseRetryDispatch(ctx, tx, release, current.session);
  }
}

/** A reconnect may replay a stored receipt, but cannot supply the first terminal fact for another live owner. */
export async function assertRecoveryPublicationReceiptSession(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow,
  session?: ProductReleasePairedSession): Promise<void> {
  if (!ProductReleaseRequestSchema.parse(release.request).imported_recovery) return;
  const decision = await recoveryPublicationDecision(ctx, tx, release);
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, decision.recoveryAuthorizationEventId ?? ""),
    eq(eventLog.organizationId, ctx.organizationId)));
  const expected = (event?.payload as { session?: ProductReleasePairedSession } | undefined)?.session;
  if (!session || !expected || canonical(session) !== canonical(expected) || canonical(ctx.getPairedNodeSession?.(release.computerId)) !== canonical(session))
    throw AppError.permissionDenied("Recovery publication receipt requires its original newly authorized session");
}

/** New H9 source after interruption gets a separate publication ID; old receipt-less history is never converted into a failed retry. */
export async function ensureRecoveryProductRelease(ctx: ServerContext, tx: DrizzleDb, automation: ReleaseAcceptanceAutomation,
  source: AcceptedReleaseSource, previous?: ReleaseRow): Promise<{ status: "pending" | "failed"; reason: string }> {
  const refs = source.recoveryOrigin;
  if (!refs) throw AppError.conflict("Recovery publication has no final source");
  const current = await currentAuthorization(ctx, tx, source), { goal, budgets, session } = current;
  if (automation.goalId !== goal.id || automation.planId !== source.binding.plan.id) throw AppError.conflict("Recovery publication goal changed");
  const [head] = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId),
    eq(productReleases.goalId, goal.id))).orderBy(desc(productReleases.publicationGeneration)).limit(1).for("update");
  if ((head?.id ?? null) !== (previous?.id ?? null)) throw AppError.conflict("Recovery publication predecessor changed");
  if (previous) {
    if (previous.status !== "interrupted" || previous.receipt !== null || previous.interruptedRecoveryId !== refs.recoveryId)
      throw AppError.conflict("Recovery publication cannot cancel a queued or settled predecessor");
    await requireReleaseSettlement(ctx, tx, previous, refs.recoveryId);
  }
  const cost = previous ? 1 : 0, attempt = goal.retryCount + cost;
  if (attempt > 2147483647 || budgets.max_retries !== null && attempt > budgets.max_retries)
    return { status: "failed", reason: "Recovery publication reached the original cumulative retry budget." };
  const binding = source.capabilities.binding, computerId = source.run.computerId, workspace = source.run.workspaceRoot;
  if (!computerId || !workspace || ctx.supportsReleaseProfile?.(computerId, binding.release_profile_id, goal.projectId, workspace, binding.verification_profile_id) !== true
    || canonical(ctx.getReleaseCapabilities?.(computerId, binding.release_profile_id, goal.projectId, workspace, binding.verification_profile_id)) !== canonical(source.capabilities))
    return { status: "pending", reason: "Waiting for the newly authorized recovery publication profile and capabilities." };
  const id = ctx.idGen.generate("release"), generation = previous ? previous.publicationGeneration + 1 : 0;
  const event = await appendEvent(tx, buildEvent(ctx, { type: "product.release.recovery-authorized", actorType: "system", actorId: "goal_runner",
    correlationId: id, goalId: goal.id, projectId: goal.projectId, runId: source.run.id, payload: { release_id: id, recovery_id: refs.recoveryId,
      recovery_of_release_id: previous?.id ?? null, generation, source_digest: refs.sourceDigest, checkpoint_digest: refs.checkpointDigest,
      actor_user_id: current.automation.actorUserId, previous_retry_count: goal.retryCount, attempt_index: attempt, session } }));
  const request = ProductReleaseRequestSchema.parse({ version: 1, release_id: id, goal_id: goal.id, project_id: goal.projectId, run_id: source.run.id,
    release_profile_id: binding.release_profile_id, verification_request_id: source.evidence.requestId,
    verification_profile_id: source.evidence.payload.profile_id, verification_profile_digest: source.evidence.payload.profile_digest,
    subject_digest: source.evidence.payload.subject_digest, acceptance_binding: source.binding,
    imported_recovery: { ...refs.releaseOrigin, recovery_of_release_id: previous?.id ?? null,
      authorization: { event_id: event.id, goal_id: goal.id, actor_user_id: current.automation.actorUserId, attempt_index: attempt } } });
  if (cost) {
    const changed = await tx.update(goals).set({ retryCount: attempt, updatedAt: ctx.clock.nowIso() })
      .where(and(eq(goals.id, goal.id), eq(goals.retryCount, goal.retryCount))).returning({ id: goals.id });
    if (changed.length !== 1) throw AppError.conflict("Recovery publication cumulative retry count changed");
  }
  await tx.insert(productReleases).values({ id, organizationId: ctx.organizationId, goalId: goal.id, projectId: goal.projectId, computerId,
    runId: source.run.id, evidenceId: source.evidence.id, status: "queued", request, publicationGeneration: generation,
    recoveryId: refs.recoveryId, recoveryOfReleaseId: previous?.id ?? null, recoveryAuthorizationEventId: event.id,
    createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso() });
  await bindRecoveryValidationPublication(ctx, tx, id, source);
  await appendEvent(tx, buildEvent(ctx, { type: "product.release.queued", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: goal.id, projectId: goal.projectId, runId: source.run.id, payload: { release_id: id, request } }));
  return { status: "pending", reason: "Publishing the newly verified and independently reviewed recovered product." };
}
