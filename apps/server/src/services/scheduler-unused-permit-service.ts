import { appendEvent, runEventIngest, runs, schedulerExecutionLeases, schedulerStartGrants, tasks } from "@artoo/db";
import { SchedulerPermitUnusedV1Schema, type SchedulerExecutionLeaseBindingV1, type SchedulerPermitUnusedV1 } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { propagateBlocked } from "./dag-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { closeSchedulerExecutionLeaseInTransaction } from "./scheduler-execution-lease-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";

/** Called only after the scoped Run receipt owner authenticated and locked the
 * exact original request/Run/lease/credential in this same transaction. The
 * protected node journal owns the never-started fact; no model/adapter receipt,
 * database terminal status or timeout is promoted into physical-exit evidence. */
export async function settleUnusedSchedulerPermit(ctx: ServerContext, tx: DrizzleDb, input: {
  binding: SchedulerExecutionLeaseBindingV1;
  proof: SchedulerPermitUnusedV1;
  run: typeof runs.$inferSelect;
  task: typeof tasks.$inferSelect;
  sequence: number;
}): Promise<string> {
  const { binding: b, run, task } = input, proof = SchedulerPermitUnusedV1Schema.parse(input.proof);
  if (proof.grant_id !== b.grant_id || proof.journal_namespace !== b.journal_namespace || proof.node_attempt_id !== b.node_attempt_id || run.id !== b.run_id || run.taskId !== task.id || task.id !== b.task_id || task.organizationId !== ctx.organizationId || task.projectId !== b.project_id)
    throw AppError.permissionDenied("Unused permit evidence differs from its original assignment");
  if (run.status !== "queued" || run.startedAt !== null || run.endedAt !== null || task.status !== "assigned")
    throw AppError.conflict("Unused permit closure requires its original never-started queued Run");
  const [previous] = await tx.select({ id: runEventIngest.eventId }).from(runEventIngest).where(eq(runEventIngest.runId, run.id)).limit(1);
  if (previous) throw AppError.conflict("Unused permit closure must be the Run's first qualified receipt");
  const [grant] = await tx.select({ id: schedulerStartGrants.grantId }).from(schedulerStartGrants).where(and(eq(schedulerStartGrants.requestId, b.request_id), eq(schedulerStartGrants.grantId, proof.grant_id), eq(schedulerStartGrants.runId, run.id), eq(schedulerStartGrants.organizationId, ctx.organizationId)));
  const [lease] = await tx.select({ state: schedulerExecutionLeases.state }).from(schedulerExecutionLeases).where(and(eq(schedulerExecutionLeases.id, b.lease_id), eq(schedulerExecutionLeases.organizationId, ctx.organizationId), sql`${schedulerExecutionLeases.binding}=${JSON.stringify(b)}::jsonb`));
  if (!grant || !lease) throw AppError.conflict("Unused permit closure lost its original grant or lease");
  // Fence the logical lease in the receipt transaction too. Closed leases never
  // become active again, and this supplies no permission for a replacement Run.
  if (lease.state === "active") await closeSchedulerExecutionLeaseInTransaction(ctx, tx, b, "revoked");
  const now = ctx.clock.nowIso();
  const scope = { actorType: "system" as const, actorId: b.computer_id, correlationId: b.request_id, projectId: task.projectId, taskId: task.id, roomId: task.roomId, runId: run.id };
  const evidence = buildEvent(ctx, { ...scope, type: "scheduler.permit_unused", sequence: input.sequence, payload: { ...proof, binding: b } });
  await appendEvent(tx, evidence);
  await transitionRun(tx, ctx, { runId: run.id, from: "queued", trigger: "cancel", patch: { endedAt: now } });
  const cancelled = await transitionTask(tx, ctx, { taskId: task.id, from: "assigned", trigger: "cancel", now,
    events: (status) => [buildEvent(ctx, { ...scope, type: "task.updated", payload: { status, cancelled_run_id: run.id, process_never_started: true } })],
  });
  await appendEvent(tx, buildEvent(ctx, { ...scope, type: "run.cancelled", payload: { run_id: run.id, reason: "unused_permit_fenced", process_never_started: true } }));
  await releaseRunLeases(ctx, tx, run.id);
  if (cancelled.changed) await propagateBlocked(ctx, tx, task.id, "run_cancelled");
  return evidence.id;
}
