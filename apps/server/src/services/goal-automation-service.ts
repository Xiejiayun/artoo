import { agentInstances, appendEvent, artifacts, assistantTurns, autonomousReviews, computers, discussions, eventLog, goalAutomations, goals, messages, plans, runs, tasks } from "@artoo/db";
import { AutonomousTeamSchema, canTransitionTask, CreateAutonomousGoalRequestSchema, GoalAutomationSchema, GoalBudgetsSchema, TaskSpecSchema, validateProductDevelopmentPlan,
  type AutonomousTeam, type CreateAutonomousGoalRequest, type GoalAutomation, type TaskStatus } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, desc, eq, inArray, notInArray, or } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
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
import { goalImportedDesignContinuations } from "@artoo/db";
import { ImportedDesignContinuationResultV1Schema } from "@artoo/domain";
import { ensureGoalImportedDesignContinuation, stopGoalImportedDesignContinuations } from "./imported-design-continuation-service.js";

type AutomationRow = typeof goalAutomations.$inferSelect;
type StopProcess = (ctx: ServerContext, runId: string) => Promise<void>;
const ACTIVE = ["planning", "executing", "waiting"];

export function mapGoalAutomation(row: AutomationRow): GoalAutomation {
  return GoalAutomationSchema.parse({ goal_id: row.goalId, organization_id: row.organizationId,
    actor_user_id: row.actorUserId, consent_id: row.consentId, policy_version: row.policyVersion,
    status: row.status, discussion_id: row.discussionId, plan_id: row.planId, agent_instance_id: row.agentInstanceId,
    computer_id: row.computerId, workspace_root: row.workspaceRoot,
    planning_capability_snapshot: row.planningCapabilitySnapshot,
    verification_profile_id: row.verificationProfileId, execution_mode: row.executionMode, team: row.team, release_profile_id: row.releaseProfileId, last_error: row.lastError,
    delivery: row.status === "completed" && row.releaseProfileId ? "published_product" : "verified_workspace",
    created_at: row.createdAt, updated_at: row.updatedAt });
}

/** Reuse service transactions inside this one atomic orchestration step. Node IO is deferred until commit. */
type ImportedReviewDispatch = { id: string; control: "start" | "stop" | "status" };
type SourceOperationDispatch = { id: string; control: "start" | "stop" | "status" | "qualify" };
function transactionContext(ctx: ServerContext, tx: DrizzleDb, queued: string[] = [], importedReviews: ImportedReviewDispatch[] = [], sourceOperations: SourceOperationDispatch[] = [], designs: ImportedReviewDispatch[] = []): ServerContext {
  return { ...ctx, db: { db: tx, transaction: (fn) => fn(tx),
    migrate: () => Promise.reject(new Error("Migrations cannot run inside an orchestration transaction")),
    healthCheck: () => ctx.db.healthCheck(), close: () => Promise.reject(new Error("Cannot close an orchestration transaction")) },
    onRunQueued: async (id) => { queued.push(id); },
    onImportedProductReviewQueued: async (id, control) => { importedReviews.push({ id, control }); },
    onProductSourceOperationQueued: async (id, control) => { sourceOperations.push({ id, control }); },
    onImportedDesignContinuationQueued: async (id, control) => { designs.push({ id, control }); } };
}

async function update(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, patch: Partial<typeof goalAutomations.$inferInsert>) {
  if (Object.entries(patch).every(([key, value]) => row[key as keyof AutomationRow] === value)) return row;
  const [next] = await tx.update(goalAutomations).set({ ...patch, updatedAt: ctx.clock.nowIso() })
    .where(and(eq(goalAutomations.goalId, row.goalId), eq(goalAutomations.organizationId, ctx.organizationId))).returning();
  const [goal] = await tx.select({ projectId: goals.projectId, roomId: goals.roomId }).from(goals).where(eq(goals.id, row.goalId));
  await appendEvent(tx, buildEvent(ctx, { type: "goal.automation.updated", actorType: "system", actorId: "goal_runner",
    correlationId: row.goalId, goalId: row.goalId, projectId: goal?.projectId, roomId: goal?.roomId,
    payload: { status: next!.status, delivery: next!.status === "completed" && next!.releaseProfileId ? "published_product" : "verified_workspace", last_error: next!.lastError } }));
  return next!;
}

