import { appendEvent, devices, deviceTokens, eventLog, goalAutomations, goals, productReleases, productReleaseRetrySources, runs } from "@artoo/db";
import { PRODUCT_RELEASE_RETRY_FEATURE_V1, ProductReleaseRequestSchema, ProductReleaseReceiptSchema,
  canonicalReleaseJson, canonicalProductReleaseRequest, type ProductReleaseReceipt, type ProductReleaseRequest } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { bindImportedValidationPublication } from "./imported-validation-release-service.js";
import { bindRecoveryValidationPublication } from "./recovery-validation-release-service.js";
import { bindCleanValidationPublication } from "./clean-validation-release-service.js";
import type { AcceptedReleaseSource } from "./release-acceptance.js";

type ReleaseRow = typeof productReleases.$inferSelect;
export type ProductReleasePairedSession = NonNullable<ReturnType<NonNullable<ServerContext["getPairedNodeSession"]>>>;
const sha = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
export const releaseRequestDigest = (request: ProductReleaseRequest) => sha(canonicalProductReleaseRequest(request));
export const releaseReceiptDigest = (receipt: ProductReleaseReceipt) => sha(canonicalReleaseJson(ProductReleaseReceiptSchema.parse(receipt)));
function subject(request: ProductReleaseRequest) {
  const { release_id: _release, retry: _retry, ...immutable } = request;
  return immutable;
}
function storedSession(source: typeof productReleaseRetrySources.$inferSelect): ProductReleasePairedSession {
  return { computerId: source.computerId, deviceId: source.deviceId, tokenLookup: source.tokenLookup, sessionId: source.sessionId };
}

