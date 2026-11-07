import { appendEvent, eventLog, goalAutomations, goals, productReleases, productReleaseHealthReports, runs, tasks } from "@artoo/db";
import { ProductReleaseRequestSchema, ProductReleaseReceiptSchema, ProductReleaseHealthReportSchema, ProductReleaseSchema,
  type ProductRelease, type ProductReleaseReceipt, type ProductReleaseHealthReport } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { inspectRunVerification } from "./verification-service.js";
import { unsettledGoalExecutionCount } from "./execution-state.js";
import { inspectFinalReleaseAcceptance, inspectReleaseAcceptanceRun, assertReleaseAcceptanceReceipt, releaseAcceptanceSettlement,
  type ReleaseAcceptanceAutomation } from "./release-acceptance.js";
import { persistedPlanningSnapshot } from "./planning-capabilities.js";
import { assertNoActiveDesignRevision } from "./product-design-revision-guard.js";

type ReleaseRow = typeof productReleases.$inferSelect;
type Automation = ReleaseAcceptanceAutomation;

export function mapProductRelease(row: ReleaseRow, health: ProductReleaseHealthReport | null = null): ProductRelease {
  return ProductReleaseSchema.parse({ id: row.id, goal_id: row.goalId, project_id: row.projectId,
    computer_id: row.computerId, run_id: row.runId, evidence_id: row.evidenceId,
    status: row.status, request: row.request, receipt: row.receipt, health, created_at: row.createdAt, updated_at: row.updatedAt });
}
export async function getGoalProductRelease(ctx: ServerContext, goalId: string): Promise<ProductRelease | null> {
  const [goal] = await ctx.db.db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) throw AppError.notFound("Goal not found");
  const [row] = await ctx.db.db.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, goalId)));
  if (!row) return null;
  const [last] = await ctx.db.db.select().from(productReleaseHealthReports).where(and(
    eq(productReleaseHealthReports.organizationId, ctx.organizationId), eq(productReleaseHealthReports.releaseId, row.id),
  )).orderBy(desc(productReleaseHealthReports.sequence)).limit(1);
  return mapProductRelease(row, last ? ProductReleaseHealthReportSchema.parse(last.payload) : null);
}

/** Recover an already committed completion fact without treating later health as its historical measurement. */
export async function assertRecordedGoalReleaseCompletion(ctx: ServerContext, tx: DrizzleDb, automation: Automation): Promise<void> {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  if (!goal || !persistedPlanningSnapshot(automation, goal.projectId)?.release) return;
  const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId),
    eq(productReleases.goalId, goal.id))).for("update");
  const source = await inspectFinalReleaseAcceptance(ctx, tx, automation);
  const [completion] = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId),
    eq(eventLog.goalId, goal.id), eq(eventLog.type, "goal.completed"), eq(eventLog.actorType, "system"), eq(eventLog.actorId, "goal_runner")))
    .orderBy(desc(eventLog.occurredAt), desc(eventLog.id)).limit(1);
  const payload = completion?.payload as { trigger?: unknown; settlement?: { health_event_id?: unknown } } | undefined;
  if (!source || !release || release.status !== "published" || release.runId !== source.run.id || release.evidenceId !== source.evidence.id
    || payload?.trigger !== "product_release_healthy" || !payload.settlement) {
    throw AppError.conflict("Completed publication has no recorded exact acceptance settlement");
  }
  const receipt = ProductReleaseReceiptSchema.parse(release.receipt), healthId = payload.settlement.health_event_id;
  const [health] = typeof healthId === "string" ? await tx.select().from(productReleaseHealthReports).where(and(
    eq(productReleaseHealthReports.eventId, healthId), eq(productReleaseHealthReports.organizationId, ctx.organizationId),
    eq(productReleaseHealthReports.releaseId, release.id), eq(productReleaseHealthReports.computerId, release.computerId))) : [];
  if (healthId !== null && !health) throw AppError.conflict("Recorded publication settlement lost its exact health observation");
  const report = health ? ProductReleaseHealthReportSchema.parse(health.payload) : null;
  mapProductRelease(release, report);
  if (!isDeepStrictEqual(payload.settlement, releaseAcceptanceSettlement(source, receipt, report))) {
    throw AppError.conflict("Completed publication differs from its recorded acceptance settlement");
  }
}