export async function createAutonomousGoal(ctx: ServerContext, request: CreateAutonomousGoalRequest) {
  const input = CreateAutonomousGoalRequestSchema.parse(request);
  return ctx.db.transaction(async (tx) => {
    const sharing = await requireAiSharingAuthorization(ctx, tx);
    await requireContentAllowed(ctx, input.objective, tx);
    const atomic = transactionContext(ctx, tx);
    const goal = await createGoal(atomic, { project_id: input.project_id, title: input.objective.slice(0, 80), objective: input.objective,
      acceptance_criteria: [input.objective, "The configured node verification profile passes against the delivered workspace."],
      budgets: { max_elapsed_ms: (input.execution_mode === "agent_team" ? 8 : 1) * 60 * 60 * 1000, max_retries: input.max_retries, max_concurrent_runs: 1 },
    });
    const [row] = await tx.insert(goalAutomations).values({ goalId: goal.id, organizationId: ctx.organizationId,
      actorUserId: ctx.actorUserId, consentId: sharing.consentId, policyVersion: sharing.policyVersion,
      status: "planning", verificationProfileId: input.verification_profile_id, executionMode: input.execution_mode ?? "single_agent", releaseProfileId: input.release_profile_id ?? null,
      createdAt: ctx.clock.nowIso(), updatedAt: ctx.clock.nowIso(),
    }).returning();
    return { goal, automation: mapGoalAutomation(row!) };
  });
}

