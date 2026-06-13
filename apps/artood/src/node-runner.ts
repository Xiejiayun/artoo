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
}

export interface ArtoodNode {
  /** Connects, sends node.hello, and starts dispatching commands to the adapter. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createArtoodNode(options: ArtoodNodeOptions): ArtoodNode {
  const transport = createWebSocketTransport({
    url: options.url,
    hello: options.hello,
    heartbeat: options.heartbeat,
    heartbeatIntervalMs: options.heartbeatIntervalMs
  });
  const client = createNodeClient({
    nodeId: options.hello.node_id,
    transport,
    adapter: options.adapter
  });

  return {
    async start(): Promise<void> {
      // Subscribe before the connection is registered for dispatch (server only
      // dispatches after node.hello), then wait for open + hello.
      client.start();
      await transport.ready;
    },
    async stop(): Promise<void> {
      await client.stop();
      await transport.close();
    }
  };
}
