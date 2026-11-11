import { artifacts, assistantTurns, autonomousReviews, computers, contextPacks, goalAutomations, goals, goalImportedDesignContinuations,
  goalProductHandoffs, productDesignRevisions, productDesignRevisionRuns, productReleases, runEvidence, runs, tasks } from "@artoo/db";
import { canonicalProductDesignRevisionContextV1, canonicalReleaseJson, ContextPackSchema, MAX_PRODUCT_DESIGN_REVISION_BYTES,
  PRODUCT_DESIGN_REVISION_FEATURE_V1, ProductDesignRevisionContextV1Schema, ProductDesignV2Schema,
  RunVerificationPayloadSchema, validateAdditiveDesignRevision, type ContextPack, type ProductDesignRevisionContextV1, type RunVerificationPayload,
  type VerificationCapabilities } from "@artoo/domain";
import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, type DrizzleDb } from "@artoo/storage";
import { and, desc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { readContentAddressedBlob } from "../content-addressed-blob.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";

export type DesignRevision = typeof productDesignRevisions.$inferSelect;
export const designRevisionDigest = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const designRevisionDescriptorDigest = (value: unknown): string => designRevisionDigest(canonicalProductDesignRevisionContextV1(value));

export async function latestDesignRevision(ctx: ServerContext, tx: DrizzleDb, goalId: string): Promise<DesignRevision | undefined> {
  return (await tx.select().from(productDesignRevisions).where(and(eq(productDesignRevisions.organizationId, ctx.organizationId),
    eq(productDesignRevisions.goalId, goalId))).orderBy(desc(productDesignRevisions.sequence)).limit(1))[0];
}

export async function designRevisionContextForRun(ctx: ServerContext, tx: DrizzleDb, runId: string): Promise<ContextPack | undefined> {
  const [row] = await tx.select({ payload: contextPacks.payload }).from(runs).innerJoin(contextPacks,
    and(eq(contextPacks.id, runs.contextPackId), eq(contextPacks.runId, runs.id), eq(contextPacks.taskId, runs.taskId), eq(contextPacks.organizationId, ctx.organizationId)))
    .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
  return row ? ContextPackSchema.parse(row.payload) : undefined;
}

export function assertDesignRevisionProfile(capabilities: VerificationCapabilities | undefined): void {
  if (!capabilities || capabilities.measurement_plan_policy?.version !== 2 || !capabilities.checks.length
    || capabilities.checks.some(check => check.contract.version !== 3 || check.contract.stage_policy.design !== "declared-cases")) {
    throw AppError.conflict("Design revision requires policy-v2 and protected v3 declared-design-case verification");
  }
}

/** Capability guidance is shown only where this local optional path can actually be requested. */
export async function canSuggestDesignRevision(ctx: ServerContext, tx: DrizzleDb, subject: typeof runs.$inferSelect): Promise<boolean> {
  if (!(ctx.artifactStore ?? ctx.productSourceArtifactDir) || subject.workspaceBranch !== null || subject.workspaceAllocation !== null
    || ctx.supportsExecutionFeature?.(subject.computerId, PRODUCT_DESIGN_REVISION_FEATURE_V1) !== true) return false;
  const context = await designRevisionContextForRun(ctx, tx, subject.id);
  if (!context || context.product_development?.stage !== "implementation" || context.transferred_product_input || context.imported_review_subject
    || !context.goal_context?.plan) return false;
  const [computer] = await tx.select().from(computers).where(and(eq(computers.id, subject.computerId), eq(computers.organizationId, ctx.organizationId)));
  if (!computer || !["win32", "windows"].includes(computer.os)) return false;
  const capabilities = ctx.getVerificationCapabilities?.(subject.computerId, context.verification_capabilities?.profile_id ?? "", context.project.id, context.workspace.root);
  try { assertDesignRevisionProfile(capabilities); } catch (error) { if (error instanceof AppError) return false; throw error; }
  if (!isDeepStrictEqual(context.verification_capabilities, { ...capabilities, profile_id: context.verification_capabilities?.profile_id })) return false;
  const goalId = context.goal_context.goal_id;
  const [handoff] = await tx.select({ id: goalProductHandoffs.id }).from(goalProductHandoffs).where(eq(goalProductHandoffs.goalId, goalId)).limit(1);
  const [imported] = await tx.select({ id: goalImportedDesignContinuations.id }).from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.goalId, goalId)).limit(1);
  const [release] = await tx.select({ id: productReleases.id }).from(productReleases).where(eq(productReleases.goalId, goalId)).limit(1);
  return !handoff && !imported && !release;
}