/** Cancellation cannot free a goal while a publication may still be changing its endpoint. */
export async function cancelGoalProductRelease(ctx: ServerContext, goalId: string): Promise<void> {
  const release = await getGoalProductRelease(ctx, goalId);
  if (!release || release.status !== "queued") return;
  if (!ctx.onProductReleaseCancel) throw AppError.conflict("Publication must confirm cancellation before the goal can stop");
  await ctx.onProductReleaseCancel(release.id);
  const settled = await getGoalProductRelease(ctx, goalId);
  if (!settled || settled.status === "queued") throw AppError.conflict("Publication cancellation has not been confirmed");
}

/** Called under the goal automation transaction; dispatch occurs only after this row commits. */
export async function ensureGoalProductRelease(ctx: ServerContext, tx: DrizzleDb, automation: Automation): Promise<{
  status: "pending" | "succeeded" | "failed"; reason?: string; endpoint?: string;
  settlement?: ReturnType<typeof releaseAcceptanceSettlement>;
}> {
  await assertNoActiveDesignRevision(ctx, tx, automation.goalId);
  if (!automation.releaseProfileId || !automation.computerId || !automation.workspaceRoot || !automation.planId) throw AppError.validation("Product release is missing its configured execution binding");
  // Health ingestion takes the same release lock. Keep its latest observation and
  // the caller's completion write in one transaction, after the goal lock.
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [existing] = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, automation.goalId))).for("update");
  const accepted = await inspectFinalReleaseAcceptance(ctx, tx, automation);
  if (existing) {
    const request = ProductReleaseRequestSchema.parse(existing.request);
    if (!isDeepStrictEqual(request.acceptance_binding, accepted?.binding)
      || accepted && (existing.runId !== accepted.run.id || existing.evidenceId !== accepted.evidence.id)) {
      throw AppError.conflict("The immutable publication no longer matches the accepted final criteria");
    }
    const receipt = existing.receipt === null ? null : ProductReleaseReceiptSchema.parse(existing.receipt);
    if (receipt && accepted) assertReleaseAcceptanceReceipt(receipt, accepted);
    if (existing.status === "published" && receipt?.outcome === "published") {
      const [last] = await tx.select().from(productReleaseHealthReports).where(and(eq(productReleaseHealthReports.organizationId, ctx.organizationId),
        eq(productReleaseHealthReports.releaseId, existing.id))).orderBy(desc(productReleaseHealthReports.sequence)).limit(1);
      const health = last ? ProductReleaseHealthReportSchema.parse(last.payload) : null;
      mapProductRelease(existing, health);
      if (health?.state === "degraded") return { status: "pending", reason: health.reason ?? "Published product health is degraded; waiting for recovery." };
      if (health?.state === "rolled_back" || health?.state === "unavailable") return { status: "failed", reason: health.reason ?? `Published product is ${health.state}` };
      return { status: "succeeded", endpoint: receipt.endpoint!,
        ...(accepted ? { settlement: releaseAcceptanceSettlement(accepted, receipt, health) } : {}) };
    }
    if (existing.status !== "queued") return { status: "failed", reason: receipt?.reason ?? `Product release ${existing.status}` };
    return { status: "pending", reason: "Waiting for publication and endpoint health checks." };
  }
  if (!goal || goal.status !== "running" || goal.currentPlanId !== automation.planId) throw AppError.conflict("Goal is not ready for product release");
  const children = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, automation.planId)));
  if (!children.length || children.some((task) => task.status !== "done") || await unsettledGoalExecutionCount(ctx, tx, goal.id)) throw AppError.conflict("All required work and process exits must be accepted before release");
  const [last] = accepted ? [{ run: accepted.run }] : await tx.select({ run: runs }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId)).where(and(
    eq(runs.organizationId, ctx.organizationId), eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goal.id),
    eq(tasks.sourcePlanId, automation.planId), eq(runs.status, "completed"), isNotNull(runs.verificationRequirement),
  )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  if (!last || last.run.computerId !== automation.computerId || last.run.workspaceRoot !== automation.workspaceRoot) throw AppError.conflict("Final verified run is not bound to the publication workspace");
  const verification = await inspectRunVerification(ctx, tx, last.run);
  if (!verification.passed || !verification.evidence?.payload.subject_digest) throw AppError.conflict("Final product has no successful immutable-source verification evidence");
  if (ctx.supportsReleaseProfile?.(automation.computerId, automation.releaseProfileId, goal.projectId, automation.workspaceRoot, automation.verificationProfileId) !== true) {
    return { status: "pending", reason: "Waiting for a connected worker advertising the exact release profile, project and verified workspace." };
  }
  if (accepted && !isDeepStrictEqual(ctx.getReleaseCapabilities?.(automation.computerId, automation.releaseProfileId,
    goal.projectId, automation.workspaceRoot, automation.verificationProfileId), accepted.capabilities)) {
    return { status: "pending", reason: "Waiting for the exact configured publication acceptance contract." };
  }
  const id = ctx.idGen.generate("release");
  const evidence = verification.evidence;
  const request = ProductReleaseRequestSchema.parse({ version: 1, release_id: id, goal_id: goal.id, project_id: goal.projectId,
    run_id: last.run.id, release_profile_id: automation.releaseProfileId, verification_request_id: evidence.requestId,
    verification_profile_id: automation.verificationProfileId, verification_profile_digest: evidence.payload.profile_digest,
    subject_digest: evidence.payload.subject_digest, ...(accepted ? { acceptance_binding: accepted.binding } : {}) });
  await tx.insert(productReleases).values({ id, organizationId: ctx.organizationId, goalId: goal.id, projectId: goal.projectId,
    computerId: automation.computerId, runId: last.run.id, evidenceId: evidence.id, status: "queued", request,
    createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso() });
  await appendEvent(tx, buildEvent(ctx, { type: "product.release.queued", actorType: "system", actorId: "goal_runner",
    correlationId: id, goalId: goal.id, projectId: goal.projectId, runId: last.run.id, payload: { release_id: id, request } }));
  return { status: "pending", reason: "Publishing the final verified product." };
}

