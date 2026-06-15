import {
  agentInstances,
  appendEvent,
  runs,
  schedulerDecisions,
  taskDependencies,
  tasks,
} from "@artoo/db";
import {
  canTransitionTask,
  type DagEdge,
  ID_PREFIXES,
  type AssignRequest,
  type Capability,
  type ReviewRequest,
  type Run,
  type Task,
  type TaskStatus,
} from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun, mapTask } from "../mappers.js";
import * as dagService from "./dag-service.js";
import * as contextPackService from "./context-pack-service.js";
import * as leaseService from "./lease-service.js";
import { scheduleTask } from "./scheduler.js";
import { transitionTask } from "./transition-service.js";

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
          actorType: "user",
          actorId: ctx.actorUserId,
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
): Promise<AssignResult> {
  const now = ctx.clock.nowIso();
  const result = await ctx.db.transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (row === undefined) {
      throw AppError.notFound(`task not found: ${taskId}`, { task_id: taskId });
    }
    if (row.status !== "ready") {
      throw AppError.invalidState(`task must be 'ready' to assign (is '${row.status}')`, {
        status: row.status,
      });
    }

    const outcome = await scheduleTask(tx, ctx, row.requiredCapabilities as Capability[], {
      mode: req.mode,
      agentInstanceId: req.agent_instance_id ?? null,
    });

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

    // Record the assigned instance's workspace root (#20). Real FS path — source
    // case preserved. branch stays null in Phase A (ordinary workspace; branch
    // activation waits for artood worktreeBaseRepo + gated git worktree smoke).
    const instance = (
      await tx
        .select({ workspaceRoot: agentInstances.workspaceRoot })
        .from(agentInstances)
        .where(eq(agentInstances.id, outcome.selected.agent_instance_id))
    )[0];

    const workspaceRoot = instance?.workspaceRoot ?? null;

    // Build + persist the run's ContextPack (#21 Part D): select accepted memories
    // for this context and record source_memory_ids for audit; the run links it.
    const contextPack = await contextPackService.buildRunContextPack(ctx, tx, {
      runId,
      task: row,
      workspaceRoot,
      writePaths: req.write_paths ?? [],
    });

    await tx.insert(runs).values({
      id: runId,
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
      workspaceBranch: null,
      createdAt: now,
    });

    // Reserve write leases for the run's declared paths (#20). A conflict throws,
    // rolling back this whole transaction: no run, no assignment, task stays ready.
    await leaseService.reserveRunLeases(ctx, tx, {
      taskId,
      runId,
      projectId: row.projectId,
      paths: req.write_paths ?? [],
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
): Promise<Task> {
  const now = ctx.clock.nowIso();
  const trigger = req.outcome === "accepted" ? "accept" : "request_changes";
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
    if (row.status !== "review") {
      throw AppError.invalidState(`task must be 'review' to review (is '${row.status}')`, {
        status: row.status,
      });
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
    const result = await transitionTask(tx, ctx, {
      taskId,
      from: "review",
      trigger,
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "review.completed",
          actorType: "user",
          actorId: ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { outcome: req.outcome, comment: req.comment ?? null },
        }),
        buildEvent(ctx, {
          type: "task.updated",
          actorType: "user",
          actorId: ctx.actorUserId,
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
    // On accept (-> done), auto-unlock downstream dependents whose gating
    // prerequisites are now all satisfied (emits dag.node.ready per unlock).
    if (req.outcome === "accepted") {
      await dagService.unlockDownstream(ctx, tx, taskId);
    }
    const updated = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (updated === undefined) {
      throw new Error("reviewTask: task missing after transition");
    }
    return mapTask(updated);
  });
}

/**
 * POST /tasks/:id/retry — recover a blocked task by returning it to ready
 * (blocked -> ready). Reassignment then creates a NEW run (runs are never
 * reused). Guarantees a blocked task is never stuck (the ack/timeout invariant).
 */
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
    await transitionTask(tx, ctx, {
      taskId,
      from: row.status as TaskStatus,
      trigger: "retry",
      now,
      events: (to) => [
        buildEvent(ctx, {
          type: "task.updated",
          actorType: "user",
          actorId: ctx.actorUserId,
          correlationId: taskId,
          projectId: row.projectId,
          taskId,
          roomId: row.roomId,
          payload: { status: to, retried: true },
        }),
      ],
    });
    const updated = (await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (updated === undefined) {
      throw new Error("retryTask: task missing after transition");
    }
    return mapTask(updated);
  });
}
