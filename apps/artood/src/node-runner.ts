import type { NodeHeartbeat, NodeHello, RuntimeAdapter } from "@artoo/protocol";

import { createNodeClient } from "./node-client.js";
import { createWebSocketTransport } from "./ws-transport.js";

/**
 * The artood node daemon: wires a {@link createWebSocketTransport} (real WS to
 * `ws /api/v1/node`) and a {@link RuntimeAdapter} together through #6's
 * {@link createNodeClient}. This is the live MockAdapter -> ProcessAdapter
 * handoff — the same node-client contract, now driving a real process adapter
 * over a real transport. The Codex adapter is just a {@link createProcessAdapter}
 * instance passed as `adapter`.
 */
export interface ArtoodNodeOptions {
  url: string;
  hello: NodeHello;
  adapter: RuntimeAdapter;
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
        adapter: options.adapter
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
