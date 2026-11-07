import { goalAutomations, goalImportedDesignContinuations, goalImportedDesignReviews, goalImportedProductReviews, goalProductHandoffs,
  goalImportedValidations, goalImportedValidationDeliveries, goalImportedValidationReviews, goalImportedValidationReviewDeliveries,
  goalImportedValidationPublications, productReleases, runs, nodeRecoveryRegistrations } from "@artoo/db";
import { SOURCE_CLEAN_RESTART_FEATURE_V1, canonicalProductSourceTransferValueV1 as canonical,
  type ProductSourceRecoveryRegistrationV1, type RecoveryOperationRefV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readImportedValidationOrigin, type ValidationRoot } from "./imported-validation-source-service.js";
import { assertImportedImplementationCredential as credential } from "./imported-execution-service.js";
import { requireActiveMember } from "./member-status.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { importedDesignHash as hash } from "./imported-design-completion-service.js";
import type { AuthenticatedTransferNode } from "./product-source-transfer-service.js";

/** Revalidates historical H6 inputs and retained authorization without pretending
 * that an old destination session is live after its complete native shutdown. */
export async function readSourceCleanOrigin(ctx: ServerContext, tx: DrizzleDb, reviewId: string,
  identity: AuthenticatedTransferNode, registration: ProductSourceRecoveryRegistrationV1) {
  const root = await readImportedValidationOrigin(ctx, tx, reviewId), old = root.sessionBindings.destination;
  await requireActiveMember(ctx, root.h6.actorUserId, tx);
  await requireAiSharingAuthorization({ ...ctx, actorUserId: root.h6.actorUserId }, tx, { consentId: root.h6.consentId, policyVersion: root.h6.policyVersion });
  if (root.goal.status !== "running" || root.goal.currentPlanId !== root.plan.id || root.automation.planId !== root.plan.id
    || !["executing", "waiting"].includes(root.automation.status) || root.h6.computerId !== identity.computerId || old.deviceId !== identity.deviceId
    || old.computerId !== registration.binding.node_id || old.deviceId !== registration.binding.device_id
    || old.sessionId !== registration.epoch.session_id || root.h6.workspaceRoot !== registration.binding.workspace_root)
    throw AppError.conflict("Clean restart requires its original accepted H6 goal, device and physical workspace");
  if (root.budgets.max_elapsed_ms !== null && root.goal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(root.goal.runningSince)) >= root.budgets.max_elapsed_ms)
    throw AppError.conflict("Clean restart goal elapsed budget reached");
  if (root.budgets.max_retries !== null && root.goal.retryCount > root.budgets.max_retries)
    throw AppError.conflict("Clean restart goal retry budget reached");
  // The initial clean-stop milestone changes only the accepted destination. It
  // cannot renew the original source computer/session or its research authority.
  if (root.sessionBindings.source.computerId === identity.computerId
    || canonical(ctx.getPairedNodeSession?.(root.sessionBindings.source.computerId)) !== canonical(root.sessionBindings.source))
    throw AppError.conflict("Clean restart retains its distinct original research-source session");
  for (const bound of [identity, root.sessionBindings.source].sort((a, b) => a.deviceId.localeCompare(b.deviceId))) await credential(ctx, tx, bound);
  const [h4] = await tx.select().from(goalImportedDesignReviews).where(eq(goalImportedDesignReviews.id, root.execution.reviewId));
  const [h3] = h4 ? await tx.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.id, h4.continuationId)) : [];
  const [h2] = h3 ? await tx.select().from(goalImportedProductReviews).where(eq(goalImportedProductReviews.id, h3.reviewId)) : [];
  const [h1] = h2 ? await tx.select().from(goalProductHandoffs).where(eq(goalProductHandoffs.id, h2.handoffId)) : [];
  if (!h4 || !h3 || !h2 || !h1 || [h4, h3, h2, h1].some(row => row.stopRequested) || !h1.qualifiedReceipt
    || canonical(h4.request) !== canonical(root.origin.execution_request.review_request)
    || canonical(h3.request) !== canonical(root.origin.execution_request.review_request.continuation_request)
    || canonical(h2.request) !== canonical(root.origin.execution_request.review_request.continuation_request.review_request)
    || !root.team.reviewer_instance_ids.includes(root.h6.reviewerInstanceId))
    throw AppError.conflict("Clean restart accepted transfer, research, design or independent team was revoked");
  return root;
}

/** Server derives the entire relevant dispatched set. A parent cannot omit an
 * inconvenient operation by submitting its own list. Uncovered active work on
 * this whole executor is rejected, including work in another workspace. */
