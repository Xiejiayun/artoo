import { EventEnvelopeSchema, type EventEnvelope } from "@artoo/domain";

/** WS close code the server uses for a terminal auth failure (#28 slice 3b):
 *  missing/bad/expired/revoked credential, or the pre-auth frame-buffer
 *  overflow. The client must NOT reconnect on this — it re-authenticates. */
export const WS_UNAUTHENTICATED_CODE = 1008;

/** Minimal WebSocket surface so tests can inject a fake. `onclose` receives the
 *  close code so the client can distinguish a terminal 1008 auth failure from a
 *  transport-level drop (1006/1001/…) that should reconnect. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

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
  tokenProvider?: () => string | null | undefined | Promise<string | null | undefined>;
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

function defaultSocketFactory(url: string, protocols?: string[]): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

/**
 * Reconnecting client for `ws /api/v1/ws` (engineer's WS contract). Sends
 * subscribe/unsubscribe frames, dispatches `{type:"event", topic, event}`
 * pushes, and re-subscribes the current topic set on reconnect.
 */
export class RealtimeClient {
  private readonly statusListeners = new Set<() => void>();
  private status: "connecting" | "connected" | "disconnected" | "unauthenticated" = "disconnected";
  getStatus = (): typeof this.status => this.status;
  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  };
  private setStatus(status: typeof this.status): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener());
  }
  private readonly url: string;
  private readonly onEvent: (topic: string, event: EventEnvelope) => void;
  private readonly socketFactory: SocketFactory;
  private readonly reconnectDelayMs: number;
  private readonly scheduleTimeout: (handler: () => void, ms: number) => unknown;
  private readonly onUnauthenticated: () => void;
  private readonly tokenProvider?: RealtimeClientOptions["tokenProvider"];
  private generation = 0;

  private socket: WebSocketLike | null = null;
  private readonly topics = new Map<string, number>();
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
    this.tokenProvider = options.tokenProvider;
  }

  connect(): void {
    if (this.socket !== null || this.unauthenticated) return;
    this.closedByUser = false;
    const generation = ++this.generation;
    this.setStatus("connecting");
    if (generation !== this.generation || this.closedByUser) return;
    if (this.tokenProvider) {
      void Promise.resolve(this.tokenProvider()).then((token) => {
        if (generation !== this.generation || this.closedByUser) return;
        this.openSocket(generation, token ? ["artoo", `artoo-auth.${token}`] : undefined);
      }).catch(() => { if (generation === this.generation) { this.setStatus("unauthenticated"); this.onUnauthenticated(); } });
    } else this.openSocket(generation);
  }

  private openSocket(generation: number, protocols?: string[]): void {
    const socket = this.socketFactory(this.url, protocols);
    this.socket = socket;
    const isCurrent = () => generation === this.generation && this.socket === socket && !this.closedByUser;
    socket.onopen = () => {
      if (!isCurrent() || socket.readyState !== 1) return;
      // Replay before notifying UI listeners, which can close/reconnect this
      // client and remount subscriptions synchronously.
      if (this.topics.size > 0) {
        this.sendFrame({ type: "subscribe", topics: [...this.topics.keys()] });
      }
      this.setStatus("connected");
    };
    socket.onclose = (event) => {
      if (!isCurrent()) return;
      this.socket = null;
      // Terminal auth failure (#28 3b): the server closes 1008 for any
      // missing/bad/expired/revoked credential (and pre-auth buffer overflow).
      // Do NOT reconnect — clear subscriptions and signal the app to route
      // through the #34 auth gate. Transport drops (1006/1001/…) reconnect.
      if (event.code === WS_UNAUTHENTICATED_CODE) {
        this.unauthenticated = true;
        this.topics.clear();
        this.setStatus("unauthenticated");
        this.onUnauthenticated();
        return;
      }
      this.setStatus("disconnected");
      if (generation === this.generation && !this.closedByUser && !this.unauthenticated && this.reconnectDelayMs > 0) {
        this.scheduleTimeout(() => {
          if (generation === this.generation && !this.closedByUser && !this.unauthenticated) {
            this.connect();
          }
        }, this.reconnectDelayMs);
      }
    };
    socket.onerror = () => {
      // Errors are followed by close; reconnect is handled there.
    };
    socket.onmessage = (message) => { if (isCurrent()) this.handleMessage(message.data); };
  }

  subscribe(topics: string[]): void {
    const added = topics.filter((topic) => !this.topics.has(topic));
    for (const topic of new Set(topics)) {
      this.topics.set(topic, (this.topics.get(topic) ?? 0) + 1);
    }
    if (added.length > 0) {
      this.sendFrame({ type: "subscribe", topics: added });
    }
  }

  unsubscribe(topics: string[]): void {
    const removed: string[] = [];
    for (const topic of new Set(topics)) {
      const count = this.topics.get(topic) ?? 0;
      if (count > 1) this.topics.set(topic, count - 1);
      else if (count === 1) { this.topics.delete(topic); removed.push(topic); }
    }
    if (removed.length > 0) {
      this.sendFrame({ type: "unsubscribe", topics: removed });
    }
  }

  close(): void {
    const socket = this.socket;
    this.generation++;
    this.closedByUser = true;
    this.socket = null;
    socket?.close();
    this.setStatus("disconnected");
  }

  private sendFrame(frame: SubscribeFrame): void {
    const socket = this.socket;
    // WebSocket.OPEN is 1. UI status and queued callbacks cannot establish
    // transport readiness; desired topics remain in the map for the next open.
    if (!this.closedByUser && !this.unauthenticated && socket?.readyState === 1) socket.send(JSON.stringify(frame));
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
