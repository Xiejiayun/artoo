import { assertSourceLineageDispatch } from "./source-lineage-fence.js";
import { assertResearchDestinationUnreserved } from "./research-destination-pool-service.js";
import { resolveResearchRevisionOrigin } from "./research-revision-origin-service.js";
import { currentImportedDesignBoundary } from "./execution-state.js";
import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import {
  agentInstances,
  appendEvent,
  artifacts,
  assistantRunDispatches,
  assistantTurns,
  autonomousReviews,
  computers,
  contextPacks,
  discussions,
  goals,
  goalAutomations,
  plans,
  runs,
  schedulerDecisions,
  taskDependencies,
  tasks,
} from "@artoo/db";
import {
  canTransitionTask,
  type DagEdge,
  ID_PREFIXES,
  applyGoalTransition,
  type AssignRequest,
  type Capability,
  type ReviewRequest,
  type Run,
  type Task,
  type TaskStatus,
  type WorkspaceAllocationRecord,
  TaskSpecSchema,
  AutonomousTeamSchema,
  type VerificationRequirement,
  AssignRequestSchema, ContextPackSchema, canonicalOwnedResultAuthorContextV1,
  type NodeOwnedResultProfileDescriptorV1,
  APPLICATION_VERIFICATION_FEATURE_V1,
} from "@artoo/domain";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DrizzleDb } from "@artoo/storage";
import { allocateWorkspaceRoot, validateWorktreeBaseConfiguration, WorkspaceAllocationError } from "@artoo/protocol";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun, mapTask } from "../mappers.js";
import * as dagService from "./dag-service.js";
import * as contextPackService from "./context-pack-service.js";
import * as leaseService from "./lease-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";
import { scheduleTask } from "./scheduler.js";
import { assertFreshTaskBaseVersion } from "./sync-service.js";
import { transitionTask } from "./transition-service.js";
import { supportedGoalPolicy } from "./budget-policy.js";
import { assertExecutionApprovalGranted, bindExecutionApprovalToRun } from "./approval-service.js";
import { unsettledGoalExecutionCount, unsettledStandaloneExecutions } from "./execution-state.js";
import { goalImportedDesignContinuations } from "@artoo/db";
import { assertSupportedPlanTaskControls } from "./plan-policy.js";
import { assertInheritedApprovalRequired, inheritedWritePaths, resolveExecutionPolicyTask } from "./task-execution-policy.js";
import { inspectRunVerification, readRunVerificationEvidence } from "./verification-service.js";
import { assertDesignRevisionAssignment, assertDesignRevisionRunAdmission, bindDesignRevisionRun,
  prepareDesignRevisionAcceptance, settleDesignRevisionAcceptance, type DesignRevision } from "./product-design-revision-guard.js";
import { automationWorkspacesOverlap, canonicalAutomationWorkspace, resolveAutomationWorkspace } from "./automation-workspace.js";
import { inspectIndependentReview } from "./independent-review-service.js";
import { assertPlanningTargetAvailable, assertSelectedPlanningCapabilities, recheckPlanningSnapshot } from "./planning-capabilities.js";
import { AssignOwnedResultRequestSchema, sealOwnedResultAssignment, resolveAcceptedOwnedResultInput,
  readReviewableOwnedResultEvidence, ownedResultReview, type AssignOwnedResultRequest, type OwnedResultAssignment } from "./owned-result-service.js";

export type { VerificationRequirement } from "@artoo/domain";

async function automationForTask(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect) {
  if (!task.goalId) return undefined;
  return (await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, task.goalId), eq(goalAutomations.organizationId, ctx.organizationId))))[0];
}

/** Restored/older accepted plans must pass the same policy gate as new plans. */
async function assertTaskPlanControlsSupported(ctx: ServerContext, tx: DrizzleDb, task: typeof tasks.$inferSelect): Promise<void> {
  if (task.sourcePlanId === null) return;
  const plan = (await tx.select({ taskSpecs: plans.taskSpecs }).from(plans).where(and(
    eq(plans.id, task.sourcePlanId), eq(plans.organizationId, ctx.organizationId),
  )))[0];
  const index = Number(task.sourcePlanSpecRef);
  if (!plan || task.sourcePlanSpecRef === null || !Number.isInteger(index) || index < 0 || String(index) !== task.sourcePlanSpecRef || !Array.isArray(plan.taskSpecs)) {
    throw AppError.validation("Cannot verify the source plan's task controls", { source_plan_id: task.sourcePlanId });
  }
  const parsed = TaskSpecSchema.safeParse(plan.taskSpecs[index]);
  if (!parsed.success) throw AppError.validation("Cannot verify the source plan's task controls", { source_plan_id: task.sourcePlanId, spec_index: index });
  assertSupportedPlanTaskControls(parsed.data, index);
}

