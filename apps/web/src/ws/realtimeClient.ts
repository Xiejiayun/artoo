import type { EventEnvelope } from "@artoo/domain";

/** Minimal WebSocket surface so tests can inject a fake. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
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

  private socket: WebSocketLike | null = null;
  private readonly topics = new Set<string>();
  private open = false;
  private closedByUser = false;

  constructor(options: RealtimeClientOptions) {
    this.url = options.url;
    this.onEvent = options.onEvent;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    this.scheduleTimeout =
      options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
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
    socket.onclose = () => {
      this.open = false;
      this.socket = null;
      if (!this.closedByUser && this.reconnectDelayMs > 0) {
        this.scheduleTimeout(() => this.connect(), this.reconnectDelayMs);
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
    if (!isEventFrame(parsed)) {
      return;
    }
    this.onEvent(parsed.topic, parsed.event);
  }
}

function isEventFrame(value: unknown): value is EventFrame {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "event" &&
    typeof candidate.topic === "string" &&
    typeof candidate.event === "object" &&
    candidate.event !== null
  );
}
