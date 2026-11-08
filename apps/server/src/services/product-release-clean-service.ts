import { appendEvent, eventLog, goalAutomations, goals, productReleases, goalImportedValidations,
  goalImportedValidationPublications, sourceCleanGenerations, sourceCleanStops, sourceCleanOperationSettlements } from "@artoo/db";
import { ProductReleaseRequestSchema, SourceCleanStopIntentV1Schema, SourceCleanRestartGrantV1Schema,
  PRODUCT_RELEASE_CLEAN_FEATURE_V1, canonicalProductSourceTransferValueV1 as canonical, type ProductReleaseRequest } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { importedDesignHash as hash } from "./imported-design-completion-service.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { importedImplementationActorContext } from "./imported-execution-service.js";
import { readCleanValidationRoot } from "./clean-validation-origin-service.js";
import { bindCleanValidationPublication, cleanReleaseSourceOrigin } from "./clean-validation-release-service.js";
import type { AcceptedReleaseSource, ReleaseAcceptanceAutomation } from "./release-acceptance.js";
import { assertProductReleaseRetryDispatch, assertProductReleaseRetryHistory, type ProductReleasePairedSession } from "./product-release-retry-service.js";

type ReleaseRow = typeof productReleases.$inferSelect;

/** Old publication history is settled only by the whole-parent closure ledger.
 * It does not become a failed publication receipt or a retry token. */
async function requireReleaseSettlement(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow, generationId: string) {
  const root = await readCleanValidationRoot(ctx, tx, generationId);
  const [stop] = await tx.select().from(sourceCleanStops).where(and(eq(sourceCleanStops.id, root.cleanGeneration.predecessorStopId), eq(sourceCleanStops.organizationId, ctx.organizationId)));
  const intent = SourceCleanStopIntentV1Schema.parse(stop?.intent);
  const [settlement] = await tx.select().from(sourceCleanOperationSettlements).where(and(eq(sourceCleanOperationSettlements.organizationId, ctx.organizationId),
    eq(sourceCleanOperationSettlements.generationId, generationId), eq(sourceCleanOperationSettlements.kind, "release"), eq(sourceCleanOperationSettlements.operationId, release.id)));
  const [publication] = await tx.select().from(goalImportedValidationPublications).where(and(eq(goalImportedValidationPublications.releaseId, release.id), eq(goalImportedValidationPublications.organizationId, ctx.organizationId)));
  const [author] = publication ? await tx.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.id, publication.validationId), eq(goalImportedValidations.organizationId, ctx.organizationId))) : [];
  const destination = (author?.sessionBindings as { destination?: ProductReleasePairedSession } | null)?.destination;
  const request = ProductReleaseRequestSchema.parse(release.request), old = intent.registration;
  const ref = intent.operations.find(item => item.kind === "release" && item.operation_id === release.id);
  if (!settlement || !publication || !author || !destination || !ref || !request.imported_validation || request.imported_recovery || request.imported_clean
    || release.goalId !== root.goal.id || release.computerId !== old.binding.node_id || publication.originReviewId !== root.h6.id || author.originReviewId !== root.h6.id
    || publication.goalId !== release.goalId || publication.runId !== release.runId || publication.evidenceId !== release.evidenceId
    || author.runId !== release.runId || author.computerId !== release.computerId || canonical(request.imported_validation) !== canonical(publication.origin)
    || destination.computerId !== old.binding.node_id || destination.deviceId !== old.binding.device_id || destination.sessionId !== old.epoch.session_id
    || settlement.eventId !== root.cleanGeneration.settlementEventId || settlement.requestDigest !== hash(request) || ref.request_digest !== hash(request)
    || settlement.runId !== null || settlement.goalId !== root.goal.id || settlement.computerId !== release.computerId)
    throw AppError.conflict("Clean publication interruption lost its exact old operation, owner and whole-process settlement");
  return root;
}

