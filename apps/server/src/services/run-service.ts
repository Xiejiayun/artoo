import { appendEvent, artifacts, messages, runEventIngest, runs, tasks } from "@artoo/db";
import {
  canTransitionRun,
  canTransitionTask,
  ID_PREFIXES,
  type ArtifactType,
  type Run,
  type RunStatus,
  type TaskStatus,
} from "@artoo/domain";
import { and, eq, inArray } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun } from "../mappers.js";
import { enforceGoalBudget } from "./budget-service.js";
import * as dagService from "./dag-service.js";
import { enqueueArtifactForIntegration } from "./integration-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";

/** GET /api/v1/runs/:id — run snapshot. */
export async function getRun(ctx: ServerContext, runId: string): Promise<Run> {
  const row = (
    await ctx.db.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined) {
    throw AppError.notFound(`run not found: ${runId}`, { run_id: runId });
  }
  return mapRun(row);
}

/** POST /api/v1/runs/:id/cancel — cancel a non-terminal run; emits run.cancelled. */
export async function cancelRun(ctx: ServerContext, runId: string): Promise<Run> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const run = (
      await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
    )[0];
    if (run === undefined) {
      throw AppError.notFound(`run not found: ${runId}`, { run_id: runId });
    }
    const from = run.status as RunStatus;
    if (!canTransitionRun(from, "cancel")) {
      throw AppError.invalidState(`cannot cancel run in status '${from}'`, { status: from });
    }
    await transitionRun(tx, ctx, { runId, from, trigger: "cancel", patch: { endedAt: now } });
    const taskRow = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    let taskCancelled = false;
    if (taskRow !== undefined && canTransitionTask(taskRow.status as TaskStatus, "cancel")) {
      const cancelTransition = await transitionTask(tx, ctx, {
        taskId: run.taskId,
        from: taskRow.status as TaskStatus,
        trigger: "cancel",
        now,
        events: (to) => [
          buildEvent(ctx, {
            type: "task.updated",
            actorType: "user",
            actorId: ctx.actorUserId,
            correlationId: run.taskId,
            projectId: taskRow.projectId,
            taskId: run.taskId,
            roomId: taskRow.roomId,
            payload: { status: to, cancelled_run_id: runId },
          }),
        ],
      });
      taskCancelled = cancelTransition.changed;
    }
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "run.cancelled",
        actorType: "user",
        actorId: ctx.actorUserId,
        correlationId: run.taskId,
        projectId: taskRow?.projectId ?? null,
        taskId: run.taskId,
        roomId: taskRow?.roomId ?? null,
        runId,
        payload: { run_id: runId },
      }),
    );
    if (taskCancelled) {
      // The task is now cancelled: signal downstream gating dependents (advisory).
      await dagService.propagateBlocked(ctx, tx, run.taskId, "run_cancelled");
    }
    await releaseRunLeases(ctx, tx, runId);
    const updated = (await tx.select().from(runs).where(eq(runs.id, runId)))[0];
    if (updated === undefined) {
      throw new Error("cancelRun: run missing after transition");
    }
    return mapRun(updated);
  });
}

export type RunIngestEvent =
  | { kind: "lifecycle"; phase: "started" | "completed" | "failed" | "cancelled"; failureReason?: string }
  | { kind: "output"; stream: "stdout" | "stderr"; text: string }
  | { kind: "artifact"; artifactType: ArtifactType; uri: string; checksum?: string | null };

export interface IngestEnvelope {
  runId: string;
  nodeId: string;
  sequence: number;
  event: RunIngestEvent;
}

export interface IngestResult {
  deduped: boolean;
  runStatus: RunStatus;
  taskStatus: TaskStatus;
}

/**
 * Ingest one run event coming from a node (artood). Dedup by
 * (node_id, run_id, sequence); apply the run AND task transitions on the server
 * side (the node never writes task status directly); persist the domain event
 * and, for user-facing milestones, a task-room message. High-frequency stdout
 * becomes a run.output event only (it folds into the run timeline, not chat).
 */
