import { computers, contextPacks, devices, deviceTokens, goalAutomations, goals, plans, productSourceTransfers, productSourceSemanticTransfers, runs, tasks } from "@artoo/db";
import { canonicalProductSourceTransferValueV1, ContextPackSchema, PRODUCT_SOURCE_TRANSFER_FEATURE_V1,
  ProductSourceTransferRequestV1Schema, ProductSourceTransferReceiptV1Schema, productSourceTransferRequestDigestV1,
  PRODUCT_SOURCE_TRANSFER_FEATURE_V2, PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1,
  ProductSourceTransferRequestV2Schema, productSourceTransferRequestDigestV2,
  type ProductSourceTransferRequestV1, type ProductSourceTransferRequestV2 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { requireActiveMember } from "./member-status.js";
import { inspectRunVerification } from "./verification-service.js";
import { requireProductSourceExportForTransfer } from "./product-source-export-service.js";
import { requireProductSourceSemanticExportForTransfer } from "./product-source-semantic-export-service.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type TransferRow = typeof productSourceTransfers.$inferSelect;
/** Constructed only after resolveNodeToken verifies the raw secret at the HTTP boundary. */
export interface AuthenticatedTransferNode { deviceId: string; computerId: string; tokenLookup: string }

function parse(value: unknown): ProductSourceTransferRequestV1 {
  const result = ProductSourceTransferRequestV1Schema.safeParse(value);
  if (!result.success) throw AppError.validation("Invalid product source transfer request");
  const request = result.data;
  if (sha(canonicalProductSourceTransferValueV1(request.destination.capabilities)) !== request.destination.capability_digest) {
    throw AppError.validation("Destination capability digest differs from its snapshot");
  }
  return request;
}
function receipt(row: TransferRow) {
  return ProductSourceTransferReceiptV1Schema.parse({ version: 1, transfer_id: row.id, request_digest: row.requestDigest,
    capsule_digest: parse(row.request).source.capsule_digest, status: row.status, execution_authorized: false });
}

async function lockTransferParticipants(ctx: ServerContext, db: DrizzleDb, request: ProductSourceTransferRequestV1): Promise<Set<string>> {
  const nodeIds = [request.source.node_id, request.destination.node_id];
  // Read identities without locking devices first. Member suspension locks its user before
  // updating devices/tokens, so reversing that order here can deadlock across different users.
  const observed = await db.select().from(devices).where(and(eq(devices.organizationId, ctx.organizationId),
    inArray(devices.computerId, nodeIds), eq(devices.trust, "active"), isNull(devices.revokedAt))).orderBy(devices.id);
  if (nodeIds.some(id => !observed.some(device => device.computerId === id))) throw AppError.permissionDenied("Transfer node is no longer paired");
  // This includes the initiating user even when neither node was paired by that user.
  const userIds = [...new Set([request.authorization.actor_user_id, ...observed.map(device => device.enrolledByUserId)])].sort();
  for (const id of userIds) await requireActiveMember(ctx, id, db);
  // requireAiSharingAuthorization repeats the already-held initiator's user SHARE lock,
  // then reads the exact grant. It cannot first acquire a new user lock after a device.
  await requireAiSharingAuthorization({ ...ctx, actorUserId: request.authorization.actor_user_id }, db,
    { consentId: request.authorization.consent_id, policyVersion: request.authorization.policy_version });
  for (const prior of observed) {
    const [current] = await db.select().from(devices).where(and(eq(devices.id, prior.id), eq(devices.organizationId, ctx.organizationId))).for("update");
    if (!current || current.trust !== "active" || current.revokedAt !== null || current.computerId !== prior.computerId
      || current.enrolledByUserId !== prior.enrolledByUserId) throw AppError.permissionDenied("Transfer pairing changed while acquiring authorization");
  }
  return new Set(observed.map(device => device.id));
}

/** Synchronous reads from both current accepted sessions; remote JSON installs no profile. */
export function assertMeasurementV2TransferSessions(ctx: ServerContext, request: ProductSourceTransferRequestV2): void {
  const sourceRelease = request.source_export.measurement_v2?.source_release, destinationRelease = request.measurement_v2?.destination_release;
  if (!sourceRelease || !destinationRelease) throw AppError.conflict("Measurement-v2 transfer requires both configured release associations");
  const base = request.byte_request;
  const targets = [
    { node: base.source, capabilities: request.source_export.source_capabilities, release: sourceRelease },
    { node: base.destination, capabilities: base.destination.capabilities, release: destinationRelease },
  ];
  for (const { node, capabilities, release } of targets) {
    const binding = release.binding;
    if (binding.project_id !== base.project_id || binding.workspace_root !== node.workspace_root
      || binding.verification_profile_id !== node.profile_id || binding.verification_profile_digest !== capabilities.profile_digest
      || ctx.supportsExecutionFeature?.(node.node_id, PRODUCT_SOURCE_TRANSFER_FEATURE_V2) !== true
      || ctx.supportsExecutionFeature?.(node.node_id, PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1) !== true
      || ctx.supportsVerificationProfile?.(node.node_id, node.profile_id, base.project_id, node.workspace_root) !== true
      || !isDeepStrictEqual(ctx.getVerificationCapabilities?.(node.node_id, node.profile_id, base.project_id, node.workspace_root), capabilities)
      || ctx.supportsReleaseProfile?.(node.node_id, binding.release_profile_id, base.project_id, node.workspace_root, node.profile_id) !== true
      || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(node.node_id, binding.release_profile_id,
        base.project_id, node.workspace_root, node.profile_id), release)) {
      throw AppError.conflict("Measurement-v2 transfer lacks both current feature, verifier and complete release configurations");
    }
  }
}

