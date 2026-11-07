import { eventLog, goalCleanValidations as validations, goalCleanValidationReviews as reviews,
  goalCleanValidationPublications as publications, sourceCleanGenerations, productReleases, runs } from "@artoo/db";
import { ProductReleaseRequestSchema, ReleaseAcceptanceBindingV1Schema,
  ReleaseCapabilitiesV1Schema, canonicalProductSourceTransferValueV1 as canonical,
  type ImportedCleanReleaseOriginV1, type ReleaseAcceptanceBindingV1, type ReleaseCapabilitiesV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import type { AcceptedReleaseSource, ReleaseAcceptanceAutomation } from "./release-acceptance.js";
import { importedImplementationActorContext } from "./imported-execution-service.js";
import { unsettledGoalExecutionCount } from "./execution-state.js";
import { assertCleanPublicationAuthorization } from "./product-release-clean-service.js";
import { readCleanValidationRoot, readValidationSource, readValidationReview, validationTask, type Validation } from "./clean-validation-source-service.js";
import { assertCleanValidationDispatch } from "./clean-validation-origin-service.js";

export function cleanReleaseSourceOrigin(origin: ImportedCleanReleaseOriginV1 | undefined) {
  if (!origin) return undefined;
  const { interrupted_release_id: _previous, authorization: _authorization, ...source } = origin;
  return source;
}

/** The sole clean-restart source resolver: history proves bytes; live admission separately proves current authority. */
async function resolve(ctx: ServerContext, tx: DrizzleDb, author: Validation, options: { live?: boolean; final?: boolean } = {}): Promise<AcceptedReleaseSource> {
  const acting = options.live ? importedImplementationActorContext(ctx, author.actorUserId) : ctx;
  const root = await readCleanValidationRoot(acting, tx, author.cleanGenerationId, { live: options.live });
  const { task } = validationTask(root, author.taskId), measured = await readValidationSource(ctx, tx, author, root);
  const [review] = await tx.select().from(reviews).where(and(eq(reviews.validationId, author.id), eq(reviews.organizationId, ctx.organizationId)))
    .orderBy(desc(reviews.sequence)).limit(1);
  if (author.goalId !== root.goal.id || author.planId !== root.plan.id || author.readyKind !== "review" || measured.source.outcome !== "verified"
    || task.status !== "done" || !review || !review.acceptedAt || !review.acceptanceEventId || review.stopRequested)
    throw AppError.conflict("Publication requires the latest independently accepted clean-restart final product");
  const qualified = await readValidationReview(ctx, tx, review, root, measured.source);
  const [acceptance] = await tx.select().from(eventLog).where(and(eq(eventLog.id, review.acceptanceEventId), eq(eventLog.organizationId, ctx.organizationId)));
  const payload = acceptance?.payload as Record<string, unknown> | undefined;
  if (qualified.result.outcome !== "reviewed" || qualified.result.verdict.outcome !== "accepted" || !measured.evidence
    || review.goalId !== author.goalId || review.planId !== author.planId || review.taskId !== author.taskId
    || review.computerId !== author.computerId || review.workspaceRoot !== author.workspaceRoot
    || review.authorAgentId !== author.writerAgentId || review.authorInstanceId !== author.writerInstanceId
    || review.reviewerAgentId === author.writerAgentId || review.reviewerInstanceId === author.writerInstanceId
    || !acceptance || acceptance.type !== "goal.clean-validation-review.accepted" || acceptance.actorType !== "system" || acceptance.actorId !== "goal_runner"
    || acceptance.goalId !== author.goalId || acceptance.taskId !== author.taskId || acceptance.runId !== author.runId
    || payload?.review_id !== review.id || payload.validation_id !== author.id || payload.result_digest !== review.resultDigest
    || payload.source_digest !== measured.sourceDigest || payload.subject_digest !== measured.source.subject_digest
    || payload.verification_evidence_id !== measured.evidence.id || payload.actor_user_id !== author.actorUserId || payload.publication_authorized !== false)
    throw AppError.conflict("Publication lacks the exact original clean-restart review and acceptance event");
  if (options.final && (root.goal.currentPlanId !== root.plan.id || root.automation.planId !== root.plan.id
    || root.siblings.some(child => child.status !== "done") || await unsettledGoalExecutionCount(ctx, tx, root.goal.id)))
    throw AppError.conflict("Final publication settlement requires every original plan task and process exit");
  const context = measured.request.run_start.context_pack.payload, summary = measured.evidence.payload.measurement_plan;
  const transfer = root.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request;
  const capabilities = ReleaseCapabilitiesV1Schema.parse(transfer.measurement_v2?.destination_release);
  if (canonical(context.release_capabilities) !== canonical(capabilities) || context.product_development?.stage !== "validation"
    || !context.imported_clean_validation || context.imported_clean_validation.validation_id !== author.id || context.review_subject || context.imported_clean_validation_review_subject
    || context.goal_context?.goal_id !== author.goalId || context.goal_context.plan?.id !== author.planId || context.goal_context.plan.version !== root.plan.version
    || context.goal_context.plan.spec_ref !== task.sourcePlanSpecRef || summary?.version !== 2 || summary.scope !== "final" || !summary.pending_release.length
    || measured.run.status !== "completed" || measured.evidence.payload.subject_digest !== measured.source.subject_digest
    || capabilities.binding.workspace_root !== author.workspaceRoot || measured.run.computerId !== author.computerId
    || summary.pending_release.some(ref => canonical(ref.release_binding) !== canonical(capabilities.binding)))
    throw AppError.conflict("clean-restart final evidence differs from the original destination publication contract");
  const pin = context.product_development.accepted_inputs?.files.find(file => file.path === summary.research.path);
  if (!pin || pin.checksum !== summary.research.checksum || pin.size !== summary.research.size)
    throw AppError.conflict("clean-restart release obligations lost the accepted research pin");
  const binding = ReleaseAcceptanceBindingV1Schema.parse({ version: 1, plan: { id: root.plan.id, version: root.plan.version },
    research: summary.research, measurement_plan_digest: summary.measurement_plan_digest, release_binding: capabilities.binding,
    criteria: summary.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) => ({ requirement_id, criterion_index, criterion_digest, claim_id })) });
  const releaseOrigin = { version: 1 as const, clean_generation_id: author.cleanGenerationId, restart_digest: root.restartDigest,
    validation_id: author.id, validation_request_digest: author.requestDigest,
    validation_result_digest: author.resultDigest!, review_id: review.id, review_request_digest: review.requestDigest, review_result_digest: review.resultDigest!,
    acceptance_event_id: review.acceptanceEventId, subject_digest: measured.source.subject_digest };
  return { run: measured.run, evidence: measured.evidence, binding, capabilities, cleanOrigin: { cleanGenerationId: author.cleanGenerationId, restartDigest: root.restartDigest, validationId: author.id,
    reviewId: review.id, originReviewId: author.originReviewId, sourceDigest: measured.sourceDigest, acceptanceEventId: review.acceptanceEventId,
    session: root.sessionBindings.destination, releaseOrigin } };
}

