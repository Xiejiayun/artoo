import {
  commandAckSchema,
  nodeHeartbeatSchema,
  nodeHelloSchema,
  runEventMessageSchema,
  type NodeToServerMessage,
  type NodeTransport,
  type ServerToNodeMessage,
  type Unsubscribe,
} from "@artoo/protocol";

/** The minimal surface of a `ws` WebSocket we use (avoids a direct ws dep). */
export interface RawServerSocket {
  send(data: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  close(code?: number, reason?: string): void;
}

/**
 * Server-side {@link NodeTransport} over a Fastify WebSocket connection to
 * `ws /api/v1/node`. Frames are bare protocol JSON (WS wire format v0.1):
 * Server->Node sends `command`, Node->Server delivers node.hello / node.heartbeat
 * / command.ack / run.event. Incoming frames are validated by their protocol
 * schema (by `kind`); unknown/invalid frames are dropped (forward-compat).
 */
export function createServerNodeTransport(socket: RawServerSocket): NodeTransport {
  const handlers = new Set<(message: NodeToServerMessage) => void>();

  socket.on("message", (data: unknown) => {
    const message = parseNodeToServer(data);
    if (message === null) {
      return;
    }
    for (const handler of [...handlers]) {
      handler(message);
    }
  });

  return {
    async send(message: ServerToNodeMessage): Promise<void> {
      socket.send(JSON.stringify(message));
    },
    subscribe(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async close(): Promise<void> {
      handlers.clear();
      socket.close();
    },
  };
}

function toText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data !== null && typeof data === "object" && "toString" in data) {
    return String(data);
  }
  return null;
}

/** Validate a raw frame against the protocol Node->Server messages by `kind`. */
export function parseNodeToServer(data: unknown): NodeToServerMessage | null {
  const text = toText(data);
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || !("kind" in raw)) {
    return null;
  }
  const kind = (raw as { kind: unknown }).kind;
  switch (kind) {
    case "node.hello":
      return ok(nodeHelloSchema.safeParse(raw));
    case "node.heartbeat":
      return ok(nodeHeartbeatSchema.safeParse(raw));
    case "command.ack":
      return ok(commandAckSchema.safeParse(raw));
    case "run.event":
      return ok(runEventMessageSchema.safeParse(raw));
    default:
      return null;
  }
}

function ok<T>(result: { success: true; data: T } | { success: false }): T | null {
  return result.success ? result.data : null;
}