export async function assertDesignRevisionAuthorization(ctx: ServerContext, tx: DrizzleDb, revision: DesignRevision): Promise<void> {
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, revision.goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, revision.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!automation || !goal || goal.status !== "running" || goal.currentPlanId !== revision.planId || automation.planId !== revision.planId
    || automation.executionMode !== "agent_team" || !["executing", "waiting"].includes(automation.status)
    || automation.actorUserId !== revision.actorUserId || automation.consentId !== revision.consentId || automation.policyVersion !== revision.policyVersion
    || automation.computerId !== revision.computerId || automation.workspaceRoot !== revision.workspaceRoot) {
    throw AppError.conflict("Design revision authorization, plan or workspace changed");
  }
  await requireAiSharingAuthorization({ ...ctx, actorUserId: revision.actorUserId }, tx, { consentId: revision.consentId, policyVersion: revision.policyVersion });
}

/** Scope auxiliary reviews through their owning relation; they deliberately have no direct goalId. */
export async function designRevisionTaskScope(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect) {
  const [review] = await tx.select().from(autonomousReviews).where(and(eq(autonomousReviews.reviewTaskId, task.id), eq(autonomousReviews.organizationId, ctx.organizationId)));
  const goalId = task.goalId ?? review?.goalId;
  return { review, revision: goalId ? await latestDesignRevision(ctx, tx, goalId) : undefined };
}

/** Called under the existing task -> goal -> instance/computer assignment locks. */
export async function assertDesignRevisionAssignment(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect,
  input: { instanceId: string; computerId: string; workspaceRoot: string; assistantTurnId?: string; capabilities?: VerificationCapabilities }): Promise<void> {
  const { revision, review } = await designRevisionTaskScope(ctx, tx, task);
  if (!revision || revision.state !== "active") return;
  await assertDesignRevisionAuthorization(ctx, tx, revision);
  if (!ctx.automationActor || ctx.actorUserId !== revision.actorUserId || input.computerId !== revision.computerId || input.workspaceRoot !== revision.workspaceRoot) {
    throw AppError.permissionDenied("Only the original local automation can execute an active design revision");
  }
  assertDesignRevisionProfile(input.capabilities);
  if (ctx.supportsExecutionFeature?.(input.computerId, PRODUCT_DESIGN_REVISION_FEATURE_V1) !== true) throw AppError.conflict("The node does not support additive design revision verification");
  if (task.id === revision.designTaskId && !review && input.instanceId === revision.authorInstanceId && !input.assistantTurnId) return;
  const [current] = await tx.select().from(productDesignRevisionRuns).where(eq(productDesignRevisionRuns.revisionId, revision.id))
    .orderBy(desc(productDesignRevisionRuns.attempt)).limit(1);
  if (review && current && review.taskId === revision.designTaskId && review.subjectRunId === current.runId
    && review.status === "pending" && review.turnId === input.assistantTurnId && review.reviewerInstanceId === input.instanceId) return;
  throw AppError.conflict("Active design revision fences other stages and historical review turns");
}