/** The binding supplies the already authenticated identity; no remote payload supplies a session. */
export async function qualifyProductReleaseRetrySession(ctx: ServerContext, tx: DrizzleDb, computerId: string,
  session?: ProductReleasePairedSession): Promise<ProductReleasePairedSession | undefined> {
  if (!session || ctx.supportsExecutionFeature?.(computerId, PRODUCT_RELEASE_RETRY_FEATURE_V1) !== true) return undefined;
  if (session.computerId !== computerId || !isDeepStrictEqual(ctx.getPairedNodeSession?.(computerId), session))
    throw AppError.permissionDenied("Publication retry requires its original current paired session");
  const [device] = await tx.select().from(devices).where(and(eq(devices.id, session.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
  const [token] = await tx.select().from(deviceTokens).where(and(eq(deviceTokens.organizationId, ctx.organizationId), eq(deviceTokens.deviceId, session.deviceId),
    eq(deviceTokens.tokenLookup, session.tokenLookup), eq(deviceTokens.kind, "node"), eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
  if (!device || device.trust !== "active" || device.revokedAt !== null || device.computerId !== computerId || !token
    || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso()))
    throw AppError.permissionDenied("Publication retry node credential is no longer active");
  return session;
}

export async function recordProductReleaseRetrySource(ctx: ServerContext, tx: DrizzleDb, row: ReleaseRow,
  receipt: ProductReleaseReceipt, receiptEventId: string, session: ProductReleasePairedSession): Promise<void> {
  const projection = receipt.retry_source;
  if (!projection) throw AppError.conflict("Publication has no executor-owned settled retry source");
  if (projection.recovery.kind === "previous-restored") {
    const recovery = projection.recovery;
    const [previous] = await tx.select().from(productReleases).where(and(eq(productReleases.id, recovery.active_release_id), eq(productReleases.organizationId, ctx.organizationId)));
    const restored = ProductReleaseReceiptSchema.safeParse(previous?.receipt);
    if (!previous || previous.status !== "published" || previous.computerId !== row.computerId || previous.projectId !== row.projectId
      || !restored.success || restored.data.outcome !== "published" || restored.data.artifact_digest !== recovery.active_artifact_digest
      // Failed publication keeps endpoint=null; the immutable profile digest still binds its configured URL.
      || receipt.endpoint !== null && restored.data.endpoint !== receipt.endpoint || restored.data.release_profile_digest !== receipt.release_profile_digest
      || restored.data.request.release_profile_id !== receipt.request.release_profile_id
      || !isDeepStrictEqual([...receipt.recovery_checks!].map(check => [check.path, check.body_digest]).sort(),
        restored.data.health_checks.map(check => [check.path, check.body_digest]).sort()))
      throw AppError.conflict("Retry recovery has no exact previously published version and measured paths");
  }
  await tx.insert(productReleaseRetrySources).values({ releaseId: row.id, organizationId: ctx.organizationId,
    computerId: row.computerId, deviceId: session.deviceId, tokenLookup: session.tokenLookup, sessionId: session.sessionId,
    sourceId: projection.source_id, requestDigest: releaseRequestDigest(receipt.request), receiptDigest: releaseReceiptDigest(receipt),
    projection, receiptEventId, receivedAt: ctx.clock.nowIso() });
}

/** A late terminal fact may follow pause, but the successor's original node session remains mandatory. */
export async function assertProductReleaseRetryReceiptSession(ctx: ServerContext, tx: DrizzleDb, row: ReleaseRow,
  session?: ProductReleasePairedSession): Promise<void> {
  const retry = ProductReleaseRequestSchema.parse(row.request).retry;
  if (!retry) return;
  const [source] = await tx.select().from(productReleaseRetrySources).where(and(eq(productReleaseRetrySources.releaseId, retry.previous_release_id),
    eq(productReleaseRetrySources.organizationId, ctx.organizationId)));
  if (!source || !isDeepStrictEqual(session, storedSession(source)) || !await qualifyProductReleaseRetrySession(ctx, tx, row.computerId, session))
    throw AppError.permissionDenied("Retry receipt does not belong to its original paired executor session");
}

async function originalAuthorization(ctx: ServerContext, tx: DrizzleDb, release: ReleaseRow, attemptIndex?: number) {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, release.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, release.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, release.runId), eq(runs.organizationId, ctx.organizationId)));
  if (!goal || !automation || !run || goal.status !== "running" || !automation.planId || goal.currentPlanId !== automation.planId
    || !["executing", "waiting"].includes(automation.status) || run.requestedByUserId !== automation.actorUserId
    || run.aiDataSharingConsentId !== automation.consentId || run.aiDataSharingPolicyVersion !== automation.policyVersion
    || run.status !== "completed" || run.computerId !== release.computerId)
    throw AppError.conflict("Publication retry lost its original running goal, author or authorization");
  await requireAiSharingAuthorization({ ...ctx, actorUserId: automation.actorUserId }, tx,
    { consentId: automation.consentId, policyVersion: automation.policyVersion });
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= budgets.max_elapsed_ms)
    throw AppError.conflict("Publication retry reached the original elapsed goal budget");
  if (attemptIndex !== undefined && (goal.retryCount < attemptIndex || budgets.max_retries !== null && attemptIndex > budgets.max_retries))
    throw AppError.conflict("Publication retry exceeded the original cumulative retry budget");
  return { goal, automation, run, budgets };
}

