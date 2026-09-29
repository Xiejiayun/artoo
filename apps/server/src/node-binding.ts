import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentInstances, contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, ID_PREFIXES } from "@artoo/domain";
import type {
  NodeToServerMessage,
  NodeTransport,
  RunEventMessage,
  RunResumeCommand,
  RunStartCommand,
  RunStopCommand,
  Unsubscribe,
} from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import {
  failRunDaemonDisconnect,
  failRunStart,
  ingestRunEvent,
  type IngestEnvelope,
  type RunIngestEvent,
} from "./services/run-service.js";

const FALLBACK_WORKSPACE_ROOT = join(tmpdir(), "artoo-workspace");

export interface NodeBinding {
  /** Build + send run.start for a queued run over the node transport. */
  dispatchRunStart(runId: string): Promise<void>;
  /** Build + send run.resume for an already-active run (#115 P2-S3 reconnect). */
  dispatchRunResume(runId: string): Promise<void>;
  /** Resolves only after the node has confirmed that the process is stopped. */
  dispatchRunStop(runId: string): Promise<void>;
  /** Deliver frames buffered by the WebSocket authentication handshake. */
  receive(message: NodeToServerMessage): void;
  /** Resolves once all received run-events have been ingested (test sync point). */
  drain(): Promise<void>;
  close(): void;
}

/**
 * Server side of the node protocol. Owns a {@link NodeTransport}: dispatches
 * run.start / run.resume commands, and ingests Node->Server messages — run.event
 * through the same {@link ingestRunEvent} path the dev mock-execute uses,
 * rejected run.start command.ack through {@link failRunStart} recovery, and
 * rejected run.resume command.ack through the daemon_disconnect failure path.
 *
 * Incoming run-events are serialized (the in-process transport delivers them
 * synchronously and the node streams in sequence order) so run/task transitions
 * apply in order. A real artood swaps the in-process transport for a WebSocket;
 * this binding is unchanged.
 */