export async function buildDesignRevisionContext(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect,
  runId: string, review?: typeof autonomousReviews.$inferSelect): Promise<ProductDesignRevisionContextV1 | undefined> {
  const goalId = task.goalId ?? review?.goalId;
  const revision = goalId ? await latestDesignRevision(ctx, tx, goalId) : undefined;
  if (!revision || revision.state !== "active") return undefined;
  if (review) {
    const author = await designRevisionContextForRun(ctx, tx, review.subjectRunId);
    if (review.taskId !== revision.designTaskId || author?.product_design_revision?.revision_id !== revision.id) throw AppError.conflict("Design revision review has no bound author context");
    return author.product_design_revision;
  }
  if (task.id !== revision.designTaskId) throw AppError.conflict("Downstream context is fenced by the active design revision");
  return ProductDesignRevisionContextV1Schema.parse({ ...(revision.intent as object), author_run_id: runId });
}

/** Runs already exist here; a rollback leaves neither the run nor its immutable binding. */
export async function bindDesignRevisionRun(ctx: ServerContext, tx: DrizzleDb, runId: string): Promise<void> {
  const context = await designRevisionContextForRun(ctx, tx, runId), descriptor = context?.product_design_revision;
  if (!descriptor || context.review_subject) return;
  const [last] = await tx.select().from(productDesignRevisionRuns).where(eq(productDesignRevisionRuns.revisionId, descriptor.revision_id))
    .orderBy(desc(productDesignRevisionRuns.attempt)).limit(1);
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
  await tx.insert(productDesignRevisionRuns).values({ runId, revisionId: descriptor.revision_id, organizationId: ctx.organizationId,
    contextPackId: run!.contextPackId!, attempt: (last?.attempt ?? 0) + 1, descriptorDigest: designRevisionDescriptorDigest(descriptor), createdAt: ctx.clock.nowIso() });
}

/** Historical evidence remains readable, but must retain its exact immutable context/run binding. */
export async function designRevisionEvidenceError(ctx: ServerContext, tx: DrizzleDb, runId: string,
  payload: RunVerificationPayload, context: ContextPack | undefined): Promise<string | undefined> {
  const descriptor = context?.product_design_revision, echo = payload.product_design_revision;
  if (!descriptor) {
    if (echo) return "Design revision evidence has no persisted descriptor";
    const [binding] = await tx.select({ id: productDesignRevisionRuns.runId }).from(productDesignRevisionRuns).where(and(
      eq(productDesignRevisionRuns.organizationId, ctx.organizationId), eq(productDesignRevisionRuns.runId, context?.review_subject?.run_id ?? runId)));
    return binding ? "Persisted design revision descriptor is missing" : undefined;
  }
  const [revision] = await tx.select().from(productDesignRevisions).where(and(eq(productDesignRevisions.id, descriptor.revision_id), eq(productDesignRevisions.organizationId, ctx.organizationId)));
  const [bound] = await tx.select().from(productDesignRevisionRuns).where(and(eq(productDesignRevisionRuns.runId, descriptor.author_run_id), eq(productDesignRevisionRuns.organizationId, ctx.organizationId)));
  const [run] = await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
  const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
  if (!revision || !bound || !run || bound.revisionId !== revision.id || stage !== "design"
    || context.transferred_product_input || context.imported_review_subject || run.workspaceAllocation !== null || run.workspaceBranch !== null
    || run.computerId !== revision.computerId || run.workspaceRoot !== revision.workspaceRoot
    || context.project.id !== revision.projectId || context.goal_context?.goal_id !== revision.goalId || context.goal_context.plan?.id !== revision.planId
    || descriptor.author_run_id !== (context.review_subject?.run_id ?? run.id)
    || !isDeepStrictEqual(descriptor, { ...(revision.intent as object), author_run_id: descriptor.author_run_id })
    || bound.descriptorDigest !== designRevisionDescriptorDigest(descriptor)) return "Design revision evidence differs from its immutable author context";
  if (context.review_subject) {
    const [review] = await tx.select().from(autonomousReviews).where(and(eq(autonomousReviews.reviewTaskId, run.taskId), eq(autonomousReviews.organizationId, ctx.organizationId)));
    const [turn] = await tx.select().from(assistantTurns).where(and(eq(assistantTurns.runId, run.id), eq(assistantTurns.organizationId, ctx.organizationId)));
    if (!review || !turn || review.subjectRunId !== descriptor.author_run_id || review.taskId !== revision.designTaskId
      || context.conversation?.turn_id !== turn.id || turn.taskId !== run.taskId || run.agentInstanceId !== review.reviewerInstanceId) return "Design revision reviewer is not bound to its own persisted turn";
  } else if (run.taskId !== revision.designTaskId || run.agentInstanceId !== revision.authorInstanceId || bound.contextPackId !== run.contextPackId) return "Design revision author binding changed";
  try { assertDesignRevisionProfile(context.verification_capabilities); } catch { return "Design revision profile no longer declares complete v3 design measurement"; }
  if (payload.outcome !== "passed") return echo ? "Failed verification cannot attest a design revision" : undefined;
  if (!echo || echo.revision_id !== revision.id || echo.descriptor_digest !== bound.descriptorDigest
    || echo.baseline_checksum !== descriptor.baseline.design.checksum
    || !payload.required_files.some(file => isDeepStrictEqual(file, echo.revised_design))
    || !payload.required_files.some(file => file.path === descriptor.baseline.research.path && file.checksum === descriptor.baseline.research.checksum && file.size === descriptor.baseline.research.size)
    || context.verification_capabilities!.checks.some(check => {
      const observation = payload.checks.find(value => value.id === check.command_id)?.observation;
      return observation?.version !== 3 || observation.scope !== "final" || observation.stage !== "design" || !observation.cases.length;
    })) return "Passing design revision lacks exact node attestation and complete final design observations";
  return undefined;
}