export async function ingestRunEvent(
  ctx: ServerContext,
  env: IngestEnvelope,
): Promise<IngestResult> {
  const now = ctx.clock.nowIso();
  // #115 P3a: captured inside the tx; a terminal run event on a goal-linked task
  // triggers budget enforcement AFTER the ingest commits (below), so a budget
  // hook failure can never break the already-committed run ingest.
  let budgetGoalId: string | null = null;
  const result = await ctx.db.transaction(async (tx) => {
    const run = (
      await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, env.runId), eq(runs.organizationId, ctx.organizationId)))
    )[0];
    if (run === undefined) {
      throw AppError.notFound(`run not found: ${env.runId}`, { run_id: env.runId });
    }
    const taskRow = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    if (taskRow === undefined) {
      throw new Error("ingestRunEvent: task missing for run");
    }
    const roomId = taskRow.roomId;

    const duplicate = await tx
      .select({ eventId: runEventIngest.eventId })
      .from(runEventIngest)
      .where(
        and(
          eq(runEventIngest.nodeId, env.nodeId),
          eq(runEventIngest.runId, env.runId),
          eq(runEventIngest.sequence, env.sequence),
        ),
      );
    if (duplicate.length > 0) {
      return {
        deduped: true,
        runStatus: run.status as RunStatus,
        taskStatus: taskRow.status as TaskStatus,
      };
    }

    const emit = async (
      type: string,
      payload: Record<string, unknown>,
      message?: { kind: string; body: string },
    ): Promise<string> => {
      const event = buildEvent(ctx, {
        type,
        actorType: "agent",
        actorId: run.agentInstanceId,
        correlationId: run.taskId,
        projectId: taskRow.projectId,
        taskId: run.taskId,
        roomId,
        runId: env.runId,
        sequence: env.sequence,
        payload,
      });
      await appendEvent(tx, event);
      if (message !== undefined && roomId !== null) {
        await tx.insert(messages).values({
          id: ctx.idGen.generate(ID_PREFIXES.message),
          organizationId: ctx.organizationId,
          roomId,
          taskId: run.taskId,
          runId: env.runId,
          actorType: "agent",
          actorId: run.agentInstanceId,
          kind: message.kind,
          body: message.body,
          payload,
          createdAt: now,
        });
      }
      return event.id;
    };

    let eventId: string;
    const ev = env.event;
    if (ev.kind === "lifecycle") {
      if (ev.phase === "started") {
        await transitionRun(tx, ctx, { runId: env.runId, from: "queued", trigger: "start", patch: { startedAt: now } });
        await transitionRun(tx, ctx, { runId: env.runId, from: "starting", trigger: "process_started" });
        await transitionTask(tx, ctx, { taskId: run.taskId, from: "assigned", trigger: "run_started", now });
        eventId = await emit("run.started", { run_id: env.runId }, { kind: "run_event", body: "Run started" });
      } else if (ev.phase === "completed") {
        await transitionRun(tx, ctx, { runId: env.runId, from: "running", trigger: "run_completed", patch: { endedAt: now } });
        await transitionTask(tx, ctx, { taskId: run.taskId, from: "running", trigger: "run_completed", now });
        eventId = await emit("run.completed", { run_id: env.runId }, { kind: "run_event", body: "Run completed; task ready for review" });
        await releaseRunLeases(ctx, tx, env.runId);
      } else if (ev.phase === "failed") {
        await transitionRun(tx, ctx, {
          runId: env.runId,
          from: "running",
          trigger: "run_failed",
          patch: { endedAt: now, failureReason: ev.failureReason ?? "unknown" },
        });
        const taskBlocked = await transitionTask(tx, ctx, { taskId: run.taskId, from: "running", trigger: "run_failed", now });
        eventId = await emit("run.failed", { run_id: env.runId, failure_reason: ev.failureReason ?? "unknown" }, { kind: "run_event", body: "Run failed" });
        await releaseRunLeases(ctx, tx, env.runId);
        if (taskBlocked.changed) {
          // The task is now blocked: signal downstream gating dependents (advisory).
          await dagService.propagateBlocked(ctx, tx, run.taskId, `run_failed: ${ev.failureReason ?? "unknown"}`);
        }
      } else {
        await transitionRun(tx, ctx, { runId: env.runId, from: run.status as RunStatus, trigger: "cancel", patch: { endedAt: now } });
        eventId = await emit("run.cancelled", { run_id: env.runId }, { kind: "run_event", body: "Run cancelled" });
        await releaseRunLeases(ctx, tx, env.runId);
      }
    } else if (ev.kind === "output") {
      eventId = await emit("run.output", { stream: ev.stream, text: ev.text });
    } else {
      const artifactId = ctx.idGen.generate(ID_PREFIXES.artifact);
      await tx.insert(artifacts).values({
        id: artifactId,
        organizationId: ctx.organizationId,
        taskId: run.taskId,
        runId: env.runId,
        type: ev.artifactType,
        uri: ev.uri,
        metadata: {},
        checksum: ev.checksum ?? null,
        createdAt: now,
      });
      eventId = await emit(
        "artifact.created",
        { artifact_id: artifactId, type: ev.artifactType, uri: ev.uri },
        { kind: "artifact", body: `Artifact created: ${ev.artifactType}` },
      );
      // Enqueue mergeable artifacts (patch/pull_request) for serialized integration (#20).
      await enqueueArtifactForIntegration(ctx, tx, {
        projectId: taskRow.projectId,
        taskId: run.taskId,
        runId: env.runId,
        artifactId,
        artifactType: ev.artifactType,
      });
    }

    await tx.insert(runEventIngest).values({
      nodeId: env.nodeId,
      runId: env.runId,
      sequence: env.sequence,
      eventId,
      createdAt: now,
    });

    // A terminal run lifecycle on a goal-linked task changes budget usage
    // (retries/cost/concurrency); enforce after commit.
    if (ev.kind === "lifecycle" && ev.phase !== "started") {
      budgetGoalId = taskRow.goalId ?? null;
    }

    const finalRun = (await tx.select().from(runs).where(eq(runs.id, env.runId)))[0];
    const finalTask = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    return {
      deduped: false,
      runStatus: (finalRun?.status ?? run.status) as RunStatus,
      taskStatus: (finalTask?.status ?? taskRow.status) as TaskStatus,
    };
  });
  // Post-commit budget enforcement (#115 P3a). Best-effort: a failure here must
  // not undo the committed run ingest.
  if (budgetGoalId !== null) {
    await enforceGoalBudget(ctx, budgetGoalId).catch(() => {});
  }
  return result;
}