export function attachNodeBinding(
  ctx: ServerContext,
  transport: NodeTransport,
  computerId: string,
): NodeBinding {
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id (run.start)
  const pendingResumeRun = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
  const pendingStops = new Map<string, { runId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stoppingRuns = new Map<string, Promise<void>>();
  let closed = false;
  async function ownsRun(runId: string): Promise<boolean> {
    const run = (await ctx.db.db.select({ computerId: runs.computerId }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))))[0];
    return run?.computerId === computerId;
  }
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): void => {
    tail = tail.then(work, work).then(
      () => undefined,
      () => undefined,
    );
  };

  const receive = (message: NodeToServerMessage): void => {
    // The credential-bound identity is authoritative for every inbound frame.
    if (closed || message.node_id !== computerId) return;
    if (message.kind === "run.event") {
      const envelope = mapRunEvent(message);
      if (envelope !== null) {
        enqueue(async () => {
          if (!(await ownsRun(envelope.runId))) return;
          let status: "accepted" | "rejected" = "accepted";
          try { await ingestRunEvent(ctx, envelope); } catch { status = "rejected"; }
          await transport.send({
            kind: "command", id: `receipt:${envelope.runId}:${envelope.sequence}`,
            idempotency_key: `receipt:${envelope.runId}:${envelope.sequence}`, type: "run.event.ack",
            payload: { run_id: envelope.runId, sequence: envelope.sequence, status,
              ...(status === "rejected" ? { message: "run event could not be accepted" } : {}),
            },
          });
        });
      }
    } else if (message.kind === "command.ack" && pendingStops.has(message.command_id)) {
      const pending = pendingStops.get(message.command_id)!;
      pendingStops.delete(message.command_id);
      clearTimeout(pending.timer);
      enqueue(async () => {
        if (!(await ownsRun(pending.runId))) pending.reject(AppError.permissionDenied("run is not owned by this node"));
        else if (message.status === "rejected") pending.reject(AppError.conflict(`node could not stop run: ${message.message}`));
        else pending.resolve();
      });
    } else if (message.kind === "command.ack" && message.status === "rejected") {
      const startRunId = pendingCommandRun.get(message.command_id);
      if (startRunId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        enqueue(async () => {
          if (await ownsRun(startRunId)) await failRunStart(ctx, startRunId, message.error_code, message.message);
        });
        return;
      }
      // #115 P2-S3b: a rejected run.resume (node no longer has the process) maps to
      // the same auditable daemon_disconnect failure path — idempotent, and only
      // for a starting/running run on this connected computer.
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        pendingResumeRun.delete(message.command_id);
        clearTimeout(resume.timer);
        // Only explicit process_exited proves absence. Permission/policy errors
        // and malformed/unsupported requests cannot release write leases.
        enqueue(() => failRunDaemonDisconnect(ctx, resume.runId, computerId, message.error_code === "process_exited"));
      }
    } else if (message.kind === "command.ack") {
      // Accepted: no server-side transition (resume just continues the live run).
      pendingCommandRun.delete(message.command_id);
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        clearTimeout(resume.timer);
        // A process may have survived beyond grace expiry. Its run has already
        // failed, so stop that exact process and wait for confirmation before
        // allowing another execution. Do not resurrect the failed run.
        void reconcileSurvivingProcess(resume.runId).catch(() => {});
      }
      pendingResumeRun.delete(message.command_id);
    }
  };
  const unsubscribe: Unsubscribe = transport.subscribe(receive);

  async function reconcileSurvivingProcess(runId: string): Promise<void> {
    const run = (await ctx.db.db.select({ status: runs.status, failureReason: runs.failureReason }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computerId))))[0];
    if (closed || run?.status !== "failed" || run.failureReason !== "daemon_disconnect") return;
    await binding.dispatchRunStop(runId);
    await failRunDaemonDisconnect(ctx, runId, computerId, true);
  }

  const binding: NodeBinding = {
    receive,
    async dispatchRunStart(runId: string): Promise<void> {
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const run = (
        await ctx.db.db
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
      )[0];
      if (run === undefined || run.status !== "queued") {
        return;
      }
      const instance = (
        await ctx.db.db
          .select()
          .from(agentInstances)
          .where(eq(agentInstances.id, run.agentInstanceId))
      )[0];
      const workspaceRoot = run.workspaceRoot ?? instance?.workspaceRoot ?? FALLBACK_WORKSPACE_ROOT;
      // Use the ContextPack persisted at assign time (#21 Part D). The transient
      // fallback only covers legacy/defensive rows with no pack of record.
      const contextPackId = run.contextPackId ?? ctx.idGen.generate(ID_PREFIXES.contextPack);
      const persistedContextPack =
        run.contextPackId === null
          ? undefined
          : (
              await ctx.db.db
                .select()
                .from(contextPacks)
                .where(and(eq(contextPacks.id, run.contextPackId), eq(contextPacks.organizationId, ctx.organizationId)))
            )[0];
      const parsedContextPack =
        persistedContextPack === undefined ? undefined : ContextPackSchema.safeParse(persistedContextPack.payload);
      const commandId = ctx.idGen.generate("cmd");
      pendingCommandRun.set(commandId, runId);

      const command: RunStartCommand = {
        kind: "command",
        id: commandId,
        idempotency_key: `${runId}:start`,
        type: "run.start",
        payload: {
          run_id: runId,
          task_id: run.taskId,
          agent_instance_id: run.agentInstanceId,
          runtime: run.runtimeId,
          // Branch-backed worktree (#23): include `branch` only when the run was
          // assigned one, so artood materializes a worktree; ordinary runs send
          // just `root`. The node worktree-root authorization stays governed by
          // policy_snapshot.filesystem_write_scope = [workspaceRoot] (unchanged) —
          // write_paths narrowing lives in the ContextPack domain, not here.
          workspace: {
            root: workspaceRoot,
            ...(run.workspaceBranch != null ? { branch: run.workspaceBranch } : {}),
          },
          context_pack:
            parsedContextPack?.success === true
              ? { id: contextPackId, payload: parsedContextPack.data }
              : { id: contextPackId, uri: `artoo://contextpack/${contextPackId}` },
          policy_snapshot: {
            filesystem_write_scope: [workspaceRoot],
            requires_approval: ["git.push", "external.post"],
          },
          artifact_rules: { paths: ["artifacts/**", "*.patch"] },
        },
      };
      await transport.send(command);
    },

    // #115 P2-S3: ask a reconnected node to continue an already-active run after a
    // brief disconnect grace window. Only the run id is sent; accepted means no
    // server transition, rejected means the node lost the process and the server
    // fails the run through the daemon_disconnect path.
    async dispatchRunResume(runId: string): Promise<void> {
      if (closed) return;
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const commandId = ctx.idGen.generate("cmd");
      const timer = setTimeout(() => {
        if (closed || !pendingResumeRun.delete(commandId)) return;
        enqueue(async () => {
          await failRunDaemonDisconnect(ctx, runId, computerId);
          // Run the stop outside the ingestion queue: its ACK is itself queued.
          void reconcileSurvivingProcess(runId).catch(() => {});
        });
      }, 15_000);
      pendingResumeRun.set(commandId, { runId, timer });
      const command: RunResumeCommand = {
        kind: "command",
        id: commandId,
        idempotency_key: `${runId}:resume`,
        type: "run.resume",
        payload: { run_id: runId },
      };
      try { await transport.send(command); }
      catch (error) {
        clearTimeout(timer);
        pendingResumeRun.delete(commandId);
        await failRunDaemonDisconnect(ctx, runId, computerId);
        throw error;
      }
    },

    async dispatchRunStop(runId: string): Promise<void> {
      if (closed) throw AppError.conflict("node disconnected before process stop was confirmed");
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const existing = stoppingRuns.get(runId);
      if (existing) return existing;
      const commandId = ctx.idGen.generate("cmd");
      const pending = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingStops.delete(commandId);
          reject(AppError.conflict("node did not confirm process stop; the run and write leases remain active"));
        }, 15_000);
        pendingStops.set(commandId, { runId, resolve, reject, timer });
      });
      void pending.catch(() => {}); // disconnect may reject during transport.send
      stoppingRuns.set(runId, pending);
      const command: RunStopCommand = {
        kind: "command", id: commandId, idempotency_key: `${runId}:stop`,
        type: "run.stop", payload: { run_id: runId, reason: "user_cancelled" },
      };
      try {
        try { await transport.send(command); }
        catch (error) { pendingStops.get(commandId)?.reject(error instanceof Error ? error : new Error(String(error))); }
        await pending;
      } finally {
        const entry = pendingStops.get(commandId);
        if (entry) clearTimeout(entry.timer);
        pendingStops.delete(commandId);
        stoppingRuns.delete(runId);
      }
    },

    async drain(): Promise<void> {
      // Settle the current chain, then re-check in case ingestion enqueued more.
      let previous: Promise<void>;
      do {
        previous = tail;
        await previous;
      } while (previous !== tail);
    },

    close(): void {
      closed = true;
      unsubscribe();
      for (const pending of pendingResumeRun.values()) clearTimeout(pending.timer);
      pendingResumeRun.clear();
      for (const pending of pendingStops.values()) {
        clearTimeout(pending.timer);
        pending.reject(AppError.conflict("node disconnected before process stop was confirmed"));
      }
      pendingStops.clear();
    },
  };
  return binding;
}

/** Map a protocol run.event message to the run-service ingest envelope. */
function mapRunEvent(message: RunEventMessage): IngestEnvelope | null {
  const body = message.event;
  let event: RunIngestEvent | null;
  if (body.type === "run.output") {
    event = { kind: "output", stream: body.payload.stream, text: body.payload.text };
  } else if (body.type === "run.answer") {
    event = { kind: "answer", text: body.payload.text };
  } else if (body.type === "run.usage") {
    event = { kind: "usage", usage: body.payload };
  } else if (body.type === "artifact.created") {
    event = {
      kind: "artifact",
      artifactType: body.payload.type,
      uri: body.payload.uri,
      checksum: body.payload.checksum ?? null,
    };
  } else {
    const phase = body.payload.phase;
    if (phase === "started" || phase === "completed" || phase === "failed" || phase === "cancelled") {
      event = { kind: "lifecycle", phase, failureReason: body.payload.reason ?? undefined };
    } else {
      event = null; // paused/resumed are not part of the v0.1 core loop
    }
  }
  if (event === null) {
    return null;
  }
  return { runId: message.run_id, nodeId: message.node_id, sequence: message.sequence, event };
}