/** Repeated after blob I/O as well as admission: old availability cannot revive withdrawn authority. */
async function qualify(ctx: ServerContext, db: DrizzleDb, request: ProductSourceTransferRequestV1,
  semantic?: ProductSourceTransferRequestV2): Promise<{ lockedDevices: Set<string>; sourceExportEventId: string | null }> {
  if (semantic && !isDeepStrictEqual(parseSemantic(semantic).byte_request, request)) throw AppError.conflict("Semantic envelope differs from its byte request");
  if (request.organization_id !== ctx.organizationId) throw AppError.permissionDenied("Transfer organization differs");
  const [goal] = await db.select().from(goals).where(and(eq(goals.id, request.goal_id), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [plan] = await db.select().from(plans).where(and(eq(plans.id, request.plan_id), eq(plans.organizationId, ctx.organizationId)));
  const [automation] = await db.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, request.goal_id), eq(goalAutomations.organizationId, ctx.organizationId)));
  const authorization = request.authorization;
  if (!goal || goal.status !== "running" || goal.projectId !== request.project_id || goal.currentPlanId !== request.plan_id
    || !plan || plan.goalId !== goal.id || plan.status !== "accepted" || !automation || automation.planId !== request.plan_id
    || !["executing", "waiting"].includes(automation.status) || automation.actorUserId !== authorization.actor_user_id
    || automation.consentId !== authorization.consent_id || automation.policyVersion !== authorization.policy_version) {
    throw AppError.conflict("Transfer requires its current running goal, accepted plan and original automation authorization");
  }
  const lockedDevices = await lockTransferParticipants(ctx, db, request);
  const source = request.source, destination = request.destination;
  const [node] = await db.select().from(computers).where(and(eq(computers.id, destination.node_id), eq(computers.organizationId, ctx.organizationId)));
  if (!node || node.status !== "online" || ctx.supportsExecutionFeature?.(destination.node_id,
    semantic ? PRODUCT_SOURCE_TRANSFER_FEATURE_V2 : PRODUCT_SOURCE_TRANSFER_FEATURE_V1) !== true
    || ctx.supportsVerificationProfile?.(destination.node_id, destination.profile_id, request.project_id, destination.workspace_root) !== true
    || !isDeepStrictEqual(ctx.getVerificationCapabilities?.(destination.node_id, destination.profile_id, request.project_id, destination.workspace_root), destination.capabilities)) {
    throw AppError.conflict("Destination is missing the exact current transfer feature and verifier capabilities");
  }
  if (semantic?.measurement_v2) assertMeasurementV2TransferSessions(ctx, semantic);
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, source.task_id), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [run] = await db.select().from(runs).where(and(eq(runs.id, source.run_id), eq(runs.organizationId, ctx.organizationId))).for("update");
  const [latest] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, source.task_id), eq(runs.organizationId, ctx.organizationId)))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  if (!task || task.status !== "done" || task.projectId !== request.project_id || task.goalId !== request.goal_id || task.sourcePlanId !== request.plan_id
    || !run || run.status !== "completed" || run.taskId !== task.id || run.computerId !== source.node_id || run.workspaceRoot !== source.workspace_root
    || latest?.id !== source.run_id || (await unconfirmedDisconnectRunIds(ctx, db, { taskId: source.task_id })).length) {
    throw AppError.conflict("Transfer source is not the latest completed and accepted task in this plan");
  }
  const [storedContext] = run.contextPackId ? await db.select().from(contextPacks).where(and(eq(contextPacks.id, run.contextPackId),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, task.id))) : [];
  const context = ContextPackSchema.safeParse(storedContext?.payload);
  if (!context.success || !context.data.product_development || context.data.task.id !== task.id || context.data.project.id !== request.project_id
    || context.data.workspace.root !== source.workspace_root || run.ownedResultAssignment !== null) {
    throw AppError.conflict("Transfer v1 requires an ordinary verified product stage, never an owned-result reinterpretation");
  }
  const measured = await inspectRunVerification(ctx, db, run), evidence = measured.evidence;
  if (!measured.passed || !evidence || evidence.id !== source.evidence_id || evidence.requestId !== source.verification_request_id
    || evidence.payload.profile_id !== source.profile_id || evidence.payload.profile_digest !== source.profile_digest
    || evidence.payload.subject_digest !== source.subject_digest) throw AppError.conflict("Transfer source verification binding changed");
  const review = await inspectIndependentReview(ctx, db, run, evidence);
  if (review.status !== "accepted" || review.review?.status !== "accepted" || review.review.id !== source.review_id
    || review.review.goalId !== request.goal_id || review.review.taskId !== source.task_id
    || review.reviewerRunId !== source.reviewer_run_id || review.reviewerEvidenceId !== source.reviewer_evidence_id) {
    throw AppError.conflict("Transfer source lacks the exact current accepted independent review");
  }
  if (semantic) {
    if (ctx.supportsExecutionFeature?.(source.node_id, PRODUCT_SOURCE_TRANSFER_FEATURE_V2) !== true) {
      throw AppError.conflict("Source node has no current semantic transfer feature");
    }
    const sourceExportEventId = await requireProductSourceSemanticExportForTransfer(ctx, db, run, task, semantic);
    if (semantic.measurement_v2) {
      const currentNodes = await db.select({ id: computers.id, status: computers.status }).from(computers)
        .where(and(eq(computers.organizationId, ctx.organizationId), inArray(computers.id, [source.node_id, destination.node_id])));
      if ([source.node_id, destination.node_id].some(id => !currentNodes.some(current => current.id === id && current.status === "online"))) {
        throw AppError.conflict("Measurement-v2 transfer requires both online paired execution nodes");
      }
      // Awaited source/review qualification may have outlived a node session.
      // Re-read both full snapshots immediately before returning authority to the caller.
      assertMeasurementV2TransferSessions(ctx, semantic);
    }
    return { lockedDevices, sourceExportEventId };
  }
  await requireProductSourceExportForTransfer(ctx, db, run, task, request);
  return { lockedDevices, sourceExportEventId: null };
}

