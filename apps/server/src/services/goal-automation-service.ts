import { agentInstances, appendEvent, applicationPublications, applicationPublicationSettlements, artifacts, assistantTurns, autonomousReviews, computers, discussions, eventLog, goalAutomations, goals, messages, plans, runs, tasks } from "@artoo/db";
import { AutonomousTeamSchema, canTransitionTask, CreateAutonomousGoalRequestSchema, GoalAutomationSchema, GoalBudgetsSchema, TaskSpecSchema, validateProductDevelopmentPlan,
  type AutonomousTeam, type CreateAutonomousGoalRequest, type GoalAutomation, type TaskStatus } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import type { ImportedSourceReceiptFamily, ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { withPreparedGoalSubmission } from "../config/goal-entry.js";
import { beginGoalSubmission, finishGoalSubmission, type GoalSubmissionIdentity } from "./goal-submission.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { requireContentAllowed } from "./content-moderation-service.js";
import { createGoal, getGoal, pauseGoal } from "./goal-service.js";
import { acceptPlan, validatePlanTaskSpecs } from "./plan-service.js";
import { cancelDiscussion, parseDiscussionPlan, proposeDiscussionPlan, retryAutonomousSynthesis, startDiscussion } from "./discussion-service.js";
import { assignTask, markReady, retryTask, reviewTask } from "./lifecycle-service.js";
import { scheduleTask } from "./scheduler.js";
import { unsettledGoalRunIds, unsettledStandaloneExecutions, unconfirmedDisconnectRunIds } from "./execution-state.js";
import { inspectRunVerification } from "./verification-service.js";
import { listDependencies } from "./dag-service.js";
import { automationWorkspacesOverlap, resolveAutomationWorkspace } from "./automation-workspace.js";
import { cancelAssistantTurn } from "./assistant-service.js";
import { ensureIndependentReview } from "./independent-review-service.js";
import { requestProductDesignRevision } from "./product-design-revision-service.js";
import { latestDesignRevision } from "./product-design-revision-guard.js";
import { assertRecordedGoalReleaseCompletion, cancelGoalProductRelease, ensureGoalProductRelease } from "./product-release-service.js";
import { failRunDaemonDisconnect } from "./run-service.js";
import { transitionTask } from "./transition-service.js";
import { capturePlanningSnapshot } from "./planning-capabilities.js";
import { goalImportedProductReviews, goalProductHandoffs, goalProductHandoffOperations } from "@artoo/db";
import { ImportedProductReviewResultV1Schema, ProductSourceOperationResultV1Schema } from "@artoo/domain";
import { advanceGoalImportedProductReview, stopGoalImportedProductReviews } from "./imported-product-review-service.js";
import { stopGoalProductHandoffs } from "./goal-product-handoff-service.js";
import { goalImportedDesignContinuations, goalImportedDesignReviews, goalImportedExecutions } from "@artoo/db";
import { ImportedDesignContinuationResultV1Schema, ImportedDesignReviewResultV1Schema, ImportedExecutionResultV1Schema, IMPORTED_EXECUTION_FEATURE_V1 } from "@artoo/domain";
import { ensureGoalImportedDesignContinuation, stopGoalImportedDesignContinuations } from "./imported-design-continuation-service.js";
import { advanceGoalImportedDesignReview, stopGoalImportedDesignReviews } from "./imported-design-review-service.js";
import { advanceGoalImportedExecution, stopGoalImportedExecutions } from "./imported-execution-service.js";
import { advanceGoalImportedExecutionReview, stopGoalImportedExecutionReviews } from "./imported-execution-review-service.js";
import { advanceGoalImportedExecutionRepair, stopGoalImportedExecutionRepairs } from "./imported-execution-repair-service.js";
import { goalImportedExecutionReviews, goalImportedExecutionRepairs } from "@artoo/db";
import { ImportedExecutionReviewResultV1Schema, ImportedExecutionRepairResultV1Schema, IMPORTED_EXECUTION_REVIEW_FEATURE_V1 } from "@artoo/domain";
import { goalImportedValidations, goalImportedValidationReviews } from "@artoo/db";
import { ImportedValidationResultV1Schema, ImportedValidationReviewResultV1Schema, IMPORTED_VALIDATION_FEATURE_V1 } from "@artoo/domain";
import { ensureGoalImportedValidation, ensureGoalImportedValidationRepair, advanceGoalImportedValidation, stopGoalImportedValidations } from "./imported-validation-service.js";
import { advanceGoalImportedValidationReview, stopGoalImportedValidationReviews } from "./imported-validation-review-service.js";
import { hasImportedValidationPublication } from "./imported-validation-release-service.js";
import { goalRecoveryValidations, goalRecoveryValidationReviews, goalSourceRecoveries } from "@artoo/db";
import { ImportedRecoveryValidationResultV1Schema, ImportedRecoveryValidationReviewResultV1Schema } from "@artoo/domain";
import { ensureGoalSourceRecovery, advanceGoalSourceRecovery, stopGoalSourceRecoveries } from "./source-recovery-service.js";
import { settleRecoveryPublications } from "./product-release-recovery-service.js";
import { ensureGoalRecoveryValidation, ensureGoalRecoveryValidationRepair, advanceGoalRecoveryValidation, stopGoalRecoveryValidations } from "./recovery-validation-service.js";
import { advanceGoalRecoveryValidationReview, stopGoalRecoveryValidationReviews } from "./recovery-validation-review-service.js";
import { automaticSourceAvailable, automaticSourceHandoffPlanErrors, ensureAutomaticProductHandoff } from "./automatic-product-handoff-service.js";
import { researchRevisionPoolRequested } from "./research-destination-pool-service.js";
import { readCurrentResearchHandoff, resolveResearchRevisionOrigin } from "./research-revision-origin-service.js";
import { ensureGoalResearchRevision } from "./research-revision-service.js";
import { goalCleanValidations, goalCleanValidationReviews, sourceCleanStops, sourceCleanGenerations, sourceWorkspaceLineages } from "@artoo/db";
import { ImportedCleanValidationResultV1Schema, ImportedCleanValidationReviewResultV1Schema, SOURCE_CLEAN_RESTART_FEATURE_V1 } from "@artoo/domain";
import { settleSourceCleanGeneration } from "./source-clean-lifecycle-service.js";
import { ensureGoalCleanValidation, ensureGoalCleanValidationRepair, advanceGoalCleanValidation, stopGoalCleanValidations } from "./clean-validation-service.js";
import { advanceGoalCleanValidationReview, stopGoalCleanValidationReviews } from "./clean-validation-review-service.js";
import { settleCleanPublications } from "./product-release-clean-service.js";
import { hasCleanValidationPublication } from "./clean-validation-release-service.js";
import { goalImportedDesignCompletions, goalImportedDesignReviewReceipts, goalImportedExecutionCompletions, goalImportedExecutionReceipts,
  goalImportedExecutionReviewReceipts, goalImportedExecutionRepairCompletions, goalImportedExecutionRepairReceipts,
  goalImportedValidationCompletions, goalImportedValidationReceipts, goalImportedValidationReviewReceipts } from "@artoo/db";
import { IMPORTED_DESIGN_CONTINUATION_FEATURE_V1, IMPORTED_DESIGN_REVIEW_FEATURE_V1 } from "@artoo/domain";
import { APPLICATION_VERIFICATION_FEATURE_V1 } from "@artoo/domain";
import { APPLICATION_PUBLICATION_FEATURE_V1, ApplicationPublicationCapabilitiesV1Schema } from "@artoo/domain";
import { originalApplicationPublication, assertCurrentApplicationPublication } from "./application-verification.js";
import { ensureGoalApplicationPublication, cancelGoalApplicationPublication } from "./application-publication-service.js";

type AutomationRow = typeof goalAutomations.$inferSelect;
type StopProcess = (ctx: ServerContext, runId: string) => Promise<void>;
const ACTIVE = ["planning", "executing", "waiting"];

/** This only withholds ordinary H7; it cannot grant a stop, checkpoint or run.
 * Retained local enrollment stays a fence if the node disconnects or withdraws
 * its hello, so an explicit user stop cannot silently select another path. */
async function awaitsPlannedCleanTransition(ctx: ServerContext, tx: DrizzleDb, review: typeof goalImportedExecutionReviews.$inferSelect): Promise<boolean> {
  const retained = await tx.select({ id: sourceWorkspaceLineages.id }).from(sourceWorkspaceLineages)
    .where(and(eq(sourceWorkspaceLineages.organizationId, ctx.organizationId), eq(sourceWorkspaceLineages.computerId, review.computerId),
      eq(sourceWorkspaceLineages.workspaceRoot, review.workspaceRoot))).limit(1);
  return retained.length !== 0 || ctx.supportsExecutionFeature?.(review.computerId, SOURCE_CLEAN_RESTART_FEATURE_V1) === true;
}
export function mapGoalAutomation(row: AutomationRow, importedPublication = false): GoalAutomation {
  return GoalAutomationSchema.parse({ goal_id: row.goalId, organization_id: row.organizationId,
    actor_user_id: row.actorUserId, consent_id: row.consentId, policy_version: row.policyVersion,
    status: row.status, discussion_id: row.discussionId, plan_id: row.planId, agent_instance_id: row.agentInstanceId,
    computer_id: row.computerId, workspace_root: row.workspaceRoot,
    planning_capability_snapshot: row.planningCapabilitySnapshot,
    ...(row.appDelivery != null ? { app_delivery: row.appDelivery } : {}),
    ...(row.appPublication != null ? { app_publication: row.appPublication,
      application_publication_authorization_event_id: row.applicationPublicationAuthorizationEventId } : {}),
    verification_profile_id: row.verificationProfileId, execution_mode: row.executionMode, team: row.team, source_handoff: row.sourceHandoff, release_profile_id: row.releaseProfileId, last_error: row.lastError,
    delivery: row.status === "completed" && (row.releaseProfileId || row.appPublication != null || importedPublication) ? "published_product" : "verified_workspace",
    created_at: row.createdAt, updated_at: row.updatedAt });
}

/** Reuse service transactions inside this one atomic orchestration step. Node IO is deferred until commit. */
type ImportedReviewDispatch = { id: string; control: "start" | "stop" | "status" };
type SourceOperationDispatch = { id: string; control: "start" | "stop" | "status" | "qualify" };
type CleanDispatchQueues = { validations: ImportedReviewDispatch[]; reviews: ImportedReviewDispatch[] };
type RecoveryDispatchQueues = { recoveries: ImportedReviewDispatch[]; validations: ImportedReviewDispatch[]; reviews: ImportedReviewDispatch[] };
function transactionContext(ctx: ServerContext, tx: DrizzleDb, queued: string[] = [], importedReviews: ImportedReviewDispatch[] = [], sourceOperations: SourceOperationDispatch[] = [], designs: ImportedReviewDispatch[] = [], designReviews: ImportedReviewDispatch[] = [], importedExecutions: ImportedReviewDispatch[] = [], executionReviews: ImportedReviewDispatch[] = [], executionRepairs: ImportedReviewDispatch[] = [], validations: ImportedReviewDispatch[] = [], validationReviews: ImportedReviewDispatch[] = [], recoveryQueues: RecoveryDispatchQueues = { recoveries: [], validations: [], reviews: [] }, cleanQueues: CleanDispatchQueues = { validations: [], reviews: [] }): ServerContext {
  return { ...ctx, db: { db: tx, transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error("Migrations cannot run inside an orchestration transaction")),
    healthCheck: () => ctx.db.healthCheck(), close: () => Promise.reject(new Error("Cannot close an orchestration transaction")) },
    onRunQueued: async (id) => { queued.push(id); },
    onImportedProductReviewQueued: async (id, control) => { importedReviews.push({ id, control }); },
    onProductSourceOperationQueued: async (id, control) => { sourceOperations.push({ id, control }); },
    onImportedDesignContinuationQueued: async (id, control) => { designs.push({ id, control }); },
    onImportedDesignReviewQueued: async (id, control) => { designReviews.push({ id, control }); },
    onImportedExecutionReviewQueued: async (id, control) => { executionReviews.push({ id, control }); },
    onImportedExecutionRepairQueued: async (id, control) => { executionRepairs.push({ id, control }); },
    onImportedValidationQueued: async (id, control) => { validations.push({ id, control }); },
    onImportedValidationReviewQueued: async (id, control) => { validationReviews.push({ id, control }); },
    onCleanValidationQueued: async (id, control) => { cleanQueues.validations.push({ id, control }); },
    onCleanValidationReviewQueued: async (id, control) => { cleanQueues.reviews.push({ id, control }); },
    onSourceRecoveryQueued: async (id, control) => { recoveryQueues.recoveries.push({ id, control }); },
    onRecoveryValidationQueued: async (id, control) => { recoveryQueues.validations.push({ id, control }); },
    onRecoveryValidationReviewQueued: async (id, control) => { recoveryQueues.reviews.push({ id, control }); },
    onImportedExecutionQueued: async (id, control) => { importedExecutions.push({ id, control }); } };
}

