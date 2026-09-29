import type { NodeHeartbeat, NodeHello, RuntimeAdapter } from "@artoo/protocol";

import type { AdapterRegistry } from "./adapter-registry.js";
import type { ArtifactUploader } from "./artifact-upload.js";
import { createRegistryHeartbeat } from "./heartbeat.js";
import { createNodeClient } from "./node-client.js";
import { createWebSocketTransport } from "./ws-transport.js";
import type { GitExecutor, WorkspaceConfig } from "./workspace-binding.js";

/**
 * The artood node daemon: wires a {@link createWebSocketTransport} (real WS to
 * `ws /api/v1/node`) and a runtime (single {@link RuntimeAdapter} or an
 * {@link AdapterRegistry} for multi-runtime) together through {@link createNodeClient}.
 * The same node-client contract drives a real process adapter over a real
 * transport; with a registry, `run.start.runtime` selects the adapter.
 */
export interface ArtoodNodeOptions {
  url: string;
  hello: NodeHello;
  /** Single-runtime mode. Provide this OR registry. */
  adapter?: RuntimeAdapter;
  /** Multi-runtime mode: run.start.runtime selects the adapter. */
  registry?: AdapterRegistry;
  heartbeat?: () => NodeHeartbeat;
  heartbeatIntervalMs?: number;
  /** Node-side workspace materialization config (git worktree mode). */
  workspace?: WorkspaceConfig;
  /** Git executor for worktree materialization; defaults to the real git CLI. */
  git?: GitExecutor;
  WebSocketImpl?: typeof WebSocket;
  uploadArtifact?: ArtifactUploader;
  acknowledgeRunEvents?: boolean;
  reconnectDelayMs?: number;
}

export interface ArtoodNode {
  /** Connects, sends node.hello, and starts dispatching commands to the adapter. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createArtoodNode(options: ArtoodNodeOptions): ArtoodNode {
  let transport: ReturnType<typeof createWebSocketTransport> | null = null;
  let client: ReturnType<typeof createNodeClient> | null = null;

  return {
    async start(): Promise<void> {
      if (transport !== null && client !== null) {
        await transport.ready;
        return;
      }
      // In registry mode, default to a heartbeat that advertises the registered
      // runtimes' capability tags (so the server learns runtime capabilities for
      // scheduling). An explicit `heartbeat` option overrides this escape hatch.
      const heartbeat =
        options.heartbeat ??
        (options.registry
          ? createRegistryHeartbeat({ nodeId: options.hello.node_id, registry: options.registry })
          : undefined);
      transport = createWebSocketTransport({
        url: options.url,
        hello: options.hello,
        heartbeat,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        acknowledgeRunEvents: options.acknowledgeRunEvents,
        reconnectDelayMs: options.reconnectDelayMs,
        onFatalDisconnect: () => { void client?.stop(true); },
        WebSocketImpl: options.WebSocketImpl
      });
      client = createNodeClient({
        nodeId: options.hello.node_id,
        transport,
        adapter: options.adapter,
        registry: options.registry,
        workspace: options.workspace,
        git: options.git,
        uploadArtifact: options.uploadArtifact
      });
      // Subscribe before the connection is registered for dispatch (server only
      // dispatches after node.hello), then wait for open + hello.
      client.start();
      try {
        await transport.ready;
      } catch (err) {
        await client.stop();
        await transport.close();
        client = null;
        transport = null;
        throw err;
      }
    },
    async stop(): Promise<void> {
      const activeTransport = transport;
      // Give a live connection time to commit cancellation events before exit.
      // A disconnected/unresponsive server cannot hold desktop shutdown open.
      if (!activeTransport?.connected) await activeTransport?.close();
      const deadline = setTimeout(() => { void activeTransport?.close(); }, 8000);
      try { await client?.stop(true); }
      finally {
        clearTimeout(deadline);
        await activeTransport?.close();
        client = null;
        transport = null;
      }
    }
  };
}