/** Trusted orchestrator entry only. No HTTP admission or existing scheduling path calls this yet. */
export async function admitProductSourceTransfer(ctx: ServerContext, input: unknown) {
  const request = parse(input), requestDigest = productSourceTransferRequestDigestV1(request, sha);
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== request.authorization.actor_user_id) {
    throw AppError.permissionDenied("Only the goal runner using the original user authorization can admit a transfer");
  }
  return ctx.db.transaction(async db => {
    await qualify(ctx, db, request);
    const [existing] = await db.select().from(productSourceTransfers).where(eq(productSourceTransfers.id, request.transfer_id)).for("update");
    if (existing) {
      if (existing.organizationId !== ctx.organizationId || existing.requestDigest !== requestDigest || !isDeepStrictEqual(existing.request, request)) {
        throw AppError.conflict("Transfer ID is already bound to another immutable request");
      }
      return receipt(existing);
    }
    const [row] = await db.insert(productSourceTransfers).values({ id: request.transfer_id, organizationId: ctx.organizationId,
      projectId: request.project_id, goalId: request.goal_id, planId: request.plan_id, actorUserId: request.authorization.actor_user_id,
      sourceNodeId: request.source.node_id, sourceRunId: request.source.run_id, sourceEvidenceId: request.source.evidence_id,
      sourceReviewId: request.source.review_id, destinationNodeId: request.destination.node_id, requestDigest, request,
      status: "awaiting_upload", createdAt: ctx.clock.nowIso() }).returning();
    return receipt(row!);
  });
}

