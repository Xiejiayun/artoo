import type {
  AgentInstanceHandle,
  NodeSideTransport,
  NodeErrorCode,
  RunEventMessage,
  RunStartCommand,
  RunStopCommand,
  RunResumeCommand,
  RuntimeAdapter,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";
import { assertWorkspaceScope } from "@artoo/protocol";

import type { AdapterRegistry } from "./adapter-registry.js";
import {
  cleanupWorkspace,
  createGitCliExecutor,
  materializeWorkspace,
  planWorkspace,
  type GitExecutor,
  type WorkspaceConfig,
  type WorkspacePlan
} from "./workspace-binding.js";

/**
 * `artood` node-protocol client (mock-loop core of task #6).
 *
 * Drives a {@link RuntimeAdapter} in response to Server->Node commands over a
 * {@link NodeSideTransport}, proving the node-side protocol loop:
 *
 *   run.start -> command.ack(accepted) -> adapter.start
 *             -> stream RunEvents as run.event with a per-run monotonic sequence
 *   run.stop  -> command.ack(accepted) -> adapter.stop (the run streams to a
 *               cancelled lifecycle and ends)
 *
 * This is transport- and adapter-agnostic: testkit's in-process channel + mock
 * adapter exercise it here; task #7 swaps in a WebSocket transport + the Codex
 * process adapter without changing this client. Production code depends only on
 * @artoo/protocol — never on any test helper.
 */
export interface NodeClientOptions {
  nodeId: string;
  transport: NodeSideTransport;
  /** Single-runtime mode: handles any run.start.runtime. Provide this OR registry. */
  adapter?: RuntimeAdapter;
  /** Multi-runtime mode: resolves the adapter by run.start.runtime; unknown -> runtime_missing. */
  registry?: AdapterRegistry;
  /** Node-side workspace materialization config (git worktree mode). Default: no worktree support. */
  workspace?: WorkspaceConfig;
  /** Git executor for worktree materialization; defaults to the real git CLI. */
  git?: GitExecutor;
}

export interface NodeClient {
  start(): void;
  stop(): Promise<void>;
}

export function createNodeClient(options: NodeClientOptions): NodeClient {
  const { nodeId, transport } = options;
  if (!options.adapter && !options.registry) {
    throw new Error("createNodeClient requires either an adapter or a registry");
  }
  // run.start.runtime is the only adapter-selection key on the node side — no
  // scheduling or fallback here. Single-adapter mode handles every runtime.
  const resolveAdapter = (runtime: string): RuntimeAdapter | undefined =>
    options.registry ? options.registry.resolve(runtime) : options.adapter;
  const workspaceConfig: WorkspaceConfig = options.workspace ?? {};
  const git: GitExecutor = options.git ?? createGitCliExecutor();
  const runs = new Map<string, { handle: AgentInstanceHandle; adapter: RuntimeAdapter }>();
  const inflight = new Set<Promise<void>>();
  let unsubscribe: Unsubscribe | undefined;

  async function ackAccepted(commandId: string): Promise<void> {
    await transport.send({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "accepted",
      message: null
    });
  }

  async function ackRejected(commandId: string, errorCode: NodeErrorCode, message: string): Promise<void> {
    await transport.send({
      kind: "command.ack",
      node_id: nodeId,
      command_id: commandId,
      status: "rejected",
      error_code: errorCode,
      message
    });
  }

  async function onRunStart(command: RunStartCommand): Promise<void> {
    const payload = command.payload;
    const adapter = resolveAdapter(payload.runtime);
    if (!adapter) {
      await ackRejected(command.id, "runtime_missing", `no adapter for runtime '${payload.runtime}'`);
      return;
    }

    // Prepare the workspace before the adapter starts. A branch-backed run
    // materializes a git worktree at workspace.root; a missing base repo or a
    // failed materialization rejects run.start without ever starting the adapter.
    const planResult = planWorkspace(payload.workspace, workspaceConfig);
    if (!planResult.ok) {
      await ackRejected(command.id, planResult.code, planResult.reason);
      return;
    }
    const plan = planResult.plan;
    try {
      assertWorkspaceScope(plan.root, payload.policy_snapshot.filesystem_write_scope);
      await materializeWorkspace(plan, git);
    } catch (err) {
      await ackRejected(command.id, "process_start_failed", errorMessage(err));
      return;
    }

    let handle: AgentInstanceHandle;
    try {
      handle = await adapter.start({
        runId: payload.run_id,
        taskId: payload.task_id,
        agentInstanceId: payload.agent_instance_id,
        runtime: payload.runtime,
        workspaceRoot: payload.workspace.root,
        runStart: payload
      });
    } catch (err) {
      // The adapter never started: tear down a worktree we just materialized.
      await safeCleanup(plan);
      await ackRejected(command.id, "process_start_failed", errorMessage(err));
      return;
    }
    await ackAccepted(command.id);
    runs.set(payload.run_id, { handle, adapter });
    try {
      let sequence = 0;
      for await (const event of adapter.streamEvents(handle)) {
        const message: RunEventMessage = {
          kind: "run.event",
          node_id: nodeId,
          run_id: payload.run_id,
          sequence: sequence,
          event
        };
        sequence += 1;
        await transport.send(message);
      }
    } finally {
      runs.delete(payload.run_id);
      // Terminal (completed/failed/cancelled): remove a worktree we created.
      await safeCleanup(plan);
    }
  }

  async function safeCleanup(plan: WorkspacePlan): Promise<void> {
    try {
      await cleanupWorkspace(plan, git);
    } catch {
      // Best-effort: the run outcome is already reported, so a worktree that
      // fails to remove must not turn a finished run into a failure.
    }
  }

  async function onRunStop(command: RunStopCommand): Promise<void> {
    await ackAccepted(command.id);
    const run = runs.get(command.payload.run_id);
    if (run) {
      await run.adapter.stop(run.handle, "user_cancelled");
    }
  }

  // #115 P2-S3b: resume an already-active run after a reconnect. This NEVER
  // rebuilds or starts a process — it only reports whether the run's handle is
  // still live here. Alive → ack accepted (the existing streamEvents loop keeps
  // flowing, so nothing else is needed). Lost → ack rejected(process_exited), and
  // the server maps that to the daemon_disconnect failure path.
  async function onRunResume(command: RunResumeCommand): Promise<void> {
    if (runs.has(command.payload.run_id)) {
      await ackAccepted(command.id);
    } else {
      await ackRejected(command.id, "process_exited", `run ${command.payload.run_id} is not active on this node`);
    }
  }

  async function dispatch(message: ServerToNodeMessage): Promise<void> {
    switch (message.type) {
      case "run.start":
        return onRunStart(message);
      case "run.stop":
        return onRunStop(message);
      case "artifact.collect":
        return ackAccepted(message.id);
      case "run.resume":
        return onRunResume(message);
    }
  }

  return {
    start(): void {
      unsubscribe = transport.subscribe((message) => {
        const task = dispatch(message);
        inflight.add(task);
        void task.finally(() => {
          inflight.delete(task);
        });
      });
    },
    async stop(): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.allSettled([...inflight]);
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : "process start failed";
}
