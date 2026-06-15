import type { NodeHeartbeat, NodeHello, RuntimeAdapter } from "@artoo/protocol";

import type { AdapterRegistry } from "./adapter-registry.js";
import { createNodeClient } from "./node-client.js";
import { createWebSocketTransport } from "./ws-transport.js";

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
  WebSocketImpl?: typeof WebSocket;
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
      transport = createWebSocketTransport({
        url: options.url,
        hello: options.hello,
        heartbeat: options.heartbeat,
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        WebSocketImpl: options.WebSocketImpl
      });
      client = createNodeClient({
        nodeId: options.hello.node_id,
        transport,
        adapter: options.adapter,
        registry: options.registry
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
      await client?.stop();
      await transport?.close();
      client = null;
      transport = null;
    }
  };
}