/** The secret was authenticated before this call; lock and recheck its exact still-active credential. */
async function currentCredential(ctx: ServerContext, db: DrizzleDb, identity: AuthenticatedTransferNode, lockedDevices: ReadonlySet<string>): Promise<void> {
  if (!lockedDevices.has(identity.deviceId)) throw AppError.permissionDenied("Transfer credential was not part of the qualified pairing");
  const [device] = await db.select().from(devices).where(and(eq(devices.id, identity.deviceId), eq(devices.organizationId, ctx.organizationId))).for("update");
  const [token] = await db.select().from(deviceTokens).where(and(eq(deviceTokens.organizationId, ctx.organizationId),
    eq(deviceTokens.deviceId, identity.deviceId), eq(deviceTokens.tokenLookup, identity.tokenLookup), eq(deviceTokens.kind, "node"),
    eq(deviceTokens.status, "active"), isNull(deviceTokens.revokedAt))).for("update");
  if (!token || token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.parse(ctx.clock.nowIso()) || !device || device.trust !== "active"
    || device.revokedAt !== null || device.computerId !== identity.computerId) throw AppError.permissionDenied("Transfer node credential was revoked");
  // Its enroller's SHARE lock and active check were acquired before all device locks.
}

export async function inspectProductSourceTransferForNode(ctx: ServerContext, id: string, requestDigest: string,
  identity: AuthenticatedTransferNode, mode: "upload" | "download", makeAvailable = false) {
  return ctx.db.transaction(async db => {
    const [initial] = await db.select().from(productSourceTransfers).where(and(eq(productSourceTransfers.id, id), eq(productSourceTransfers.organizationId, ctx.organizationId)));
    if (!initial) throw AppError.notFound("Product source transfer not found");
    const request = parse(initial.request);
    if (initial.requestDigest !== requestDigest || initial.requestDigest !== productSourceTransferRequestDigestV1(request, sha)) {
      throw AppError.conflict("Transfer request digest changed");
    }
    if (identity.computerId !== (mode === "upload" ? request.source.node_id : request.destination.node_id)) {
      throw AppError.permissionDenied("Transfer is not assigned to this node");
    }
    const { lockedDevices } = await qualify(ctx, db, request);
    await currentCredential(ctx, db, identity, lockedDevices);
    const [row] = await db.select().from(productSourceTransfers).where(eq(productSourceTransfers.id, id)).for("update");
    if (!row || row.requestDigest !== initial.requestDigest) throw AppError.conflict("Transfer changed");
    if (mode === "download" && row.status !== "available") throw AppError.conflict("Transfer content is not available");
    if (mode === "upload" && ctx.supportsExecutionFeature?.(identity.computerId, PRODUCT_SOURCE_TRANSFER_FEATURE_V1) !== true) {
      throw AppError.conflict("Source node has no current transfer feature");
    }
    if (makeAvailable) {
      if (mode !== "upload") throw AppError.permissionDenied("Only its source can upload transfer content");
      if (row.status === "awaiting_upload") {
        const [updated] = await db.update(productSourceTransfers).set({ status: "available", uploadedByDeviceId: identity.deviceId,
          availableAt: ctx.clock.nowIso() }).where(eq(productSourceTransfers.id, id)).returning();
        return { request, receipt: receipt(updated!) };
      }
    }
    return { request, receipt: receipt(row) };
  });
}

