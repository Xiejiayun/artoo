import type {
  NodeHeartbeat,
  NodeHello,
  NodeSideTransport,
  NodeToServerMessage,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";
import { commandSchema } from "@artoo/protocol";

/**
 * Node-side {@link NodeSideTransport} over a WebSocket to `ws /api/v1/node`
 * (WS wire format v0.1). Frames are bare protocol JSON — Node->Server sends
 * node.hello / node.heartbeat / command.ack / run.event, Server->Node delivers
 * `command` (run.start / run.stop / artifact.collect). No custom envelope.
 *
 * node.hello is the first app frame on open (the server registers the transport
 * for dispatch only after hello). Incoming frames are validated with the merged
 * protocol `commandSchema`; unknown/invalid frames are dropped (forward-compat).
 *
 * Production uses the Node built-in global `WebSocket` (no extra dependency); the
 * client impl is injectable for tests. This swaps in for testkit's
 * InProcessTransport behind the unchanged createNodeClient contract.
 */
export interface WebSocketTransportOptions {
  url: string;
  /** node.hello sent as the first app frame on open. */
  hello: NodeHello;
  /** Optional heartbeat producer; when set, a node.heartbeat is sent on an interval. */
  heartbeat?: () => NodeHeartbeat;
  heartbeatIntervalMs?: number;
  /** Injectable WebSocket implementation (defaults to the global WebSocket). */
  WebSocketImpl?: typeof WebSocket;
}

export interface WebSocketNodeTransport extends NodeSideTransport {
  /** Resolves once the socket is open and node.hello has been sent. */
  readonly ready: Promise<void>;
  /** Always present here (overrides the optional base close). */
  close(): Promise<void>;
}

export function createWebSocketTransport(options: WebSocketTransportOptions): WebSocketNodeTransport {
  const WS = options.WebSocketImpl ?? WebSocket;
  const intervalMs = options.heartbeatIntervalMs ?? 10_000;
  const handlers = new Set<(message: ServerToNodeMessage) => void>();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const socket = new WS(options.url);

  const sendRaw = (message: NodeToServerMessage): void => {
    socket.send(JSON.stringify(message));
  };

  socket.addEventListener("open", () => {
    // node.hello must be the first app frame.
    sendRaw(options.hello);
    const beat = options.heartbeat;
    if (beat) {
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WS.OPEN) {
          sendRaw(beat());
        }
      }, intervalMs);
    }
    resolveReady();
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = commandSchema.safeParse(parsed);
    if (!result.success) {
      return;
    }
    for (const handler of [...handlers]) {
      handler(result.data);
    }
  });

  socket.addEventListener("error", () => {
    rejectReady(new Error("websocket error"));
  });

  return {
    ready,
    async send(message: NodeToServerMessage): Promise<void> {
      sendRaw(message);
    },
    subscribe(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async close(): Promise<void> {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      handlers.clear();
      socket.close();
    }
  };
}
