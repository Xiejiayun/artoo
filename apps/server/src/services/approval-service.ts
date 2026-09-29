import { appendEvent, approvals, blockers, tasks } from "@artoo/db";
import {
  applyApprovalTransition,
  canTransitionApproval,
  ID_PREFIXES,
  type Approval,
  type ApprovalStatus,
  type ResolveApprovalRequest,
  type TaskStatus,
} from "@artoo/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DrizzleDb } from "@artoo/storage";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapApproval } from "../mappers.js";
import { resolveBlockersForSource } from "./collaboration-service.js";
import { transitionTask } from "./transition-service.js";

export interface RequestApprovalParams {
  taskId: string;
  runId?: string | null;
  action: string;
  risk: "low" | "medium" | "high";
  summary: string;
}

export const EXECUTION_GATE_CURRENT = "execution-gate/current";
export const EXECUTION_GATE_SUPERSEDED = "execution-gate/superseded";

/**
 * Running-task review record used by the development fixture. This does not
 * intercept CLI commands. Production pre-run gating is requestExecutionApproval.
 */
export async function requestApproval(
  ctx: ServerContext,
  params: RequestApprovalParams,
): Promise<Approval> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const task = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, params.taskId), eq(tasks.organizationId, ctx.organizationId)))
    )[0];
    if (task === undefined) {
      throw AppError.notFound(`task not found: ${params.taskId}`, { task_id: params.taskId });
    }
    if (task.status !== "running") {
      throw AppError.invalidState(
        `task must be 'running' to request approval (is '${task.status}')`,
        { status: task.status },
      );
    }
    const approvalId = ctx.idGen.generate(ID_PREFIXES.approval);
    await tx.insert(approvals).values({
      id: approvalId,
      organizationId: ctx.organizationId,
      taskId: params.taskId,
      runId: params.runId ?? null,
      requestedByType: "system",
      requestedById: "control_plane",
      action: params.action,
      risk: params.risk,
      summary: params.summary,
      status: "pending",
      createdAt: now,
    });
    const transition = await transitionTask(tx, ctx, {
      taskId: params.taskId,
      from: "running",
      trigger: "approval_requested",
      now,
      events: () => [
        buildEvent(ctx, {
          type: "approval.requested",
          actorType: "system",
          actorId: "control_plane",
          correlationId: params.taskId,
          projectId: task.projectId,
          taskId: params.taskId,
          roomId: task.roomId,
          runId: params.runId ?? null,
          payload: {
            approval_id: approvalId,
            action: params.action,
            risk: params.risk,
            summary: params.summary,
          },
        }),
      ],
    });
    if (!transition.changed) {
      throw AppError.conflict("task is no longer running; approval was not requested");
    }
    const row = (await tx.select().from(approvals).where(eq(approvals.id, approvalId)))[0];
    if (row === undefined) {
      throw new Error("requestApproval: approval missing after insert");
    }
    return mapApproval(row);
  });
}

/** A human requests review before dispatch. Each request has an immutable id so
 * a decision from an old page can never approve a newer execution proposal. */
