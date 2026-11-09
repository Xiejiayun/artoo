import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { agentInstances, appendEvent, applicationPublications, applicationPublicationObservations, applicationPublicationSettlements,
  contextPacks, eventLog, goalAutomations, goals, plans, runs, tasks } from "@artoo/db";
import { APPLICATION_PUBLICATION_FEATURE_V1, ApplicationPublicationRequestV1Schema, ApplicationPublicationReceiptV1Schema,
  ApplicationPublicationObservationV1Schema, ContextPackSchema, TaskSpecSchema, canonicalReleaseJson,
  type ApplicationPublicationRequestV1, type ApplicationPublicationReceiptV1, type ApplicationPublicationObservationV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { unsettledGoalExecutionCount } from "./execution-state.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { persistedPlanningSnapshot } from "./planning-capabilities.js";
import { assertNoActiveDesignRevision } from "./product-design-revision-guard.js";
import { inspectRunVerification, readRunVerificationEvidence, type RunVerificationEvidence } from "./verification-service.js";

type Automation = typeof goalAutomations.$inferSelect;
type Publication = typeof applicationPublications.$inferSelect;
export const applicationPublicationDigest = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalReleaseJson(value)).digest("hex")}`;
function conflict(message: string): never { throw AppError.conflict(`Application publication: ${message}`); }

async function selectedRun(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect, evidence: RunVerificationEvidence) {
  const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, run.agentInstanceId), eq(agentInstances.organizationId, ctx.organizationId)));
  const actual = evidence.payload.application;
  if (!instance || !actual || actual.stage !== "validation" || !actual.publication) conflict("final node-owned validation and original agent identity required");
  return { run_id: run.id, request_id: evidence.requestId, evidence_id: evidence.id, agent_id: instance.agentId,
    agent_instance_id: instance.id, stage: "validation" as const, origin_run_id: actual.origin_run_id,
    origin_request_id: actual.origin_request_id, test_store_id: actual.acceptance.test_store_id, candidate: actual.candidate };
}

/** Rebuild only from committed current author/reviewer evidence. The node still
 * requires its original in-memory candidate and native closure before execution. */
async function acceptedRequest(ctx: ServerContext, tx: DrizzleDb, automation: Automation, publicationId: string): Promise<ApplicationPublicationRequestV1> {
  if (!automation.appPublication || automation.appDelivery || automation.releaseProfileId || automation.sourceHandoff
    || automation.executionMode !== "agent_team" || !automation.planId || !automation.computerId || !automation.workspaceRoot)
    conflict("separate original application publication authorization required");
  await assertNoActiveDesignRevision(ctx, tx, automation.goalId);
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId)));
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, automation.planId), eq(plans.organizationId, ctx.organizationId), eq(plans.goalId, automation.goalId)));
  if (!goal || !plan || goal.currentPlanId !== plan.id || !Array.isArray(plan.taskSpecs)) conflict("current accepted plan required");
  const configured = persistedPlanningSnapshot(automation, goal.projectId)?.application_publication?.capabilities;
  if (!configured) conflict("original planning publication capability required");
  const children = await tx.select().from(tasks).where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, goal.projectId),
    eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, plan.id)));
  if (children.length !== plan.taskSpecs.length || children.some(task => task.status !== "done") || await unsettledGoalExecutionCount(ctx, tx, goal.id))
    conflict("all accepted stages, independent reviews and original process exits must settle");
  let final: { run: typeof runs.$inferSelect; evidence: RunVerificationEvidence; peer: Awaited<ReturnType<typeof inspectIndependentReview>> } | undefined;
  const refs = new Set<number>();
  for (const task of children) {
    const ref = Number(task.sourcePlanSpecRef), spec = TaskSpecSchema.safeParse(plan.taskSpecs[ref]);
    if (task.sourcePlanSpecRef === null || !Number.isSafeInteger(ref) || refs.has(ref) || !spec.success) conflict("stage task differs from the accepted plan");
    refs.add(ref);
    const [run] = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, task.id)))
      .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
    if (!run || run.status !== "completed" || run.computerId !== automation.computerId || run.workspaceRoot !== automation.workspaceRoot || run.workspaceBranch)
      conflict("each stage needs its latest completed original author run");
    const measured = await inspectRunVerification(ctx, tx, run);
    if (!measured.passed || !measured.evidence) conflict("each accepted stage requires its actual qualified verification");
    const peer = await inspectIndependentReview(ctx, tx, run, measured.evidence);
    if (peer.status !== "accepted" || !peer.reviewerRunId || !peer.reviewerEvidenceId || peer.review?.status !== "accepted")
      conflict("each stage requires a committed independent review");
    if (spec.data.development_stage === "validation") {
      if (final) conflict("one unambiguous final validation author required");
      final = { run, evidence: measured.evidence, peer };
    }
  }
  if (!final) conflict("final validation stage is missing");
  const [stored] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, final.run.contextPackId ?? ""),
    eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, final.run.id), eq(contextPacks.taskId, final.run.taskId)));
  const context = ContextPackSchema.parse(stored?.payload), publication = context.application_publication, measurement = final.evidence.payload.application?.publication;
  if (!publication || !measurement || context.review_subject || context.product_development?.stage !== "validation"
    || context.goal_context?.goal_id !== goal.id || context.goal_context.plan?.id !== plan.id || context.goal_context.plan.version !== plan.version
    || publication.authorization.event_id !== automation.applicationPublicationAuthorizationEventId
    || !isDeepStrictEqual(publication.capabilities, configured)) conflict("final publication context differs from original grant, plan or measurement");
  const [authorization] = await tx.select().from(eventLog).where(and(eq(eventLog.id, publication.authorization.event_id),
    eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.goalId, goal.id), eq(eventLog.type, "goal.application-publication.authorized"),
    eq(eventLog.actorType, "user"), eq(eventLog.actorId, automation.actorUserId)));
  const authorized = authorization?.payload as Record<string, unknown> | undefined;
  if (!authorized || authorized.publisher_session_id !== publication.publisher_session_id
    || !isDeepStrictEqual(authorized.authorization, publication.authorization) || !isDeepStrictEqual(authorized.capabilities, publication.capabilities))
    conflict("original user authorization session changed");
  for (const [path, checksum] of [[".artoo/product/research.json", measurement.research_digest], [".artoo/product/design.json", measurement.design_digest]] as const) {
    const accepted = context.product_development.accepted_inputs?.files.find(file => file.path === path);
    const observed = final.evidence.payload.required_files.find(file => file.path === path);
    if (!accepted || !observed || accepted.checksum !== checksum || observed.checksum !== checksum || accepted.size !== observed.size)
      conflict("final requirement and design must retain their exact accepted file pins");
  }
  const [reviewRun] = await tx.select().from(runs).where(and(eq(runs.id, final.peer.reviewerRunId!), eq(runs.organizationId, ctx.organizationId)));
  const reviewEvidence = await readRunVerificationEvidence(ctx, tx, final.peer.reviewerRunId!);
  if (!reviewRun || !reviewEvidence || reviewEvidence.id !== final.peer.reviewerEvidenceId
    || !isDeepStrictEqual(reviewEvidence.payload.application?.publication, measurement)) conflict("independent reviewer criterion coverage differs");
  const [reviewEvent] = await tx.select().from(eventLog).where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.goalId, goal.id),
    eq(eventLog.taskId, final.peer.review!.reviewTaskId), eq(eventLog.type, "task.updated"), eq(eventLog.actorType, "system"), eq(eventLog.actorId, "goal_runner"),
    sql`${eventLog.payload}->>'independent_review_id' = ${final.peer.review!.id}`, sql`${eventLog.payload}->>'outcome' = 'accepted'`,
    sql`${eventLog.payload}->>'status' = 'done'`)).orderBy(desc(eventLog.position)).limit(1);
  if (!reviewEvent) conflict("committed independent acceptance event required");
  return ApplicationPublicationRequestV1Schema.parse({ version: 1, publication_id: publicationId, goal_id: goal.id, project_id: goal.projectId,
    computer_id: final.run.computerId, publisher_session_id: publication.publisher_session_id,
    subject_digest: final.evidence.payload.subject_digest, application_definition_digest: measurement.application_definition_digest,
    authorization: publication.authorization, capabilities: configured,
    author: await selectedRun(ctx, tx, final.run, final.evidence), reviewer: await selectedRun(ctx, tx, reviewRun, reviewEvidence),
    acceptance: { version: 1, plan: { id: plan.id, version: plan.version }, research_digest: measurement.research_digest, design_digest: measurement.design_digest,
      measurement_plan_digest: measurement.measurement_plan_digest, accepted_review_event_id: reviewEvent.id,
      development_criteria: measurement.development_criteria, publication_criteria: measurement.publication_criteria, unmet_criteria: measurement.unmet_criteria } });
}

function currentSession(ctx: ServerContext, request: ApplicationPublicationRequestV1): boolean {
  const session = ctx.getPairedNodeSession?.(request.computer_id);
  return !!session && session.sessionId === request.publisher_session_id && session.computerId === request.computer_id
    && ctx.supportsExecutionFeature?.(request.computer_id, APPLICATION_PUBLICATION_FEATURE_V1) === true
    && isDeepStrictEqual(ctx.getApplicationPublicationCapabilities?.(request.computer_id, request.authorization.grant.publication_profile_id, request.project_id), request.capabilities);
}

export async function assertApplicationPublicationDispatch(ctx: ServerContext, row: Publication): Promise<ApplicationPublicationRequestV1> {
  const request = ApplicationPublicationRequestV1Schema.parse(row.request);
  const [automation] = await ctx.db.db.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, row.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [goal] = await ctx.db.db.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!automation || !goal || !["executing", "waiting"].includes(automation.status) || goal.status !== "running" || !currentSession(ctx, request))
    conflict("new work requires the original active goal and current paired session");
  await requireAiSharingAuthorization({ ...ctx, actorUserId: automation.actorUserId }, ctx.db.db, automation);
  if (applicationPublicationDigest(request) !== row.requestDigest
    || !isDeepStrictEqual(await acceptedRequest(ctx, ctx.db.db, automation, row.id), request) || !currentSession(ctx, request))
    conflict("original accepted publication request changed before dispatch");
  return request;
}

/** Caller holds the goal lock; completion is separate from task acceptance and
 * requires the latest fresh observation of the original second service owner. */
export async function ensureGoalApplicationPublication(ctx: ServerContext, tx: DrizzleDb, automation: Automation): Promise<{
  status: "pending" | "succeeded" | "failed"; publicationId?: string; reason?: string; endpoint?: string;
}> {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  if (!goal || goal.status !== "running" || goal.currentPlanId !== automation.planId) conflict("goal stopped or replanned before publication");
  const [existing] = await tx.select().from(applicationPublications).where(and(eq(applicationPublications.goalId, goal.id),
    eq(applicationPublications.organizationId, ctx.organizationId))).for("update");
  if (existing?.status === "failed") return { status: "failed", publicationId: existing.id, reason: "Application publication failed; original evidence and owners are retained." };
  await requireAiSharingAuthorization({ ...ctx, actorUserId: automation.actorUserId }, tx, automation);
  const id = existing?.id ?? ctx.idGen.generate("application"), request = await acceptedRequest(ctx, tx, automation, id);
  if (!currentSession(ctx, request)) return { status: "pending", ...(existing ? { publicationId: existing.id } : {}), reason: "Waiting for the original paired publication session; reconnect cannot adopt it." };
  const requestDigest = applicationPublicationDigest(request);
  if (!existing) {
    const now = ctx.clock.nowIso();
    await tx.insert(applicationPublications).values({ id, organizationId: ctx.organizationId, goalId: goal.id, projectId: goal.projectId,
      computerId: request.computer_id, publisherSessionId: request.publisher_session_id, authorizationEventId: request.authorization.event_id,
      request, requestDigest, status: "queued", createdAt: now, updatedAt: now });
    return { status: "pending", publicationId: id, reason: "Original candidate and independent review accepted; bounded local publication queued." };
  }
  if (existing.requestDigest !== requestDigest || !isDeepStrictEqual(existing.request, request)) conflict("immutable request differs from the current accepted source");
  if (existing.status !== "published") return { status: "pending", publicationId: id, reason: "Waiting for actual installation, readiness, normal drain and same-database reopen." };
  const receipt = ApplicationPublicationReceiptV1Schema.parse(existing.receipt);
  const [latest] = await tx.select().from(applicationPublicationObservations).where(eq(applicationPublicationObservations.publicationId, id))
    .orderBy(desc(applicationPublicationObservations.sequence)).limit(1);
  const report = latest && ApplicationPublicationObservationV1Schema.parse(latest.payload), now = ctx.clock.nowIso(), at = Date.parse(now);
  if (receipt.outcome !== "published" || !report || report.state !== "healthy" || !report.health || !report.live || report.closure
    || !isDeepStrictEqual(report.lease, receipt.lease) || !isDeepStrictEqual(report.deployment, receipt.deployment)
    || at >= Date.parse(report.lease.deadline_at) || at < Date.parse(report.observed_at)
    || [report.health.checked_at, report.live.observed_at, report.live.counters_observed_at].some(time => at - Date.parse(time) > request.capabilities.contract.limits.health_freshness_ms))
    return { status: "pending", publicationId: id, reason: "Waiting for a fresh healthy observation from the original live second owner." };
  if (!currentSession(ctx, request)) conflict("paired session ended before completion");
  const binding = { version: 1, publication_id: id, request_digest: requestDigest, receipt_digest: existing.receiptDigest!,
    authorization_event_id: request.authorization.event_id, observation_id: latest!.id, observation_sequence: latest!.sequence,
    lease_id: report.lease.lease_id, deadline_at: report.lease.deadline_at, scope: "bounded-local-application-publication" };
  const event = buildEvent(ctx, { type: "goal.completed", actorType: "system", actorId: "goal_runner", correlationId: goal.id,
    goalId: goal.id, projectId: goal.projectId, roomId: goal.roomId,
    payload: { goal_id: goal.id, trigger: "application_publication_healthy", endpoint: receipt.deployment.origin, application_publication: binding } });
  event.occurredAt = now;
  await appendEvent(tx, event);
  await tx.insert(applicationPublicationSettlements).values({ goalId: goal.id, organizationId: ctx.organizationId, publicationId: id,
    requestDigest, receiptDigest: existing.receiptDigest!, authorizationEventId: request.authorization.event_id, observationId: latest!.id,
    observationSequence: latest!.sequence, leaseId: report.lease.lease_id, deadlineAt: report.lease.deadline_at, scope: binding.scope, eventId: event.id, createdAt: now });
  await tx.update(goals).set({ status: "completed", updatedAt: now }).where(eq(goals.id, goal.id));
  await tx.update(goalAutomations).set({ status: "completed", lastError: null, updatedAt: now }).where(eq(goalAutomations.goalId, goal.id));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.automation.updated", actorType: "system", actorId: "goal_runner", correlationId: goal.id,
    goalId: goal.id, projectId: goal.projectId, payload: { goal_id: goal.id, status: "completed", last_error: null } }));
  return { status: "succeeded", publicationId: id, endpoint: receipt.deployment.origin };
}

export async function ingestApplicationPublicationReceipt(ctx: ServerContext, computerId: string, input: ApplicationPublicationReceiptV1,
  isCurrent: () => boolean): Promise<void> {
  const receipt = ApplicationPublicationReceiptV1Schema.parse(input), request = receipt.request;
  if (!isCurrent() || request.computer_id !== computerId || ctx.getPairedNodeSession?.(computerId)?.sessionId !== request.publisher_session_id)
    conflict("receipt is not from its original authenticated publisher connection");
  await ctx.db.transaction(async tx => {
    const [row] = await tx.select().from(applicationPublications).where(and(eq(applicationPublications.id, request.publication_id),
      eq(applicationPublications.organizationId, ctx.organizationId), eq(applicationPublications.computerId, computerId))).for("update");
    if (!row || row.requestDigest !== receipt.request_digest || !isDeepStrictEqual(row.request, request)) conflict("receipt differs from its immutable dispatched request");
    const hash = applicationPublicationDigest(receipt);
    if (row.receipt) { if (row.receiptDigest !== hash || !isDeepStrictEqual(row.receipt, receipt)) conflict("terminal receipt is immutable"); return; }
    if (!isCurrent()) conflict("receipt connection ended before commit");
    const event = buildEvent(ctx, { type: "goal.application-publication.receipt", actorType: "system", actorId: "goal_runner",
      correlationId: row.id, projectId: row.projectId, goalId: row.goalId,
      payload: { publication_id: row.id, request_digest: row.requestDigest, receipt_digest: hash, outcome: receipt.outcome } });
    await appendEvent(tx, event);
    await tx.update(applicationPublications).set({ status: receipt.outcome, receipt, receiptDigest: hash, receiptEventId: event.id,
      updatedAt: ctx.clock.nowIso() }).where(eq(applicationPublications.id, row.id));
  });
}

export async function ingestApplicationPublicationObservation(ctx: ServerContext, computerId: string, input: ApplicationPublicationObservationV1,
  isCurrent: () => boolean): Promise<void> {
  const report = ApplicationPublicationObservationV1Schema.parse(input), request = report.request;
  if (!isCurrent() || request.computer_id !== computerId || ctx.getPairedNodeSession?.(computerId)?.sessionId !== request.publisher_session_id)
    conflict("observation is not from its original authenticated publisher connection");
  await ctx.db.transaction(async tx => {
    const [row] = await tx.select().from(applicationPublications).where(and(eq(applicationPublications.id, request.publication_id),
      eq(applicationPublications.organizationId, ctx.organizationId), eq(applicationPublications.computerId, computerId))).for("update");
    if (!row || row.requestDigest !== report.request_digest || !isDeepStrictEqual(row.request, request)) conflict("observation differs from its immutable dispatched request");
    const [prior] = await tx.select().from(applicationPublicationObservations).where(eq(applicationPublicationObservations.id, report.event_id));
    const hash = applicationPublicationDigest(report);
    if (prior) { if (prior.publicationId !== row.id || prior.payloadDigest !== hash || !isDeepStrictEqual(prior.payload, report)) conflict("observation identity already contains different facts"); return; }
    const receipt = ApplicationPublicationReceiptV1Schema.parse(row.receipt);
    if (receipt.outcome !== "published") conflict("later observations require the original published second owner");
    for (const actual of [report.health?.service, report.live?.service, report.closure?.service])
      if (actual && !isDeepStrictEqual(actual, receipt.second_service.live.service)) conflict("observation replaced its original second service owner");
    if (report.live && !isDeepStrictEqual(report.live.native, receipt.second_service.live.native)) conflict("observation replaced its original native root identity");
    const [previous] = await tx.select().from(applicationPublicationObservations).where(and(eq(applicationPublicationObservations.publicationId, row.id),
      sql`${applicationPublicationObservations.payload}->'live' IS NOT NULL AND ${applicationPublicationObservations.payload}->'live' <> 'null'::jsonb`))
      .orderBy(desc(applicationPublicationObservations.sequence)).limit(1);
    const previousReport = previous && ApplicationPublicationObservationV1Schema.parse(previous.payload);
    const previousLive = previousReport?.live ?? receipt.second_service.live;
    if (report.live && (report.live.requests_used < previousLive.requests_used
      || Date.parse(report.live.counters_observed_at) < Date.parse(previousLive.counters_observed_at))
      || report.closure?.kind === "normal-drain" && report.closure.counters.accepted_transports < previousLive.requests_used)
      conflict("original request counters regressed");
    if (["healthy", "live"].includes(report.state) && !currentSession(ctx, request)) conflict("new live observations require the original paired publication session");
    if (!isCurrent()) conflict("observation connection ended before commit");
    const event = buildEvent(ctx, { type: "goal.application-publication.observation", actorType: "system", actorId: "goal_runner",
      correlationId: row.id, projectId: row.projectId, goalId: row.goalId,
      payload: { publication_id: row.id, request_digest: row.requestDigest, event_id: report.event_id, sequence: report.sequence, observation_digest: hash, state: report.state } });
    await appendEvent(tx, event);
    await tx.insert(applicationPublicationObservations).values({ id: report.event_id, organizationId: ctx.organizationId,
      publicationId: row.id, publisherSessionId: request.publisher_session_id, sequence: report.sequence, generation: report.generation,
      state: report.state, requestDigest: row.requestDigest, payload: report, payloadDigest: hash, eventId: event.id, createdAt: ctx.clock.nowIso() });
  });
}

/** Stop is available independently of goal completion; terminal facts survive
 * withdrawn publication authorization and never reopen the goal or old owner. */
export async function cancelGoalApplicationPublication(ctx: ServerContext, goalId: string): Promise<void> {
  const [row] = await ctx.db.db.select().from(applicationPublications).where(and(eq(applicationPublications.goalId, goalId), eq(applicationPublications.organizationId, ctx.organizationId)));
  if (!row) return;
  const [last] = await ctx.db.db.select().from(applicationPublicationObservations).where(eq(applicationPublicationObservations.publicationId, row.id))
    .orderBy(desc(applicationPublicationObservations.sequence)).limit(1);
  if (["closed-normal", "closed-aborted"].includes(last?.state ?? "") || last?.state === "expired" && ApplicationPublicationObservationV1Schema.parse(last.payload).closure) return;
  const receipt = row.receipt ? ApplicationPublicationReceiptV1Schema.parse(row.receipt) : null;
  if (receipt && receipt.outcome === "failed" && receipt.cleanup.state !== "unconfirmed") return;
  if (!ctx.onApplicationPublicationQueued) conflict("original publisher is unavailable; stop remains unconfirmed");
  await ctx.onApplicationPublicationQueued(row.id, "stop");
  const [closed] = await ctx.db.db.select().from(applicationPublicationObservations).where(eq(applicationPublicationObservations.publicationId, row.id))
    .orderBy(desc(applicationPublicationObservations.sequence)).limit(1);
  const [settled] = await ctx.db.db.select().from(applicationPublications).where(eq(applicationPublications.id, row.id));
  const failed = settled?.receipt ? ApplicationPublicationReceiptV1Schema.parse(settled.receipt) : null;
  if (!closed || !ApplicationPublicationObservationV1Schema.parse(closed.payload).closure) {
    if (!failed || failed.outcome !== "failed" || failed.cleanup.state === "unconfirmed") conflict("original service closure remains unconfirmed");
  }
}

/** Historical publication remains visible after expiry; availability must use a
 * fresh observation and the still-current original connection. */
export async function getGoalApplicationPublication(ctx: ServerContext, goalId: string) {
  const [goal] = await ctx.db.db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) throw AppError.notFound("Goal not found");
  const [row] = await ctx.db.db.select().from(applicationPublications).where(and(eq(applicationPublications.goalId, goalId), eq(applicationPublications.organizationId, ctx.organizationId)));
  if (!row) return null;
  const [latest] = await ctx.db.db.select().from(applicationPublicationObservations).where(eq(applicationPublicationObservations.publicationId, row.id))
    .orderBy(desc(applicationPublicationObservations.sequence)).limit(1);
  const request = ApplicationPublicationRequestV1Schema.parse(row.request), receipt = row.receipt ? ApplicationPublicationReceiptV1Schema.parse(row.receipt) : null;
  const report = latest ? ApplicationPublicationObservationV1Schema.parse(latest.payload) : null;
  const now = Date.parse(ctx.clock.nowIso()), deadline = receipt?.lease?.deadline_at ?? report?.lease.deadline_at;
  let state: ApplicationPublicationObservationV1["state"] | "pending" = report?.state ?? (receipt ? "unknown" : "pending");
  if (deadline && now >= Date.parse(deadline)) state = "expired";
  else if (["healthy", "live", "draining"].includes(state) && (!currentSession(ctx, request) || !report
    || [report.observed_at, report.health?.checked_at, report.live?.observed_at, report.live?.counters_observed_at].filter((time): time is string => !!time)
      .some(time => now < Date.parse(time) || now - Date.parse(time) > request.capabilities.contract.limits.health_freshness_ms))) state = "unknown";
  return { id: row.id, goal_id: row.goalId, status: row.status, scope: "bounded-local-application-publication" as const,
    request, receipt, latest_observation: report, current_state: state,
    endpoint: receipt?.outcome === "published" ? receipt.deployment.origin : null,
    created_at: row.createdAt, updated_at: row.updatedAt };
}