/** Lock the goal during scheduling/retry so pause/cancel creates a real fence. */
async function assertGoalAllowsExecution(ctx: ServerContext, tx: DrizzleDb, goalId: string | null, operation: "assign" | "retry", sourcePlanId: string | null): Promise<string[] | null> {
  if (!goalId) return null;
  const goal = (await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
  if (!goal) return null;
  if (sourcePlanId !== null && sourcePlanId !== goal.currentPlanId) {
    throw AppError.invalidState("This task belongs to a superseded plan; use the current plan's tasks", { goal_id: goalId, source_plan_id: sourcePlanId, current_plan_id: goal.currentPlanId });
  }
  if (["paused", "cancelled", "completed", "archived", "awaiting_approval"].includes(goal.status)) {
    throw AppError.invalidState(`goal is '${goal.status}'; resume the goal before assigning or retrying tasks`, { goal_id: goalId, status: goal.status });
  }
  if (await currentImportedDesignBoundary(ctx, tx, goalId, sourcePlanId)) throw AppError.conflict("Imported design requires dedicated H4 acceptance and separate H5 implementation authority");
  const { budgets } = supportedGoalPolicy(goal.budgets, goal.stopConditions);
  if (budgets.max_elapsed_ms !== null && goal.runningSince !== null) {
    const elapsed = Math.max(0, Date.parse(ctx.clock.nowIso()) - Date.parse(goal.runningSince));
    if (elapsed >= budgets.max_elapsed_ms) throw AppError.conflict("Goal elapsed time budget has been reached", { goal_id: goalId, budget: "max_elapsed_ms", limit: budgets.max_elapsed_ms, actual: elapsed });
  }
  const retries = goal.retryCount + (operation === "retry" ? 1 : 0);
  if (budgets.max_retries !== null && retries > budgets.max_retries) {
    throw AppError.conflict("Goal retry budget would be exceeded", { goal_id: goalId, budget: "max_retries", limit: budgets.max_retries, actual: retries });
  }
  if (operation === "assign" && budgets.max_concurrent_runs !== null) {
    const active = await unsettledGoalExecutionCount(ctx, tx, goalId);
    if (active >= budgets.max_concurrent_runs) throw AppError.conflict("Goal concurrent run limit has been reached", { goal_id: goalId, budget: "max_concurrent_runs", limit: budgets.max_concurrent_runs, actual: active + 1 });
  }
  return budgets.allowed_runtimes;
}

/**
 * POST /tasks/:id/ready — triage backlog -> ready. Requires non-empty
 * acceptance criteria and all upstream gating dependencies done (API contract).
 */
export async function markReady(ctx: ServerContext, taskId: string): Promise<Task> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
    }
    if ((row.acceptanceCriteria as string[]).length === 0) {
      throw AppError.validation("acceptance_criteria must be non-empty to mark a task ready");
    }
    const dependencyRows = await tx
      .select({
        fromTaskId: taskDependencies.fromTaskId,
        toTaskId: taskDependencies.toTaskId,
        type: taskDependencies.type,
        status: tasks.status,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.fromTaskId, tasks.id))
      .where(and(eq(taskDependencies.organizationId, ctx.organizationId), eq(taskDependencies.toTaskId, taskId)));
    const incoming: DagEdge[] = dependencyRows.map((dep) => ({
      from_task_id: dep.fromTaskId,
      to_task_id: dep.toTaskId,
      type: dep.type as DagEdge["type"],
    }));
    const statusById: Record<string, TaskStatus> = {};
    for (const dep of dependencyRows) {
      statusById[dep.fromTaskId] = dep.status as TaskStatus;
    }
    if (!(await dagService.isDependentSatisfied(ctx, tx, incoming, statusById))) {
      throw AppError.invalidState("upstream gating dependencies are not all satisfied");
    }
    const currentStatus = row.status as TaskStatus;
    if (!canTransitionTask(currentStatus, "triage")) {
      throw AppError.invalidState(`cannot mark ready from '${row.status}'`, { status: row.status });
    }

    await transitionTask(tx, ctx, {
      taskId,
      from: currentStatus,
      trigger: "triage",
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "task.updated",
          actorType: ctx.automationActor?.type ?? "user",
          actorId: ctx.automationActor?.id ?? ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { status: to },
        }),
      ],
    });

    const updated = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (updated === undefined) {
      throw new Error("markReady: task missing after transition");
    }
    return mapTask(updated);
  });
}

export interface AssignResult {
  run: Run;
  scheduler_decision: { id: string; reason: string; score: number };
}

/**
 * POST /tasks/:id/assign — schedule an idle instance and create a queued run.
 * The guarded transition (ready -> assigned) runs FIRST; if the row is no longer
 * `ready` it fails and we never create an orphan run/decision.
 */
