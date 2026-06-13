import type {
  AgentInstanceHandle,
  NodeSideTransport,
  NodeErrorCode,
  RunEventMessage,
  RunStartCommand,
  RunStopCommand,
  RuntimeAdapter,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";

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
  adapter: RuntimeAdapter;
}

export interface NodeClient {
  start(): void;
  stop(): Promise<void>;
}

export function createNodeClient(options: NodeClientOptions): NodeClient {
  const { nodeId, transport, adapter } = options;
  const handles = new Map<string, AgentInstanceHandle>();
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
      await ackRejected(command.id, "process_start_failed", errorMessage(err));
      return;
    }
    await ackAccepted(command.id);
    handles.set(payload.run_id, handle);
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
      handles.delete(payload.run_id);
    }
  }

  async function onRunStop(command: RunStopCommand): Promise<void> {
    await ackAccepted(command.id);
    const handle = handles.get(command.payload.run_id);
    if (handle) {
      await adapter.stop(handle, "user_cancelled");
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