export async function hasCleanValidationPublication(ctx: ServerContext, tx: DrizzleDb, goalId: string): Promise<boolean> {
  return (await tx.select({ id: publications.releaseId }).from(publications).where(and(eq(publications.organizationId, ctx.organizationId), eq(publications.goalId, goalId))).limit(1)).length !== 0;
}

export async function inspectCleanFinalReleaseAcceptance(ctx: ServerContext, tx: DrizzleDb, automation: ReleaseAcceptanceAutomation): Promise<AcceptedReleaseSource | undefined> {
  const [recovery] = await tx.select().from(sourceCleanGenerations).where(and(eq(sourceCleanGenerations.organizationId, ctx.organizationId),
    sql`${sourceCleanGenerations.grant}->>'goal_id' = ${automation.goalId}`)).orderBy(desc(sourceCleanGenerations.createdAt), desc(sourceCleanGenerations.id)).limit(1);
  if (!recovery) return undefined;
  const [author] = await tx.select().from(validations).where(and(eq(validations.cleanGenerationId, recovery.id), eq(validations.organizationId, ctx.organizationId), eq(validations.goalId, automation.goalId),
    eq(validations.planId, automation.planId ?? ""))).orderBy(desc(validations.generation)).limit(1);
  if (!author) throw AppError.conflict("Recovered workspace has no dedicated accepted clean-restart final source");

  const source = await resolve(ctx, tx, author, { final: true });
  const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, author.goalId)))
    .orderBy(desc(productReleases.publicationGeneration)).limit(1);
  if (release && release.status !== "interrupted") {
    await assertCleanPublicationAuthorization(ctx, tx, release, source, false);
    await assertPublication(ctx, tx, release, source);
  }
  return source;
}

export async function inspectCleanReleaseAcceptanceRun(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect,
  goalId: string, plan: ReleaseAcceptanceBindingV1["plan"], expectedCapabilities?: ReleaseCapabilitiesV1, releaseId?: string): Promise<AcceptedReleaseSource | undefined> {
  const [author] = await tx.select().from(validations).where(and(eq(validations.runId, run.id), eq(validations.organizationId, ctx.organizationId)));
  if (!author) return undefined;
  const source = await resolve(ctx, tx, author);
  if (author.goalId !== goalId || canonical(source.binding.plan) !== canonical(plan)
    || expectedCapabilities && canonical(source.capabilities) !== canonical(expectedCapabilities)) throw AppError.conflict("clean-restart publication source belongs to another goal, plan or capability");
  if (!releaseId) throw AppError.conflict("Historical clean-restart publication requires its exact release ID");
  const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId), eq(productReleases.goalId, goalId)));
  if (!release) throw AppError.conflict("Historical clean-restart publication requires its immutable publication-origin relation");
  await assertCleanPublicationAuthorization(ctx, tx, release, source, false);
  await assertPublication(ctx, tx, release, source);
  return source;
}