async function update(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, patch: Partial<typeof goalAutomations.$inferInsert>) {
  if (Object.entries(patch).every(([key, value]) => row[key as keyof AutomationRow] === value)) return row;
  const [next] = await tx.update(goalAutomations).set({ ...patch, updatedAt: ctx.clock.nowIso() })
    .where(and(eq(goalAutomations.goalId, row.goalId), eq(goalAutomations.organizationId, ctx.organizationId))).returning();
  const [goal] = await tx.select({ projectId: goals.projectId, roomId: goals.roomId }).from(goals).where(eq(goals.id, row.goalId));
  const importedPublication = next!.status === "completed" && (await hasImportedValidationPublication(ctx, tx, row.goalId) || await hasCleanValidationPublication(ctx, tx, row.goalId));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.automation.updated", actorType: "system", actorId: "goal_runner",
    correlationId: row.goalId, goalId: row.goalId, projectId: goal?.projectId, roomId: goal?.roomId,
    payload: { status: next!.status, delivery: next!.status === "completed" && (next!.releaseProfileId || next!.appPublication != null || importedPublication) ? "published_product" : "verified_workspace", last_error: next!.lastError } }));
  return next!;
}

export async function createAutonomousGoal(ctx: ServerContext, request: CreateAutonomousGoalRequest, identity?: GoalSubmissionIdentity) {
  const input = CreateAutonomousGoalRequestSchema.parse(request);
  return withPreparedGoalSubmission(ctx, input, identity, () => ctx.db.transaction(async (tx) => {
    if (identity) {
      const existing = await beginGoalSubmission(ctx, tx, input, identity);
      if (existing) return existing;
    }
    const sharing = await requireAiSharingAuthorization(ctx, tx);
    await requireContentAllowed(ctx, input.objective, tx);
    const atomic = transactionContext(ctx, tx);
    const goal = await createGoal(atomic, { project_id: input.project_id, title: input.objective.slice(0, 80), objective: input.objective,
      acceptance_criteria: [input.objective, "The configured node verification profile passes against the delivered workspace."],
      budgets: { max_elapsed_ms: (input.execution_mode === "agent_team" ? 8 : 1) * 60 * 60 * 1000, max_retries: input.max_retries, max_concurrent_runs: 1 },
    });
    let applicationPublicationAuthorizationEventId: string | null = null;
    if (input.app_publication) {
      const available = await tx.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
      const selected = available.flatMap(computer => {
        const capabilities = ApplicationPublicationCapabilitiesV1Schema.safeParse(ctx.getApplicationPublicationCapabilities?.(
          computer.id, input.app_publication!.publication_profile_id, input.project_id));
        const session = ctx.getPairedNodeSession?.(computer.id);
        if (!capabilities.success || !session || session.computerId !== computer.id || !["windows", "win32"].includes(computer.os)
          || capabilities.data.binding.computer_id !== computer.id || capabilities.data.binding.project_id !== input.project_id
          || capabilities.data.binding.verification_profile_id !== input.verification_profile_id
          || capabilities.data.binding.publication_profile_id !== input.app_publication!.publication_profile_id
          || ctx.supportsExecutionFeature?.(computer.id, APPLICATION_PUBLICATION_FEATURE_V1) !== true
          || ctx.supportsExecutionFeature?.(computer.id, APPLICATION_VERIFICATION_FEATURE_V1) !== true) return [];
        return [{ capabilities: capabilities.data, session }];
      });
      if (selected.length !== 1) throw AppError.conflict("Application publication requires one unambiguous currently paired native Windows profile for the requested project and verifier");
      const original = selected[0]!;
      const event = buildEvent(ctx, { type: "goal.application-publication.authorized", actorType: "user", actorId: ctx.actorUserId,
        goalId: goal.id, projectId: goal.project_id, correlationId: goal.id });
      event.payload = { app_publication: input.app_publication, verification_profile_id: input.verification_profile_id,
        capabilities: original.capabilities, publisher_session_id: original.session.sessionId,
        authorization: { version: 1, event_id: event.id, actor_user_id: ctx.actorUserId, consent_id: sharing.consentId,
          policy_version: sharing.policyVersion, grant: input.app_publication } };
      await appendEvent(tx, event);
      applicationPublicationAuthorizationEventId = event.id;
    }
    const [row] = await tx.insert(goalAutomations).values({ goalId: goal.id, organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId, consentId: sharing.consentId, policyVersion: sharing.policyVersion,
      status: "planning", verificationProfileId: input.verification_profile_id, executionMode: input.execution_mode ?? "single_agent", releaseProfileId: input.release_profile_id ?? null,
      sourceHandoff: input.source_handoff ?? null,
      appDelivery: input.app_delivery ?? null,
      appPublication: input.app_publication ?? null, applicationPublicationAuthorizationEventId,
      createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso(),
    }).returning();
    if (input.app_delivery) await appendEvent(tx, buildEvent(ctx, { type: "goal.application-development.authorized", actorType: "user", actorId: ctx.actorUserId,
      goalId: goal.id, projectId: goal.project_id, correlationId: goal.id,
      payload: { version: 1, app_delivery: input.app_delivery, consent_id: sharing.consentId, policy_version: sharing.policyVersion } }));
    if (input.source_handoff) await appendEvent(tx, buildEvent(ctx, { type: "goal.product-handoff.authorized", actorType: "user", actorId: ctx.actorUserId,
      goalId: goal.id, projectId: goal.project_id, correlationId: goal.id,
      payload: { version: 1, source_handoff: input.source_handoff, consent_id: sharing.consentId, policy_version: sharing.policyVersion } }));
    const result = { goal, automation: mapGoalAutomation(row!) };
    if (identity) await finishGoalSubmission(ctx, tx, identity, result);
    return result;
  }));
}

export async function getGoalAutomation(ctx: ServerContext, goalId: string): Promise<GoalAutomation | null> {
  if (!await getGoal(ctx, goalId)) throw AppError.notFound("Goal not found");
  const [row] = await ctx.db.db.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  return row ? mapGoalAutomation(row, row.status === "completed" && (await hasImportedValidationPublication(ctx, ctx.db.db, goalId) || await hasCleanValidationPublication(ctx, ctx.db.db, goalId))) : null;
}