function parseSemantic(input: unknown): ProductSourceTransferRequestV2 {
  const parsed = ProductSourceTransferRequestV2Schema.safeParse(input);
  if (!parsed.success) throw AppError.validation("Invalid semantic product source transfer request");
  try { productSourceTransferRequestDigestV2(parsed.data, sha); }
  catch { throw AppError.validation("Semantic transfer digest differs from its immutable envelope"); }
  return parsed.data;
}
function semanticReceipt(row: TransferRow, requestDigest: string) {
  return ProductSourceTransferReceiptV1Schema.parse({ ...receipt(row), request_digest: requestDigest });
}

/** Trusted orchestrator admission only. Byte availability is not destination execution authority. */
export async function admitProductSourceSemanticTransfer(ctx: ServerContext, input: unknown) {
  return ctx.db.transaction(db=>admitProductSourceSemanticTransferInTransaction(ctx,db,input));
}
export async function admitProductSourceSemanticTransferInTransaction(ctx: ServerContext, db: DrizzleDb, input: unknown) {
  const semantic = parseSemantic(input), request = semantic.byte_request;
  const requestDigest = productSourceTransferRequestDigestV2(semantic, sha), byteDigest = productSourceTransferRequestDigestV1(request, sha);
  if (ctx.automationActor?.id !== "goal_runner" || ctx.actorUserId !== request.authorization.actor_user_id) {
    throw AppError.permissionDenied("Only the goal runner using the original user authorization can admit a semantic transfer");
  }
    const { sourceExportEventId } = await qualify(ctx, db, request, semantic);
    if (!sourceExportEventId) throw AppError.conflict("Semantic transfer is missing its original source export");
    const [existing] = await db.select().from(productSourceTransfers).where(eq(productSourceTransfers.id, request.transfer_id)).for("update");
    const [companion] = await db.select().from(productSourceSemanticTransfers).where(eq(productSourceSemanticTransfers.id, request.transfer_id)).for("update");
    if (existing || companion) {
      if (!existing || !companion || existing.organizationId !== ctx.organizationId || existing.requestDigest !== byteDigest
        || !isDeepStrictEqual(existing.request, request) || companion.organizationId !== ctx.organizationId
        || companion.requestDigest !== requestDigest || !isDeepStrictEqual(companion.request, semantic)
        || companion.sourceExportEventId !== sourceExportEventId || companion.sourceExportDigest !== semantic.source_export_digest) {
        throw AppError.conflict("Transfer ID is already bound to another immutable byte or semantic request");
      }
      if (semantic.measurement_v2) assertMeasurementV2TransferSessions(ctx, semantic);
      return semanticReceipt(existing, requestDigest);
    }
    const createdAt = ctx.clock.nowIso();
    const [row] = await db.insert(productSourceTransfers).values({ id: request.transfer_id, organizationId: ctx.organizationId,
      projectId: request.project_id, goalId: request.goal_id, planId: request.plan_id, actorUserId: request.authorization.actor_user_id,
      sourceNodeId: request.source.node_id, sourceRunId: request.source.run_id, sourceEvidenceId: request.source.evidence_id,
      sourceReviewId: request.source.review_id, destinationNodeId: request.destination.node_id, requestDigest: byteDigest, request,
      status: "awaiting_upload", createdAt }).returning();
    await db.insert(productSourceSemanticTransfers).values({ id: request.transfer_id, organizationId: ctx.organizationId,
      requestDigest, request: semantic, sourceExportEventId, sourceExportDigest: semantic.source_export_digest, createdAt });
    if (semantic.measurement_v2) assertMeasurementV2TransferSessions(ctx, semantic);
    return semanticReceipt(row!, requestDigest);
}