/** Only the authenticated currently bound node can deliver this separate, immutable receipt. */
export async function ingestProductReleaseReceipt(ctx: ServerContext, computerId: string, input: ProductReleaseReceipt,
  isCurrentSession: () => boolean = () => true): Promise<void> {
  const receipt = ProductReleaseReceiptSchema.parse(input);
  const assertCurrent = () => { if (!isCurrentSession()) throw AppError.permissionDenied("Publication receipt session is no longer current"); };
  assertCurrent();
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(productReleases).where(and(eq(productReleases.id, receipt.request.release_id), eq(productReleases.organizationId, ctx.organizationId))).for("update");
    assertCurrent();
    if (!row || row.computerId !== computerId) throw AppError.permissionDenied("Release is not owned by this computer");
    if (!isDeepStrictEqual(row.request, receipt.request)) throw AppError.validation("Release receipt does not match the persisted immutable request");
    if (row.receipt !== null) {
      if (!isDeepStrictEqual(row.receipt, receipt)) throw AppError.conflict("Release receipt is immutable");
      assertCurrent(); return;
    }
    if (row.status !== "queued") throw AppError.conflict("Release is no longer waiting for a node receipt");
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, row.runId), eq(runs.organizationId, ctx.organizationId)));
    const result = run && await inspectRunVerification(ctx, tx, run);
    if (!result?.passed || result.evidence?.id !== row.evidenceId || result.evidence.payload.subject_digest !== receipt.request.subject_digest) throw AppError.conflict("Release no longer has matching verified source evidence");
    const pending = result.evidence.payload.measurement_plan;
    if (pending?.version === 2 && pending.pending_release.length && !receipt.request.acceptance_binding) {
      throw AppError.conflict("Publication cannot downgrade its pending acceptance obligations");
    }
    const accepted = receipt.request.acceptance_binding
      ? await inspectReleaseAcceptanceRun(ctx, tx, run!, row.goalId, receipt.request.acceptance_binding.plan) : undefined;
    if (!isDeepStrictEqual(receipt.request.acceptance_binding, accepted?.binding)) throw AppError.conflict("Release criterion binding is missing or changed");
    if (accepted) assertReleaseAcceptanceReceipt(receipt, accepted);
    assertCurrent();
    await tx.update(productReleases).set({ status: receipt.outcome, receipt, updatedAt: ctx.clock.nowIso() }).where(eq(productReleases.id, row.id));
    await appendEvent(tx, buildEvent(ctx, { type: "product.release.completed", actorType: "system", actorId: computerId,
      correlationId: row.id, goalId: row.goalId, projectId: row.projectId, runId: row.runId, payload: { release_id: row.id, receipt } }));
    assertCurrent();
  });
}

