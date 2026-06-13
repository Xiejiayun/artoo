import {
  appendEvent,
  runs,
  schedulerDecisions,
  taskDependencies,
  tasks,
} from "@artoo/db";
import {
  canTransitionTask,
  ID_PREFIXES,
  type AssignRequest,
  type Capability,
  type Run,
  type Task,
  type TaskStatus,
} from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun, mapTask } from "../mappers.js";
import { scheduleTask } from "./scheduler.js";
import { transitionTask } from "./transition-service.js";

/**
 * POST /tasks/:id/ready — triage backlog -> ready. Requires non-empty
 * acceptance criteria and all upstream `blocks` dependencies done (API contract).
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
    const blockers = await tx
      .select({ status: tasks.status })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.fromTaskId, tasks.id))
      .where(and(eq(taskDependencies.toTaskId, taskId), eq(taskDependencies.type, "blocks")));
    if (blockers.some((b) => b.status !== "done")) {
      throw AppError.invalidState("upstream 'blocks' dependencies are not all done");
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
      createdAt: now,
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
}