async function stopIndependentReviews(ctx: ServerContext, goalId: string, stopProcess: StopProcess): Promise<void> {
  const pending = await ctx.db.db.select().from(autonomousReviews).where(and(eq(autonomousReviews.goalId, goalId), eq(autonomousReviews.organizationId, ctx.organizationId), eq(autonomousReviews.status, "pending")));
  for (const review of pending) {
    for (const runId of await unconfirmedDisconnectRunIds(ctx, ctx.db.db, { taskId: review.reviewTaskId })) {
      const [run] = await ctx.db.db.select().from(runs).where(eq(runs.id, runId));
      await stopProcess(ctx, runId);
      await failRunDaemonDisconnect(ctx, runId, run!.computerId, true);
    }
    const [turn] = await ctx.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, review.turnId));
    const [run] = turn?.runId ? await ctx.db.db.select().from(runs).where(eq(runs.id, turn.runId)) : [];
    if (turn && ["queued", "waiting", "running"].includes(turn.status)) {
      if (!run || !["completed", "failed", "cancelled"].includes(run.status)) {
        await cancelAssistantTurn(ctx, review.turnId, (runId) => stopProcess(ctx, runId));
      } else {
        await ctx.db.db.update(assistantTurns).set({ status: "cancelled", updatedAt: ctx.clock.nowIso() }).where(eq(assistantTurns.id, turn.id));
      }
    }
    await ctx.db.db.update(autonomousReviews).set({ status: "cancelled", updatedAt: ctx.clock.nowIso() }).where(eq(autonomousReviews.id, review.id));
    await ctx.db.transaction(async (tx) => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, review.reviewTaskId));
      if (task && canTransitionTask(task.status as TaskStatus, "cancel")) {
        await transitionTask(tx, ctx, { taskId: task.id, from: task.status as TaskStatus, trigger: "cancel", now: ctx.clock.nowIso(),
          events: (to) => [buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: review.id,
            goalId, projectId: task.projectId, taskId: task.id, roomId: task.roomId, payload: { status: to, independent_review_id: review.id } })] });
      }
    });
  }
}