export async function assignTask(
  ctx: ServerContext,
  taskId: string,
  req: AssignRequest,
  assistantTurnId?: string,
  verificationRequirement?: VerificationRequirement,
  ownedResultSelection?: AssignOwnedResultRequest,
): Promise<AssignResult> {
  const ownedSelection = ownedResultSelection === undefined ? undefined : AssignOwnedResultRequestSchema.parse(structuredClone(ownedResultSelection));
  if (ownedSelection) {
    req = AssignRequestSchema.parse(structuredClone(req));
    if (assistantTurnId || verificationRequirement || ctx.automationActor || req.mode !== "manual"
      || req.agent_instance_id !== ownedSelection.agent_instance_id || req.branch_backed !== true) {
      throw AppError.validation("Owned result execution requires an explicit plain manual allocation");
    }
  }
  const now = ctx.clock.nowIso();
  const result = await ctx.db.transaction(async (tx) => {
    let sharing = await requireAiSharingAuthorization(ctx, tx);
    const row = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
        .for("update")
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
    }
    if (row.status !== "ready") {
      throw AppError.invalidState(`task must be 'ready' to assign (is '${row.status}')`, {
        status: row.status,
      });
    }
    const [importedDesign] = await tx.select({ id: goalImportedDesignContinuations.id }).from(goalImportedDesignContinuations)
      .where(and(eq(goalImportedDesignContinuations.taskId, taskId), eq(goalImportedDesignContinuations.organizationId, ctx.organizationId)));
    if (importedDesign) throw AppError.permissionDenied("Imported design is bound to its dedicated single-use writer execution");
    const planning = (await tx.select({ id: discussions.id, goalId: discussions.goalId, activeTurnId: discussions.activeTurnId }).from(discussions)
      .where(and(eq(discussions.taskId, taskId), eq(discussions.organizationId, ctx.organizationId))))[0];
    const planningAutomation = planning ? (await tx.select().from(goalAutomations).where(and(
      eq(goalAutomations.goalId, planning.goalId), eq(goalAutomations.organizationId, ctx.organizationId))))[0] : undefined;
    const independentReview = (await tx.select().from(autonomousReviews).where(and(eq(autonomousReviews.reviewTaskId, taskId), eq(autonomousReviews.organizationId, ctx.organizationId))))[0];
    let reviewedResearchOrigin: Awaited<ReturnType<typeof resolveResearchRevisionOrigin>> = undefined;
    const reviewAutomation = independentReview ? (await tx.select().from(goalAutomations).where(eq(goalAutomations.goalId, independentReview.goalId)))[0] : undefined;
    if (independentReview) {
      const goal = (await tx.select().from(goals).where(eq(goals.id, independentReview.goalId)).for("update"))[0];
      const [subject] = await tx.select().from(runs).where(eq(runs.id, independentReview.subjectRunId));
      const [sourceTask] = await tx.select().from(tasks).where(eq(tasks.id, independentReview.taskId));
      const sourceOrigin = sourceTask ? await resolveResearchRevisionOrigin(ctx, tx, sourceTask) : undefined;
      reviewedResearchOrigin = sourceOrigin;
      if (!reviewAutomation || reviewAutomation.executionMode !== "agent_team" || !ctx.automationActor || ctx.actorUserId !== reviewAutomation.actorUserId
        || !goal || goal.status !== "running" || !["executing", "waiting"].includes(reviewAutomation.status) || goal.currentPlanId !== reviewAutomation.planId
        || sourceTask?.status !== "review" || (sourceOrigin?.plan.id ?? sourceTask.sourcePlanId) !== goal.currentPlanId || subject?.status !== "completed"
        || independentReview.status !== "pending" || assistantTurnId !== independentReview.turnId || req.mode !== "manual"
        || req.agent_instance_id !== independentReview.reviewerInstanceId || req.branch_backed || req.workspace_branch != null
        || verificationRequirement?.profile_id !== reviewAutomation.verificationProfileId || verificationRequirement?.expected_subject_digest !== independentReview.subjectDigest) {
        throw AppError.permissionDenied("Independent review must use its bound reviewer, source and verification request");
      }
      const measured = await inspectRunVerification(ctx, tx, subject);
      if (!measured.passed || measured.evidence?.id !== independentReview.evidenceId || measured.evidence.payload.subject_digest !== independentReview.subjectDigest) {
        throw AppError.conflict("Independent review source evidence changed");
      }
      await assertGoalAllowsExecution(ctx, tx, goal.id, "assign", goal.currentPlanId);
      await requireAiSharingAuthorization(ctx, tx, { consentId: reviewAutomation.consentId, policyVersion: reviewAutomation.policyVersion });
    }
    if (planning) {
      const goal = (await tx.select({ status: goals.status }).from(goals).where(and(eq(goals.id, planning.goalId),
        eq(goals.organizationId, ctx.organizationId), eq(goals.projectId, row.projectId))).for("share"))[0];
      if (!goal) throw AppError.conflict("Planning discussion does not belong to this task's project");
      if (planningAutomation) {
        if (goal.status !== "draft" || !["planning", "waiting"].includes(planningAutomation.status)
          || planningAutomation.discussionId !== planning.id || planning.activeTurnId !== assistantTurnId || verificationRequirement) {
          throw AppError.conflict("Autonomous planning is paused, changed or stopped");
        }
        await requireAiSharingAuthorization(ctx, tx, { consentId: planningAutomation.consentId, policyVersion: planningAutomation.policyVersion });
      }
    }
    if (assistantTurnId) {
      const turn = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, assistantTurnId),
        eq(assistantTurns.taskId, taskId), eq(assistantTurns.organizationId, ctx.organizationId))).for("update"))[0];
      if (!turn || !["queued", "waiting"].includes(turn.status) || turn.runId !== null) throw AppError.conflict("Assistant turn was cancelled, changed, or already dispatched");
      sharing = await requireAiSharingAuthorization(ctx, tx, { consentId: turn.aiDataSharingConsentId, policyVersion: turn.aiDataSharingPolicyVersion });
      const active = await tx.select({ id: assistantTurns.id }).from(assistantTurns).where(and(
        eq(assistantTurns.roomId, turn.roomId), turn.threadRootId ? eq(assistantTurns.threadRootId, turn.threadRootId) : isNull(assistantTurns.threadRootId), eq(assistantTurns.status, "running")));
      if (active.length) throw AppError.conflict("Another assistant turn is still running in this room");
    }
    const policyTask = await resolveExecutionPolicyTask(ctx, tx, row);
    const researchOrigin = await resolveResearchRevisionOrigin(ctx, tx, row);
    const executionPlanId = researchOrigin?.plan.id ?? row.sourcePlanId;
    const executionSpecRef = researchOrigin?.specRef ?? row.sourcePlanSpecRef;
    const automation = await automationForTask(ctx, tx, policyTask);
    if (ownedSelection && (automation || independentReview || planning)) {
      throw AppError.validation("Owned result v1 does not support product stages, independent review or planning");
    }
    if (automation) {
      let permittedInstance = automation.agentInstanceId;
      if (automation.executionMode === "agent_team") {
        const [plan] = await tx.select().from(plans).where(eq(plans.id, executionPlanId!));
        const spec = TaskSpecSchema.parse((plan?.taskSpecs as unknown[] | undefined)?.[Number(executionSpecRef)]);
        permittedInstance = AutonomousTeamSchema.parse(automation.team).members.find((member) => member.stage === spec.development_stage)?.agent_instance_id ?? null;
      }
      if (!ctx.automationActor || ctx.actorUserId !== automation.actorUserId || !verificationRequirement || assistantTurnId || automation.planId !== executionPlanId
        || !permittedInstance || req.mode !== "manual" || req.agent_instance_id !== permittedInstance || req.branch_backed || req.workspace_branch != null
        || verificationRequirement.profile_id !== automation.verificationProfileId || !["planning", "executing", "waiting"].includes(automation.status)) {
        throw AppError.permissionDenied("Autonomous goal execution must use its fixed worker and trusted verification request");
      }
      sharing = await requireAiSharingAuthorization(ctx, tx, { consentId: automation.consentId, policyVersion: automation.policyVersion });
    } else if (verificationRequirement && !independentReview) {
      throw AppError.permissionDenied("Verification requests are reserved for autonomous goal execution");
    }
    const allowedRuntimes = await assertGoalAllowsExecution(ctx, tx, policyTask.goalId, "assign", policyTask.sourcePlanId);
    if ((await unconfirmedDisconnectRunIds(ctx, tx, { taskId })).length > 0) {
      throw AppError.conflict("execution node has not confirmed the previous process stopped; reconnect it before assigning this task again");
    }
    await assertTaskPlanControlsSupported(ctx, tx, policyTask);
    await assertInheritedApprovalRequired(ctx, tx, row, policyTask);
    await assertExecutionApprovalGranted(ctx, tx, taskId);
    const writePaths = req.write_paths ?? (assistantTurnId || row.executionPolicyTaskId ? await inheritedWritePaths(ctx, tx, row, policyTask) : []);

    const scheduleOptions = {
      mode: req.mode,
      projectId: row.projectId,
      agentInstanceId: req.agent_instance_id ?? null,
      allowedRuntimes,
      branchBacked: req.workspace_branch != null || req.branch_backed === true,
    };
    const outcome = await scheduleTask(tx, ctx, row.requiredCapabilities as Capability[], scheduleOptions);

    // Share the administrator configuration fence. Only this selected instance
    // is locked; candidate revalidation must use a fresh post-wait query.
    const [instance] = await tx.select().from(agentInstances).where(and(
      eq(agentInstances.id, outcome.selected.agent_instance_id), eq(agentInstances.organizationId, ctx.organizationId),
    )).for("update");
    if (!instance) throw AppError.conflict("Selected agent instance is no longer available");
    const rechecked = await scheduleTask(tx, ctx, row.requiredCapabilities as Capability[], {
      ...scheduleOptions, mode: "manual", agentInstanceId: instance.id,
    });
    if (!isDeepStrictEqual(rechecked.selected, outcome.selected)) {
      throw AppError.conflict("Selected agent instance changed before assignment; retry the request");
    }
    const [computer] = await tx.select({ id: computers.id, os: computers.os }).from(computers).where(and(
      eq(computers.id, instance.computerId), eq(computers.organizationId, ctx.organizationId),
    )).for("update");
    if (!computer) throw AppError.conflict("Selected execution computer is no longer available");
    const revisionAdmission = researchOrigin ?? reviewedResearchOrigin;
    const revisionRole = researchOrigin?.snapshot.source.writer ?? reviewedResearchOrigin?.snapshot.source.reviewer;
    if (revisionAdmission && revisionRole && (instance.id !== revisionRole.instance_id || instance.agentId !== revisionRole.agent_id
      || instance.runtime !== revisionRole.runtime || instance.modelProfileId !== revisionRole.model_profile_id
      || instance.effortProfileId !== revisionRole.effort_profile_id || instance.computerId !== revisionAdmission.snapshot.source.computer_id
      || instance.workspaceRoot !== revisionAdmission.snapshot.source.workspace_root
      || ctx.supportsExecutionFeature?.(instance.computerId, "product-research-revision.v1") !== true
      || !isDeepStrictEqual(ctx.getReleaseCapabilities?.(instance.computerId, revisionAdmission.snapshot.source.release.binding.release_profile_id,
        row.projectId, instance.workspaceRoot, revisionAdmission.snapshot.source.release.binding.verification_profile_id), revisionAdmission.snapshot.source.release))) {
      throw AppError.conflict("Research revision must retain its original source contributor, model, effort and prepared scope");
    }
    let ownedProfile: NodeOwnedResultProfileDescriptorV1 | undefined;
    if (ownedSelection) {
      ownedProfile = ctx.getOwnedResultProfile?.(instance.computerId, ownedSelection.result_profile_id,
        ownedSelection.verifier_template_id, row.projectId);
      if (!ownedProfile || instance.runtime === "mock" || !["linux", "darwin"].includes(computer.os)
        || ownedProfile.node_id !== instance.computerId || ownedProfile.project_id !== row.projectId) {
        throw AppError.conflict("The selected node has no current qualified owned-result profile");
      }
    }
    const executionAutomation = automation ?? reviewAutomation;
    if (executionAutomation && (!instance.workspaceRoot || instance.runtime === "mock"
      || ctx.supportsExecutionFeature?.(instance.computerId, "run-verification.v1") !== true)) {
      throw AppError.conflict("The fixed worker does not support trusted workspace verification");
    }
    if (executionAutomation && (executionAutomation.computerId !== instance.computerId || !executionAutomation.workspaceRoot || !instance.workspaceRoot
      || canonicalAutomationWorkspace(executionAutomation.workspaceRoot, computer.os) !== canonicalAutomationWorkspace(instance.workspaceRoot, computer.os))) {
      throw AppError.permissionDenied("The fixed autonomous worker's workspace configuration changed");
    }
    if (executionAutomation && resolveAutomationWorkspace(ctx, computer, executionAutomation.verificationProfileId, row.projectId,
      instance.workspaceRoot!) !== executionAutomation.workspaceRoot) {
      throw AppError.conflict("The fixed worker no longer advertises this verification profile, project and workspace");
    }
    if (executionAutomation && (await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.organizationId, ctx.organizationId),
      eq(runs.agentInstanceId, instance.id), sql`${runs.status} NOT IN ('completed','failed','cancelled')`))).length > 0) {
      throw AppError.conflict("The autonomous workspace is already in use; waiting for its current execution");
    }

    const decisionId = ctx.idGen.generate(ID_PREFIXES.schedulerDecision);
    const runId = ctx.idGen.generate(ID_PREFIXES.run);

    // Transition first so a stale/duplicate assign can't create an orphan run.
    const transition = await transitionTask(tx, ctx, {
      taskId,
      from: "ready",
      trigger: "assign",
      now,
    });
    if (!transition.changed) {
      throw AppError.conflict("task is no longer ready (already assigned?)");
    }

    await tx.insert(schedulerDecisions).values({
      id: decisionId,
      organizationId: ctx.organizationId,
      taskId,
      selectedComputerId: outcome.selected.computer_id,
      selectedAgentInstanceId: outcome.selected.agent_instance_id,
      selectedModelProfileId: outcome.selected.model_profile_id,
      selectedEffortProfileId: outcome.selected.effort_profile_id,
      mode: req.mode,
      score: outcome.score,
      reason: outcome.reason,
      candidates: outcome.candidates,
      createdAt: now,
    });

    // Branch-backed worktree opt-in (#23): an explicit branch is used verbatim; a
    // `branch_backed` request generates a deterministic per-run `artoo/run-<id>`;
    // neither -> null (ordinary workspace, unchanged). Branch spelling is a git ref
    // (source-case preserved), separate from canonical-lowercase lease keys.
    const explicitBranch = req.workspace_branch ?? null;
    const workspaceBranch =
      explicitBranch != null
        ? explicitBranch
        : req.branch_backed === true
          ? `artoo/run-${runId}`
          : null;

    const config = instance.config;
    const setting = config !== null && typeof config === "object" && !Array.isArray(config)
      && "worktree_workspace_base" in config ? config.worktree_workspace_base : undefined;
    let workspaceRoot: string | null;
    let workspaceAllocation: WorkspaceAllocationRecord | null = null;
    try {
      const validated = workspaceBranch !== null && setting !== undefined
        ? validateWorktreeBaseConfiguration(setting, computer.os) : undefined;
      // Only new assignment resolves a root. Existing runs are never reallocated.
      workspaceRoot = allocateWorkspaceRoot({ workspaceRoot: instance.workspaceRoot,
        branchBacked: workspaceBranch !== null, targetComputerOs: computer.os,
        agentInstanceId: instance.id, runId, worktreeBase: setting });
      if (validated) workspaceAllocation = { version: 1, strategy: "per-run", base_path: validated.basePath };
    } catch (error) {
      if (error instanceof WorkspaceAllocationError) {
        throw AppError.validation("Invalid per-run workspace allocation", { reason: error.code });
      }
      throw error;
    }
    // Persist the exact ordinary root that matched the node's profile advertisement.
    // Manual runs keep their existing path spelling; autonomous runs must not send
    // a trailing-slash/dot alias that the node correctly rejects as a different binding.
    if (executionAutomation) workspaceRoot = executionAutomation.workspaceRoot;
    await assertSourceLineageDispatch(ctx, tx, instance.computerId, workspaceRoot);
    await assertResearchDestinationUnreserved(ctx, tx, instance.computerId, workspaceRoot);
    // H2 holds the same instance -> computer fence when issuing its delivery.
    const standalone = await unsettledStandaloneExecutions(ctx, tx, { computerId: instance.computerId });
    if (standalone.some(operation => operation.participantInstanceIds.includes(instance.id) || !workspaceRoot || automationWorkspacesOverlap(operation.workspaceRoot, workspaceRoot, computer.os)))
      throw AppError.conflict("The selected agent or workspace is reserved by an active or unconfirmed source operation");
    if (ownedSelection && (!workspaceRoot || !workspaceBranch || !workspaceAllocation)) {
      throw AppError.conflict("Owned result execution requires configured per-run workspace allocation");
    }
    // Verification needs an unchanged shared workspace; fence other starts there until terminal state.
    const uncertainWriters = await unconfirmedDisconnectRunIds(ctx, tx, { computerId: instance.computerId });
    const neighbors = await tx.select({ id: runs.id, root: runs.workspaceRoot, verification: runs.verificationRequirement }).from(runs).where(and(
      eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, instance.computerId),
      or(sql`${runs.status} NOT IN ('completed','failed','cancelled')`, uncertainWriters.length ? inArray(runs.id, uncertainWriters) : undefined)));
    if (neighbors.some((run) => (executionAutomation || run.verification !== null || uncertainWriters.includes(run.id))
      && (!run.root || !workspaceRoot || automationWorkspacesOverlap(run.root, workspaceRoot, computer.os)))) throw AppError.conflict("The workspace is reserved by an active or unconfirmed execution");
    const reservations = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.organizationId, ctx.organizationId),
      eq(goalAutomations.computerId, instance.computerId), sql`${goalAutomations.status} IN ('planning','executing','waiting')`));
    if (workspaceRoot && reservations.some((reservation) => reservation.goalId !== (executionAutomation?.goalId ?? planning?.goalId)
      && reservation.workspaceRoot && automationWorkspacesOverlap(reservation.workspaceRoot, workspaceRoot, computer.os))) {
      throw AppError.conflict("The workspace is reserved for another autonomous goal");
    }

    // Build + persist the run's ContextPack (#21 Part D): select accepted memories
    // for this context and record source_memory_ids for audit; the run links it.
    let verificationSnapshot: contextPackService.BuildContextPackParams["verification"];
    if (executionAutomation && verificationRequirement) {
      if ((executionAutomation.appDelivery != null || executionAutomation.appPublication != null) && (workspaceBranch != null || workspaceAllocation
        || !["windows", "win32"].includes(computer.os)
        || ctx.supportsExecutionFeature?.(instance.computerId, APPLICATION_VERIFICATION_FEATURE_V1) !== true)) {
        throw AppError.conflict("Application development requires a supporting native Windows node and ordinary workspace");
      }
      // Recheck synchronously beside the single snapshot read: a disconnect during
      // the preceding database work must not turn a configured profile into legacy unknown scope.
      if (ctx.supportsVerificationProfile?.(instance.computerId, verificationRequirement.profile_id, row.projectId, workspaceRoot!) !== true) {
        throw AppError.conflict("The selected node verification profile is no longer available");
      }
      verificationSnapshot = { profile_id: verificationRequirement.profile_id,
        capabilities: ctx.getVerificationCapabilities?.(instance.computerId, verificationRequirement.profile_id, row.projectId, workspaceRoot!) };
      if (verificationSnapshot.capabilities?.measurement_plan_policy
        && ctx.supportsExecutionFeature?.(instance.computerId, `measurement-plan.v${verificationSnapshot.capabilities.measurement_plan_policy.version}`) !== true) {
        throw AppError.conflict("The selected node cannot enforce its measurement-plan policy");
      }
    }
    await assertDesignRevisionAssignment(ctx, tx, row, { instanceId: instance.id, computerId: instance.computerId,
      workspaceRoot: workspaceRoot!, assistantTurnId, capabilities: verificationSnapshot?.capabilities });
    const contextPack = await contextPackService.buildRunContextPack(ctx, tx, {
      runId,
      agentInstanceId: instance.id,
      task: row,
      workspaceRoot,
      writePaths,
      assistantTurnId,
      ...(verificationSnapshot ? { verification: verificationSnapshot } : {}),
    });
    if (executionAutomation && verificationSnapshot) assertSelectedPlanningCapabilities(executionAutomation, row.projectId, verificationSnapshot.capabilities);
    if (verificationRequirement?.capability_binding
      && !isDeepStrictEqual(verificationRequirement.capability_binding, contextPack.verificationCapabilityBinding)) {
      throw AppError.conflict("Verification request does not match the selected capability snapshot");
    }
    if (verificationRequirement?.release_capability_binding
      && !isDeepStrictEqual(verificationRequirement.release_capability_binding, contextPack.releaseCapabilityBinding)) {
      throw AppError.conflict("Verification request does not match the fixed release capability snapshot");
    }
    const boundVerificationRequirement = verificationRequirement ? { ...verificationRequirement,
      ...(contextPack.applicationRequirement ? { application: contextPack.applicationRequirement } : {}),
      ...(contextPack.applicationPublicationRequirement ? { application_publication: contextPack.applicationPublicationRequirement } : {}),
      ...(contextPack.releaseCapabilityBinding ? { release_capability_binding: contextPack.releaseCapabilityBinding } : {}),
      ...(contextPack.verificationCapabilityBinding ? { capability_binding: contextPack.verificationCapabilityBinding } : {}) } : undefined;
    if (verificationRequirement?.application && !isDeepStrictEqual(verificationRequirement.application, contextPack.applicationRequirement)) {
      throw AppError.conflict("Application request differs from the original goal and current verified candidate");
    }
    if (verificationRequirement?.application_publication
      && !isDeepStrictEqual(verificationRequirement.application_publication, contextPack.applicationPublicationRequirement)) {
      throw AppError.conflict("Application publication request differs from its original authorization or paired connection");
    }

    let ownedResultAssignment: OwnedResultAssignment | null = null;
    if (ownedSelection && ownedProfile) {
      const [saved] = await tx.select().from(contextPacks).where(and(eq(contextPacks.id, contextPack.contextPackId),
        eq(contextPacks.organizationId, ctx.organizationId), eq(contextPacks.runId, runId), eq(contextPacks.taskId, taskId)));
      if (!saved) throw AppError.conflict("Owned result author context was not persisted");
      const payload = ContextPackSchema.parse(saved.payload);
      if (!isDeepStrictEqual(payload, saved.payload)) throw AppError.conflict("Owned result author context has unsupported fields");
      let contextDigest: string;
      try { contextDigest = `sha256:${createHash("sha256").update(canonicalOwnedResultAuthorContextV1(payload)).digest("hex")}`; }
      catch { throw AppError.validation("Owned result v1 requires plain author context without product-stage, review or capability inputs"); }
      const acceptedInput = ownedSelection.input.kind === "accepted_run"
        ? await resolveAcceptedOwnedResultInput(ctx, tx, row, ownedProfile, ownedSelection.input.run_id) : undefined;
      ownedResultAssignment = sealOwnedResultAssignment({ version: 1, run_start: {
        run_id: runId, task_id: taskId, agent_instance_id: instance.id, runtime: instance.runtime,
        workspace: { root: workspaceRoot!, branch: workspaceBranch! }, workspace_allocation: workspaceAllocation!,
        workspace_retention_reporting: "typed-v1", context_pack: { id: contextPack.contextPackId, payload },
        policy_snapshot: { filesystem_write_scope: [workspaceRoot!], requires_approval: ["git.push", "external.post"] },
        artifact_rules: { paths: ["artifacts/**", "*.patch"] },
      }, requirement: { version: 1, request_id: ctx.idGen.generate("result_verify"),
        capture_request_id: ctx.idGen.generate("result_capture"), verification_materialization_request_id: ctx.idGen.generate("result_tree"),
        profile: ownedProfile, author_context_digest: contextDigest,
        input: acceptedInput ? { kind: "result", reference: acceptedInput.reference } : { kind: "baseline" },
      } }, acceptedInput);
      const current = ctx.getOwnedResultProfile?.(instance.computerId, ownedSelection.result_profile_id,
        ownedSelection.verifier_template_id, row.projectId);
      if (!current || !isDeepStrictEqual(current, ownedProfile)) throw AppError.conflict("Owned result profile changed during assignment");
    }

    await tx.insert(runs).values({
      id: runId,
      requestedByUserId: ctx.actorUserId, aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion,
      organizationId: ctx.organizationId,
      taskId,
      computerId: outcome.selected.computer_id,
      agentInstanceId: outcome.selected.agent_instance_id,
      runtimeId: outcome.selected.runtime,
      schedulerDecisionId: decisionId,
      modelProfileId: outcome.selected.model_profile_id,
      effortProfileId: outcome.selected.effort_profile_id,
      status: "queued",
      contextPackId: contextPack.contextPackId,
      workspaceRoot,
      workspaceBranch,
      workspaceAllocation,
      verificationRequirement: boundVerificationRequirement ?? null,
      ownedResultAssignment,
      createdAt: now,
    });
    await bindDesignRevisionRun(ctx, tx, runId);
    await bindExecutionApprovalToRun(ctx, tx, taskId, runId);
    if (assistantTurnId) {
      await tx.insert(assistantRunDispatches).values({ runId, organizationId: ctx.organizationId, turnId: assistantTurnId,
        version: 1, state: "prepared", createdAt: now });
      await tx.update(assistantTurns).set({ runId, status: "running", error: null, updatedAt: now }).where(eq(assistantTurns.id, assistantTurnId));
      await appendEvent(tx, buildEvent(ctx, { type: "assistant.turn.updated", actorType: ctx.automationActor?.type ?? "user", actorId: ctx.automationActor?.id ?? ctx.actorUserId,
        correlationId: assistantTurnId, projectId: row.projectId, taskId, roomId: row.roomId, runId,
        payload: { turn_id: assistantTurnId, status: "running", run_id: runId } }));
    }

    // Reserve write leases for the run's declared paths (#20). A conflict throws,
    // rolling back this whole transaction: no run, no assignment, task stays ready.
    await leaseService.reserveRunLeases(ctx, tx, {
      taskId,
      runId,
      projectId: row.projectId,
      paths: writePaths,
    });

    await tx
      .update(tasks)
      .set({ assigneeType: "agent", assigneeId: outcome.selected.agent_id, updatedAt: now })
      .where(eq(tasks.id, taskId));

    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "task.assigned",
        actorType: "system",
        actorId: "scheduler",
        correlationId: taskId,
        projectId: row.projectId,
        taskId,
        roomId: row.roomId,
        runId,
        payload: {
          run_id: runId,
          agent_instance_id: outcome.selected.agent_instance_id,
          scheduler_decision_id: decisionId,
        },
      }),
    );

    const runRow = (await tx.select().from(runs).where(eq(runs.id, runId)))[0];
    if (runRow === undefined) {
      throw new Error("assignTask: run missing after insert");
    }
    // This is the last awaited read in assignment. New planning uses the fixed
    // future writer, even when the current participant runs on another node.
    if (planningAutomation) recheckPlanningSnapshot(ctx, planningAutomation, row.projectId);
    if (executionAutomation) assertPlanningTargetAvailable(ctx, executionAutomation, row.projectId);
    if (ownedSelection && ownedProfile) {
      const current = ctx.getOwnedResultProfile?.(instance.computerId, ownedSelection.result_profile_id,
        ownedSelection.verifier_template_id, row.projectId);
      if (!current || !isDeepStrictEqual(current, ownedProfile)) throw AppError.conflict("Owned result profile changed before assignment committed");
    }
    return {
      run: mapRun(runRow),
      scheduler_decision: { id: decisionId, reason: outcome.reason, score: outcome.score },
    };
  });

  // After commit: let a node binding dispatch run.start (no-op in REST-only tests).
  await ctx.onRunQueued?.(result.run.id);
  return result;
}