export async function settleCleanPublications(ctx: ServerContext, tx: DrizzleDb, generationId: string): Promise<void> {
  const root = await readCleanValidationRoot(ctx, tx, generationId);
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== root.h6.actorUserId)
    throw AppError.permissionDenied("Only the initiating GoalRunner may settle clean publication history");
  const operations = await tx.select().from(sourceCleanOperationSettlements).where(and(eq(sourceCleanOperationSettlements.generationId, generationId),
    eq(sourceCleanOperationSettlements.organizationId, ctx.organizationId), eq(sourceCleanOperationSettlements.kind, "release")));
  for (const operation of operations) {
    const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.id, operation.operationId), eq(productReleases.organizationId, ctx.organizationId))).for("update");
    if (!release) throw AppError.conflict("Clean publication operation is missing");
    await requireReleaseSettlement(ctx, tx, release, generationId);
    if (release.status === "interrupted") {
      if (release.interruptedCleanGenerationId !== generationId || release.interruptedRecoveryId !== null
        || release.interruptionEventId !== root.cleanGeneration.settlementEventId || release.interruptionCheckpointDigest !== root.cleanGeneration.checkpointDigest || release.receipt !== null)
        throw AppError.conflict("Clean interruption is immutable");
      continue;
    }
    if (release.status !== "queued") continue;
    if (release.receipt !== null) throw AppError.conflict("Queued publication unexpectedly has a receipt");
    const changed = await tx.update(productReleases).set({ status: "interrupted", interruptedCleanGenerationId: generationId,
      interruptionEventId: root.cleanGeneration.settlementEventId, interruptionCheckpointDigest: root.cleanGeneration.checkpointDigest, updatedAt: ctx.clock.nowIso() })
      .where(and(eq(productReleases.id, release.id), eq(productReleases.status, "queued"))).returning({ id: productReleases.id });
    if (changed.length !== 1) throw AppError.conflict("Publication changed before clean interruption");
  }
}