/**
 * Recovery for a rejected run.start (node ack rejected, e.g. process_start_failed):
 * the run never started, so move it queued -> starting -> failed and return the
 * task to ready (assign_failed_retryable) so it can be rescheduled — never stuck.
 */
export async function failRunStart(
  ctx: ServerContext,
  runId: string,
  errorCode: string,
  message: string,
): Promise<void> {
  const now = ctx.clock.nowIso();
  const reason = `${errorCode}: ${message}`;
  await ctx.db.transaction(async (tx) => {
    const run = (
      await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
    )[0];
    if (run === undefined) {
      throw AppError.notFound(`run not found: ${runId}`, { run_id: runId });
    }
    const taskRow = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    await transitionRun(tx, ctx, { runId, from: "queued", trigger: "start", patch: { startedAt: now } });
    await transitionRun(tx, ctx, {
      runId,
      from: "starting",
      trigger: "start_failed",
      patch: { endedAt: now, failureReason: reason },
    });
    await transitionTask(tx, ctx, {
      taskId: run.taskId,
      from: "assigned",
      trigger: "assign_failed_retryable",
      now,
    });
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: "run.failed",
        actorType: "system",
        actorId: "control_plane",
        correlationId: run.taskId,
        projectId: taskRow?.projectId ?? null,
        taskId: run.taskId,
        roomId: taskRow?.roomId ?? null,
        runId,
        payload: { run_id: runId, failure_reason: reason, recoverable: true },
      }),
    );
    await releaseRunLeases(ctx, tx, runId);
  });
}

/**
 * #115 P2-S3 — fail a run whose node did not reconnect within the disconnect
 * grace window. Idempotent and auditable: re-verifies the run is still on this
 * computer and non-terminal (compare-and-set on run status), then fails it with
 * `failureReason="daemon_disconnect"`, matching the existing running/starting
 * failure task-transitions. Repeated close/timeout calls are safe no-ops once the
 * run has left starting/running. Returns whether it actually failed the run.
 *
 * NOTE (dogfood boundary): the grace timer that calls this is in-memory only. On
 * a server restart un-fired timers are lost; recovery is then handled by the
 * #115 S2 resume-service checkpoint reconciliation (a run with no event past the
 * checkpoint's cursor is detected as stale and blocked). A DB-backed grace timer
 * is a later/release-path item, not implemented here.
 */
