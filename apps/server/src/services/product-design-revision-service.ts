import { agentInstances, appendEvent, autonomousReviews, computers, fileLeases, goalAutomations, goalImportedDesignContinuations,
  goalProductHandoffs, goals, plans, productDesignRevisions, productReleases, runs, tasks } from "@artoo/db";
import { AutonomousTeamSchema, criterionRefKey, ProductDesignRevisionContextV1Schema, ProductDesignV2Schema,
  ProductResearchReportV2Schema, TaskSpecSchema, validateProductDevelopmentHandoff, PRODUCT_DESIGN_REVISION_FEATURE_V1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { automationWorkspacesOverlap } from "./automation-workspace.js";
import { unconfirmedDisconnectRunIds, unsettledStandaloneExecutions } from "./execution-state.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { reviewTask } from "./lifecycle-service.js";
import { assertDesignRevisionAuthorization, assertDesignRevisionProfile, designRevisionContextForRun,
  latestDesignRevision, readDesignRevisionFile, type DesignRevision } from "./product-design-revision-guard.js";
import { transitionTask } from "./transition-service.js";
import { inspectRunVerification } from "./verification-service.js";

/** Caller owns the automation transaction. Task locks precede the goal, then instance/computer locks, as in assignment. */
export async function requestProductDesignRevision(ctx: ServerContext, tx: DrizzleDb, input: {
  goalId: string; implementationTaskId: string; implementationRunId: string; requestingReviewId: string;
}): Promise<DesignRevision> {
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, input.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  if (!automation || !ctx.automationActor || ctx.actorUserId !== automation.actorUserId || automation.executionMode !== "agent_team") {
    throw AppError.permissionDenied("Only the original Agent Team goal runner may request design revision");
  }
  await requireAiSharingAuthorization(ctx, tx, { consentId: automation.consentId, policyVersion: automation.policyVersion });
  const [prior] = await tx.select().from(productDesignRevisions).where(and(eq(productDesignRevisions.organizationId, ctx.organizationId),
    eq(productDesignRevisions.requestingReviewId, input.requestingReviewId)));
  if (prior) {
    const expected = prior.intent as { requesting_review?: { subject_run_id?: string } };
    if (prior.goalId !== input.goalId || expected.requesting_review?.subject_run_id !== input.implementationRunId) throw AppError.conflict("Revision retry changed the original request binding");
    return prior;
  }
  const [implementation] = await tx.select().from(tasks).where(and(eq(tasks.id, input.implementationTaskId), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [subject] = await tx.select().from(runs).where(and(eq(runs.id, input.implementationRunId), eq(runs.organizationId, ctx.organizationId)));
  const context = subject ? await designRevisionContextForRun(ctx, tx, subject.id) : undefined;
  const designPin = context?.product_development?.accepted_inputs?.files.find(file => file.path === ".artoo/product/design.json");
  const researchPin = context?.product_development?.accepted_inputs?.files.find(file => file.path === ".artoo/product/research.json");
  if (!implementation || implementation.status !== "review" || implementation.goalId !== automation.goalId || implementation.sourcePlanId !== automation.planId
    || !subject || subject.taskId !== implementation.id || subject.status !== "completed" || context?.product_development?.stage !== "implementation"
    || context.goal_context?.goal_id !== automation.goalId || context.goal_context.plan?.id !== automation.planId || !designPin || !researchPin
    || context.transferred_product_input || context.imported_review_subject || subject.workspaceAllocation !== null || subject.workspaceBranch !== null) {
    throw AppError.conflict("Revision requires the current local implementation review and accepted design/research pins");
  }
  const [designTask] = await tx.select().from(tasks).where(and(eq(tasks.id, designPin.source_task_id), eq(tasks.organizationId, ctx.organizationId))).for("update");
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, automation.goalId), eq(goals.organizationId, ctx.organizationId))).for("update");
  const [plan] = await tx.select().from(plans).where(and(eq(plans.id, automation.planId ?? ""), eq(plans.organizationId, ctx.organizationId)));
  const designSpec = designTask && plan && Array.isArray(plan.taskSpecs) ? TaskSpecSchema.safeParse(plan.taskSpecs[Number(designTask.sourcePlanSpecRef)]) : undefined;
  if (!goal || goal.status !== "running" || goal.currentPlanId !== automation.planId || !plan || !designTask || designTask.status !== "done"
    || designTask.goalId !== goal.id || designTask.projectId !== goal.projectId || designTask.sourcePlanId !== plan.id
    || !designSpec?.success || designSpec.data.development_stage !== "design") throw AppError.conflict("Revision design task or current plan is no longer accepted");
  if ((await latestDesignRevision(ctx, tx, goal.id))?.state === "active") throw AppError.conflict("This goal already has an active design revision");
  const [imported] = await tx.select({ id: goalProductHandoffs.id }).from(goalProductHandoffs).where(eq(goalProductHandoffs.goalId, goal.id)).limit(1);
  const [importedDesign] = await tx.select({ id: goalImportedDesignContinuations.id }).from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.goalId, goal.id)).limit(1);
  const [release] = await tx.select({ id: productReleases.id }).from(productReleases).where(eq(productReleases.goalId, goal.id)).limit(1);
  if (imported || importedDesign || release) throw AppError.conflict("Local design revision excludes imported histories and existing publication intents");
  const [baseline] = await tx.select().from(runs).where(and(eq(runs.taskId, designTask.id), eq(runs.organizationId, ctx.organizationId)))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  const [latestImplementation] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, implementation.id), eq(runs.organizationId, ctx.organizationId)))
    .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
  const team = AutonomousTeamSchema.parse(automation.team), authorId = team.members.find(member => member.stage === "design")!.agent_instance_id;
  if (!baseline || baseline.id !== designPin.source_run_id || baseline.status !== "completed" || latestImplementation?.id !== subject.id
    || baseline.agentInstanceId !== authorId || baseline.workspaceAllocation !== null || baseline.workspaceBranch !== null
    || baseline.computerId !== automation.computerId || baseline.workspaceRoot !== automation.workspaceRoot
    || subject.computerId !== baseline.computerId || subject.workspaceRoot !== baseline.workspaceRoot
    || [baseline, subject].some(run => run.requestedByUserId !== automation.actorUserId || run.aiDataSharingConsentId !== automation.consentId
      || run.aiDataSharingPolicyVersion !== automation.policyVersion)) throw AppError.conflict("Revision must reuse the exact accepted design and its original local owner");
  const [author] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, authorId), eq(agentInstances.organizationId, ctx.organizationId))).for("update");
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, baseline.computerId), eq(computers.organizationId, ctx.organizationId))).for("update");
  if (!author || author.runtime === "mock" || !computer || !["win32", "windows"].includes(computer.os)) throw AppError.conflict("Local design revision requires an ordinary native Windows author");
  const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id });
  const occupants = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id),
    or(sql`${runs.status} NOT IN ('completed','failed','cancelled')`, uncertain.length ? inArray(runs.id, uncertain) : undefined)));
  const standalone = await unsettledStandaloneExecutions(ctx, tx, { computerId: computer.id });
  const held = await tx.select({ id: fileLeases.id }).from(fileLeases).where(and(eq(fileLeases.organizationId, ctx.organizationId), eq(fileLeases.projectId, goal.projectId), eq(fileLeases.status, "held")));
  if (held.length || occupants.some(run => !run.workspaceRoot || automationWorkspacesOverlap(run.workspaceRoot, baseline.workspaceRoot!, computer.os))
    || standalone.some(operation => automationWorkspacesOverlap(operation.workspaceRoot, baseline.workspaceRoot!, computer.os))) {
    throw AppError.conflict("Revision waits for all workspace processes, leases and uncertain closures");
  }
  const assertProfile = () => {
    if (ctx.supportsExecutionFeature?.(computer.id, PRODUCT_DESIGN_REVISION_FEATURE_V1) !== true
      || ctx.supportsVerificationProfile?.(computer.id, automation.verificationProfileId, goal.projectId, baseline.workspaceRoot!) !== true) throw AppError.conflict("Current Windows node does not advertise design revision support");
    const capabilities = ctx.getVerificationCapabilities?.(computer.id, automation.verificationProfileId, goal.projectId, baseline.workspaceRoot!);
    assertDesignRevisionProfile(capabilities);
    if (!isDeepStrictEqual(context.verification_capabilities, { ...capabilities, profile_id: automation.verificationProfileId })) throw AppError.conflict("Revision profile differs from the accepted implementation scope");
  };
  assertProfile();
  const measured = await inspectRunVerification(ctx, tx, subject), accepted = await inspectRunVerification(ctx, tx, baseline);
  if (!measured.passed || !measured.evidence || !accepted.passed || !accepted.evidence || accepted.evidence.id !== designPin.evidence_id
    || !accepted.evidence.payload.required_files.some(file => file.path === designPin.path && file.checksum === designPin.checksum && file.size === designPin.size)) {
    throw AppError.conflict("Revision lacks exact independently measured implementation and accepted baseline evidence");
  }
  const request = await inspectIndependentReview(ctx, tx, subject, measured.evidence), acceptedReview = await inspectIndependentReview(ctx, tx, baseline, accepted.evidence);
  if (request.status !== "changes_requested" || request.review?.id !== input.requestingReviewId || !request.designRevisionRequest || !request.responseBinding
    || !request.reviewerRunId || !request.reviewerEvidenceId || acceptedReview.status !== "accepted" || !acceptedReview.review
    || !acceptedReview.reviewerRunId || !acceptedReview.reviewerEvidenceId) throw AppError.conflict("Revision requires an explicit independently qualified implementation request and accepted baseline review");
  const baselineContext = await designRevisionContextForRun(ctx, tx, baseline.id);
  if (baselineContext?.transferred_product_input || baselineContext?.imported_review_subject || baselineContext?.product_development?.stage !== "design"
    || !isDeepStrictEqual(baselineContext.product_development.accepted_inputs?.files.find(file => file.path === researchPin.path), researchPin)) {
    throw AppError.conflict("Accepted design and implementation do not share the same local research pin");
  }
  const [researchRun] = await tx.select().from(runs).where(and(eq(runs.id, researchPin.source_run_id), eq(runs.organizationId, ctx.organizationId)));
  const [researchTask] = await tx.select().from(tasks).where(and(eq(tasks.id, researchPin.source_task_id), eq(tasks.organizationId, ctx.organizationId)));
  const researchEvidence = researchRun ? await inspectRunVerification(ctx, tx, researchRun) : undefined;
  if (!researchRun || researchRun.status !== "completed" || researchRun.taskId !== researchPin.source_task_id || researchTask?.status !== "done"
    || researchTask.goalId !== goal.id || researchTask.sourcePlanId !== plan.id || !researchEvidence?.passed || researchEvidence.evidence?.id !== researchPin.evidence_id
    || !researchEvidence.evidence.payload.required_files.some(file => file.path === researchPin.path && file.checksum === researchPin.checksum && file.size === researchPin.size)) {
    throw AppError.conflict("Revision research pin is not an accepted measured local source");
  }
  const raw = await readDesignRevisionFile(ctx, tx, baseline, designPin), research = await readDesignRevisionFile(ctx, tx, researchRun, researchPin);
  const parsedDesign = ProductDesignV2Schema.parse(raw.json), parsedResearch = ProductResearchReportV2Schema.parse(research.json);
  if (validateProductDevelopmentHandoff(parsedResearch, parsedDesign).length) throw AppError.conflict("Accepted design baseline differs from its pinned policy-v2 research");
  const allowed = new Set(parsedResearch.measurement_plan.entries.filter(entry => entry.method === "workspace-check").map(criterionRefKey));
  if (request.designRevisionRequest.requirement_criteria.some(ref => !allowed.has(criterionRefKey(ref)))) throw AppError.conflict("Revision request targets a criterion outside the accepted workspace mapping");
  // Re-read the live response after I/O; a mutable assistant message is never retained as unqualified authority.
  const refreshed = await inspectIndependentReview(ctx, tx, subject, measured.evidence);
  if (!isDeepStrictEqual(refreshed.responseBinding, request.responseBinding) || !isDeepStrictEqual(refreshed.designRevisionRequest, request.designRevisionRequest)
    || refreshed.status !== "changes_requested") throw AppError.conflict("Revision requesting response changed during content retrieval");
  const id = ctx.idGen.generate("design_revision"), now = ctx.clock.nowIso(), previous = await latestDesignRevision(ctx, tx, goal.id);
  const descriptor = ProductDesignRevisionContextV1Schema.parse({ version: 1, revision_id: id, project_id: goal.projectId, goal_id: goal.id, plan_id: plan.id,
    computer_id: computer.id, workspace_root: baseline.workspaceRoot, design_task_id: designTask.id, author_run_id: baseline.id, request: request.designRevisionRequest,
    requesting_review: { review_id: request.review.id, subject_run_id: subject.id, subject_evidence_id: measured.evidence.id,
      reviewer_instance_id: request.review.reviewerInstanceId, reviewer_run_id: request.reviewerRunId, reviewer_evidence_id: request.reviewerEvidenceId, ...request.responseBinding },
    baseline: { run_id: baseline.id, evidence_id: accepted.evidence.id, review_id: acceptedReview.review.id, reviewer_run_id: acceptedReview.reviewerRunId,
      reviewer_evidence_id: acceptedReview.reviewerEvidenceId, design: { path: designPin.path, checksum: designPin.checksum, size: designPin.size, text: raw.text }, research: researchPin } });
  const { author_run_id: _authorRun, ...intent } = descriptor;
  // The intent must exist before the internal reopen. It cannot be committed without the ordinary retry debit.
  await tx.update(autonomousReviews).set({ status: "changes_requested", updatedAt: now }).where(eq(autonomousReviews.id, request.review.id));
  const [revision] = await tx.insert(productDesignRevisions).values({ id, organizationId: ctx.organizationId, goalId: goal.id, planId: plan.id, projectId: goal.projectId,
    designTaskId: designTask.id, requestingReviewId: request.review.id, authorInstanceId: authorId, computerId: computer.id, workspaceRoot: baseline.workspaceRoot!,
    actorUserId: automation.actorUserId, consentId: automation.consentId, policyVersion: automation.policyVersion, sequence: (previous?.sequence ?? 0) + 1,
    intent, state: "active", createdAt: now }).returning();
  await assertDesignRevisionAuthorization(ctx, tx, revision!);
  assertProfile();
  const atomic = { ...ctx, db: { ...ctx.db, db: tx, transaction: async <T>(fn: (inner: DrizzleDb) => Promise<T>) => fn(tx) } } as ServerContext;
  await reviewTask(atomic, implementation.id, { outcome: "changes_requested", comment: request.reason });
  const changed = await transitionTask(tx, ctx, { taskId: designTask.id, from: "done", trigger: "design_revision_requested", now,
    events: to => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: id, goalId: goal.id,
      projectId: goal.projectId, taskId: designTask.id, roomId: designTask.roomId, payload: { status: to, design_revision_id: id,
        requesting_review_id: request.review!.id, baseline_run_id: baseline.id, baseline_evidence_id: accepted.evidence!.id } })] });
  if (!changed.changed) throw AppError.conflict("Accepted design changed before its internal revision transition");
  await appendEvent(tx, buildEvent(ctx, { type: "goal.automation.updated", actorType: "system", actorId: "goal_runner", correlationId: id,
    goalId: goal.id, projectId: goal.projectId, payload: { design_revision_id: id, requesting_review_id: request.review.id, status: "executing" } }));
  return revision!;
}