/** Assignment fences are insufficient for a run with a previously persisted context. */
export async function assertDesignRevisionRunAdmission(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect,
  options: { live?: boolean; acceptance?: boolean } = {}): Promise<void> {
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId)));
  if (!task) throw AppError.conflict("Execution task no longer exists");
  const { revision, review } = await designRevisionTaskScope(ctx, tx, task);
  if (!revision) return;
  const context = await designRevisionContextForRun(ctx, tx, run.id);
  if (revision.state !== "active") {
    // A completed revision author is history; only fresh downstream contexts may execute or be accepted.
    if (options.live && context?.product_design_revision) throw AppError.conflict("Settled design revision cannot resume an old execution");
    const stage = context?.product_development?.stage ?? context?.review_subject?.development_stage;
    if (stage === "implementation" || stage === "validation") {
      const sourceContext = review ? await designRevisionContextForRun(ctx, tx, review.subjectRunId) : context;
      const pin = sourceContext?.product_development?.accepted_inputs?.files.find(file => file.path === ".artoo/product/design.json");
      const [acceptedEvidence] = await tx.select().from(runEvidence).where(and(eq(runEvidence.id, revision.acceptedEvidenceId!),
        eq(runEvidence.runId, revision.acceptedRunId!), eq(runEvidence.organizationId, ctx.organizationId)));
      const accepted = RunVerificationPayloadSchema.safeParse(acceptedEvidence?.payload).data;
      const design = accepted?.required_files.find(file => file.path === ".artoo/product/design.json");
      if (!pin || !design || accepted?.product_design_revision?.revision_id !== revision.id
        || pin.source_task_id !== revision.designTaskId || pin.source_run_id !== revision.acceptedRunId || pin.evidence_id !== revision.acceptedEvidenceId
        || pin.checksum !== design.checksum || pin.size !== design.size) {
        throw AppError.conflict("Downstream run still pins the superseded design");
      }
    }
    return;
  }
  await assertDesignRevisionAuthorization(ctx, tx, revision);
  const descriptor = context?.product_design_revision;
  const [current] = await tx.select().from(productDesignRevisionRuns).where(eq(productDesignRevisionRuns.revisionId, revision.id))
    .orderBy(desc(productDesignRevisionRuns.attempt)).limit(1);
  if (!context || !descriptor || !current || descriptor.revision_id !== revision.id || descriptor.author_run_id !== current.runId
    || current.descriptorDigest !== designRevisionDescriptorDigest(descriptor)
    || !isDeepStrictEqual(descriptor, { ...(revision.intent as object), author_run_id: current.runId })
    || run.computerId !== revision.computerId || run.workspaceRoot !== revision.workspaceRoot
    || run.requestedByUserId !== revision.actorUserId || run.aiDataSharingConsentId !== revision.consentId
    || run.aiDataSharingPolicyVersion !== revision.policyVersion) throw AppError.conflict("Active design revision rejects a stale or unbound run/context");
  if (review) {
    const [turn] = await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, review.turnId), eq(assistantTurns.organizationId, ctx.organizationId)));
    if (review.taskId !== revision.designTaskId || review.subjectRunId !== current.runId || turn?.runId !== run.id
      || context.review_subject?.run_id !== current.runId || context.conversation?.turn_id !== review.turnId
      || options.live && review.status !== "pending") throw AppError.conflict("Active design revision rejects a stale reviewer turn");
  } else if (run.id !== current.runId || run.taskId !== revision.designTaskId || run.agentInstanceId !== revision.authorInstanceId
    || run.contextPackId !== current.contextPackId) throw AppError.conflict("Active design revision rejects a historical author attempt");
  if (options.live) {
    assertDesignRevisionProfile(ctx.getVerificationCapabilities?.(revision.computerId, context.verification_capabilities!.profile_id, revision.projectId, revision.workspaceRoot));
    if (ctx.supportsExecutionFeature?.(revision.computerId, PRODUCT_DESIGN_REVISION_FEATURE_V1) !== true) throw AppError.conflict("Current node cannot enforce design revisions");
  }
}

