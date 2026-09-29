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
import { assertRealWorkspaceScope } from "./process-adapter.js";
import type { ArtifactUploader } from "./artifact-upload.js";
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
 *   run.resume -> command.ack(accepted) only when this client still tracks the
 *                live handle; otherwise command.ack(rejected/process_exited).
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
  uploadArtifact?: ArtifactUploader;
}

export interface NodeClient {
  start(): void;
  stop(cancelRunning?: boolean): Promise<void>;
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
  const starting = new Map<string, Promise<void>>();
  const finished = new Set<string>();
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
    const runId = command.payload.run_id;
    if (starting.has(runId) || runs.has(runId) || finished.has(runId)) {
      await ackAccepted(command.id); // Retries never spawn another writer.
      return;
    }
    let ready!: () => void;
    starting.set(runId, new Promise<void>((resolve) => { ready = resolve; }));
    try {
      await executeStart(command, () => { starting.delete(runId); ready(); });
    } finally {
      starting.delete(runId);
      ready();
    }
  }

  async function executeStart(command: RunStartCommand, ready: () => void): Promise<void> {
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
      if (workspaceConfig.allowedRoots) {
        assertRealWorkspaceScope(plan.root, workspaceConfig.allowedRoots);
        if (plan.kind === "worktree") assertRealWorkspaceScope(plan.baseRepo, workspaceConfig.allowedRoots);
      }
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
    runs.set(payload.run_id, { handle, adapter });
    ready();
    await ackAccepted(command.id);
    let delivered = false;
    let sequence = 0;
    try {
      for await (const rawEvent of adapter.streamEvents(handle)) {
        const event = rawEvent.type === "artifact.created" && options.uploadArtifact
          ? await options.uploadArtifact(payload.run_id, payload.workspace.root, rawEvent) : rawEvent;
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
      delivered = true;
    } catch (error) {
      // Preserve the worktree when a deliverable could not be safely transferred.
      // A delivery error can occur while the process is still writing. Confirm
      // process stop before reporting failure and allowing lease release.
      await adapter.stop(handle, "user_cancelled");
      await transport.send({
        kind: "run.event", node_id: nodeId, run_id: payload.run_id, sequence,
        event: { type: "run.lifecycle", payload: { phase: "failed", reason: errorMessage(error) } },
      }).catch(() => {});
    } finally {
      runs.delete(payload.run_id);
      finished.add(payload.run_id);
      // Preserve recoverable work if any output/artifact could not be delivered.
      if (delivered) await safeCleanup(plan);
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
    await starting.get(command.payload.run_id);
    const run = runs.get(command.payload.run_id);
    if (!run && !finished.has(command.payload.run_id)) {
      // A cancellation can race ahead of run.start. Record the tombstone before
      // acknowledging absence, so a later start for this run cannot spawn.
      finished.add(command.payload.run_id);
      await ackAccepted(command.id);
      return;
    }
    try {
      if (run) await run.adapter.stop(run.handle, "user_cancelled");
      await ackAccepted(command.id);
    } catch (error) {
      await ackRejected(command.id, "process_exited", errorMessage(error));
    }
  }

  // #115 P2-S3b: resume an already-active run after a reconnect. This handler is
  // deliberately narrow: it does not implement WebSocket reconnect or outbound
  // event buffering, and it NEVER rebuilds or starts a process. It only reports
  // whether the run's handle is still live in this client. Alive → ack accepted
  // (the existing streamEvents loop keeps flowing). Lost → ack rejected
  // (process_exited), and the server maps that to the daemon_disconnect path.
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
      case "run.event.ack":
        return; // WebSocket transport owns persisted-event acknowledgements.
    }
  }

  return {
    start(): void {
      unsubscribe = transport.subscribe((message) => {
        const task = dispatch(message);
        inflight.add(task);
        void task.catch(() => {}).finally(() => {
          inflight.delete(task);
        });
      });
    },
    async stop(cancelRunning = false): Promise<void> {
      unsubscribe?.();
      unsubscribe = undefined;
      if (cancelRunning) {
        await Promise.allSettled([...starting.values()]);
        const stopped = await Promise.allSettled([...runs.values()].map((run) => run.adapter.stop(run.handle, "user_cancelled")));
        const failure = stopped.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      await Promise.allSettled([...inflight]);
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : "process start failed";
}