function assertMeasuredReleasePaths(actual: ProductReleaseReceipt["health_checks"], published: ProductReleaseReceipt["health_checks"]): void {
  const expected = new Map(published.map((check) => [check.path, check]));
  if (actual.length !== expected.size || actual.some((check) => !expected.has(check.path)
    || (check.passed && expected.get(check.path)!.body_digest !== check.body_digest))) {
    throw AppError.validation("Health measurements do not match the published immutable endpoint paths and content");
  }
}

/** Observations cannot rewrite deployment history or turn an unchecked rollback into success. */
export async function ingestProductReleaseHealthReport(ctx: ServerContext, computerId: string, input: ProductReleaseHealthReport,
  isCurrentSession: () => boolean = () => true): Promise<void> {
  const report = ProductReleaseHealthReportSchema.parse(input);
  const assertCurrent = () => { if (!isCurrentSession()) throw AppError.permissionDenied("Health report session is no longer current"); };
  assertCurrent();
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(productReleases).where(and(eq(productReleases.id, report.request.release_id),
      eq(productReleases.organizationId, ctx.organizationId))).for("update");
    assertCurrent();
    if (!row || row.computerId !== computerId) throw AppError.permissionDenied("Release is not owned by this computer");
    if (!isDeepStrictEqual(row.request, report.request)) throw AppError.validation("Health report does not match the persisted immutable request");
    const receipt = ProductReleaseReceiptSchema.safeParse(row.receipt);
    if (row.status !== "published" || !receipt.success || receipt.data.outcome !== "published") {
      throw AppError.conflict("Health reports require a confirmed published release");
    }
    if (report.release_profile_digest !== receipt.data.release_profile_digest || report.artifact_digest !== receipt.data.artifact_digest) {
      throw AppError.validation("Health report profile or immutable artifact binding changed");
    }
    assertMeasuredReleasePaths(report.health_checks, receipt.data.health_checks);
    if (Date.parse(report.checked_at) < Math.max(...receipt.data.health_checks.map((check) => Date.parse(check.checked_at)))) {
      throw AppError.validation("Health report predates publication measurements");
    }
    if (report.state === "rolled_back") {
      if (report.active_release_id !== receipt.data.previous_release_id) throw AppError.validation("Recovery does not identify the publication's previous version");
      const [previous] = await tx.select().from(productReleases).where(and(eq(productReleases.id, report.active_release_id!),
        eq(productReleases.organizationId, ctx.organizationId)));
      const restored = ProductReleaseReceiptSchema.safeParse(previous?.receipt);
      if (!previous || previous.computerId !== computerId || previous.projectId !== row.projectId || previous.status !== "published"
        || !restored.success || restored.data.outcome !== "published" || restored.data.endpoint !== receipt.data.endpoint
        || restored.data.request.release_profile_id !== report.request.release_profile_id
        || restored.data.release_profile_digest !== report.release_profile_digest || restored.data.artifact_digest !== report.active_artifact_digest) {
        throw AppError.validation("Recovery has no matching published previous-version evidence");
      }
      assertMeasuredReleasePaths(report.recovery_checks, restored.data.health_checks);
    }
    // A disconnected worker may replay only its latest report, so sequence gaps are valid.
    // Reused IDs or sequences must still have exactly the original bytes/meaning.
    const [replay] = await tx.select().from(productReleaseHealthReports).where(or(
      eq(productReleaseHealthReports.eventId, report.event_id),
      and(eq(productReleaseHealthReports.organizationId, ctx.organizationId), eq(productReleaseHealthReports.releaseId, row.id),
        eq(productReleaseHealthReports.sequence, report.sequence)),
    ));
    if (replay) {
      if (replay.organizationId !== ctx.organizationId || replay.releaseId !== row.id || replay.computerId !== computerId
        || !isDeepStrictEqual(replay.payload, report)) throw AppError.conflict("Health report identity is immutable");
      assertCurrent(); return;
    }
    const [latest] = await tx.select().from(productReleaseHealthReports).where(and(eq(productReleaseHealthReports.organizationId, ctx.organizationId),
      eq(productReleaseHealthReports.releaseId, row.id))).orderBy(desc(productReleaseHealthReports.sequence)).limit(1);
    if (latest) {
      if (report.sequence < latest.sequence) throw AppError.conflict("Health report is older than the current observation");
      const prior = ProductReleaseHealthReportSchema.parse(latest.payload);
      if (["rolled_back", "unavailable"].includes(prior.state)) throw AppError.conflict("A quarantined publication cannot resume without a new release");
      if (Date.parse(report.checked_at) < Date.parse(prior.checked_at)) throw AppError.validation("Health report time moved backwards");
    }
    assertCurrent();
    await tx.insert(productReleaseHealthReports).values({ eventId: report.event_id, organizationId: ctx.organizationId,
      releaseId: row.id, computerId, version: 1, sequence: report.sequence, payload: report, receivedAt: ctx.clock.nowIso() });
    await appendEvent(tx, buildEvent(ctx, { type: "product.release.health", actorType: "system", actorId: computerId,
      correlationId: row.id, goalId: row.goalId, projectId: row.projectId, runId: row.runId,
      payload: { release_id: row.id, report } }));
    // A replaced socket cannot commit after an await in the durable ingest transaction.
    assertCurrent();
  });
}

/** Delivery retries retain the exact ID. A disconnect is uncertainty, never publication failure or success. */
export function createProductReleaseDispatcher(ctx: ServerContext, onError: (error: unknown) => void = () => {}) {
  let running: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  async function drain(): Promise<void> {
    const queued = await ctx.db.db.select({ release: productReleases, goal: goals, automation: goalAutomations })
      .from(productReleases).innerJoin(goals, eq(goals.id, productReleases.goalId)).innerJoin(goalAutomations, eq(goalAutomations.goalId, goals.id))
      .where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.status, "queued"), eq(goals.status, "running")));
    for (const { release, automation } of queued) {
      if (stopped) return;
      if (!["executing", "waiting"].includes(automation.status)) continue;
      try { await ctx.onProductReleaseQueued?.(release.id); } catch (error) { onError(error); }
    }
  }
  const pump = () => stopped ? Promise.resolve() : running ??= drain().finally(() => { running = undefined; });
  return { pump, start() { stopped = false; timer ??= setInterval(() => { void pump().catch(onError); }, 1500); timer.unref(); void pump().catch(onError); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await running; } };
}
