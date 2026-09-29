import { appendEvent, artifacts, assistantTurns, messages, runEventIngest, runs, runUsage, tasks } from "@artoo/db";
import {
  canTransitionRun,
  canTransitionTask,
  ID_PREFIXES,
  RunAnswerPayloadSchema,
  RunUsagePayloadSchema,
  type ArtifactType,
  type Run,
  type RunStatus,
  type RunUsagePayload,
  type TaskStatus,
} from "@artoo/domain";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapRun } from "../mappers.js";
import { enforceGoalBudget } from "./budget-service.js";
import * as dagService from "./dag-service.js";
import { enqueueArtifactForIntegration } from "./integration-service.js";
import { releaseRunLeases } from "./lease-service.js";
import { transitionRun, transitionTask } from "./transition-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";

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

/** Provider measurements remain explicitly unknown until the runtime reports them. */
export async function getRunUsage(ctx: ServerContext, runId: string) {
  await getRun(ctx, runId);
  const row = (await ctx.db.db.select().from(runUsage).where(and(eq(runUsage.runId, runId), eq(runUsage.organizationId, ctx.organizationId))))[0];
  return row ? { run_id: runId, input_tokens: row.inputTokens, output_tokens: row.outputTokens,
    cached_input_tokens: row.cachedInputTokens, cost_usd: row.costUsd, currency: row.currency,
    provider_session_id: row.providerSessionId, updated_at: row.updatedAt } : null;
}