/** Read only a scoped content-store object and verify its actual bytes against the node's fact. */
export async function readDesignRevisionFile(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect,
  pin: { path: string; checksum: string; size: number }): Promise<{ text: string; json: unknown }> {
  const artifactStore = ctx.artifactStore ?? ctx.productSourceArtifactDir;
  if (!artifactStore || pin.size < 1 || pin.size > MAX_PRODUCT_DESIGN_REVISION_BYTES) throw AppError.conflict("Design revision needs bounded retained product bytes");
  const candidates = await tx.select().from(artifacts).where(and(eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.runId, run.id),
    eq(artifacts.taskId, run.taskId), eq(artifacts.checksum, pin.checksum)));
  if (!candidates.some(artifact => {
    const metadata = artifact.metadata as Record<string, unknown> | null;
    return metadata?.storage_key === pin.checksum.slice(7) && metadata.size === pin.size && metadata.computer_id === run.computerId;
  })) throw AppError.conflict("Design revision baseline has no retained artifact from its measured source run");
  let bytes: Buffer;
  try {
    bytes = await readContentAddressedBlob(artifactStore, pin.checksum, pin.size);
  } catch (error) {
    if (!(error instanceof ContentAddressedBlobNotFoundError || error instanceof ContentAddressedBlobIntegrityError)) throw error;
    throw AppError.conflict(`Retained product bytes cannot be qualified: ${error.message}`);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Product JSON is not lossless UTF-8");
    return { text, json: JSON.parse(text) };
  } catch (error) { throw AppError.conflict(`Retained product bytes cannot be qualified: ${error instanceof Error ? error.message : "read failure"}`); }
}

/** The author and peer must both measure every retained and appended workspace case at every configured viewport. */
export function assertDesignRevisionCasesMeasured(rawDesign: unknown, context: ContextPack, payload: RunVerificationPayload): void {
  const design = ProductDesignV2Schema.parse(rawDesign);
  assertDesignRevisionProfile(context.verification_capabilities);
  for (const configured of context.verification_capabilities!.checks) {
    const observation = payload.checks.find(check => check.id === configured.command_id)?.observation;
    if (observation?.version !== 3) throw AppError.conflict("Revision lacks v3 measured case observations");
    const expected = design.validation_cases.filter(test => test.method === "workspace-check").flatMap(test => {
      if (test.method !== "workspace-check") return [];
      return configured.contract.viewports.map(viewport => ({ case_id: test.id, viewport,
        program_digest: designRevisionDigest(canonicalReleaseJson(test.browser_program)) }));
    });
    if (observation.cases.length !== expected.length || expected.some(item => !observation.cases.some(actual =>
      actual.case_id === item.case_id && actual.program_digest === item.program_digest && isDeepStrictEqual(actual.viewport, item.viewport)))) {
      throw AppError.conflict("Revision did not measure every declared case and viewport against the exact new design");
    }
  }
}

