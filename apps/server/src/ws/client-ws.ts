import type { FastifyInstance, FastifyRequest } from "fastify";

import type { HubSocket, WsHub } from "./ws-hub.js";

/** The minimal surface of a `ws` WebSocket the client route uses. */
interface RawClientSocket extends HubSocket {
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
}

interface ClientFrame {
  type: "subscribe" | "unsubscribe";
  topics: string[];
}

/**
 * Register the client realtime endpoint `ws /api/v1/ws` (WS wire format v0.1).
 * MVP is dev-auth (single user). Client frames: {type:subscribe|unsubscribe,
 * topics}. The server pushes {type:"event", topic, event:<EventEnvelope>} for
 * each topic a socket subscribes to; the web client invalidates/refetches.
 */
export function registerClientWsRoute(app: FastifyInstance, hub: WsHub): void {
  app.get("/api/v1/ws", { websocket: true }, (socket: unknown, _req: FastifyRequest) => {
    const raw = socket as RawClientSocket;
    hub.add(raw);
    raw.on("message", (data: unknown) => {
      const frame = parseClientFrame(data);
      if (frame === null) {
        return;
      }
      if (frame.type === "subscribe") {
        hub.subscribe(raw, frame.topics);
      } else {
        hub.unsubscribe(raw, frame.topics);
      }
    });
    raw.on("close", () => {
      hub.remove(raw);
    });
  });
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

function parseClientFrame(data: unknown): ClientFrame | null {
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
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const type = (raw as { type?: unknown }).type;
  const topics = (raw as { topics?: unknown }).topics;
  if (
    (type === "subscribe" || type === "unsubscribe") &&
    Array.isArray(topics) &&
    topics.every((topic) => typeof topic === "string")
  ) {
    return { type, topics: topics as string[] };
  }
  return null;
}