/** Planning uses a separate task; stop it explicitly before the goal cancellation can report success. */
export async function stopAutonomousGoalPlanning(ctx: ServerContext, goalId: string, stopProcess: StopProcess): Promise<void> {
  const automation = await getGoalAutomation(ctx, goalId);
  if (!automation) return;
  const goal = await getGoal(ctx, goalId);
  if (goal && ["draft", "running", "awaiting_approval", "blocked"].includes(goal.status)) await pauseGoal(ctx, goalId);
  await cancelGoalProductRelease(ctx, goalId);
  await cancelGoalApplicationPublication(ctx, goalId);
  // Reload after the goal fence: a concurrent planner may have committed its link before pause acquired the goal lock.
  const current = await getGoalAutomation(ctx, goalId);
  await stopIndependentReviews(ctx, goalId, stopProcess);
  await stopGoalProductHandoffs({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedProductReviews({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedDesignContinuations({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedExecutions({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedExecutionReviews({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedExecutionRepairs({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedValidations({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedValidationReviews({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  const recoveryActor: ServerContext = { ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } };
  await stopGoalSourceRecoveries(recoveryActor, goalId);
  await stopGoalRecoveryValidations(recoveryActor, goalId);
  await stopGoalRecoveryValidationReviews(recoveryActor, goalId);
  await stopGoalCleanValidations(recoveryActor, goalId);
  await stopGoalCleanValidationReviews(recoveryActor, goalId);
  if (!current?.discussion_id) return;
  const discussion = await cancelDiscussion(ctx, current.discussion_id, stopProcess);
  if (discussion.status === "stopping") throw AppError.conflict("Goal paused: planning process stop has not been confirmed");
}

async function advancePublication(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, goal: typeof goals.$inferSelect): Promise<void> {
  const release = await ensureGoalProductRelease(ctx, tx, row);
  if (release.status === "succeeded") {
    const [current] = await tx.select().from(goals).where(and(eq(goals.id, goal.id), eq(goals.organizationId, ctx.organizationId))).for("update");
    if (!current || current.status !== "running" || current.currentPlanId !== row.planId) throw AppError.conflict("Goal was paused, stopped or replanned before publication completion");
    await tx.update(goals).set({ status: "completed", updatedAt: ctx.clock.nowIso() }).where(and(eq(goals.id, goal.id), eq(goals.status, "running")));
    await appendEvent(tx, buildEvent(ctx, { type: "goal.completed", actorType: "system", actorId: "goal_runner", correlationId: goal.id,
      projectId: goal.projectId, goalId: goal.id, roomId: goal.roomId, payload: { goal_id: goal.id, trigger: "product_release_healthy", endpoint: release.endpoint ?? null,
        ...(release.settlement ? { settlement: release.settlement } : {}) } }));
  }
  await update(ctx, tx, row, { status: release.status === "succeeded" ? "completed" : release.status === "failed" ? "failed" : "executing", lastError: release.reason ?? null });
}

/** Once H7 exists it owns current product bytes; do not re-enter H5/H6 live-S0 admission. */
async function advanceValidationLineage(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, goal: typeof goals.$inferSelect,
  author: typeof goalImportedValidations.$inferSelect): Promise<void> {
  const progress = await advanceGoalImportedValidation(ctx, tx, row, author.id);
  let reason = progress.reason;
  if (!progress.validation.stopRequested && progress.validation.readyKind === "repair") {
    const repair = await ensureGoalImportedValidationRepair(ctx, tx, row, author.id, "failure");
    reason = (await advanceGoalImportedValidation(ctx, tx, row, repair.id)).reason;
  } else if (!progress.validation.stopRequested && progress.validation.readyKind === "review") {
    const reviewed = await advanceGoalImportedValidationReview(ctx, tx, row, author.id);
    reason = reviewed.reason;
    if (reviewed.review.acceptedAt) { await advancePublication(ctx, tx, row, goal); return; }
    const result = ImportedValidationReviewResultV1Schema.safeParse(reviewed.review.result).data;
    if (!reviewed.review.stopRequested && result?.outcome === "reviewed" && result.verdict.outcome === "rejected") {
      const repair = await ensureGoalImportedValidationRepair(ctx, tx, row, reviewed.review.id);
      reason = (await advanceGoalImportedValidation(ctx, tx, row, repair.id)).reason;
    }
  }
  await update(ctx, tx, row, { status: "waiting", lastError: reason });
}

/** Once H9 exists it owns current product bytes; do not re-enter H5/H6 live-S0 admission. */
async function advanceRecoveryValidationLineage(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, goal: typeof goals.$inferSelect,
  author: typeof goalRecoveryValidations.$inferSelect): Promise<void> {
  const progress = await advanceGoalRecoveryValidation(ctx, tx, row, author.id);
  let reason = progress.reason;
  if (!progress.validation.stopRequested && progress.validation.readyKind === "repair") {
    const repair = await ensureGoalRecoveryValidationRepair(ctx, tx, row, author.id, "failure");
    reason = (await advanceGoalRecoveryValidation(ctx, tx, row, repair.id)).reason;
  } else if (!progress.validation.stopRequested && progress.validation.readyKind === "review") {
    const reviewed = await advanceGoalRecoveryValidationReview(ctx, tx, row, author.id);
    reason = reviewed.reason;
    if (reviewed.review.acceptedAt) { await advancePublication(ctx, tx, row, goal); return; }
    const result = ImportedRecoveryValidationReviewResultV1Schema.safeParse(reviewed.review.result).data;
    if (!reviewed.review.stopRequested && result?.outcome === "reviewed" && result.verdict.outcome === "rejected") {
      const repair = await ensureGoalRecoveryValidationRepair(ctx, tx, row, reviewed.review.id);
      reason = (await advanceGoalRecoveryValidation(ctx, tx, row, repair.id)).reason;
    }
  }
  await update(ctx, tx, row, { status: "waiting", lastError: reason });
}

/** Once a clean restart settles it owns current product bytes; do not re-enter H5/H6 live-S0 admission. */
async function advanceCleanValidationLineage(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, goal: typeof goals.$inferSelect,
  author: typeof goalCleanValidations.$inferSelect): Promise<void> {
  const progress = await advanceGoalCleanValidation(ctx, tx, row, author.id);
  let reason = progress.reason;
  if (!progress.validation.stopRequested && progress.validation.readyKind === "repair") {
    const repair = await ensureGoalCleanValidationRepair(ctx, tx, row, author.id, "failure");
    reason = (await advanceGoalCleanValidation(ctx, tx, row, repair.id)).reason;
  } else if (!progress.validation.stopRequested && progress.validation.readyKind === "review") {
    const reviewed = await advanceGoalCleanValidationReview(ctx, tx, row, author.id);
    reason = reviewed.reason;
    if (reviewed.review.acceptedAt) { await advancePublication(ctx, tx, row, goal); return; }
    const result = ImportedCleanValidationReviewResultV1Schema.safeParse(reviewed.review.result).data;
    if (!reviewed.review.stopRequested && result?.outcome === "reviewed" && result.verdict.outcome === "rejected") {
      const repair = await ensureGoalCleanValidationRepair(ctx, tx, row, reviewed.review.id);
      reason = (await advanceGoalCleanValidation(ctx, tx, row, repair.id)).reason;
    }
  }
  await update(ctx, tx, row, { status: "waiting", lastError: reason });
}

async function advance(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, queued: string[]): Promise<void> {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) return;
  if (["cancelled", "archived"].includes(goal.status)) { await update(ctx, tx, row, { status: "cancelled", lastError: null }); return; }
  if (goal.status === "completed") {
    if (row.appDelivery != null) throw AppError.conflict("Application publication is unsupported; development verification cannot complete a product goal");
    if (row.appPublication != null) {
      const [settlement] = await tx.select().from(applicationPublicationSettlements).where(and(
        eq(applicationPublicationSettlements.goalId, row.goalId), eq(applicationPublicationSettlements.organizationId, ctx.organizationId)));
      if (!settlement || settlement.authorizationEventId !== row.applicationPublicationAuthorizationEventId) {
        throw AppError.conflict("Completed application goal lacks its immutable original publication settlement");
      }
    } else await assertRecordedGoalReleaseCompletion(ctx, tx, row);
    await update(ctx, tx, row, { status: "completed", lastError: null }); return;
  }
  if (["paused", "awaiting_approval"].includes(goal.status)) { await update(ctx, tx, row, { status: "waiting", lastError: `Goal is ${goal.status}; no new work will start.` }); return; }
  await requireAiSharingAuthorization(ctx, tx, { consentId: row.consentId, policyVersion: row.policyVersion });
  if (row.planId && goal.currentPlanId !== row.planId) {
    await update(ctx, tx, row, { status: "failed", lastError: "The accepted plan changed; automatic execution stopped." }); return;
  }
  if (!row.discussionId) {
    const publication = row.appPublication == null ? undefined : await originalApplicationPublication(ctx, tx, row, goal.projectId);
    if (publication) assertCurrentApplicationPublication(ctx, publication);
    // This query also adopts a committed discussion after an interrupted older dispatcher.
    const existing = (await tx.select().from(discussions).where(and(eq(discussions.goalId, goal.id), eq(discussions.organizationId, ctx.organizationId)))
      .orderBy(asc(discussions.createdAt), asc(discussions.id)).limit(1))[0];
    if (existing) {
      const recoverable = row.agentInstanceId && row.computerId && row.workspaceRoot && existing.actorUserId === row.actorUserId
        && existing.aiDataSharingConsentId === row.consentId && existing.aiDataSharingPolicyVersion === row.policyVersion;
      await update(ctx, tx, row, { discussionId: existing.id, status: recoverable ? "planning" : "failed",
        lastError: recoverable ? null : "Planning recovery is missing the fixed worker or original authorization; start a new autonomous goal." });
      return;
    }
    const candidates = (await scheduleTask(tx, ctx, [], { mode: "auto", projectId: goal.projectId, branchBacked: false })).candidates.filter((item) => item.runtime !== "mock");
    if (candidates.length < 2) throw AppError.conflict("Connect at least two available agent instances for autonomous planning.");
    const capable = (await scheduleTask(tx, ctx, ["code.modify"], { mode: "auto", projectId: goal.projectId, branchBacked: false })).candidates;
    const teamCapable = row.executionMode === "agent_team" ? (await scheduleTask(tx, ctx, ["code.read", "code.modify", "code.review"],
      { mode: "auto", projectId: goal.projectId, branchBacked: false })).candidates : [];
    const researchCapable = row.executionMode === "agent_team" ? (await scheduleTask(tx, ctx, ["code.read", "code.modify", "code.review", "research.web"],
      { mode: "auto", projectId: goal.projectId, branchBacked: false })).candidates : [];
    const instances = await tx.select().from(agentInstances).where(eq(agentInstances.organizationId, ctx.organizationId));
    const availableComputers = await tx.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
    const profileRoots = new Map<string, string>();
    for (const candidate of candidates) {
      const instance = instances.find((item) => item.id === candidate.agent_instance_id);
      const computer = availableComputers.find((item) => item.id === candidate.computer_id);
      if (!instance?.workspaceRoot || !computer || ctx.supportsExecutionFeature?.(computer.id, "run-verification.v1") !== true) continue;
      if (row.executionMode === "agent_team" && ctx.supportsExecutionFeature?.(computer.id, "product-stage-verification.v1") !== true) continue;
      if ((row.appDelivery != null || row.appPublication != null) && ctx.supportsExecutionFeature?.(computer.id, APPLICATION_VERIFICATION_FEATURE_V1) !== true) continue;
      if (publication && computer.id !== publication.capabilities.binding.computer_id) continue;
      const root = resolveAutomationWorkspace(ctx, computer, row.verificationProfileId, goal.projectId, instance.workspaceRoot);
      if (root !== undefined) {
        profileRoots.set(candidate.agent_instance_id, root);
      }
    }
    let writer: (typeof capable)[number] | undefined, writerRoot: string | undefined;
    for (const candidate of capable) {
      const instance = instances.find((item) => item.id === candidate.agent_instance_id);
      if (!profileRoots.has(candidate.agent_instance_id) || !instance?.workspaceRoot) continue;
      if (row.executionMode === "agent_team" && (!teamCapable.some((peer) => peer.agent_instance_id === candidate.agent_instance_id)
        || !researchCapable.some((peer) => peer.agent_id !== candidate.agent_id && peer.computer_id === candidate.computer_id
          && profileRoots.get(peer.agent_instance_id) === profileRoots.get(candidate.agent_instance_id)))) continue;
      // The same computer lock protects both reservations and ordinary assignments against phantoms.
      const [computer] = await tx.select().from(computers).where(eq(computers.id, candidate.computer_id)).for("update");
      if (!computer) continue;
      const root = resolveAutomationWorkspace(ctx, computer, row.verificationProfileId, goal.projectId, instance.workspaceRoot);
      if (root === undefined || root !== profileRoots.get(candidate.agent_instance_id)) continue;
      if ((row.appDelivery != null || row.appPublication != null) && (!['windows', 'win32'].includes(computer.os)
        || !ctx.getVerificationCapabilities?.(computer.id, row.verificationProfileId, goal.projectId, root)?.application)) continue;
      if (row.sourceHandoff != null && (!row.releaseProfileId || !["windows", "win32"].includes(computer.os)
        || !automaticSourceAvailable(ctx, computer.id, goal.projectId, root, row.verificationProfileId, row.releaseProfileId))) continue;
      if (row.releaseProfileId) {
        const capabilities = ctx.getVerificationCapabilities?.(computer.id, row.verificationProfileId, goal.projectId, root);
        if (capabilities?.measurement_plan_policy?.version === 2
          && (!ctx.getReleaseCapabilities?.(computer.id, row.releaseProfileId, goal.projectId, root, row.verificationProfileId)
            || ctx.supportsExecutionFeature?.(computer.id, "product-release.acceptance.v1") !== true)) continue;
      }
      const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.computerId, computer.id), inArray(goalAutomations.status, ACTIVE)));
      const uncertain = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: computer.id });
      const activeRuns = await tx.select().from(runs).where(and(eq(runs.computerId, computer.id), or(notInArray(runs.status, ["completed", "failed", "cancelled"]), uncertain.length ? inArray(runs.id, uncertain) : undefined)));
      if (reservations.some((item) => item.goalId !== row.goalId && item.workspaceRoot && automationWorkspacesOverlap(item.workspaceRoot, root, computer.os))
        || activeRuns.some((item) => !item.workspaceRoot || automationWorkspacesOverlap(item.workspaceRoot, root, computer.os))) continue;
      writer = candidate; writerRoot = root; break;
    }
    if (!writer) throw AppError.conflict("Connect a verification-capable worker advertising the requested verification profile, project and ordinary workspace.");
    let team: AutonomousTeam | undefined;
    if (row.executionMode === "agent_team") {
      const peers = teamCapable.filter((candidate) => candidate.computer_id === writer!.computer_id
        && profileRoots.get(candidate.agent_instance_id) === writerRoot);
      if (!peers.some((candidate) => candidate.agent_instance_id === writer!.agent_instance_id)) {
        throw AppError.conflict("The implementation agent must support code.read, code.modify and code.review");
      }
      const specialist = researchCapable.find((candidate) => candidate.agent_id !== writer!.agent_id && peers.some((peer) => peer.agent_instance_id === candidate.agent_instance_id));
      if (!specialist) throw AppError.conflict("Agent Team needs a distinct research-capable contributor and two independent reviewers in one verified workspace");
      team = AutonomousTeamSchema.parse({ version: 1, members: [
        { stage: "research", agent_instance_id: specialist.agent_instance_id },
        { stage: "design", agent_instance_id: specialist.agent_instance_id },
        { stage: "implementation", agent_instance_id: writer.agent_instance_id },
        { stage: "validation", agent_instance_id: specialist.agent_instance_id },
      ], reviewer_instance_ids: [writer.agent_instance_id, specialist.agent_instance_id] });
    }
    const reviewer = candidates.find((candidate) => candidate.agent_instance_id !== writer.agent_instance_id && profileRoots.has(candidate.agent_instance_id)
      && (!team || team.reviewer_instance_ids.includes(candidate.agent_instance_id)));
    if (!reviewer) throw AppError.conflict("Connect a second available planning instance advertising the requested verification profile, project and ordinary workspace.");
    const planningCapabilitySnapshot = capturePlanningSnapshot(ctx, { ...row, computerId: writer.computer_id,
      workspaceRoot: writerRoot! }, goal.projectId);
    if (publication) {
      assertCurrentApplicationPublication(ctx, publication);
      if (!isDeepStrictEqual(planningCapabilitySnapshot.application_publication?.capabilities, publication.capabilities))
        throw AppError.conflict("The planning publication capability differs from the original user's selected profile");
    }
    const discussion = await startDiscussion(ctx, goal.id, { participants: [
      { agent_instance_id: writer.agent_instance_id, role: team ? "Coordinate staged research, design, implementation and validation. Assign concrete deliverables and dependencies for the Agent Team." : "Plan research, design and implementation as concrete workspace tasks with observable criteria." },
      { agent_instance_id: reviewer.agent_instance_id, role: team ? "Challenge feasibility and evidence. Require cited research, a working prototype and measured validation. Peer review and release are handled by trusted executors." : "Review feasibility and verification. Keep delivery in the configured workspace; do not plan deployment." },
    ], rounds: 1, max_minutes: 15 });
    await update(ctx, tx, row, { discussionId: discussion.id, agentInstanceId: writer.agent_instance_id, computerId: writer.computer_id,
      workspaceRoot: writerRoot!, team: team ?? null, planningCapabilitySnapshot, status: "planning", lastError: null });
    return;
  }
  if (!row.planId) {
    const [discussion] = await tx.select().from(discussions).where(eq(discussions.id, row.discussionId));
    if (!discussion || ["failed", "cancelled", "stopping"].includes(discussion.status)) {
      await update(ctx, tx, row, { status: "failed", lastError: discussion?.error ?? "Planning did not finish successfully." }); return;
    }
    if (discussion.status !== "ready") { await update(ctx, tx, row, { status: "planning", lastError: null }); return; }
    if (!row.agentInstanceId) throw AppError.conflict("The planning session has no fixed execution worker.");
    // Validate before inserting a proposal, so a failed synthesis can be repaired
    // in the same transaction without leaving a partially accepted plan behind.
    try {
      const [answer] = discussion.finalMessageId ? await tx.select().from(messages).where(eq(messages.id, discussion.finalMessageId)) : [];
      const specs = validatePlanTaskSpecs(parseDiscussionPlan(answer?.body ?? "").task_specs);
      if (row.executionMode === "agent_team") {
        const errors = validateProductDevelopmentPlan(specs);
        if (row.sourceHandoff != null) errors.push(...automaticSourceHandoffPlanErrors(specs));
        if (errors.length) throw AppError.validation(`Agent Team plan is incomplete: ${errors.join("; ")}`);
      }
    } catch (error) {
      if (!(error instanceof AppError && ["validation_error", "conflict"].includes(error.code))) throw error;
      const budgets = GoalBudgetsSchema.parse(goal.budgets);
      if (budgets.max_retries !== null && goal.retryCount >= budgets.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
      await retryAutonomousSynthesis(ctx, discussion.id, error.message, goal.retryCount + 1);
      await tx.update(goals).set({ retryCount: goal.retryCount + 1, updatedAt: ctx.clock.nowIso() }).where(eq(goals.id, goal.id));
      await update(ctx, tx, row, { status: "planning", lastError: error.message }); return;
    }
    const proposal = await proposeDiscussionPlan(ctx, discussion.id);
    await acceptPlan(ctx, proposal.plan.id);
    await update(ctx, tx, row, { planId: proposal.plan.id, status: "executing", lastError: null });
    return;
  }
  const planTasks = await tx.select().from(tasks).where(and(eq(tasks.goalId, goal.id), eq(tasks.sourcePlanId, row.planId), eq(tasks.organizationId, ctx.organizationId)))
    .orderBy(asc(tasks.createdAt), asc(tasks.sourcePlanSpecRef));
  if (planTasks.length === 0) { await update(ctx, tx, row, { status: "failed", lastError: "The accepted plan has no execution tasks." }); return; }
  if (planTasks.some((task) => task.status === "cancelled")) { await update(ctx, tx, row, { status: "failed", lastError: "A required task was cancelled." }); return; }
  // A prepared clean stop fences the old execution path even before a successor
  // exists. Only the exact committed checkpoint may move the lineage, and only
  // this initiating GoalRunner may start a fresh author after full settlement.
  const [cleanStop] = await tx.select().from(sourceCleanStops).where(and(eq(sourceCleanStops.organizationId, ctx.organizationId),
    sql`${sourceCleanStops.intent}->>'goal_id' = ${goal.id}`)).orderBy(desc(sourceCleanStops.createdAt), desc(sourceCleanStops.id)).limit(1);
  if (cleanStop) {
    const [generation] = await tx.select().from(sourceCleanGenerations).where(and(eq(sourceCleanGenerations.organizationId, ctx.organizationId),
      eq(sourceCleanGenerations.predecessorStopId, cleanStop.id)));
    if (!generation?.checkpointedAt || !generation.checkpoint || !generation.receipt) {
      await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for the original parent closure and committed fresh Windows checkpoint." }); return;
    }
    await settleSourceCleanGeneration(ctx, tx, generation.id);
    await settleCleanPublications(ctx, tx, generation.id);
    const [author] = await tx.select().from(goalCleanValidations).where(and(eq(goalCleanValidations.organizationId, ctx.organizationId),
      eq(goalCleanValidations.cleanGenerationId, generation.id))).orderBy(desc(goalCleanValidations.generation)).limit(1);
    await advanceCleanValidationLineage(ctx, tx, row, goal, author ?? await ensureGoalCleanValidation(ctx, tx, row, generation.id)); return;
  }
  const [validation] = await tx.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.organizationId, ctx.organizationId),
    eq(goalImportedValidations.goalId, goal.id), eq(goalImportedValidations.planId, row.planId))).orderBy(desc(goalImportedValidations.generation)).limit(1);
  const validationBudgets = validation && GoalBudgetsSchema.parse(goal.budgets);
  if (validationBudgets && validationBudgets.max_elapsed_ms !== null && goal.runningSince !== null
    && Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince)) >= validationBudgets.max_elapsed_ms) {
    await update(ctx, tx, row, { status: "failed", lastError: "Original goal elapsed budget reached; H7 execution must confirm closure." }); return;
  }
  // Reconcile the original registered epoch before re-entering any H7 live-session gate.
  const [origin] = await tx.select().from(goalImportedExecutionReviews).where(and(eq(goalImportedExecutionReviews.organizationId, ctx.organizationId),
    eq(goalImportedExecutionReviews.goalId, goal.id), eq(goalImportedExecutionReviews.planId, row.planId), isNotNull(goalImportedExecutionReviews.acceptedAt)))
    .orderBy(desc(goalImportedExecutionReviews.acceptedAt)).limit(1);
  if (origin && await awaitsPlannedCleanTransition(ctx, tx, origin)) {
    await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for the planned native Windows transition after accepted H6." }); return;
  }
  const recovery = origin && await ensureGoalSourceRecovery(ctx, tx, row, origin.id);
  if (recovery) {
    const progress = await advanceGoalSourceRecovery(ctx, tx, recovery);
    if (progress.state === "waiting") {
      await ctx.onSourceRecoveryQueued?.(recovery.id, recovery.stopRequested ? "stop" : "start");
      await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for exact old daemon closure and a fresh unverified recovery checkpoint." }); return;
    }
    if (progress.state === "unknown") {
      await update(ctx, tx, row, { status: "waiting", lastError: "Old daemon closure remains unknown; the original workspace stays fenced." }); return;
    }
    await settleRecoveryPublications(ctx, tx, recovery.id);
    const [author] = await tx.select().from(goalRecoveryValidations).where(and(eq(goalRecoveryValidations.organizationId, ctx.organizationId), eq(goalRecoveryValidations.recoveryId, recovery.id)))
      .orderBy(desc(goalRecoveryValidations.generation)).limit(1);
    const currentAuthor = author ?? await ensureGoalRecoveryValidation(ctx, tx, row, recovery.id);
    await advanceRecoveryValidationLineage(ctx, tx, row, goal, currentAuthor); return;
  }
  const standalone = await unsettledStandaloneExecutions(ctx, tx, { goalId: goal.id });
  if (standalone.length) {
    for (const operation of standalone) {
      const control = operation.stopRequested ? "stop" : operation.result === null ? "start" : "status";
      if (operation.kind === "design" || operation.kind === "execution" || operation.kind === "execution_repair" || operation.kind === "validation" || operation.kind === "recovery_validation" || operation.kind === "clean_validation") {
        const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, operation.runId));
        const actual = control === "start" && run?.status !== "queued" ? "status" : control;
        if (operation.kind === "clean_validation") await ctx.onCleanValidationQueued?.(operation.id, actual);
        else if (operation.kind === "recovery_validation") await ctx.onRecoveryValidationQueued?.(operation.id, actual);
        else if (operation.kind === "validation") await ctx.onImportedValidationQueued?.(operation.id, actual);
        else if (operation.kind === "execution_repair") await ctx.onImportedExecutionRepairQueued?.(operation.id, actual);
        else if (operation.kind === "execution") await ctx.onImportedExecutionQueued?.(operation.id, actual);
        else await ctx.onImportedDesignContinuationQueued?.(operation.id, actual);
      } else if (operation.kind === "clean_validation_review") await ctx.onCleanValidationReviewQueued?.(operation.id, control);
      else if (operation.kind === "recovery_validation_review") await ctx.onRecoveryValidationReviewQueued?.(operation.id, control);
      else if (operation.kind === "validation_review") await ctx.onImportedValidationReviewQueued?.(operation.id, control);
      else if (operation.kind === "execution_review") await ctx.onImportedExecutionReviewQueued?.(operation.id, control);
      else if (operation.kind === "design_review") await ctx.onImportedDesignReviewQueued?.(operation.id, control);
      else if (operation.kind === "review") await ctx.onImportedProductReviewQueued?.(operation.id, control);
      else await ctx.onProductSourceOperationQueued?.(operation.id, control);
    }
    await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for source transfer or imported research review and confirmed closure; no new stage can start." }); return;
  }
  if (validation) { await advanceValidationLineage(ctx, tx, row, goal, validation); return; }
  // Initial H3 owns exactly one imported design execution. Its terminal result cannot
  // reuse the original source computer's ordinary independent-review/workspace binding.
  const [design] = await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.goalId, goal.id), eq(goalImportedDesignContinuations.planId, row.planId), eq(goalImportedDesignContinuations.organizationId, ctx.organizationId)));
  if (design) {
    const outcome = ImportedDesignContinuationResultV1Schema.safeParse(design.result).data;
    const [run] = await tx.select().from(runs).where(eq(runs.id, design.runId));
    const verification = run?.status === "completed" ? await inspectRunVerification(ctx, tx, run) : undefined;
    let reason = outcome?.outcome === "finished" && outcome.verified_design && verification?.passed
      ? (await advanceGoalImportedDesignReview(ctx, tx, row, design.id)).reason
      : `Imported design requires reconciliation before continuation: ${verification?.reason ?? outcome?.outcome ?? "execution closure pending"}`;
    const [accepted] = await tx.select().from(goalImportedDesignReviews).where(and(eq(goalImportedDesignReviews.continuationId, design.id), eq(goalImportedDesignReviews.organizationId, ctx.organizationId)));
    if (accepted?.acceptedAt && ctx.supportsExecutionFeature?.(accepted.computerId, IMPORTED_EXECUTION_FEATURE_V1) === true) {
      reason = (await advanceGoalImportedExecution(ctx, tx, row, accepted.id)).reason;
      const [execution] = await tx.select().from(goalImportedExecutions).where(and(eq(goalImportedExecutions.reviewId, accepted.id), eq(goalImportedExecutions.organizationId, ctx.organizationId)));
      if (execution?.reviewReadyAt && ctx.supportsExecutionFeature?.(execution.computerId, IMPORTED_EXECUTION_REVIEW_FEATURE_V1) === true) {
        const repairs = await tx.select().from(goalImportedExecutionRepairs).where(and(eq(goalImportedExecutionRepairs.baseExecutionId, execution.id), eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId)));
        const latestRepair = repairs.sort((a, b) => b.attemptIndex - a.attemptIndex)[0];
        if (latestRepair && !latestRepair.reviewReadyAt) reason = (await advanceGoalImportedExecutionRepair(ctx, tx, row, latestRepair.reviewId)).reason;
        else {
          const reviewed = await advanceGoalImportedExecutionReview(ctx, tx, row, execution.id);
          reason = reviewed.reason;
          const result = ImportedExecutionReviewResultV1Schema.safeParse(reviewed.review.result).data;
          if (!reviewed.review.stopRequested && !reviewed.review.acceptedAt && result?.outcome === "reviewed" && result.verdict.outcome === "rejected")
            reason = (await advanceGoalImportedExecutionRepair(ctx, tx, row, reviewed.review.id)).reason;
          if (reviewed.review.acceptedAt && ctx.supportsExecutionFeature?.(reviewed.review.computerId, IMPORTED_VALIDATION_FEATURE_V1) === true) {
            // H6 acceptance and this decision share the GoalRunner transaction.
            // A clean-enabled destination cannot race ordinary H7/publication
            // ahead of its original launcher's protected stop request.
            if (await awaitsPlannedCleanTransition(ctx, tx, reviewed.review)) {
              await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for the planned native Windows transition after accepted H6." }); return;
            }
            const initial = await ensureGoalImportedValidation(ctx, tx, row, reviewed.review.id);
            await advanceValidationLineage(ctx, tx, row, goal, initial); return;
          }
        }
      }
    }
    // An unqualified H7 destination remains at H6; ordinary review/retry/release cannot bypass this fence.
    await update(ctx, tx, row, { status: "waiting", lastError: reason }); return;
  }
  if (row.appDelivery != null && planTasks.every((task) => task.status === "done")) {
    await update(ctx, tx, row, { status: "waiting", lastError: "Application development verification and independent review completed. Application publication remains unsupported." }); return;
  }
  if (row.appPublication != null && planTasks.every((task) => task.status === "done")) {
    const publication = await ensureGoalApplicationPublication(ctx, tx, row);
    // Publication owns the completion event, immutable settlement and both status writes.
    if (publication.status !== "succeeded") await update(ctx, tx, row,
      { status: publication.status === "failed" ? "failed" : "waiting", lastError: publication.reason ?? null });
    return;
  }
  if (row.releaseProfileId && planTasks.every((task) => task.status === "done")) {
    await advancePublication(ctx, tx, row, goal); return;
  }
  const unsettled = await unsettledGoalRunIds(ctx, tx, goal.id);
  if (unsettled.length) {
    // Re-delivery uses the existing run ID and the node's idempotent start protocol.
    const active = await tx.select({ id: runs.id, status: runs.status }).from(runs).where(inArray(runs.id, unsettled));
    for (const run of active) if (run.status === "queued") queued.push(run.id);
    const uncertain = active.some((run) => ["failed", "completed", "cancelled"].includes(run.status));
    await update(ctx, tx, row, { status: uncertain ? "waiting" : "executing", lastError: uncertain ? "Waiting for the previous execution's process exit and workspace release." : null }); return;
  }
  const revision = await latestDesignRevision(ctx, tx, goal.id);
  const designTask = planTasks.find(task => task.sourcePlanSpecRef === "1");
  const research = researchRevisionPoolRequested(row) && designTask
    ? await readCurrentResearchHandoff(ctx, tx, goal.id, row.planId, designTask.id) : undefined;
  const [researchTask] = research?.revision && research.handoffId === null ? await tx.select().from(tasks).where(and(
    eq(tasks.id, research.revision.auxiliaryTaskId), eq(tasks.organizationId, ctx.organizationId))) : [];
  if (researchTask?.status === "cancelled") {
    await update(ctx, tx, row, { status: "failed", lastError: "The required research revision was cancelled." }); return;
  }
  const runnable = researchTask && researchTask.status !== "done" ? [researchTask]
    : revision?.state === "active" ? planTasks.filter(task => task.id === revision.designTaskId) : planTasks;
  const review = runnable.find((task) => task.status === "review");
  if (review) {
    const run = (await tx.select().from(runs).where(and(eq(runs.taskId, review.id), eq(runs.organizationId, ctx.organizationId))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0];
    const result = run?.status === "completed" ? await inspectRunVerification(ctx, tx, run) : { passed: false, reason: "Latest execution did not complete successfully" };
    const [plan] = await tx.select().from(plans).where(eq(plans.id, row.planId));
    const origin = await resolveResearchRevisionOrigin(ctx, tx, review);
    const spec = TaskSpecSchema.parse((plan?.taskSpecs as unknown[] | undefined)?.[Number(origin?.specRef ?? review.sourcePlanSpecRef)]);
    const outputs = run ? await tx.select({ type: artifacts.type }).from(artifacts).where(and(eq(artifacts.runId, run.id), eq(artifacts.organizationId, ctx.organizationId))) : [];
    const missing = spec.expected_artifacts.filter((expected) => !outputs.some((actual) => actual.type === expected.type));
    let passed = result.passed && missing.length === 0;
    let reason = missing.length ? `Missing expected artifact types: ${missing.map((item) => item.type).join(", ")}` : result.reason;
    if (passed && row.executionMode === "agent_team" && run && "evidence" in result && result.evidence) {
      const peer = await ensureIndependentReview(ctx, tx, row, review, run, result.evidence);
      if (peer.status === "pending") { await update(ctx, tx, row, { status: "executing", lastError: peer.reason }); return; }
      if (peer.status === "changes_requested" && peer.designRevisionRequest && peer.review) {
        if (spec.development_stage !== "implementation") throw AppError.conflict("Additive design revision requests are restricted to implementation review");
        await requestProductDesignRevision(ctx, tx, { goalId: goal.id, implementationTaskId: review.id, implementationRunId: run.id, requestingReviewId: peer.review.id });
        await update(ctx, tx, row, { status: "executing", lastError: "The accepted design is being revised against the independent implementation findings." }); return;
      }
      passed = peer.status === "accepted";
      reason = peer.reason;
    }
    await reviewTask(ctx, review.id, { outcome: passed ? "accepted" : "changes_requested", comment: `${passed ? "Verified" : "Verification requires changes"} for run ${run?.id ?? "missing"}: ${reason}` });
    const latestGoal = await getGoal(ctx, goal.id);
    await update(ctx, tx, row, { status: latestGoal?.status === "completed" ? "completed" : "executing", lastError: passed ? null : reason });
    return;
  }
  const blocked = runnable.find((task) => task.status === "blocked");
  if (blocked) {
    if ((await unconfirmedDisconnectRunIds(ctx, tx, { taskId: blocked.id })).length) throw AppError.conflict("Waiting for the previous execution process to confirm it stopped.");
    await retryTask(ctx, blocked.id);
    await update(ctx, tx, row, { status: "executing", lastError: null }); return;
  }
  const ready = runnable.find((task) => task.status === "ready");
  if (ready) {
    if (await ensureAutomaticProductHandoff(ctx, tx, row, ready.id)) {
      await update(ctx, tx, row, { status: "waiting", lastError: "Prepared destination selected; transferring accepted research before design." }); return;
    }
    const imported = await advanceGoalImportedProductReview(ctx, tx, row, ready.id);
    if (imported) {
      if ("state" in imported && imported.state === "accepted_waiting_writer_authority") {
        const continuation = await ensureGoalImportedDesignContinuation(ctx, tx, row, imported.review_id);
        if (continuation.result === null && !continuation.stopRequested) await ctx.onImportedDesignContinuationQueued?.(continuation.id, "start");
        await update(ctx, tx, row, { status: "executing", lastError: "Imported research accepted; its single-use destination design execution is queued." });
      } else if ("state" in imported && imported.state === "changes_requested" && researchRevisionPoolRequested(row)) {
        await ensureGoalResearchRevision(ctx, tx, row, imported.review_id);
        await update(ctx, tx, row, { status: "executing", lastError: "Imported research requires changes; its source revision is queued for fresh verification and independent review." });
      } else await update(ctx, tx, row, { status: "waiting", lastError: imported.reason });
      return;
    }
    const previous = (await tx.select().from(runs).where(and(eq(runs.taskId, ready.id), eq(runs.organizationId, ctx.organizationId))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0];
    // startedAt records entry to "starting", including rejected starts. Only the
    // durable run.started event proves the process began; ready start failures
    // otherwise bypass retryTask and must consume their budget here.
    const lifecycle = previous?.status === "failed" ? await tx.select({ type: eventLog.type, payload: eventLog.payload }).from(eventLog).where(and(
      eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.runId, previous.id), eq(eventLog.taskId, ready.id),
      inArray(eventLog.type, ["run.started", "run.failed"]),
    )) : [];
    const rejectedStart = lifecycle.some((event) => event.type === "run.failed" && event.payload !== null && typeof event.payload === "object"
      && "recoverable" in event.payload && event.payload.recoverable === true)
      && !lifecycle.some((event) => event.type === "run.started");
    if (previous && rejectedStart) {
      const budget = GoalBudgetsSchema.parse(goal.budgets);
      if (budget.max_retries !== null && goal.retryCount >= budget.max_retries) throw AppError.conflict("Goal retry budget would be exceeded", { budget: "max_retries" });
      await tx.update(goals).set({ retryCount: goal.retryCount + 1, updatedAt: ctx.clock.nowIso() }).where(eq(goals.id, goal.id));
      await appendEvent(tx, buildEvent(ctx, { type: "task.updated", actorType: "system", actorId: "goal_runner", correlationId: ready.id,
        goalId: goal.id, projectId: goal.projectId, taskId: ready.id, payload: { retried: true, previous_run_id: previous.id, reason: "process_start_failed" } }));
    }
    let assignee = row.agentInstanceId!;
    if (row.executionMode === "agent_team") {
      const [source] = await tx.select().from(plans).where(eq(plans.id, row.planId));
      const origin = await resolveResearchRevisionOrigin(ctx, tx, ready);
      const spec = TaskSpecSchema.parse((source?.taskSpecs as unknown[] | undefined)?.[Number(origin?.specRef ?? ready.sourcePlanSpecRef)]);
      const member = AutonomousTeamSchema.parse(row.team).members.find((entry) => entry.stage === spec.development_stage);
      if (!member) throw AppError.validation("Agent Team task has no stage owner");
      assignee = member.agent_instance_id;
    }
    await assignTask(ctx, ready.id, { mode: "manual", agent_instance_id: assignee }, undefined,
      { version: 1, request_id: ctx.idGen.generate("verify"), profile_id: row.verificationProfileId });
    await update(ctx, tx, row, { status: "executing", lastError: null }); return;
  }
  for (const task of runnable.filter((item) => item.status === "backlog")) {
    // markReady is the authoritative dependency/evidence gate. Select the first root/unlocked node.
    const edges = await listDependencies(ctx, task.id);
    if (edges.some((edge) => edge.type !== "soft_context" && !planTasks.some((item) => item.id === edge.from_task_id && item.status === "done"))) continue;
    await markReady(ctx, task.id);
    await update(ctx, tx, row, { status: "executing", lastError: null }); return;
  }
  await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for required dependencies or approvals." });
}