/**
 * POST /tasks/:id/review — accept (review -> done) or request changes
 * (review -> ready). The review.completed event carries the outcome so the
 * change-request loop is auditable (gap1).
 */
export async function reviewTask(
  ctx: ServerContext,
  taskId: string,
  req: ReviewRequest,
  baseVersion?: number | null,
): Promise<Task> {
  const now = ctx.clock.nowIso();
  const trigger = req.outcome === "accepted" ? "accept" : "request_changes";
  return ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
        .for("update")
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
    }
    // Optimistic concurrency (#27 v2-B slice 2): if the caller pinned a
    // base_version from the task snapshot it hydrated, reject when the task has
    // since advanced. Checked inside the tx so it is consistent with the write.
    await assertFreshTaskBaseVersion(tx, ctx.organizationId, taskId, baseVersion);
    if (row.status !== "review") {
      throw AppError.invalidState(`task must be 'review' to review (is '${row.status}')`, {
        status: row.status,
      });
    }
    const researchOrigin = await resolveResearchRevisionOrigin(ctx, tx, row);
    const reviewPlanId = researchOrigin?.plan.id ?? row.sourcePlanId;
    const reviewSpecRef = researchOrigin?.specRef ?? row.sourcePlanSpecRef;
    const automation = await automationForTask(ctx, tx, row);
    if (row.goalId && await currentImportedDesignBoundary(ctx, tx, row.goalId, row.sourcePlanId)) throw AppError.conflict("Imported design cannot be accepted through ordinary task review; H4 and H5 remain separately fenced");
    let verifiedReview: {
      verified_run_id: string; verification_evidence_id: string; verification_request_id: string;
      profile_digest: string; subject_digest: string | null;
      independent_review_id?: string; reviewer_run_id?: string; reviewer_evidence_id?: string;
    } | undefined;
    let ownedReview: ReturnType<typeof ownedResultReview> | undefined;
    let revisionAcceptance: DesignRevision | undefined;
    if (automation) {
      if (!ctx.automationActor || ctx.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("Autonomous tasks require the goal runner's evidence review");
      if (automation.planId !== reviewPlanId) throw AppError.conflict("The autonomous task is not in the current plan");
      await requireAiSharingAuthorization(ctx, tx, { consentId: automation.consentId, policyVersion: automation.policyVersion });
      const goal = (await tx.select().from(goals).where(eq(goals.id, automation.goalId)).for("update"))[0];
      if (!goal || goal.status !== "running" || goal.currentPlanId !== automation.planId) throw AppError.conflict("Autonomous review is paused or its plan changed");
      if (req.outcome === "accepted") {
        const run = (await tx.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.organizationId, ctx.organizationId))).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1))[0];
        if (!run || run.status !== "completed") throw AppError.conflict("The latest execution did not complete successfully");
        await assertDesignRevisionRunAdmission(ctx, tx, run, { acceptance: true });
        const verification = await inspectRunVerification(ctx, tx, run);
        if (!verification.passed || !verification.evidence) throw AppError.conflict(verification.reason);
        const plan = (await tx.select().from(plans).where(eq(plans.id, reviewPlanId!)))[0];
        const spec = TaskSpecSchema.parse((plan?.taskSpecs as unknown[] | undefined)?.[Number(reviewSpecRef)]);
        const outputs = await tx.select({ type: artifacts.type }).from(artifacts).where(and(eq(artifacts.runId, run.id), eq(artifacts.organizationId, ctx.organizationId)));
        if (spec.expected_artifacts.some((expected) => !outputs.some((actual) => actual.type === expected.type))) throw AppError.conflict("The latest execution is missing an expected artifact type");
        // Keep the acceptance bound to the exact node receipt, not just a human-readable comment.
        verifiedReview = { verified_run_id: run.id, verification_evidence_id: verification.evidence.id,
          verification_request_id: verification.evidence.requestId, profile_digest: verification.evidence.payload.profile_digest,
          subject_digest: verification.evidence.payload.subject_digest };
        if (automation.executionMode === "agent_team") {
          const peer = await inspectIndependentReview(ctx, tx, run, verification.evidence);
          if (peer.status !== "accepted" || !peer.review || !peer.reviewerRunId || !peer.reviewerEvidenceId) throw AppError.conflict(peer.reason);
          verifiedReview.independent_review_id = peer.review.id;
          verifiedReview.reviewer_run_id = peer.reviewerRunId;
          verifiedReview.reviewer_evidence_id = peer.reviewerEvidenceId;
          const peerEvidence = await readRunVerificationEvidence(ctx, tx, peer.reviewerRunId);
          if (!peerEvidence || peerEvidence.id !== peer.reviewerEvidenceId) throw AppError.conflict("Independent reviewer evidence changed before acceptance");
          revisionAcceptance = await prepareDesignRevisionAcceptance(ctx, tx, run, verification.evidence.payload,
            { reviewId: peer.review.id, runId: peer.reviewerRunId, payload: peerEvidence.payload });
          if (revisionAcceptance) {
            const refreshed = await inspectIndependentReview(ctx, tx, run, verification.evidence);
            if (refreshed.status !== "accepted" || refreshed.review?.id !== peer.review.id || refreshed.reviewerRunId !== peer.reviewerRunId
              || refreshed.reviewerEvidenceId !== peer.reviewerEvidenceId || !isDeepStrictEqual(refreshed.responseBinding, peer.responseBinding)) {
              throw AppError.conflict("Independent revision reviewer changed during retained-content acceptance checks");
            }
          }
        }
      }
    }
    if (req.outcome === "accepted") {
      const [latest] = await tx.select().from(runs).where(and(eq(runs.taskId, taskId), eq(runs.organizationId, ctx.organizationId)))
        .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
      if (latest && latest.ownedResultAssignment !== null) {
        const evidence = await readReviewableOwnedResultEvidence(ctx, tx, latest);
        if (latest.status !== "completed" || !evidence || evidence.payload.verification.payload.outcome !== "passed") {
          throw AppError.conflict("Owned result review requires the latest run's exact passing node evidence");
        }
        ownedReview = ownedResultReview(evidence);
      }
    }
    if (trigger === "request_changes") {
      const policyTask = await resolveExecutionPolicyTask(ctx, tx, row);
      await assertGoalAllowsExecution(ctx, tx, policyTask.goalId, "retry", policyTask.sourcePlanId);
      await assertTaskPlanControlsSupported(ctx, tx, policyTask);
    }
    // Aggregate review: a parent cannot be accepted (-> done) until every child
    // task is done or cancelled. Otherwise accepting a parent would mark a tree
    // complete while sub-tasks are still open.
    if (req.outcome === "accepted") {
      const children = await tx
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.parentTaskId, taskId), eq(tasks.organizationId, ctx.organizationId)));
      const pending = children.filter((c) => c.status !== "done" && c.status !== "cancelled");
      if (pending.length > 0) {
        throw AppError.invalidState(
          "cannot accept parent task until all child tasks are done or cancelled",
          { open_children: pending.length },
        );
      }
    }
    const artifactRows = await tx.select({ id: artifacts.id }).from(artifacts).where(and(
      eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.taskId, taskId),
    )).orderBy(asc(artifacts.id));
    const result = await transitionTask(tx, ctx, {
      taskId,
      from: "review",
      trigger,
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "review.completed",
          actorType: ctx.automationActor?.type ?? "user",
          actorId: ctx.automationActor?.id ?? ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { outcome: req.outcome, comment: req.comment ?? null, artifact_ids: artifactRows.map((artifact) => artifact.id), ...verifiedReview,
            ...(ownedReview ? { owned_result_review: ownedReview } : {}) },
        }),
        buildEvent(ctx, {
          type: "task.updated",
          actorType: ctx.automationActor?.type ?? "user",
          actorId: ctx.automationActor?.id ?? ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { status: to },
        }),
      ],
    });
    if (!result.changed) {
      throw AppError.conflict("task is no longer in review");
    }
    // #115 P3b-2: a `request_changes` review sends the task back to ready — a
    // real retry that consumes the linked goal's retry budget. `accept` does not.
    if (trigger === "request_changes" && row.goalId !== null) {
      await incrementLinkedGoalRetryCount(ctx, tx, row.goalId, now);
    }
    // On accept (-> done), auto-unlock downstream dependents whose gating
    // prerequisites are now all satisfied (emits dag.node.ready per unlock).
    if (req.outcome === "accepted") {
      if (revisionAcceptance && verifiedReview?.independent_review_id) await settleDesignRevisionAcceptance(ctx, tx, revisionAcceptance,
        { runId: verifiedReview.verified_run_id, evidenceId: verifiedReview.verification_evidence_id, reviewId: verifiedReview.independent_review_id });
      await dagService.unlockDownstream(ctx, tx, taskId);
      if (row.goalId !== null) {
        await completeGoalIfAllTasksDone(ctx, tx, row.goalId, now);
      }
    }
    const updated = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (updated === undefined) {
      throw new Error("reviewTask: task missing after transition");
    }
    return mapTask(updated);
  });
}

