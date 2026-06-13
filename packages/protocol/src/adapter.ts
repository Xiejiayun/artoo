import type { ArtifactPayload, RunStartPayload } from "@artoo/domain";

import type { RunEvent } from "./node-messages.js";

/**
 * RuntimeAdapter contract (design.md §5.2, §5.9). The adapter wraps a concrete
 * agent runtime (Codex CLI, a mock coder, …) behind a uniform lifecycle. It
 * emits {@link RunEvent}s carrying @artoo/domain payloads; the node frames each
 * one into a run.event wire message with (node_id, run_id, sequence).
 *
 * v0.1-core requires start / streamEvents / stop / collectArtifacts. detect /
 * pause / resume are optional and degrade per §5.9.
 */
export interface AgentInstanceConfig {
  runId: string;
  taskId: string;
  agentInstanceId: string;
  runtime: string;
  workspaceRoot: string;
  /** Path to the written context_pack.md, when the adapter consumes a file. */
  contextPackPath?: string;
  /** The full domain run.start payload (single source of truth). */
  runStart: RunStartPayload;
}

export interface AgentInstanceHandle {
  readonly runId: string;
}

export type StopReason = "user_cancelled" | "timeout" | "superseded" | "shutdown";

export interface ArtifactDescriptor {
  payload: ArtifactPayload;
  /** Local path the node collected the artifact from, when applicable. */
  localPath?: string;
}

export interface RuntimeAdapter {
  readonly runtimeId: string;
  start(config: AgentInstanceConfig): Promise<AgentInstanceHandle>;
  streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent>;
  stop(handle: AgentInstanceHandle, reason: StopReason): Promise<void>;
  collectArtifacts(handle: AgentInstanceHandle): Promise<ArtifactDescriptor[]>;
  // Optional capabilities (design §5.9 degradation).
  pause?(handle: AgentInstanceHandle): Promise<void>;
  resume?(handle: AgentInstanceHandle): Promise<void>;
}