export async function getGoalAutomation(ctx: ServerContext, goalId: string): Promise<GoalAutomation | null> {
  if (!await getGoal(ctx, goalId)) throw AppError.notFound("Goal not found");
  const [row] = await ctx.db.db.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  return row ? mapGoalAutomation(row) : null;
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
  // Reload after the goal fence: a concurrent planner may have committed its link before pause acquired the goal lock.
  const current = await getGoalAutomation(ctx, goalId);
  await stopIndependentReviews(ctx, goalId, stopProcess);
  await stopGoalProductHandoffs({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedProductReviews({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  await stopGoalImportedDesignContinuations({ ...ctx, actorUserId: automation.actor_user_id, automationActor: { type: "system", id: "goal_runner" } }, goalId);
  if (!current?.discussion_id) return;
  const discussion = await cancelDiscussion(ctx, current.discussion_id, stopProcess);
  if (discussion.status === "stopping") throw AppError.conflict("Goal paused: planning process stop has not been confirmed");
}

async function advance(ctx: ServerContext, tx: DrizzleDb, row: AutomationRow, queued: string[]): Promise<void> {
  const [goal] = await tx.select().from(goals).where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) return;
  if (["cancelled", "archived"].includes(goal.status)) { await update(ctx, tx, row, { status: "cancelled", lastError: null }); return; }
  if (goal.status === "completed") {
    await assertRecordedGoalReleaseCompletion(ctx, tx, row);
    await update(ctx, tx, row, { status: "completed", lastError: null }); return;
  }
  if (["paused", "awaiting_approval"].includes(goal.status)) { await update(ctx, tx, row, { status: "waiting", lastError: `Goal is ${goal.status}; no new work will start.` }); return; }
  await requireAiSharingAuthorization(ctx, tx, { consentId: row.consentId, policyVersion: row.policyVersion });
  if (row.planId && goal.currentPlanId !== row.planId) {
    await update(ctx, tx, row, { status: "failed", lastError: "The accepted plan changed; automatic execution stopped." }); return;
  }
  if (!row.discussionId) {
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
  const standalone = await unsettledStandaloneExecutions(ctx, tx, { goalId: goal.id });
  if (standalone.length) {
    for (const operation of standalone) {
      const control = operation.stopRequested ? "stop" : operation.result === null ? "start" : "status";
      if (operation.kind === "design") {
        const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, operation.runId));
        await ctx.onImportedDesignContinuationQueued?.(operation.id, control === "start" && run?.status !== "queued" ? "status" : control);
      } else if (operation.kind === "review") await ctx.onImportedProductReviewQueued?.(operation.id, control);
      else await ctx.onProductSourceOperationQueued?.(operation.id, control);
    }
    await update(ctx, tx, row, { status: "waiting", lastError: "Waiting for source transfer or imported research review and confirmed closure; no new stage can start." }); return;
  }
  // Initial H3 owns exactly one imported design execution. Its terminal result cannot
  // reuse the original source computer's ordinary independent-review/workspace binding.
  const [design] = await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.goalId, goal.id), eq(goalImportedDesignContinuations.organizationId, ctx.organizationId)));
  if (design) {
    const outcome = ImportedDesignContinuationResultV1Schema.safeParse(design.result).data;
    const [run] = await tx.select().from(runs).where(eq(runs.id, design.runId));
    const verification = run?.status === "completed" ? await inspectRunVerification(ctx, tx, run) : undefined;
    const reason = outcome?.outcome === "finished" && verification?.passed
      ? "Imported design is verified; independent destination design review is required before any subsequent stage."
      : `Imported design requires reconciliation before continuation: ${verification?.reason ?? outcome?.outcome ?? "execution closure pending"}`;
    await update(ctx, tx, row, { status: "waiting", lastError: reason }); return;
  }
  if (row.releaseProfileId && planTasks.every((task) => task.status === "done")) {
    const release = await ensureGoalProductRelease(ctx, tx, row);
    if (release.status === "succeeded") {
      // Receipt lookup can race a user pause/cancel. Fence the actual completion,
      // just as ordinary task acceptance does, before changing either status.
      const [current] = await tx.select().from(goals).where(and(eq(goals.id, goal.id), eq(goals.organizationId, ctx.organizationId))).for("update");
      if (!current || current.status !== "running" || current.currentPlanId !== row.planId) {
        throw AppError.conflict("Goal was paused, stopped or replanned before publication completion");
      }
      await tx.update(goals).set({ status: "completed", updatedAt: ctx.clock.nowIso() }).where(and(eq(goals.id, goal.id), eq(goals.status, "running")));
      await appendEvent(tx, buildEvent(ctx, { type: "goal.completed", actorType: "system", actorId: "goal_runner", correlationId: goal.id,
        projectId: goal.projectId, goalId: goal.id, roomId: goal.roomId, payload: { goal_id: goal.id, trigger: "product_release_healthy", endpoint: release.endpoint ?? null,
          ...(release.settlement ? { settlement: release.settlement } : {}) } }));
    }
    await update(ctx, tx, row, { status: release.status === "succeeded" ? "completed" : release.status === "failed" ? "failed" : "executing", lastError: release.reason ?? null });
    return;
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
  const runnable = revision?.state === "active" ? planTasks.filter(task => task.id === revision.designTaskId) : planTasks;
  const review = runnable.find((task) => task.status === "review");
  if (review) {
    const run = (await tx.select().from(runs).where(and(eq(runs.taskId, review.id), eq(runs.organizationId, ctx.organizationId))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0];
    const result = run?.status === "completed" ? await inspectRunVerification(ctx, tx, run) : { passed: false, reason: "Latest execution did not complete successfully" };
    const [plan] = await tx.select().from(plans).where(eq(plans.id, row.planId));
    const spec = TaskSpecSchema.parse((plan?.taskSpecs as unknown[] | undefined)?.[Number(review.sourcePlanSpecRef)]);
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
    const imported = await advanceGoalImportedProductReview(ctx, tx, row, ready.id);
    if (imported) {
      if ("state" in imported && imported.state === "accepted_waiting_writer_authority") {
        const continuation = await ensureGoalImportedDesignContinuation(ctx, tx, row, imported.review_id);
        if (continuation.result === null && !continuation.stopRequested) await ctx.onImportedDesignContinuationQueued?.(continuation.id, "start");
        await update(ctx, tx, row, { status: "executing", lastError: "Imported research accepted; its single-use destination design execution is queued." });
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
      const spec = TaskSpecSchema.parse((source?.taskSpecs as unknown[] | undefined)?.[Number(ready.sourcePlanSpecRef)]);
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
  async function drain() {
    const pendingReviews = await ctx.db.db.select({ goalId: autonomousReviews.goalId }).from(autonomousReviews)
      .where(and(eq(autonomousReviews.organizationId, ctx.organizationId), eq(autonomousReviews.status, "pending")));
    const importedReviews = await ctx.db.db.select({ goalId: goalImportedProductReviews.goalId, result: goalImportedProductReviews.result }).from(goalImportedProductReviews)
      .where(eq(goalImportedProductReviews.organizationId, ctx.organizationId));
    pendingReviews.push(...importedReviews.filter(row => ImportedProductReviewResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const sourceOperations = await ctx.db.db.select({ goalId: goalProductHandoffs.goalId, result: goalProductHandoffOperations.result }).from(goalProductHandoffOperations)
      .innerJoin(goalProductHandoffs, eq(goalProductHandoffs.id, goalProductHandoffOperations.handoffId)).where(eq(goalProductHandoffs.organizationId, ctx.organizationId));
    pendingReviews.push(...sourceOperations.filter(row => ProductSourceOperationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const designs = await ctx.db.db.select().from(goalImportedDesignContinuations).where(eq(goalImportedDesignContinuations.organizationId, ctx.organizationId));
    pendingReviews.push(...designs.filter(row => ImportedDesignContinuationResultV1Schema.safeParse(row.result).data?.closed !== true).map(row => ({ goalId: row.goalId })));
    const rows = await ctx.db.db.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
      or(inArray(goalAutomations.status, ACTIVE), pendingReviews.length ? inArray(goalAutomations.goalId, pendingReviews.map((review) => review.goalId)) : undefined)));
    for (const snapshot of rows) {
      if (stopped) return;
      const queued: string[] = [];
      const importedQueued: ImportedReviewDispatch[] = [];
      const sourceQueued: SourceOperationDispatch[] = [];
      const designQueued: ImportedReviewDispatch[] = [];
      const actor: ServerContext = { ...ctx, actorUserId: snapshot.actorUserId, automationActor: { type: "system", id: "goal_runner" } };
      try {
        await ctx.db.transaction(async (tx) => {
          const [row] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, snapshot.goalId), inArray(goalAutomations.status, ACTIVE))).for("update", { skipLocked: true });
          if (row) await advance(transactionContext(actor, tx, queued, importedQueued, sourceQueued, designQueued), tx, row, queued);
        });
        for (const id of new Set(queued)) await ctx.onRunQueued?.(id);
        for (const item of new Map(sourceQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onProductSourceOperationQueued?.(item.id, item.control);
        for (const item of new Map(importedQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedProductReviewQueued?.(item.id, item.control);
        for (const item of new Map(designQueued.map(item => [`${item.id}:${item.control}`, item])).values()) await ctx.onImportedDesignContinuationQueued?.(item.id, item.control);
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
      }
      const latest = (await ctx.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, snapshot.goalId)))[0];
      const goal = await getGoal(actor, snapshot.goalId);
      if (latest?.discussionId && (goal?.status === "cancelled" || latest.status === "failed" || latest.status === "cancelled")) {
        try { await cancelDiscussion(actor, latest.discussionId, stopProcess); } catch (error) { onError(error); }
      }
      if (latest && (goal?.status === "cancelled" || latest.status === "failed" || latest.status === "cancelled")) {
        try { await stopIndependentReviews(actor, snapshot.goalId, stopProcess); } catch (error) { onError(error); }
        try { await stopGoalProductHandoffs(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedProductReviews(actor, snapshot.goalId); } catch (error) { onError(error); }
        try { await stopGoalImportedDesignContinuations(actor, snapshot.goalId); } catch (error) { onError(error); }
      }
      if (latest && (goal?.status === "paused" || goal?.status === "archived")) {
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