async function assertPublication(ctx: ServerContext, tx: DrizzleDb, release: typeof productReleases.$inferSelect, source: AcceptedReleaseSource) {
  const request = ProductReleaseRequestSchema.parse(release.request), refs = source.cleanOrigin;
  const [stored] = await tx.select().from(publications).where(and(eq(publications.releaseId, release.id), eq(publications.organizationId, ctx.organizationId)));
  if (!refs || !stored || stored.cleanGenerationId !== refs.cleanGenerationId || release.cleanGenerationId !== refs.cleanGenerationId || stored.goalId !== release.goalId || stored.planId !== source.binding.plan.id || stored.validationId !== refs.validationId
    || stored.reviewId !== refs.reviewId || stored.originReviewId !== refs.originReviewId || stored.acceptanceEventId !== refs.acceptanceEventId
    || stored.runId !== source.run.id || stored.evidenceId !== source.evidence.id || stored.computerId !== source.run.computerId
    || stored.sourceDigest !== refs.sourceDigest || canonical(stored.origin) !== canonical(request.imported_clean) || canonical(stored.capabilities) !== canonical(source.capabilities)
    || release.runId !== source.run.id || release.evidenceId !== source.evidence.id || release.computerId !== source.run.computerId
    || request.run_id !== source.run.id || request.goal_id !== release.goalId || request.project_id !== release.projectId
    || request.verification_request_id !== source.evidence.requestId || request.verification_profile_id !== source.evidence.payload.profile_id
    || request.verification_profile_digest !== source.evidence.payload.profile_digest || request.subject_digest !== source.evidence.payload.subject_digest
    || request.release_profile_id !== source.capabilities.binding.release_profile_id || canonical(request.acceptance_binding) !== canonical(source.binding)
    || canonical(cleanReleaseSourceOrigin(request.imported_clean)) !== canonical(refs.releaseOrigin)) throw AppError.conflict("Publication lost its immutable clean-restart source, origin or destination binding");
}

/** Inserted once alongside the existing publisher request, never used to retarget automation A. */
export async function bindCleanValidationPublication(ctx: ServerContext, tx: DrizzleDb, releaseId: string, source: AcceptedReleaseSource): Promise<void> {
  const refs = source.cleanOrigin;
  if (!refs) throw AppError.conflict("An imported publication requires exact clean-restart origin references");
  const [author] = await tx.select().from(validations).where(and(eq(validations.id, refs.validationId), eq(validations.organizationId, ctx.organizationId)));
  const [release] = await tx.select().from(productReleases).where(and(eq(productReleases.id, releaseId), eq(productReleases.organizationId, ctx.organizationId)));
  if (!author || !release || release.status !== "queued") throw AppError.conflict("clean-restart publication request is missing");
  await assertCleanPublicationAuthorization(ctx, tx, release, source, true);
  const current = await resolve(ctx, tx, author, { live: true, final: true });
  if (canonical(current.cleanOrigin) !== canonical(refs) || canonical(current.binding) !== canonical(source.binding)) throw AppError.conflict("clean-restart source changed before publisher creation");
  await tx.insert(publications).values({ releaseId, organizationId: ctx.organizationId, goalId: author.goalId, planId: author.planId,
    cleanGenerationId: author.cleanGenerationId, validationId: author.id, reviewId: refs.reviewId, originReviewId: refs.originReviewId, acceptanceEventId: refs.acceptanceEventId,
    runId: source.run.id, evidenceId: source.evidence.id, computerId: source.run.computerId!, sourceDigest: refs.sourceDigest,
    origin: ProductReleaseRequestSchema.parse(release.request).imported_clean!, capabilities: source.capabilities, createdAt: ctx.clock.nowIso() });
  await assertPublication(ctx, tx, release, current);
}

/** Called again immediately before send; status/history resolution alone never authorizes a new write. */
export async function inspectCleanValidationPublicationDispatch(ctx: ServerContext, tx: DrizzleDb,
  release: typeof productReleases.$inferSelect): Promise<AcceptedReleaseSource | undefined> {
  const request = ProductReleaseRequestSchema.parse(release.request);
  const [stored] = await tx.select().from(publications).where(and(eq(publications.releaseId, release.id), eq(publications.organizationId, ctx.organizationId)));
  if (!request.imported_clean && !stored) return undefined;
  const [author] = await tx.select().from(validations).where(and(eq(validations.id, stored?.validationId ?? ""), eq(validations.organizationId, ctx.organizationId)));
  if (!author) throw AppError.conflict("clean-restart publisher dispatch has no immutable source relation");
  const source = await resolve(ctx, tx, author, { live: true, final: true });
  const root = await readCleanValidationRoot(importedImplementationActorContext(ctx, author.actorUserId), tx, author.cleanGenerationId, { live: true });
  await assertCleanValidationDispatch(ctx, tx, root);
  await assertCleanPublicationAuthorization(ctx, tx, release, source, true);
  await assertPublication(ctx, tx, release, source);
  return source;
}