/**
 * #138 hardening: when the final materialized task of a running goal is accepted,
 * close the goal with the existing `all_tasks_terminal` transition. The check is
 * org-scoped, same-transaction, and only runs after the accepted review changed
 * the task to `done`, so partial DAGs or stale accepts cannot complete a goal.
 */
async function completeGoalIfAllTasksDone(
  ctx: ServerContext,
  tx: ServerContext["db"]["db"],
  goalId: string,
  now: string,
): Promise<void> {
  const goal = (
    await tx
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId), eq(goals.status, "running")))
      .for("update")
  )[0];
  if (goal === undefined) {
    return;
  }
  if (await currentImportedDesignBoundary(ctx, tx, goalId)) return;
  const [automation] = await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, goalId), eq(goalAutomations.organizationId, ctx.organizationId)));
  // Publication has its own immutable artifact and health gate, after all task reviews.
  if (automation?.releaseProfileId || automation?.appDelivery != null || automation?.appPublication != null) return;
  const childTasks = await tx
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.organizationId, ctx.organizationId), eq(tasks.goalId, goalId),
      goal.currentPlanId === null ? undefined : or(isNull(tasks.sourcePlanId), eq(tasks.sourcePlanId, goal.currentPlanId))));
  if (childTasks.length === 0 || childTasks.some((task) => task.status !== "done")) {
    return;
  }
  if (await unsettledGoalExecutionCount(ctx, tx, goalId) > 0) return;
  const to = applyGoalTransition("running", "all_tasks_terminal");
  const changed = await tx
    .update(goals)
    .set({ status: to, updatedAt: now })
    .where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId), eq(goals.status, "running")))
    .returning({ id: goals.id });
  if (changed.length === 0) {
    return;
  }
  await appendEvent(
    tx,
    buildEvent(ctx, {
      type: "goal.completed",
      actorType: "system",
      actorId: "goal_aggregator",
      correlationId: goalId,
      projectId: goal.projectId,
      roomId: goal.roomId,
      goalId,
      payload: { goal_id: goalId, from: "running", to, trigger: "all_tasks_terminal" },
    }),
  );
}