export async function requestExecutionApproval(ctx: ServerContext, taskId: string, input: {
  summary: string; risk: "low" | "medium" | "high";
}): Promise<Approval> {
  const summary = input.summary.trim();
  if (!summary || summary.length > 4000 || !["low", "medium", "high"].includes(input.risk)) throw AppError.validation("A summary (1-4000 characters) and valid risk are required");
  return ctx.db.transaction(async (tx) => {
    const task = (await tx.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.organizationId, ctx.organizationId))).for("update"))[0];
    if (!task) throw AppError.notFound("task not found");
    if (task.status !== "ready") throw AppError.invalidState("Only a ready task can request approval before execution");
    const prior = await tx.select().from(approvals).where(and(eq(approvals.taskId, taskId), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start")));
    const current = prior.filter((approval) => approval.payloadRef !== EXECUTION_GATE_SUPERSEDED);
    const id = ctx.idGen.generate(ID_PREFIXES.approval);
    const now = ctx.clock.nowIso();
    for (const approval of current) {
      await tx.update(approvals).set({ payloadRef: EXECUTION_GATE_SUPERSEDED,
        ...(["pending", "needs_more_info"].includes(approval.status) ? { status: "expired", resolvedAt: now } : {}),
      }).where(eq(approvals.id, approval.id));
    }
    await tx.insert(approvals).values({ id, organizationId: ctx.organizationId, taskId,
      runId: null, requestedByType: "user", requestedById: ctx.actorUserId,
      action: "execution.start", summary, risk: input.risk, status: "pending", createdAt: now, payloadRef: EXECUTION_GATE_CURRENT,
    });
    // A replacement is the same unmet review intent. Keep active blockers
    // attached to its current request while leaving resolved history intact.
    const relinkedBlockers: { blocker_id: string; previous_source_id: string | null; source_id: string }[] = [];
    if (prior.length > 0) {
      const linked = await tx.select().from(blockers).where(and(
        eq(blockers.organizationId, ctx.organizationId), eq(blockers.sourceKind, "approval"),
        inArray(blockers.sourceId, prior.map((approval) => approval.id)),
        inArray(blockers.status, ["open", "mitigated", "accepted_risk"]),
      )).for("update");
      for (const blocker of linked) {
        await tx.update(blockers).set({ sourceId: id, updatedAt: now }).where(eq(blockers.id, blocker.id));
        relinkedBlockers.push({ blocker_id: blocker.id, previous_source_id: blocker.sourceId, source_id: id });
      }
    }
    await appendEvent(tx, buildEvent(ctx, { type: "approval.requested", actorType: "user", actorId: ctx.actorUserId,
      correlationId: taskId, projectId: task.projectId, taskId, roomId: task.roomId,
      payload: { approval_id: id, action: "execution.start", summary, risk: input.risk,
        superseded_approval_ids: current.map((approval) => approval.id), relinked_blockers: relinkedBlockers },
    }));
    return mapApproval((await tx.select().from(approvals).where(eq(approvals.id, id)))[0]!);
  });
}

/** Call under the task row lock immediately before dispatch/assignment. */
export async function assertExecutionApprovalGranted(ctx: ServerContext, tx: DrizzleDb, taskId: string): Promise<void> {
  const gates = await tx.select({ status: approvals.status, runId: approvals.runId, payloadRef: approvals.payloadRef }).from(approvals).where(and(
    eq(approvals.taskId, taskId), eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start"),
  ));
  const current = gates.filter((gate) => gate.payloadRef !== EXECUTION_GATE_SUPERSEDED);
  if ((gates.length > 0 && current.length !== 1) || current.some((gate) => gate.payloadRef !== EXECUTION_GATE_CURRENT || gate.status !== "approved" || gate.runId !== null)) {
    throw AppError.conflict("Execution approval is required before this task can start");
  }
}

export async function bindExecutionApprovalToRun(ctx: ServerContext, tx: DrizzleDb, taskId: string, runId: string): Promise<void> {
  await tx.update(approvals).set({ runId }).where(and(eq(approvals.taskId, taskId),
    eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start"), eq(approvals.status, "approved"),
    eq(approvals.payloadRef, EXECUTION_GATE_CURRENT)));
}

/** GET /api/v1/approvals?status=pending — approvals filtered by status. */
export async function listApprovals(
  ctx: ServerContext,
  status?: string,
): Promise<Approval[]> {
  const where =
    status !== undefined && status !== ""
      ? and(eq(approvals.organizationId, ctx.organizationId), eq(approvals.status, status))
      : eq(approvals.organizationId, ctx.organizationId);
  const rows = await ctx.db.db
    .select()
    .from(approvals)
    .where(where)
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
  return rows.map(mapApproval);
}

/**
 * POST /api/v1/approvals/:id/resolve — approve / reject / needs_more_info. On
 * approve the task returns to running (platform may then perform the action); on
 * reject the task goes blocked; needs_more_info keeps it awaiting_approval.
 */
