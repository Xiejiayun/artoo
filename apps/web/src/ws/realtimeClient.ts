import { EventEnvelopeSchema, type EventEnvelope } from "@artoo/domain";

/** WS close code the server uses for a terminal auth failure (#28 slice 3b):
 *  missing/bad/expired/revoked credential, or the pre-auth frame-buffer
 *  overflow. The client must NOT reconnect on this — it re-authenticates. */
export const WS_UNAUTHENTICATED_CODE = 1008;

/** Minimal WebSocket surface so tests can inject a fake. `onclose` receives the
 *  close code so the client can distinguish a terminal 1008 auth failure from a
 *  transport-level drop (1006/1001/…) that should reconnect. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface RealtimeClientOptions {
  url: string;
  onEvent: (topic: string, event: EventEnvelope) => void;
  socketFactory?: SocketFactory;
  /** Delay before reconnecting after a close. Set 0 to disable auto-reconnect. */
  reconnectDelayMs?: number;
  setTimeoutFn?: (handler: () => void, ms: number) => unknown;
  /** Called once when the server closes the socket with a terminal auth failure
   *  (#28 3b, close code 1008). The app routes the user through the #34 auth
   *  gate; the client stops reconnecting. */
  onUnauthenticated?: () => void;
}

interface SubscribeFrame {
  type: "subscribe" | "unsubscribe";
  topics: string[];
}

interface EventFrame {
  type: "event";
  topic: string;
  event: EventEnvelope;
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Reconnecting client for `ws /api/v1/ws` (engineer's WS contract). Sends
 * subscribe/unsubscribe frames, dispatches `{type:"event", topic, event}`
 * pushes, and re-subscribes the current topic set on reconnect.
 */
export class RealtimeClient {
  private readonly url: string;
  private readonly onEvent: (topic: string, event: EventEnvelope) => void;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly scheduleTimeout: (handler: () => void, ms: number) => unknown;
  private readonly onUnauthenticated: () => void;

  private socket: WebSocketLike | null = null;
  private readonly topics = new Set<string>();
  private open = false;
  private closedByUser = false;
  /** Set once the server closes 1008; suppresses all further reconnects. */
  private unauthenticated = false;

  constructor(options: RealtimeClientOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.scheduleTimeout =
      options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.onUnauthenticated = options.onUnauthenticated ?? (() => undefined);
  }

  connect(): void {
    this.closedByUser = false;
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.open = true;
      // (Re)subscribe to the full current topic set.
      if (this.topics.size > 0) {
        this.sendFrame({ type: "subscribe", topics: [...this.topics] });
      }
    };
    socket.onclose = (event) => {
      this.open = false;
      this.socket = null;
      // Terminal auth failure (#28 3b): the server closes 1008 for any
      // missing/bad/expired/revoked credential (and pre-auth buffer overflow).
      // Do NOT reconnect — clear subscriptions and signal the app to route
      // through the #34 auth gate. Transport drops (1006/1001/…) reconnect.
      if (event.code === WS_UNAUTHENTICATED_CODE) {
        this.unauthenticated = true;
        this.topics.clear();
        this.onUnauthenticated();
        return;
      }
      if (!this.closedByUser && !this.unauthenticated && this.reconnectDelayMs > 0) {
        this.scheduleTimeout(() => {
          if (!this.closedByUser && !this.unauthenticated) {
            this.connect();
          }
        }, this.reconnectDelayMs);
      }
    };
    socket.onerror = () => {
      // Errors are followed by close; reconnect is handled there.
    };
    socket.onmessage = (message) => this.handleMessage(message.data);
  }

  subscribe(topics: string[]): void {
    const added = topics.filter((topic) => !this.topics.has(topic));
    for (const topic of added) {
      this.topics.add(topic);
    }
    if (this.open && added.length > 0) {
      this.sendFrame({ type: "subscribe", topics: added });
    }
  }

  unsubscribe(topics: string[]): void {
    const removed = topics.filter((topic) => this.topics.has(topic));
    for (const topic of removed) {
      this.topics.delete(topic);
    }
    if (this.open && removed.length > 0) {
      this.sendFrame({ type: "unsubscribe", topics: removed });
    }
  }

  close(): void {
    this.closedByUser = true;
    this.open = false;
    this.socket?.close();
    this.socket = null;
  }

  private sendFrame(frame: SubscribeFrame): void {
    this.socket?.send(JSON.stringify(frame));
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames defensively
    }
    const frame = parseEventFrame(parsed);
    if (frame === null) {
      return;
    }
    this.onEvent(frame.topic, frame.event);
  }
}

function parseEventFrame(value: unknown): EventFrame | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "event" ||
    typeof candidate.topic !== "string" ||
    typeof candidate.event !== "object" ||
    candidate.event === null
  ) {
    return null;
  }
  const event = EventEnvelopeSchema.safeParse(candidate.event);
  if (!event.success) {
    return null;
  }
  return { type: "event", topic: candidate.topic, event: event.data };
}