async function currentAuthorization(ctx: ServerContext, tx: DrizzleDb, source: AcceptedReleaseSource) {
  const refs = source.cleanOrigin;
  if (!refs) throw AppError.conflict("Recovery publication has no accepted source");
  if (!source.run.requestedByUserId) throw AppError.conflict("Recovery author has no initiating user");
  const acting = importedImplementationActorContext(ctx, source.run.requestedByUserId);
  const root = await readCleanValidationRoot(acting, tx, refs.cleanGenerationId, { live: true });
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
async function cleanPublicationDecision(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow): Promise<ReleaseRow> {
  const request = ProductReleaseRequestSchema.parse(release.request);
  if (!request.retry) return release;
  const [root] = await tx.select().from(productReleases).where(and(eq(productReleases.id, request.retry.root_release_id),
    eq(productReleases.organizationId, ctx.organizationId)));
  const initial = root && ProductReleaseRequestSchema.parse(root.request);
  const immutable = ({ release_id: _id, retry: _retry, ...source }: ProductReleaseRequest) => source;
  if (!root || !initial?.imported_clean || initial.retry || !["failed", "rolled_back"].includes(root.status) || root.receipt === null
    || root.goalId !== release.goalId || root.projectId !== release.projectId || root.computerId !== release.computerId
    || root.runId !== release.runId || root.evidenceId !== release.evidenceId || root.cleanGenerationId !== release.cleanGenerationId
    || root.rootReleaseId !== null || root.retryOfReleaseId !== null || root.retryAuthorizationEventId !== null
    || release.cleanOfReleaseId !== null || release.cleanAuthorizationEventId !== null
    || release.rootReleaseId !== root.id || release.retryOfReleaseId !== request.retry.previous_release_id
    || release.retryAuthorizationEventId !== request.retry.authorization.event_id
    || canonical(immutable(request)) !== canonical(immutable(initial)))
    throw AppError.conflict("Recovery publication retry lost its immutable initial recovery decision and source");
  return root;
}

/** History binds both decisions; live dispatch additionally rechecks current consent, sessions and budget. */
export async function assertCleanPublicationAuthorization(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow,
  source: AcceptedReleaseSource, live: boolean): Promise<void> {
  const request = ProductReleaseRequestSchema.parse(release.request), origin = request.imported_clean, refs = source.cleanOrigin;
  const decision = await cleanPublicationDecision(ctx, tx, release);
  if (!origin || !refs || decision.cleanGenerationId !== origin.clean_generation_id || decision.cleanOfReleaseId !== origin.interrupted_release_id
    || decision.cleanAuthorizationEventId !== origin.authorization.event_id || decision.rootReleaseId !== null
    || decision.retryOfReleaseId !== null || decision.retryAuthorizationEventId !== null
    || canonical(cleanReleaseSourceOrigin(origin)) !== canonical(refs.releaseOrigin))
    throw AppError.conflict("Recovery publication lost its original separate recovery lineage");
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, origin.authorization.event_id), eq(eventLog.organizationId, ctx.organizationId)));
  const [recovery] = await tx.select().from(sourceCleanGenerations).where(and(eq(sourceCleanGenerations.id, origin.clean_generation_id),
    eq(sourceCleanGenerations.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  const cost = origin.interrupted_release_id === null ? 0 : 1;
  if (!event || !recovery || event.type !== "product.release.clean-authorized" || event.actorType !== "system" || event.actorId !== "goal_runner"
    || event.goalId !== release.goalId || event.projectId !== release.projectId || event.runId !== release.runId || event.correlationId !== decision.id
    || origin.authorization.goal_id !== release.goalId || origin.authorization.actor_user_id !== SourceCleanRestartGrantV1Schema.parse(recovery.grant).authorization.actor_user_id
    || payload?.release_id !== decision.id || payload.clean_generation_id !== refs.cleanGenerationId || payload.interrupted_release_id !== decision.cleanOfReleaseId
    || payload.generation !== decision.publicationGeneration || payload.source_digest !== refs.sourceDigest
    || payload.restart_digest !== refs.restartDigest || payload.actor_user_id !== origin.authorization.actor_user_id
    || canonical(payload.session) !== canonical(refs.session)
    || payload.attempt_index !== origin.authorization.attempt_index || payload.previous_retry_count !== origin.authorization.attempt_index - cost)
    throw AppError.conflict("Recovery publication lost its exact independent authorization event");
  if (origin.interrupted_release_id) {
    const [previous] = await tx.select().from(productReleases).where(and(eq(productReleases.id, origin.interrupted_release_id),
      eq(productReleases.organizationId, ctx.organizationId)));
    if (!previous || previous.status !== "interrupted" || previous.receipt !== null || previous.interruptedCleanGenerationId !== refs.cleanGenerationId
      || previous.goalId !== release.goalId || previous.projectId !== release.projectId || previous.computerId !== release.computerId
      || decision.publicationGeneration !== previous.publicationGeneration + 1 || previous.runId === release.runId || previous.evidenceId === release.evidenceId)
      throw AppError.conflict("Recovery publication must use a new author and evidence after its exact interrupted predecessor");
    await requireReleaseSettlement(ctx, tx, previous, refs.cleanGenerationId);
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
export async function assertCleanPublicationReceiptSession(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow,
  session?: ProductReleasePairedSession): Promise<void> {
  if (!ProductReleaseRequestSchema.parse(release.request).imported_clean) return;
  const decision = await cleanPublicationDecision(ctx, tx, release);
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, decision.cleanAuthorizationEventId ?? ""),
    eq(eventLog.organizationId, ctx.organizationId)));
  const expected = (event?.payload as { session?: ProductReleasePairedSession } | undefined)?.session;
  if (!session || !expected || canonical(session) !== canonical(expected) || canonical(ctx.getPairedNodeSession?.(release.computerId)) !== canonical(session))
    throw AppError.permissionDenied("Recovery publication receipt requires its original newly authorized session");
}

/** New H9 source after interruption gets a separate publication ID; old receipt-less history is never converted into a failed retry. */
export async function ensureCleanProductRelease(ctx: ServerContext, tx: DrizzleDb, automation: ReleaseAcceptanceAutomation,
  source: AcceptedReleaseSource, previous?: ReleaseRow): Promise<{ status: "pending" | "failed"; reason: string }> {
  const refs = source.cleanOrigin;
  if (!refs) throw AppError.conflict("Recovery publication has no final source");
  const current = await currentAuthorization(ctx, tx, source), { goal, budgets, session } = current;
  if (automation.goalId !== goal.id || automation.planId !== source.binding.plan.id) throw AppError.conflict("Recovery publication goal changed");
  const [head] = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId),
    eq(productReleases.goalId, goal.id))).orderBy(desc(productReleases.publicationGeneration)).limit(1).for("update");
  if ((head?.id ?? null) !== (previous?.id ?? null)) throw AppError.conflict("Recovery publication predecessor changed");
  if (previous) {
    if (previous.status !== "interrupted" || previous.receipt !== null || previous.interruptedCleanGenerationId !== refs.cleanGenerationId)
      throw AppError.conflict("Recovery publication cannot cancel a queued or settled predecessor");
    await requireReleaseSettlement(ctx, tx, previous, refs.cleanGenerationId);
  }
  const cost = previous ? 1 : 0, attempt = goal.retryCount + cost;
  if (attempt > 2147483647 || budgets.max_retries !== null && attempt > budgets.max_retries)
    return { status: "failed", reason: "Recovery publication reached the original cumulative retry budget." };
  const binding = source.capabilities.binding, computerId = source.run.computerId, workspace = source.run.workspaceRoot;
  if (!computerId || !workspace || ctx.supportsExecutionFeature?.(computerId, PRODUCT_RELEASE_CLEAN_FEATURE_V1) !== true
    || ctx.supportsReleaseProfile?.(computerId, binding.release_profile_id, goal.projectId, workspace, binding.verification_profile_id) !== true
    || canonical(ctx.getReleaseCapabilities?.(computerId, binding.release_profile_id, goal.projectId, workspace, binding.verification_profile_id)) !== canonical(source.capabilities))
    return { status: "pending", reason: "Waiting for the newly authorized recovery publication profile and capabilities." };
  const id = ctx.idGen.generate("release"), generation = previous ? previous.publicationGeneration + 1 : 0;
  const event = await appendEvent(tx, buildEvent(ctx, { type: "product.release.clean-authorized", actorType: "system", actorId: "goal_runner",
    correlationId: id, goalId: goal.id, projectId: goal.projectId, runId: source.run.id, payload: { release_id: id, clean_generation_id: refs.cleanGenerationId,
      interrupted_release_id: previous?.id ?? null, generation, source_digest: refs.sourceDigest, restart_digest: refs.restartDigest,
      actor_user_id: current.automation.actorUserId, previous_retry_count: goal.retryCount, attempt_index: attempt, session } }));
  const request = ProductReleaseRequestSchema.parse({ version: 1, release_id: id, goal_id: goal.id, project_id: goal.projectId, run_id: source.run.id,
    release_profile_id: binding.release_profile_id, verification_request_id: source.evidence.requestId,
    verification_profile_id: source.evidence.payload.profile_id, verification_profile_digest: source.evidence.payload.profile_digest,
    subject_digest: source.evidence.payload.subject_digest, acceptance_binding: source.binding,
    imported_clean: { ...refs.releaseOrigin, interrupted_release_id: previous?.id ?? null,
      authorization: { event_id: event.id, goal_id: goal.id, actor_user_id: current.automation.actorUserId, attempt_index: attempt } } });
  if (cost) {
    const changed = await tx.update(goals).set({ retryCount: attempt, updatedAt: ctx.clock.nowIso() })
      .where(and(eq(goals.id, goal.id), eq(goals.retryCount, goal.retryCount))).returning({ id: goals.id });
    if (changed.length !== 1) throw AppError.conflict("Recovery publication cumulative retry count changed");
  }
  await tx.insert(productReleases).values({ id, organizationId: ctx.organizationId, goalId: goal.id, projectId: goal.projectId, computerId,
    runId: source.run.id, evidenceId: source.evidence.id, status: "queued", request, publicationGeneration: generation,
    cleanGenerationId: refs.cleanGenerationId, cleanOfReleaseId: previous?.id ?? null, cleanAuthorizationEventId: event.id,
    createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso() });
  await bindCleanValidationPublication(ctx, tx, id, source);
  await appendEvent(tx, buildEvent(ctx, { type: "product.release.queued", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: goal.id, projectId: goal.projectId, runId: source.run.id, payload: { release_id: id, request } }));
  return { status: "pending", reason: "Publishing the newly verified and independently reviewed recovered product." };
}