export async function sourceCleanOperations(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot,
  registration: ProductSourceRecoveryRegistrationV1): Promise<RecoveryOperationRefV1[]> {
  const sessionId = registration.epoch.session_id, computerId = registration.binding.node_id;
  const [registered] = await tx.select().from(nodeRecoveryRegistrations).where(and(eq(nodeRecoveryRegistrations.id, registration.registration_id),
    eq(nodeRecoveryRegistrations.organizationId, ctx.organizationId)));
  if (!registered || canonical(registered.registration) !== canonical(registration)) throw AppError.conflict("Clean stop lost its exact original Guardian registration");
  const authors = await tx.select({ row: goalImportedValidations }).from(goalImportedValidations)
    .innerJoin(goalImportedValidationDeliveries, eq(goalImportedValidationDeliveries.validationId, goalImportedValidations.id))
    .where(and(eq(goalImportedValidations.organizationId, ctx.organizationId), eq(goalImportedValidations.originReviewId, root.h6.id),
      eq(goalImportedValidationDeliveries.sessionId, sessionId), eq(goalImportedValidationDeliveries.control, "start")));
  const authorRows = [...new Map(authors.map(({ row }) => [row.id, row])).values()];
  const reviewers = authorRows.length ? await tx.select({ row: goalImportedValidationReviews }).from(goalImportedValidationReviews)
    .innerJoin(goalImportedValidationReviewDeliveries, eq(goalImportedValidationReviewDeliveries.reviewId, goalImportedValidationReviews.id))
    .where(and(eq(goalImportedValidationReviews.organizationId, ctx.organizationId), inArray(goalImportedValidationReviews.validationId, authorRows.map(row => row.id)),
      eq(goalImportedValidationReviewDeliveries.sessionId, sessionId), eq(goalImportedValidationReviewDeliveries.control, "start"))) : [];
  const publicationRows = await tx.select({ row: productReleases }).from(productReleases)
    .innerJoin(goalImportedValidationPublications, eq(goalImportedValidationPublications.releaseId, productReleases.id))
    .where(and(eq(productReleases.organizationId, ctx.organizationId), eq(goalImportedValidationPublications.originReviewId, root.h6.id)));
  const operations: RecoveryOperationRefV1[] = [];
  for (const row of authorRows) {
    if (row.computerId !== computerId || row.workspaceRoot !== registration.binding.workspace_root || Date.parse(row.createdAt) < Date.parse(registered.createdAt))
      throw AppError.conflict("Clean stop author belongs to another workspace");
    operations.push({ kind: "validation", operation_id: row.id, request_digest: row.requestDigest, run_id: row.runId });
  }
  for (const row of [...new Map(reviewers.map(({ row }) => [row.id, row])).values()]) {
    if (row.computerId !== computerId || row.workspaceRoot !== registration.binding.workspace_root || Date.parse(row.createdAt) < Date.parse(registered.createdAt))
      throw AppError.conflict("Clean stop review belongs to another workspace");
    operations.push({ kind: "validation_review", operation_id: row.id, request_digest: row.requestDigest });
  }
  for (const { row } of publicationRows) {
    if (row.computerId !== computerId || Date.parse(row.createdAt) < Date.parse(registered.createdAt))
      throw AppError.conflict("Clean stop publication belongs to another executor or predates the original registration");
    operations.push({ kind: "release", operation_id: row.id, request_digest: hash(row.request) });
  }
  const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId });
  const activeRuns = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computerId),
    or(notInArray(runs.status, ["completed", "failed", "cancelled"]), uncertain.length ? inArray(runs.id, uncertain) : undefined)));
  const activeDedicated = await unsettledStandaloneExecutions(ctx, tx, { computerId });
  const releases = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.computerId, computerId),
    notInArray(productReleases.status, ["published", "rolled_back", "failed"])));
  if (activeRuns.some(run => !operations.some(operation => operation.run_id === run.id))
    || activeDedicated.some(row => !operations.some(operation => operation.operation_id === row.id && operation.kind === row.kind))
    || releases.some(row => !operations.some(operation => operation.kind === "release" && operation.operation_id === row.id)))
    throw AppError.conflict("Clean stop currently supports accepted-H6 H7 work only; another executor operation remains outside its closure set");
  return operations.sort((a, b) => { const left = a.kind + ":" + a.operation_id, right = b.kind + ":" + b.operation_id; return left < right ? -1 : left > right ? 1 : 0; });
}

export async function assertSourceCleanWorkspaceReservation(ctx: ServerContext, tx: DrizzleDb, root: ValidationRoot, computerId: string, workspaceRoot: string) {
  const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
    eq(goalAutomations.computerId, computerId), inArray(goalAutomations.status, ["planning", "executing", "waiting"])));
  if (reservations.some(row => row.goalId !== root.goal.id && row.workspaceRoot && automationWorkspacesOverlap(workspaceRoot, row.workspaceRoot, "windows")))
    throw AppError.conflict("Another goal reserves the physical restart workspace");
}

/** New native launch identity may change; its protected verifier and publication
 * contracts may not. Claim checks the surviving source, then fresh registration
 * and every later admission also check the actual current destination hello. */
export function assertSourceCleanCurrentProfiles(ctx: ServerContext, root: ValidationRoot, destination: boolean) {
  const transfer = root.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request;
  const source = transfer.source_export.measurement_v2?.source_release, target = transfer.measurement_v2?.destination_release;
  if (!source || !target) throw AppError.conflict("Clean restart requires the original measurement-v2 verifier and publication association");
  for (const [nodeId, release] of [[root.sessionBindings.source.computerId, source],
    ...(destination ? [[root.h6.computerId, target] as const] : [])] as const) {
    const binding = release.binding;
    if (canonical(ctx.getReleaseCapabilities?.(nodeId, binding.release_profile_id, binding.project_id, binding.workspace_root, binding.verification_profile_id)) !== canonical(release))
      throw AppError.conflict("Clean restart protected publication profile changed");
  }
  if (destination) {
    const binding = target.binding;
    if (ctx.supportsExecutionFeature?.(root.h6.computerId, SOURCE_CLEAN_RESTART_FEATURE_V1) !== true
      || canonical(ctx.getVerificationCapabilities?.(root.h6.computerId, binding.verification_profile_id, binding.project_id, binding.workspace_root))
        !== canonical(transfer.byte_request.destination.capabilities))
      throw AppError.conflict("Fresh native destination changed the original verifier or lacks the clean-restart contract");
  }
}