/** POST /api/v1/runs/:id/cancel — cancel a non-terminal run; emits run.cancelled. */
export async function cancelRun(ctx: ServerContext, runId: string, stopProcess: () => Promise<void>): Promise<Run> {
  const current = await getRun(ctx, runId);
  if (current.status === "cancelled") return current;
  if (!canTransitionRun(current.status, "cancel")) {
    throw AppError.invalidState(`cannot cancel run in status '${current.status}'`, { status: current.status });
  }
  // Never hold a database transaction while waiting for the external process.
  // Failed/offline stop leaves both status and exclusive write leases intact.
  await stopProcess();
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
    if (from === "cancelled") return mapRun(run);
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
  | { kind: "answer"; text: string }
  | { kind: "usage"; usage: RunUsagePayload }
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
    if (ev.kind === "lifecycle" && ev.phase !== "started" && run.status === "failed" && run.failureReason === "daemon_disconnect") {
      // A disconnect is uncertainty, not evidence of process exit. The owner's
      // eventual terminal event closes that uncertainty and releases its leases.
      eventId = await emit("run.reconciled", { run_id: env.runId, observed_phase: ev.phase, process_exit_confirmed: true });
      await releaseRunLeases(ctx, tx, env.runId);
    } else if (ev.kind === "lifecycle" && ["completed", "failed", "cancelled"].includes(run.status)) {
      // A stop ACK or a prior terminal event may win the race. Commit a receipt
      // for delayed lifecycle frames without changing the settled run/task.
      eventId = await emit("run.reconciled", { run_id: env.runId, observed_phase: ev.phase, settled_status: run.status });
    } else if (ev.kind === "lifecycle") {
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
        if (canTransitionTask(taskRow.status as TaskStatus, "cancel")) {
          await transitionTask(tx, ctx, {
            taskId: run.taskId, from: taskRow.status as TaskStatus, trigger: "cancel", now,
            events: (to) => [buildEvent(ctx, {
              type: "task.updated", actorType: "agent", actorId: run.agentInstanceId,
              correlationId: run.taskId, projectId: taskRow.projectId, taskId: run.taskId,
              roomId, payload: { status: to, cancelled_run_id: env.runId },
            })],
          });
          await dagService.propagateBlocked(ctx, tx, run.taskId, "run_cancelled");
        }
        eventId = await emit("run.cancelled", { run_id: env.runId }, { kind: "run_event", body: "Run cancelled" });
        await releaseRunLeases(ctx, tx, env.runId);
      }
    } else if (ev.kind === "answer") {
      const parsed = RunAnswerPayloadSchema.safeParse({ text: ev.text });
      if (!parsed.success) throw AppError.validation("invalid assistant answer");
      const turn = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.runId, env.runId), eq(assistantTurns.organizationId, ctx.organizationId))).for("update"))[0];
      const responseRoomId = turn?.roomId ?? roomId;
      if (!responseRoomId || turn?.responseMessageId || ["failed", "cancelled"].includes(run.status)) {
        eventId = await emit("run.answer.discarded", { run_id: env.runId, reason: "settled_or_already_answered" });
      } else {
        const messageId = ctx.idGen.generate(ID_PREFIXES.message);
        const payload = { run_id: env.runId, ...(turn ? { assistant_turn_id: turn.id, intent: "assistant" } : {}) };
        await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId,
          threadRootId: turn?.threadRootId ?? null,
          roomId: responseRoomId, taskId: run.taskId, runId: env.runId, actorType: "agent", actorId: run.agentInstanceId,
          kind: "text", body: parsed.data.text, payload, createdAt: now });
        if (turn) await tx.update(assistantTurns).set({ responseMessageId: messageId, updatedAt: now }).where(eq(assistantTurns.id, turn.id));
        const updatedRoot = turn?.threadRootId ? (await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, turn.threadRootId)).returning({ replyCount: messages.replyCount }))[0] : undefined;
        const event = buildEvent(ctx, { type: "message.created", actorType: "agent", actorId: run.agentInstanceId,
          correlationId: turn?.id ?? run.taskId, projectId: taskRow.projectId, taskId: run.taskId, roomId: responseRoomId,
          runId: env.runId, sequence: env.sequence, payload: { message_id: messageId, kind: "text", ...payload, ...(turn?.threadRootId ? { thread_root_id: turn.threadRootId, root_reply_count: updatedRoot!.replyCount } : {}) } });
        await appendEvent(tx, event);
        eventId = event.id;
      }
    } else if (ev.kind === "usage") {
      const parsed = RunUsagePayloadSchema.safeParse(ev.usage);
      if (!parsed.success) throw AppError.validation("invalid provider usage");
      const value = parsed.data;
      const measured = { inputTokens: value.input_tokens, outputTokens: value.output_tokens,
        cachedInputTokens: value.cached_input_tokens, costUsd: value.cost_usd, currency: value.currency,
        providerSessionId: value.provider_session_id, updatedAt: now };
      await tx.insert(runUsage).values({ runId: env.runId, organizationId: ctx.organizationId, ...measured })
        .onConflictDoUpdate({ target: runUsage.runId, set: measured });
      eventId = await emit("run.usage", { ...value });
    } else if (ev.kind === "output") {
      eventId = await emit("run.output", { stream: ev.stream, text: ev.text });
    } else {
      const storedArtifact = (await tx.select().from(artifacts).where(and(
        eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.runId, env.runId), eq(artifacts.uri, ev.uri),
      )))[0];
      if (ev.uri.startsWith("/api/v1/artifacts/") && (!storedArtifact || storedArtifact.checksum !== ev.checksum || storedArtifact.type !== ev.artifactType)) {
        throw AppError.validation("artifact must be uploaded by its execution node before it is announced");
      }
      const artifactId = storedArtifact?.id ?? ctx.idGen.generate(ID_PREFIXES.artifact);
      if (!storedArtifact) await tx.insert(artifacts).values({
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
 * Startup recovery reconstructs grace windows from durable run rows; it does
 * not depend on a goal or checkpoint. A timeout never proves process exit, so
 * leases remain held until the owning node confirms absence or completes stop.
 */
export async function failRunDaemonDisconnect(
  ctx: ServerContext,
  runId: string,
  computerId: string,
  processExitConfirmed = false,
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
    if (status === "failed" && run.failureReason === REASON && processExitConfirmed) {
      await releaseRunLeases(ctx, tx, runId);
      if ((await unconfirmedDisconnectRunIds(ctx, tx, { computerId })).includes(runId)) {
        const task = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
        await appendEvent(tx, buildEvent(ctx, { type: "run.reconciled", actorType: "system", actorId: "control_plane",
          correlationId: run.taskId, projectId: task?.projectId ?? null, taskId: run.taskId, roomId: task?.roomId ?? null, runId,
          payload: { run_id: runId, process_exit_confirmed: true, reason: "owner_confirmed_absent" },
        }));
      }
      return { failed: false };
    }
    if (!["queued", "starting", "running", "paused", "awaiting_input"].includes(status)) return { failed: false };

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
          payload: { run_id: runId, failure_reason: REASON, recoverable: true, process_exit_confirmed: processExitConfirmed },
        }),
      );
      if (processExitConfirmed) await releaseRunLeases(ctx, tx, runId);
    };

    if (status === "running" || status === "paused" || status === "awaiting_input") {
      const result = await transitionRun(tx, ctx, { runId, from: status, trigger: "run_failed", patch: { endedAt: now, failureReason: REASON } });
      if (!result.changed) return { failed: false }; // lost the race → no duplicate event
      const taskStatus = taskRow?.status as TaskStatus;
      const taskBlocked = canTransitionTask(taskStatus, "run_failed")
        ? await transitionTask(tx, ctx, { taskId: run.taskId, from: taskStatus, trigger: "run_failed", now })
        : { changed: false };
      await emitFailed();
      if (taskBlocked.changed) {
        await dagService.propagateBlocked(ctx, tx, run.taskId, `run_failed: ${REASON}`);
      }
      return { failed: true };
    }
    if (status === "queued") await transitionRun(tx, ctx, { runId, from: "queued", trigger: "start" });
    // starting (including a queued run whose dispatch/process state was uncertain)
    const result = await transitionRun(tx, ctx, { runId, from: "starting", trigger: "start_failed", patch: { endedAt: now, failureReason: REASON } });
    if (!result.changed) return { failed: false };
    await transitionTask(tx, ctx, { taskId: run.taskId, from: "assigned", trigger: "assign_failed_retryable", now });
    await emitFailed();
    return { failed: true };
  });
}

/**
 * Snapshot the ids of runs that were active (queued/starting/running) on a
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
        inArray(runs.status, ["queued", "starting", "running", "paused", "awaiting_input"]),
      ),
    );
  return rows.map((r) => r.id);
}

/** Reconcile all uncertain processes, including runs without declared leases. */
export async function unconfirmedProcessRunIdsForComputer(ctx: ServerContext, computerId: string): Promise<string[]> {
  return unconfirmedDisconnectRunIds(ctx, ctx.db.db, { computerId });
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
        inArray(runs.status, ["queued", "starting", "running", "paused", "awaiting_input"]),
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