/** Historical binding never grants a new dispatch. The live entry point additionally rechecks the current owner and budget. */
async function assertRetryBinding(ctx: ServerContext, tx: DrizzleDb, row: ReleaseRow,
  live: boolean, session?: ProductReleasePairedSession): Promise<void> {
  const request = ProductReleaseRequestSchema.parse(row.request), retry = request.retry;
  if (!retry) return;
  const [source] = await tx.select().from(productReleaseRetrySources).where(and(eq(productReleaseRetrySources.releaseId, retry.previous_release_id),
    eq(productReleaseRetrySources.organizationId, ctx.organizationId)));
  const [previous] = await tx.select().from(productReleases).where(and(eq(productReleases.id, retry.previous_release_id), eq(productReleases.organizationId, ctx.organizationId)));
  const [head] = await tx.select({ id: productReleases.id }).from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, row.goalId)))
    .orderBy(desc(productReleases.publicationGeneration)).limit(1);
  const prior = ProductReleaseReceiptSchema.safeParse(previous?.receipt);
  if (!source || !previous || !prior.success || !["failed", "rolled_back"].includes(previous.status) || prior.data.outcome !== previous.status || !prior.data.retry_source
    || live && (head?.id !== row.id || row.status !== "queued") || previous.goalId !== row.goalId || previous.projectId !== row.projectId || previous.computerId !== row.computerId
    || previous.runId !== row.runId || previous.evidenceId !== row.evidenceId || retry.generation !== (prior.data.request.retry?.generation ?? 0) + 1
    || retry.root_release_id !== (previous.rootReleaseId ?? previous.id) || row.publicationGeneration !== previous.publicationGeneration + 1
    || row.rootReleaseId !== retry.root_release_id || row.retryOfReleaseId !== previous.id || row.retryAuthorizationEventId !== retry.authorization.event_id
    || source.computerId !== row.computerId || source.sourceId !== retry.source_id || source.requestDigest !== retry.previous_request_digest || source.receiptDigest !== retry.previous_receipt_digest
    || source.requestDigest !== releaseRequestDigest(prior.data.request) || source.receiptDigest !== releaseReceiptDigest(prior.data)
    || !isDeepStrictEqual(source.projection, prior.data.retry_source) || !isDeepStrictEqual(previous.request, prior.data.request)
    || !isDeepStrictEqual(subject(request), subject(prior.data.request)) || live && !isDeepStrictEqual(session, storedSession(source)))
    throw AppError.conflict("Publication retry changed its immutable predecessor, source, generation or paired session");
  if (live && !await qualifyProductReleaseRetrySession(ctx, tx, row.computerId, session))
    throw AppError.conflict("Publication node does not support the original live retry source");
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId)));
  if (!run || run.requestedByUserId !== retry.authorization.actor_user_id)
    throw AppError.conflict("Publication retry lost its original initiating user");
  if (live) await originalAuthorization(ctx, tx, row, retry.authorization.attempt_index);
  const [event] = await tx.select().from(eventLog).where(and(eq(eventLog.id, retry.authorization.event_id), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = event?.payload as Record<string, unknown> | undefined;
  const expected = { release_id: row.id, root_release_id: retry.root_release_id, previous_release_id: previous.id, generation: retry.generation,
    source_id: retry.source_id, previous_request_digest: retry.previous_request_digest, previous_receipt_digest: retry.previous_receipt_digest,
    actor_user_id: retry.authorization.actor_user_id, previous_retry_count: retry.authorization.attempt_index - 1, attempt_index: retry.authorization.attempt_index, session: storedSession(source) };
  if (!event || event.type !== "product.release.retry-authorized" || event.actorType !== "system" || event.actorId !== "goal_runner"
    || event.goalId !== row.goalId || event.projectId !== row.projectId || event.runId !== row.runId || event.correlationId !== row.id
    || retry.authorization.goal_id !== row.goalId || !isDeepStrictEqual(payload, expected))
    throw AppError.conflict("Publication retry lost its original system decision and initiating user");
}

export async function assertProductReleaseRetryHistory(ctx: ServerContext, tx: DrizzleDb, row: ReleaseRow): Promise<void> {
  await assertRetryBinding(ctx, tx, row, false);
}

/** Idempotent delivery uses the same successor and its original live paired owner. */
export async function assertProductReleaseRetryDispatch(ctx: ServerContext, tx: DrizzleDb, row: ReleaseRow,
  session?: ProductReleasePairedSession): Promise<void> {
  await assertRetryBinding(ctx, tx, row, true, session);
}

/** Caller holds the goal and current release locks; no side effect is dispatched before commit. */
export async function ensureProductReleaseRetry(ctx: ServerContext, tx: DrizzleDb, previous: ReleaseRow,
  accepted?: AcceptedReleaseSource): Promise<{ status: "pending" | "failed"; reason: string }> {
  const receipt = ProductReleaseReceiptSchema.parse(previous.receipt);
  const [source] = await tx.select().from(productReleaseRetrySources).where(and(eq(productReleaseRetrySources.releaseId, previous.id),
    eq(productReleaseRetrySources.organizationId, ctx.organizationId)));
  if (!receipt.retry_source || !source) return { status: "failed", reason: receipt.reason ?? "Publication failed without an original settled executor retry source." };
  const session = ctx.getPairedNodeSession?.(previous.computerId);
  if (!session || !isDeepStrictEqual(session, storedSession(source)) || !await qualifyProductReleaseRetrySession(ctx, tx, previous.computerId, session))
    return { status: "failed", reason: "Publication retry requires the original live executor and paired session." };
  const { goal, automation, run, budgets } = await originalAuthorization(ctx, tx, previous);
  if (budgets.max_retries !== null && goal.retryCount >= budgets.max_retries || goal.retryCount >= 2147483647)
    return { status: "failed", reason: "Publication retry reached the original cumulative retry budget." };
  const prior = ProductReleaseRequestSchema.parse(previous.request);
  if (source.requestDigest !== releaseRequestDigest(prior) || source.receiptDigest !== releaseReceiptDigest(receipt)
    || !isDeepStrictEqual(source.projection, receipt.retry_source)) throw AppError.conflict("Publication retry source changed after receipt ingestion");
  if (!run.workspaceRoot || ctx.supportsReleaseProfile?.(previous.computerId, prior.release_profile_id, previous.projectId,
    run.workspaceRoot, prior.verification_profile_id) !== true
    || accepted && !isDeepStrictEqual(ctx.getReleaseCapabilities?.(previous.computerId, prior.release_profile_id, previous.projectId,
      run.workspaceRoot, prior.verification_profile_id), accepted.capabilities))
    return { status: "pending", reason: "Waiting for the original publication profile and acceptance capabilities." };
  // The database orders all goal publications; wire generation counts only this exact-source retry chain.
  const id = ctx.idGen.generate("release"), publicationGeneration = previous.publicationGeneration + 1,
    generation = (prior.retry?.generation ?? 0) + 1, attemptIndex = goal.retryCount + 1;
  const rootReleaseId = previous.rootReleaseId ?? previous.id;
  const payload = { release_id: id, root_release_id: rootReleaseId, previous_release_id: previous.id, generation, source_id: source.sourceId,
    previous_request_digest: source.requestDigest, previous_receipt_digest: source.receiptDigest, actor_user_id: automation.actorUserId,
    previous_retry_count: goal.retryCount, attempt_index: attemptIndex, session };
  const event = await appendEvent(tx, buildEvent(ctx, { type: "product.release.retry-authorized", actorType: "system", actorId: "goal_runner",
    correlationId: id, goalId: goal.id, projectId: previous.projectId, runId: run.id, payload }));
  const request = ProductReleaseRequestSchema.parse({ ...prior, release_id: id,
    retry: { version: 1, root_release_id: rootReleaseId, previous_release_id: previous.id, generation, source_id: source.sourceId,
      previous_request_digest: source.requestDigest, previous_receipt_digest: source.receiptDigest,
      authorization: { event_id: event.id, goal_id: goal.id, actor_user_id: automation.actorUserId, attempt_index: attemptIndex } } });
  const changed = await tx.update(goals).set({ retryCount: attemptIndex, updatedAt: ctx.clock.nowIso() })
    .where(and(eq(goals.id, goal.id), eq(goals.retryCount, goal.retryCount))).returning({ id: goals.id });
  if (changed.length !== 1) throw AppError.conflict("Original publication retry counter changed");
  const [next] = await tx.insert(productReleases).values({ id, organizationId: ctx.organizationId, goalId: previous.goalId, projectId: previous.projectId,
    computerId: previous.computerId, runId: previous.runId, evidenceId: previous.evidenceId, status: "queued", request,
    publicationGeneration, rootReleaseId, retryOfReleaseId: previous.id, retryAuthorizationEventId: event.id,
    ...(prior.imported_recovery ? { recoveryId: prior.imported_recovery.recovery_id } : {}),
    ...(prior.imported_clean ? { cleanGenerationId: prior.imported_clean.clean_generation_id } : {}),
    createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso() }).returning();
  if (accepted?.importedOrigin) await bindImportedValidationPublication(ctx, tx, id, accepted);
  if (prior.imported_clean) {
    if (!accepted?.cleanOrigin) throw AppError.conflict("Clean publication retry requires its original newly accepted source");
    await bindCleanValidationPublication(ctx, tx, id, accepted);
  } else if (prior.imported_recovery) {
    if (!accepted?.recoveryOrigin) throw AppError.conflict("Recovered publication retry requires its original accepted source");
    await bindRecoveryValidationPublication(ctx, tx, id, accepted);
  }
  await assertProductReleaseRetryDispatch(ctx, tx, next!, session);
  await appendEvent(tx, buildEvent(ctx, { type: "product.release.queued", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: previous.goalId, projectId: previous.projectId, runId: previous.runId, payload: { release_id: id, request } }));
  return { status: "pending", reason: "Retrying the same verified product with a new bounded publication attempt." };
}
