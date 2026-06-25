import { appendEvent, approvals, tasks } from "@artoo/db";
import {
  applyApprovalTransition,
  canTransitionApproval,
  ID_PREFIXES,
  type Approval,
  type ApprovalStatus,
  type ResolveApprovalRequest,
  type TaskStatus,
} from "@artoo/domain";
import { and, asc, eq } from "drizzle-orm";

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

/**
 * Platform-gated approval (v0.1 model): a high-risk platform action (git push /
 * external post / out-of-scope write) requests approval. The task moves
 * running -> awaiting_approval; the action is NOT performed until a human
 * resolves it (never a mid-run interrupt of the agent process).
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
    const approval = (
      await tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, approvalId), eq(approvals.organizationId, ctx.organizationId)))
    )[0];
    if (approval === undefined) {
      throw AppError.notFound(`approval not found: ${approvalId}`, { approval_id: approvalId });
    }
    const fromStatus = approval.status as ApprovalStatus;
    if (!canTransitionApproval(fromStatus, approvalTrigger)) {
      throw AppError.invalidState(`cannot resolve approval in status '${fromStatus}'`, {
        status: fromStatus,
      });
    }
    const toStatus = applyApprovalTransition(fromStatus, approvalTrigger);
    const task = (await tx.select().from(tasks).where(eq(tasks.id, approval.taskId)))[0];
    if (task === undefined) {
      throw new Error("resolveApproval: task missing for approval");
    }
    const taskStatus = task.status as TaskStatus;
    if (taskStatus !== "awaiting_approval") {
      throw AppError.invalidState(`task must be 'awaiting_approval' to resolve approval (is '${taskStatus}')`, {
        status: taskStatus,
      });
    }

    await tx
      .update(approvals)
      .set({ status: toStatus, resolvedBy: ctx.actorUserId, resolvedAt: now })
      .where(eq(approvals.id, approvalId));

    // Drive the task per the decision (only meaningful while awaiting_approval).
    if (req.decision === "approved" || req.decision === "rejected") {
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

    const row = (await tx.select().from(approvals).where(eq(approvals.id, approvalId)))[0];
    if (row === undefined) {
      throw new Error("resolveApproval: approval missing after update");
    }
    return mapApproval(row);
  });

  // V3 #114 — deterministic unblock: once the approval is decided (approved or
  // rejected, i.e. no longer pending), auto-resolve any blocker that linked to
  // it as its source. Runs post-commit because resolveBlockersForSource opens
  // its own transaction for the blocker.resolved events.
  if (req.decision === "approved" || req.decision === "rejected") {
    await resolveBlockersForSource(ctx, "approval", approvalId);
  }
  return resolved;
}