/**
 * POST /tasks/:id/retry — recover a blocked task by returning it to ready
 * (blocked -> ready). Reassignment then creates a NEW run (runs are never
 * reused). Guarantees a blocked task is never stuck (the ack/timeout invariant).
 */
/**
 * #115 P3b-2 — a genuine task retry (explicit `retry`, or review `request_changes`)
 * on a goal-linked task consumes the goal's retry budget. Increments the linked
 * goal's retry_count atomically within the caller's transaction, org-scoped. Call
 * ONLY after the task retry transition's compare-and-set actually changed, so a
 * duplicate/stale retry never double-counts. `assign_failed_retryable` and
 * ordinary failed runs are not retries and never reach here.
 */
async function incrementLinkedGoalRetryCount(
  ctx: ServerContext,
  tx: ServerContext["db"]["db"],
  goalId: string,
  now: string,
): Promise<void> {
  await tx
    .update(goals)
    .set({ retryCount: sql`${goals.retryCount} + 1`, updatedAt: now })
    .where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId)));
}

export async function retryTask(ctx: ServerContext, taskId: string): Promise<Task> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
    }
    if (!canTransitionTask(row.status as TaskStatus, "retry")) {
      throw AppError.invalidState(`cannot retry from '${row.status}'`, { status: row.status });
    }
    const policyTask = await resolveExecutionPolicyTask(ctx, tx, row);
    await assertGoalAllowsExecution(ctx, tx, policyTask.goalId, "retry", policyTask.sourcePlanId);
    await assertTaskPlanControlsSupported(ctx, tx, policyTask);
    const transition = await transitionTask(tx, ctx, {
      taskId,
      from: row.status as TaskStatus,
      trigger: "retry",
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "task.updated",
          actorType: ctx.automationActor?.type ?? "user",
          actorId: ctx.automationActor?.id ?? ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { status: to, retried: true },
        }),
      ],
    });
    // A real retry that actually happened consumes the linked goal's retry budget.
    if (transition.changed && row.goalId !== null) {
      await incrementLinkedGoalRetryCount(ctx, tx, row.goalId, now);
    }
    const updated = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (updated === undefined) {
      throw new Error("retryTask: task missing after transition");
    }
    return mapTask(updated);
  });
}