/** One DB-locked step per goal. Recreating or running two dispatchers cannot duplicate committed actions. */
export function createGoalAutomationDispatcher(ctx: ServerContext, stopProcess: StopProcess, onError: (error: unknown) => void = () => {}) {
  let inFlight: Promise<void> | undefined, timer: ReturnType<typeof setInterval> | undefined, stopped = false;
  let receiptCursor: string | undefined;
  type PendingReceipt = { family: ImportedSourceReceiptFamily; id: string; computerId: string; sessionId: string | null; feature: string };
  async function repairReceiptMarkers(candidates: PendingReceipt[]) {
    if (!ctx.redeliverImportedSourceReceipt) return;
    // Delivery debt is independent of goal status and process closure. Use the
    // existing single pump, with no new timer, execution capacity or start grant.
    const key = (item: PendingReceipt) => `${item.family}:${item.id}`;
    candidates.sort((left, right) => key(left).localeCompare(key(right)));
    const after = receiptCursor === undefined ? 0 : candidates.findIndex(item => key(item).localeCompare(receiptCursor!) > 0);
    const start = after < 0 ? 0 : after, computers = new Set<string>();
    let attempts = 0;
    for (let offset = 0; offset < candidates.length && attempts < 8; offset++) {
      if (stopped) return;
      const item = candidates[(start + offset) % candidates.length]!;
      if (computers.has(item.computerId)) continue;
      const session = ctx.getPairedNodeSession?.(item.computerId);
      if (!session || session.computerId !== item.computerId || session.sessionId !== item.sessionId
        || ctx.supportsExecutionFeature?.(item.computerId, item.feature) !== true) continue;
      // Advance by the first attempted item. Using the last item can pin the
      // cursor when one computer has candidates on both sides of another node.
      if (attempts === 0) receiptCursor = key(item);
      computers.add(item.computerId); attempts++;
      // The snapshot only selects an ID. The current binding rechecks its full
      // credential/session/result provenance and awaits actual send + commit.
      try { await ctx.redeliverImportedSourceReceipt(item.computerId, item.family, item.id); }
      catch (error) { onError(error); }
    }
  }
  async function drain() {
    const pendingReceipts: PendingReceipt[] = [];
    const pendingReviews = await ctx.db.db.select({ goalId: autonomousReviews.goalId }).from(autonomousReviews)
      .where(and(eq(autonomousReviews.organizationId, ctx.organizationId), eq(autonomousReviews.status, "pending")));
    const pendingPublications = await ctx.db.db.select({ goalId: applicationPublications.goalId }).from(applicationPublications)
      .leftJoin(applicationPublicationSettlements, eq(applicationPublicationSettlements.publicationId, applicationPublications.id))
      .where(and(eq(applicationPublications.organizationId, ctx.organizationId), or(inArray(applicationPublications.status, ["queued", "published"]),
        and(eq(applicationPublications.status, "failed"), sql`${applicationPublications.receipt}->'cleanup'->>'state' = 'unconfirmed'`)),
        isNull(applicationPublicationSettlements.publicationId)));
    pendingReviews.push(...pendingPublications);
    const importedReviews = await ctx.db.db.select({ goalId: goalImportedProductReviews.goalId, result: goalImportedProductReviews.result }).from(goalImportedProductReviews)
      .where(eq(goalImportedProductReviews.organizationId, ctx.organizationId));
    pendingReviews.push(...importedReviews.filter(row => ImportedProductReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const sourceOperations = await ctx.db.db.select({ goalId: goalProductHandoffs.goalId, result: goalProductHandoffOperations.result }).from(goalProductHandoffOperations)
      .innerJoin(goalProductHandoffs, eq(goalProductHandoffs.id, goalProductHandoffOperations.handoffId)).where(eq(goalProductHandoffs.organizationId, ctx.organizationId));
    pendingReviews.push(...sourceOperations.filter(row => ProductSourceOperationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const designSnapshot = await ctx.db.db.select({ operation: goalImportedDesignContinuations, completion: goalImportedDesignCompletions }).from(goalImportedDesignContinuations)
      .leftJoin(goalImportedDesignCompletions, eq(goalImportedDesignCompletions.continuationId, goalImportedDesignContinuations.id))
      .where(eq(goalImportedDesignContinuations.organizationId, ctx.organizationId));
    const designs = designSnapshot.map(item => item.operation);
    for (const { operation: row, completion } of designSnapshot) {
      const result = ImportedDesignContinuationResultV1Schema.safeParse(row.result).data;
      if (result?.outcome === "finished" && result.verified_design && completion && completion.receiptSentAt === null)
        pendingReceipts.push({ family: "design", id: row.id, computerId: row.computerId, sessionId: completion.sessionId, feature: IMPORTED_DESIGN_CONTINUATION_FEATURE_V1 });
    }
    pendingReviews.push(...designs.filter(row => ImportedDesignContinuationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const designReviewSnapshot = await ctx.db.db.select({ operation: goalImportedDesignReviews, receipt: goalImportedDesignReviewReceipts }).from(goalImportedDesignReviews)
      .leftJoin(goalImportedDesignReviewReceipts, eq(goalImportedDesignReviewReceipts.reviewId, goalImportedDesignReviews.id))
      .where(eq(goalImportedDesignReviews.organizationId, ctx.organizationId));
    const designReviews = designReviewSnapshot.map(item => item.operation);
    for (const { operation: row, receipt } of designReviewSnapshot) {
      const result = ImportedDesignReviewResultV1Schema.safeParse(row.result).data;
      if (result?.outcome === "reviewed" && result.verdict.outcome === "accepted" && !receipt)
        pendingReceipts.push({ family: "design-review", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_DESIGN_REVIEW_FEATURE_V1 });
    }
    pendingReviews.push(...designReviews.filter(row => ImportedDesignReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const executionSnapshot = await ctx.db.db.select({ operation: goalImportedExecutions, completion: goalImportedExecutionCompletions, receipt: goalImportedExecutionReceipts }).from(goalImportedExecutions)
      .leftJoin(goalImportedExecutionCompletions, eq(goalImportedExecutionCompletions.executionId, goalImportedExecutions.id))
      .leftJoin(goalImportedExecutionReceipts, eq(goalImportedExecutionReceipts.executionId, goalImportedExecutions.id))
      .where(eq(goalImportedExecutions.organizationId, ctx.organizationId));
    const importedExecutions = executionSnapshot.map(item => item.operation);
    for (const { operation: row, completion, receipt } of executionSnapshot) {
      const result = ImportedExecutionResultV1Schema.safeParse(row.result).data;
      if (result?.outcome === "finished" && result.verified_execution && completion && !receipt)
        pendingReceipts.push({ family: "execution", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_EXECUTION_FEATURE_V1 });
    }
    pendingReviews.push(...importedExecutions.filter(row => ImportedExecutionResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const executionReviewSnapshot = await ctx.db.db.select({ operation: goalImportedExecutionReviews, receipt: goalImportedExecutionReviewReceipts }).from(goalImportedExecutionReviews)
      .leftJoin(goalImportedExecutionReviewReceipts, eq(goalImportedExecutionReviewReceipts.reviewId, goalImportedExecutionReviews.id))
      .where(eq(goalImportedExecutionReviews.organizationId, ctx.organizationId));
    const executionReviews = executionReviewSnapshot.map(item => item.operation);
    for (const { operation: row, receipt } of executionReviewSnapshot) {
      const result = ImportedExecutionReviewResultV1Schema.safeParse(row.result).data;
      if (result?.outcome === "reviewed" && !receipt)
        pendingReceipts.push({ family: "execution-review", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1 });
    }
    const repairSnapshot = await ctx.db.db.select({ operation: goalImportedExecutionRepairs, completion: goalImportedExecutionRepairCompletions, receipt: goalImportedExecutionRepairReceipts }).from(goalImportedExecutionRepairs)
      .leftJoin(goalImportedExecutionRepairCompletions, eq(goalImportedExecutionRepairCompletions.repairId, goalImportedExecutionRepairs.id))
      .leftJoin(goalImportedExecutionRepairReceipts, eq(goalImportedExecutionRepairReceipts.repairId, goalImportedExecutionRepairs.id))
      .where(eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId));
    const executionRepairs = repairSnapshot.map(item => item.operation);
    for (const { operation: row, completion, receipt } of repairSnapshot) {
      const result = ImportedExecutionRepairResultV1Schema.safeParse(row.result).data;
      if (result?.outcome === "finished" && result.verified_repair && completion && !receipt)
        pendingReceipts.push({ family: "execution-repair", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_EXECUTION_REVIEW_FEATURE_V1 });
    }
    pendingReviews.push(...executionReviews.filter(row => ImportedExecutionReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    pendingReviews.push(...executionRepairs.filter(row => ImportedExecutionRepairResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const validationSnapshot = await ctx.db.db.select({ operation: goalImportedValidations, completion: goalImportedValidationCompletions, receipt: goalImportedValidationReceipts }).from(goalImportedValidations)
      .leftJoin(goalImportedValidationCompletions, eq(goalImportedValidationCompletions.validationId, goalImportedValidations.id))
      .leftJoin(goalImportedValidationReceipts, eq(goalImportedValidationReceipts.validationId, goalImportedValidations.id))
      .where(eq(goalImportedValidations.organizationId, ctx.organizationId));
    const validations = validationSnapshot.map(item => item.operation);
    for (const { operation: row, completion, receipt } of validationSnapshot) {
      const result = ImportedValidationResultV1Schema.safeParse(row.result).data;
      if ((result?.outcome === "finished" || result?.outcome === "failed" && result.closed_failure) && completion && !receipt)
        pendingReceipts.push({ family: "validation", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_VALIDATION_FEATURE_V1 });
    }
    const validationReviewSnapshot = await ctx.db.db.select({ operation: goalImportedValidationReviews, receipt: goalImportedValidationReviewReceipts }).from(goalImportedValidationReviews)
      .leftJoin(goalImportedValidationReviewReceipts, eq(goalImportedValidationReviewReceipts.reviewId, goalImportedValidationReviews.id))
      .where(eq(goalImportedValidationReviews.organizationId, ctx.organizationId));
    const validationReviews = validationReviewSnapshot.map(item => item.operation);
    for (const { operation: row, receipt } of validationReviewSnapshot) {
      const result = ImportedValidationReviewResultV1Schema.safeParse(row.result).data;
      if ((result?.outcome === "reviewed" || result?.outcome === "failed") && !receipt)
        pendingReceipts.push({ family: "validation-review", id: row.id, computerId: row.computerId, sessionId: row.resultSessionId, feature: IMPORTED_VALIDATION_FEATURE_V1 });
    }
    pendingReviews.push(...validations.filter(row => ImportedValidationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    pendingReviews.push(...validationReviews.filter(row => ImportedValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    await repairReceiptMarkers(pendingReceipts);
    if (stopped) return;
    const recovering = await ctx.db.db.select().from(goalSourceRecoveries).where(eq(goalSourceRecoveries.organizationId, ctx.organizationId));
    const recoveryAuthors = await ctx.db.db.select().from(goalRecoveryValidations).where(eq(goalRecoveryValidations.organizationId, ctx.organizationId));
    const recoveryReviews = await ctx.db.db.select().from(goalRecoveryValidationReviews).where(eq(goalRecoveryValidationReviews.organizationId, ctx.organizationId));
    pendingReviews.push(...recovering.filter(row => row.result === null).map(row => ({ goalId: row.goalId })));
    pendingReviews.push(...recoveryAuthors.filter(row => ImportedRecoveryValidationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    pendingReviews.push(...recoveryReviews.filter(row => ImportedRecoveryValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const cleanAuthors = await ctx.db.db.select().from(goalCleanValidations).where(eq(goalCleanValidations.organizationId, ctx.organizationId));
    const cleanReviews = await ctx.db.db.select().from(goalCleanValidationReviews).where(eq(goalCleanValidationReviews.organizationId, ctx.organizationId));
    pendingReviews.push(...cleanAuthors.filter(row => ImportedCleanValidationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    pendingReviews.push(...cleanReviews.filter(row => ImportedCleanValidationReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const rows = await ctx.db.db.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
      or(inArray(goalAutomations.status, ACTIVE), pendingReviews.length ? inArray(goalAutomations.goalId, pendingReviews.map((review) => review.goalId)) : undefined)));
    for (const snapshot of rows) {
      if (stopped) return;
      const queued: string[] = [];
      const importedQueued: ImportedReviewDispatch[] = [];
      const sourceQueued: SourceOperationDispatch[] = [];
      const designQueued: ImportedReviewDispatch[] = [];
      const designReviewQueued: ImportedReviewDispatch[] = [];
      const importedExecutionQueued: ImportedReviewDispatch[] = [];
      const executionReviewQueued: ImportedReviewDispatch[] = [], executionRepairQueued: ImportedReviewDispatch[] = [];
      const validationQueued: ImportedReviewDispatch[] = [], validationReviewQueued: ImportedReviewDispatch[] = [];
      const recoveryQueues: RecoveryDispatchQueues = { recoveries: [], validations: [], reviews: [] };
      const cleanQueues: CleanDispatchQueues = { validations: [], reviews: [] };
      const actor: ServerContext = { ...ctx, actorUserId: snapshot.actorUserId, automationActor: { type: "system", id: "goal_runner" } };
      try {
        await ctx.db.transaction(async (tx) => {
          const [row] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, snapshot.goalId), inArray(goalAutomations.status, ACTIVE))).for("update", { skipLocked: true });
          if (row) await advance(transactionContext(actor, tx, queued, importedQueued, sourceQueued, designQueued, designReviewQueued, importedExecutionQueued, executionReviewQueued, executionRepairQueued, validationQueued, validationReviewQueued, recoveryQueues, cleanQueues), tx, row, queued);
        });
        for (const id of new Set(queued)) await ctx.onRunQueued?.(id);
        for (const item of new Map(sourceQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onProductSourceOperationQueued?.(item.id, item.control);
        for (const item of new Map(importedQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedProductReviewQueued?.(item.id, item.control);
        for (const item of new Map(designQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedDesignContinuationQueued?.(item.id, item.control);
        for (const item of new Map(designReviewQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedDesignReviewQueued?.(item.id, item.control);
        for (const item of new Map(importedExecutionQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedExecutionQueued?.(item.id, item.control);
        for (const item of new Map(executionReviewQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedExecutionReviewQueued?.(item.id, item.control);
        for (const item of new Map(executionRepairQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedExecutionRepairQueued?.(item.id, item.control);
        for (const item of new Map(validationQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedValidationQueued?.(item.id, item.control);
        for (const item of new Map(validationReviewQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedValidationReviewQueued?.(item.id, item.control);
        for (const item of new Map(cleanQueues.validations.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onCleanValidationQueued?.(item.id, item.control);
        for (const item of new Map(cleanQueues.reviews.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onCleanValidationReviewQueued?.(item.id, item.control);
        for (const item of new Map(recoveryQueues.recoveries.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onSourceRecoveryQueued?.(item.id, item.control);
        for (const item of new Map(recoveryQueues.validations.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onRecoveryValidationQueued?.(item.id, item.control);
        for (const item of new Map(recoveryQueues.reviews.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onRecoveryValidationReviewQueued?.(item.id, item.control);
      } catch (error) {
        onError(error);
        await ctx.db.transaction(async (tx) => {
          const [row] = await tx.select().from(goalAutomations).where(eq(goalAutomations.goalId, snapshot.goalId)).for("update");
          if (!row || !ACTIVE.includes(row.status)) return;
          const [goal] = await tx.select().from(goals).where(eq(goals.id, row.goalId));
          const budgets = GoalBudgetsSchema.parse(goal?.budgets ?? {});
          const fatal = error instanceof AppError && (error.code === "permission_denied" || error.code === "validation_error"
            || (error.details?.budget === "max_retries" && budgets.max_retries !== null));
          await update(actor, tx, row, { status: fatal ? "failed" : "waiting", lastError: error instanceof Error ? error.message : "Automation failed" });
        });
        if (error instanceof AppError && ["permission_denied", "ai_consent_required", "ai_sharing_unconfigured"].includes(error.code)) {
          try { await cancelGoalApplicationPublication(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
          // Withdrawal also stops a dedicated H5 whose ordinary run already ended but whose closure remains uncertain.
          try { await stopGoalImportedExecutions(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
          try { await stopGoalImportedExecutionReviews(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
          try { await stopGoalImportedExecutionRepairs(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalImportedValidations(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalImportedValidationReviews(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalSourceRecoveries(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalRecoveryValidations(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalRecoveryValidationReviews(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalCleanValidations(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        try { await stopGoalCleanValidationReviews(actor, snapshot.goalId); } catch (stopError) { onError(stopError); }
        }
      }
      const latest = (await ctx.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, snapshot.goalId)))[0];
      const goal = await getGoal(actor, snapshot.goalId);
      if (latest?.appPublication != null) {
        // Dispatch after commit. A restart can redeliver the immutable intent, but only its original node session may act.
        try {
          if (goal?.status !== "running" || !ACTIVE.includes(latest.status)) {
            if (goal?.status !== "completed") await cancelGoalApplicationPublication(actor, snapshot.goalId);
          } else {
            const [publication] = await ctx.db.db.select().from(applicationPublications).where(and(
              eq(applicationPublications.goalId, snapshot.goalId), eq(applicationPublications.organizationId, ctx.organizationId)));
            if (publication?.status === "queued" || publication?.status === "published")
              await ctx.onApplicationPublicationQueued?.(publication.id, publication.status === "queued" ? "start" : "status");
          }
        } catch (error) { onError(error); }
      }
      if (latest?.discussionId && (goal?.status === "cancelled" || latest.status === "failed" || latest.status === "cancelled")) {
        try { await cancelDiscussion(actor, latest.discussionId, stopProcess); } catch (error) { onError(error); }
      }
      if (latest && (goal?.status === "cancelled" || latest.status === "failed" || latest.status === "cancelled")) {
        try { await stopIndependentReviews(actor, snapshot.goalId, stopProcess); } catch (error) { onError(error); }
        try { await stopGoalImportedDesignReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedExecutions(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedExecutionReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedExecutionRepairs(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalSourceRecoveries(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalRecoveryValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalRecoveryValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalCleanValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalCleanValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalProductHandoffs(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedProductReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedDesignContinuations(actor, snapshot.goalId); } catch (error) { onError(error); }
      }
      if (latest && (goal?.status === "paused" || goal?.status === "archived")) {
        try { await stopGoalImportedExecutions(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedExecutionReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedExecutionRepairs(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalSourceRecoveries(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalRecoveryValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalRecoveryValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalCleanValidations(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalCleanValidationReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedDesignReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalProductHandoffs(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedProductReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedDesignContinuations(actor, snapshot.goalId); } catch (error) { onError(error); }
      }
    }
  }
  const pump = () => stopped ? Promise.resolve() : inFlight ??= drain().finally(() => { inFlight = undefined; });
  return { pump, start() { stopped = false; timer ??= setInterval(() => { void pump().catch(onError); }, 1500); timer.unref(); void pump().catch(onError); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await inFlight; } };
}
