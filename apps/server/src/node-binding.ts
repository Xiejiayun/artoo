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
  Unsubscribe,
} from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "./context.js";
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
  /** Resolves once all received run-events have been ingested (test sync point). */
  drain(): Promise<void>;
  close(): void;
}

/**
 * Server side of the node protocol. Owns a {@link NodeTransport}: dispatches
 * run.start commands, and ingests Node->Server messages — run.event through the
 * same {@link ingestRunEvent} path the dev mock-execute uses, and a rejected
 * command.ack (e.g. process_start_failed) through {@link failRunStart} recovery.
 *
 * Incoming run-events are serialized (the in-process transport delivers them
 * synchronously and the node streams in sequence order) so run/task transitions
 * apply in order. A real artood swaps the in-process transport for a WebSocket;
 * this binding is unchanged.
 */
export function attachNodeBinding(
  ctx: ServerContext,
  transport: NodeTransport,
  computerId?: string,
): NodeBinding {
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id (run.start)
  const pendingResumeRun = new Map<string, string>(); // command_id -> run_id (run.resume, #115 P2-S3b)
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): void => {
    tail = tail.then(work, work).then(
      () => undefined,
      () => undefined,
    );
  };

  const unsubscribe: Unsubscribe = transport.subscribe((message: NodeToServerMessage) => {
    if (message.kind === "run.event") {
      const envelope = mapRunEvent(message);
      if (envelope !== null) {
        enqueue(() => ingestRunEvent(ctx, envelope));
      }
    } else if (message.kind === "command.ack" && message.status === "rejected") {
      const startRunId = pendingCommandRun.get(message.command_id);
      if (startRunId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        enqueue(() => failRunStart(ctx, startRunId, message.error_code, message.message));
        return;
      }
      // #115 P2-S3b: a rejected run.resume (node no longer has the process) maps to
      // the same auditable daemon_disconnect failure path — idempotent, and only
      // for a starting/running run on this connected computer.
      const resumeRunId = pendingResumeRun.get(message.command_id);
      if (resumeRunId !== undefined) {
        pendingResumeRun.delete(message.command_id);
        if (computerId !== undefined) {
          enqueue(() => failRunDaemonDisconnect(ctx, resumeRunId, computerId));
        }
      }
    } else if (message.kind === "command.ack") {
      // Accepted: no server-side transition (resume just continues the live run).
      pendingCommandRun.delete(message.command_id);
      pendingResumeRun.delete(message.command_id);
    }
  });

  return {
    async dispatchRunStart(runId: string): Promise<void> {
      const run = (
        await ctx.db.db
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)))
      )[0];
      if (run === undefined) {
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
    // brief disconnect grace window. Only the run id is sent; the node continues
    // the live process or acks rejected (daemon handling is the S3b gate).
    async dispatchRunResume(runId: string): Promise<void> {
      const commandId = ctx.idGen.generate("cmd");
      pendingResumeRun.set(commandId, runId);
      const command: RunResumeCommand = {
        kind: "command",
        id: commandId,
        idempotency_key: `${runId}:resume`,
        type: "run.resume",
        payload: { run_id: runId },
      };
      await transport.send(command);
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
      unsubscribe();
    },
  };
}

/** Map a protocol run.event message to the run-service ingest envelope. */
function mapRunEvent(message: RunEventMessage): IngestEnvelope | null {
  const body = message.event;
  let event: RunIngestEvent | null;
  if (body.type === "run.output") {
    event = { kind: "output", stream: body.payload.stream, text: body.payload.text };
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