export async function prepareDesignRevisionAcceptance(ctx: ServerContext, tx: DrizzleDb, run: typeof runs.$inferSelect,
  payload: RunVerificationPayload, peer: { reviewId: string; runId: string; payload: RunVerificationPayload }): Promise<DesignRevision | undefined> {
  const context = await designRevisionContextForRun(ctx, tx, run.id), descriptor = context?.product_design_revision;
  if (!context || !descriptor) return undefined;
  await assertDesignRevisionRunAdmission(ctx, tx, run, { acceptance: true });
  const revision = await latestDesignRevision(ctx, tx, descriptor.goal_id);
  if (!revision || revision.state !== "active" || revision.id !== descriptor.revision_id) throw AppError.conflict("Revision is no longer awaiting this acceptance");
  const designPin = payload.required_files.find(file => file.path === ".artoo/product/design.json");
  if (!designPin || !isDeepStrictEqual(payload.product_design_revision, peer.payload.product_design_revision)) throw AppError.conflict("Independent reviewer revision attestation differs from the author");
  const current = await readDesignRevisionFile(ctx, tx, run, designPin);
  const [researchRun] = await tx.select().from(runs).where(and(eq(runs.id, descriptor.baseline.research.source_run_id), eq(runs.organizationId, ctx.organizationId)));
  if (!researchRun) throw AppError.conflict("Accepted revision research source is missing");
  const research = await readDesignRevisionFile(ctx, tx, researchRun, descriptor.baseline.research);
  const baseline = Buffer.from(descriptor.baseline.design.text, "utf8");
  if (baseline.length !== descriptor.baseline.design.size || designRevisionDigest(baseline) !== descriptor.baseline.design.checksum) throw AppError.conflict("Retained revision baseline changed");
  const errors = validateAdditiveDesignRevision(JSON.parse(descriptor.baseline.design.text), current.json, research.json, descriptor.request);
  if (errors.length) throw AppError.conflict(errors.join("; "));
  assertDesignRevisionCasesMeasured(current.json, context, payload);
  const peerContext = await designRevisionContextForRun(ctx, tx, peer.runId);
  if (!peerContext) throw AppError.conflict("Revision peer context is missing");
  assertDesignRevisionCasesMeasured(current.json, peerContext, peer.payload);
  // Awaited content reads cannot carry an old consent or plan across the transition.
  await assertDesignRevisionAuthorization(ctx, tx, revision);
  await assertDesignRevisionRunAdmission(ctx, tx, run, { acceptance: true });
  return revision;
}

export async function settleDesignRevisionAcceptance(ctx: ServerContext, tx: DrizzleDb, revision: DesignRevision,
  accepted: { runId: string; evidenceId: string; reviewId: string }): Promise<void> {
  const [updated] = await tx.update(productDesignRevisions).set({ state: "accepted", acceptedRunId: accepted.runId,
    acceptedEvidenceId: accepted.evidenceId, acceptedReviewId: accepted.reviewId, acceptedAt: ctx.clock.nowIso() })
    .where(and(eq(productDesignRevisions.id, revision.id), eq(productDesignRevisions.state, "active"))).returning();
  if (!updated) throw AppError.conflict("Design revision was already settled");
}

export async function assertNoActiveDesignRevision(ctx: ServerContext, tx: DrizzleDb, goalId: string): Promise<void> {
  if ((await latestDesignRevision(ctx, tx, goalId))?.state === "active") throw AppError.conflict("Publication is fenced by an active design revision");
}
