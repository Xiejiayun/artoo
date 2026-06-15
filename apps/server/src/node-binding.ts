import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentInstances, runs } from "@artoo/db";
import { ID_PREFIXES } from "@artoo/domain";
import type {
  NodeToServerMessage,
  NodeTransport,
  RunEventMessage,
  RunStartCommand,
  Unsubscribe,
} from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "./context.js";
import {
  failRunStart,
  ingestRunEvent,
  type IngestEnvelope,
  type RunIngestEvent,
} from "./services/run-service.js";

const FALLBACK_WORKSPACE_ROOT = join(tmpdir(), "artoo-workspace");

export interface NodeBinding {
  /** Build + send run.start for a queued run over the node transport. */
  dispatchRunStart(runId: string): Promise<void>;
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
export function attachNodeBinding(ctx: ServerContext, transport: NodeTransport): NodeBinding {
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id
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
      const runId = pendingCommandRun.get(message.command_id);
      if (runId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        enqueue(() => failRunStart(ctx, runId, message.error_code, message.message));
      }
    } else if (message.kind === "command.ack") {
      pendingCommandRun.delete(message.command_id);
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
      const workspaceRoot = instance?.workspaceRoot ?? FALLBACK_WORKSPACE_ROOT;
      // Use the ContextPack persisted at assign time (#21 Part D). The transient
      // fallback only covers legacy/defensive rows with no pack of record.
      const contextPackId = run.contextPackId ?? ctx.idGen.generate(ID_PREFIXES.contextPack);
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
          workspace: { root: workspaceRoot },
          context_pack: { id: contextPackId, uri: `artoo://contextpack/${contextPackId}` },
          policy_snapshot: {
            filesystem_write_scope: [workspaceRoot],
            requires_approval: ["git.push", "external.post"],
          },
          artifact_rules: { paths: ["artifacts/**", "*.patch"] },
        },
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