export async function failRunDaemonDisconnect(
  ctx: ServerContext,
  runId: string,
  computerId: string,
): Promise<{ failed: boolean }> {
  const now = ctx.clock.nowIso();
  const REASON = "daemon_disconnect";
  return ctx.db.transaction(async (tx) => {
    const run = (
      await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
    )[0];
    // Gone, moved to another computer, or already terminal/other → idempotent no-op.
    if (run === undefined || run.computerId !== computerId) return { failed: false };
    const status = run.status as RunStatus;
    if (status !== "starting" && status !== "running") return { failed: false };

    const taskRow = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    const emitFailed = async (): Promise<void> => {
      await appendEvent(
        tx,
        buildEvent(ctx, {
          type: "run.failed",
          actorType: "system",
          actorId: "control_plane",
          correlationId: run.taskId,
          projectId: taskRow?.projectId ?? null,
          taskId: run.taskId,
          roomId: taskRow?.roomId ?? null,
          runId,
          payload: { run_id: runId, failure_reason: REASON, recoverable: true },
        }),
      );
      await releaseRunLeases(ctx, tx, runId);
    };

    if (status === "running") {
      const result = await transitionRun(tx, ctx, { runId, from: "running", trigger: "run_failed", patch: { endedAt: now, failureReason: REASON } });
      if (!result.changed) return { failed: false }; // lost the race → no duplicate event
      const taskBlocked = await transitionTask(tx, ctx, { taskId: run.taskId, from: "running", trigger: "run_failed", now });
      await emitFailed();
      if (taskBlocked.changed) {
        await dagService.propagateBlocked(ctx, tx, run.taskId, `run_failed: ${REASON}`);
      }
      return { failed: true };
    }
    // starting
    const result = await transitionRun(tx, ctx, { runId, from: "starting", trigger: "start_failed", patch: { endedAt: now, failureReason: REASON } });
    if (!result.changed) return { failed: false };
    await transitionTask(tx, ctx, { taskId: run.taskId, from: "assigned", trigger: "assign_failed_retryable", now });
    await emitFailed();
    return { failed: true };
  });
}

/**
 * #115 P2-S3 — snapshot the ids of runs that were active (starting/running) on a
 * computer at disconnect time. The grace window operates on this snapshot;
 * `failRunDaemonDisconnect` re-verifies each at fire time so runs that reached a
 * terminal state or moved are never double-failed.
 */
export async function activeRunIdsForComputer(ctx: ServerContext, computerId: string): Promise<string[]> {
  const rows = await ctx.db.db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, ctx.organizationId),
        eq(runs.computerId, computerId),
        inArray(runs.status, ["starting", "running"]),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * #115 P2-S3 — re-check a disconnect snapshot before sending run.resume. This
 * intentionally filters the snapshot instead of re-listing all active runs on
 * the computer, so a run created after the disconnect is not resumed as if it
 * belonged to the interrupted daemon process set.
 */
export async function activeSnapshotRunIdsForComputer(
  ctx: ServerContext,
  computerId: string,
  runIds: readonly string[],
): Promise<string[]> {
  if (runIds.length === 0) {
    return [];
  }
  const rows = await ctx.db.db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.organizationId, ctx.organizationId),
        eq(runs.computerId, computerId),
        inArray(runs.status, ["starting", "running"]),
        inArray(runs.id, [...runIds]),
      ),
    );
  const active = new Set(rows.map((r) => r.id));
  return runIds.filter((runId) => active.has(runId));
}

/**
 * Dev-only: drive a queued run through the happy path (started -> output ->
 * artifact -> completed) or a failure path (started -> output -> failed),
 * simulating what a node/adapter would stream. Proves the server-side run loop
 * end to end without a live artood.
 */
export async function mockExecuteRun(
  ctx: ServerContext,
  runId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<IngestResult> {
  const nodeId = "computer_local_mock";
  await ingestRunEvent(ctx, { runId, nodeId, sequence: 1, event: { kind: "lifecycle", phase: "started" } });
  await ingestRunEvent(ctx, {
    runId,
    nodeId,
    sequence: 2,
    event: { kind: "output", stream: "stdout", text: "running mock task..." },
  });
  if (outcome === "failed") {
    return ingestRunEvent(ctx, {
      runId,
      nodeId,
      sequence: 3,
      event: { kind: "lifecycle", phase: "failed", failureReason: "mock failure" },
    });
  }
  await ingestRunEvent(ctx, {
    runId,
    nodeId,
    sequence: 3,
    event: { kind: "artifact", artifactType: "report", uri: "file://mock/report.md" },
  });
  return ingestRunEvent(ctx, {
    runId,
    nodeId,
    sequence: 4,
    event: { kind: "lifecycle", phase: "completed" },
  });
}