export async function resolveApproval(
  ctx: ServerContext,
  approvalId: string,
  req: ResolveApprovalRequest,
): Promise<Approval> {
  const now = ctx.clock.nowIso();
  const approvalTrigger =
    req.decision === "approved" ? "approve" : req.decision === "rejected" ? "reject" : "need_more_info";

  const resolved = await ctx.db.transaction(async (tx) => {
    const initial = (
      await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, approvalId), eq(approvals.organizationId, ctx.organizationId)))
    )[0];
    if (initial === undefined) {
      throw AppError.notFound(`approval not found: ${approvalId}`, { approval_id: approvalId });
    }
    // Request, assignment and resolution all acquire task -> approval locks.
    // Re-read after the task lock: a newer request may have superseded this id.
    const task = (
      await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, initial.taskId), eq(tasks.organizationId, ctx.organizationId)))
        .for("update")
    )[0];
    if (task === undefined) {
      throw new Error("resolveApproval: task missing for approval");
    }
    const approval = (await tx.select().from(approvals).where(and(
      eq(approvals.id, approvalId), eq(approvals.organizationId, ctx.organizationId),
    )).for("update"))[0];
    if (approval === undefined) throw AppError.notFound("approval no longer exists");
    const taskStatus = task.status as TaskStatus;
    const executionGate = approval.action === "execution.start";
    if (executionGate && approval.payloadRef !== EXECUTION_GATE_CURRENT) {
      throw AppError.conflict("This execution approval has been superseded; review the current request");
    }
    const fromStatus = approval.status as ApprovalStatus;
    if (!canTransitionApproval(fromStatus, approvalTrigger)) {
      throw AppError.invalidState(`cannot resolve approval in status '${fromStatus}'`, { status: fromStatus });
    }
    const toStatus = applyApprovalTransition(fromStatus, approvalTrigger);
    if ((executionGate && taskStatus !== "ready") || (!executionGate && taskStatus !== "awaiting_approval")) {
      throw AppError.invalidState(`task must be '${executionGate ? "ready" : "awaiting_approval"}' to resolve approval (is '${taskStatus}')`, {
        status: taskStatus,
      });
    }

    await tx
      .update(approvals)
      .set({ status: toStatus, resolvedBy: ctx.actorUserId, resolvedAt: now })
      .where(eq(approvals.id, approvalId));

    // Drive the task per the decision (only meaningful while awaiting_approval).
    if (!executionGate && (req.decision === "approved" || req.decision === "rejected")) {
      const transition = await transitionTask(tx, ctx, {
        taskId: approval.taskId,
        from: "awaiting_approval",
        trigger: req.decision === "approved" ? "approval_granted" : "approval_rejected",
        now,
      });
      if (!transition.changed) {
        throw AppError.conflict("task approval state changed during approval resolution");
      }
    }

    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "approval.resolved",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: approval.taskId,
        projectId: task.projectId,
        taskId: approval.taskId,
        roomId: task.roomId,
        runId: approval.runId,
        payload: { approval_id: approvalId, decision: req.decision, comment: req.comment ?? null },
      }),
    );

    if (executionGate && (req.decision === "approved" || req.decision === "rejected")) {
      // Resolve under the same task lock as replacement. A post-commit sweep
      // could otherwise resolve a blocker after it moved to a fresh request.
      const linked = await tx.select().from(blockers).where(and(
        eq(blockers.organizationId, ctx.organizationId), eq(blockers.sourceKind, "approval"),
        eq(blockers.sourceId, approval.id), inArray(blockers.status, ["open", "mitigated"]),
      )).for("update");
      for (const blocker of linked) {
        await tx.update(blockers).set({ status: "resolved", updatedAt: now,
          mitigation: `auto-resolved by approval ${approval.id}`,
        }).where(eq(blockers.id, blocker.id));
        await appendEvent(tx, buildEvent(ctx, {
          type: "blocker.resolved", actorType: "system", actorId: "system", correlationId: blocker.id,
          roomId: blocker.roomId, taskId: blocker.taskId, runId: blocker.runId, goalId: blocker.goalId,
          payload: { blocker_id: blocker.id, from: blocker.status, to: "resolved", source_kind: "approval", source_id: approval.id },
        }));
      }
    }

    const row = (await tx.select().from(approvals).where(eq(approvals.id, approvalId)))[0];
    if (row === undefined) {
      throw new Error("resolveApproval: approval missing after update");
    }
    return mapApproval(row);
  });

  // Legacy running-task approvals retain their existing post-commit sweep.
  // Execution gates resolve in the transaction above to serialize replacement.
  if (resolved.action !== "execution.start" && (req.decision === "approved" || req.decision === "rejected")) {
    await resolveBlockersForSource(ctx, "approval", approvalId);
  }
  return resolved;
}