/** Requalified both before and after blob I/O; no envelope, credential or source-proof shortcuts. */
export async function inspectProductSourceSemanticTransferForNode(ctx: ServerContext, id: string, requestDigest: string,
  identity: AuthenticatedTransferNode, mode: "upload" | "download", makeAvailable = false) {
  return ctx.db.transaction(async db => {
    const [initial] = await db.select().from(productSourceTransfers).where(and(eq(productSourceTransfers.id, id), eq(productSourceTransfers.organizationId, ctx.organizationId)));
    const [companion] = await db.select().from(productSourceSemanticTransfers).where(and(eq(productSourceSemanticTransfers.id, id),
      eq(productSourceSemanticTransfers.organizationId, ctx.organizationId)));
    if (!initial || !companion) throw AppError.notFound("Semantic product source transfer not found");
    const request = parseSemantic(companion.request), base = request.byte_request;
    if (companion.requestDigest !== requestDigest || companion.requestDigest !== productSourceTransferRequestDigestV2(request, sha)
      || initial.requestDigest !== productSourceTransferRequestDigestV1(base, sha) || !isDeepStrictEqual(initial.request, base)
      || companion.sourceExportDigest !== request.source_export_digest) throw AppError.conflict("Semantic transfer request digest changed");
    if (identity.computerId !== (mode === "upload" ? base.source.node_id : base.destination.node_id)) {
      throw AppError.permissionDenied("Semantic transfer is not assigned to this node");
    }
    const { lockedDevices, sourceExportEventId } = await qualify(ctx, db, base, request);
    if (sourceExportEventId !== companion.sourceExportEventId) throw AppError.conflict("Semantic transfer source export changed");
    await currentCredential(ctx, db, identity, lockedDevices);
    const [row] = await db.select().from(productSourceTransfers).where(eq(productSourceTransfers.id, id)).for("update");
    const [current] = await db.select().from(productSourceSemanticTransfers).where(eq(productSourceSemanticTransfers.id, id)).for("update");
    if (!row || row.requestDigest !== initial.requestDigest || !current || !isDeepStrictEqual(current, companion)) {
      throw AppError.conflict("Semantic transfer changed");
    }
    if (mode === "download" && row.status !== "available") throw AppError.conflict("Semantic transfer content is not available");
    if (makeAvailable) {
      if (mode !== "upload") throw AppError.permissionDenied("Only its source can upload semantic transfer content");
      if (row.status === "awaiting_upload") {
        const [updated] = await db.update(productSourceTransfers).set({ status: "available", uploadedByDeviceId: identity.deviceId,
          availableAt: ctx.clock.nowIso() }).where(eq(productSourceTransfers.id, id)).returning();
        if (request.measurement_v2) assertMeasurementV2TransferSessions(ctx, request);
        return { request, receipt: semanticReceipt(updated!, requestDigest) };
      }
    }
    if (request.measurement_v2) assertMeasurementV2TransferSessions(ctx, request);
    return { request, receipt: semanticReceipt(row, requestDigest) };
  });
}
