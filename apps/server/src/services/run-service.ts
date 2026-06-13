import { appendEvent, artifacts, messages, runEventIngest, runs, tasks } from "@artoo/db";
import { ID_PREFIXES, type ArtifactType, type RunStatus, type TaskStatus } from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { transitionRun, transitionTask } from "./transition-service.js";

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
  return ctx.db.transaction(async (tx) => {
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
      } else if (ev.phase === "failed") {
        await transitionRun(tx, ctx, {
          runId: env.runId,
          from: "running",
          trigger: "run_failed",
          patch: { endedAt: now, failureReason: ev.failureReason ?? "unknown" },
        });
        await transitionTask(tx, ctx, { taskId: run.taskId, from: "running", trigger: "run_failed", now });
        eventId = await emit("run.failed", { run_id: env.runId, failure_reason: ev.failureReason ?? "unknown" }, { kind: "run_event", body: "Run failed" });
      } else {
        await transitionRun(tx, ctx, { runId: env.runId, from: run.status as RunStatus, trigger: "cancel", patch: { endedAt: now } });
        eventId = await emit("run.cancelled", { run_id: env.runId }, { kind: "run_event", body: "Run cancelled" });
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
    }

    await tx.insert(runEventIngest).values({
      nodeId: env.nodeId,
      runId: env.runId,
      sequence: env.sequence,
      eventId,
      createdAt: now,
    });

    const finalRun = (await tx.select().from(runs).where(eq(runs.id, env.runId)))[0];
    const finalTask = (await tx.select().from(tasks).where(eq(tasks.id, run.taskId)))[0];
    return {
      deduped: false,
      runStatus: (finalRun?.status ?? run.status) as RunStatus,
      taskStatus: (finalTask?.status ?? taskRow.status) as TaskStatus,
    };
  });
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
        taskId: run.taskId,
        roomId: taskRow?.roomId ?? null,
        runId,
        payload: { run_id: runId, failure_reason: reason, recoverable: true },
      }),
    );
  });
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
