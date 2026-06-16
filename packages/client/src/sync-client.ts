/**
 * @artoo/client — the canonical shared client SDK for artoo's realtime sync
 * contract (#27 v2-B). One contract source consumed by every platform shell
 * (Web, Windows/macOS desktop, Android, iOS) so clients never reinvent sync.
 *
 * Slice 1: WS recovery. The server tags every realtime push with a monotonic
 * `cursor` (event_log.position). This SDK tracks the highest cursor, dedupes
 * events by id, and on (re)connect subscribes with `since_cursor` so a client
 * that was offline catches up exactly. No IO here beyond an injected transport.
 */
import type { EventEnvelope } from "@artoo/domain";

/** Server -> client realtime push frame. */
export interface ServerEventFrame {
  type: "event";
  topic: string;
  event: EventEnvelope;
  cursor: number;
}

/** Client -> server subscribe frame (since_cursor omitted means "live only"). */
export interface SubscribeFrame {
  type: "subscribe";
  topics: string[];
  since_cursor?: number;
}

export function buildSubscribeFrame(
  topics: readonly string[],
  sinceCursor: number,
): SubscribeFrame {
  const frame: SubscribeFrame = { type: "subscribe", topics: [...topics] };
  if (sinceCursor > 0) {
    frame.since_cursor = sinceCursor;
  }
  return frame;
}

/**
 * Pure sync state: tracks the highest cursor and dedupes events by id, so
 * catch-up/live overlap (or an event delivered under multiple subscribed topics)
 * is surfaced exactly once. `cursor()` is the reconnect `since_cursor`.
 */
export class SyncState {
  private readonly seen = new Set<string>();
  private maxCursor = 0;

  /** Accept a raw frame; returns {event, cursor} to emit, or null to skip. */
  accept(raw: unknown): { event: EventEnvelope; cursor: number } | null {
    if (raw === null || typeof raw !== "object") {
      return null;
    }
    const frame = raw as Partial<ServerEventFrame>;
    if (frame.type !== "event" || typeof frame.cursor !== "number" || frame.event == null) {
      return null;
    }
    if (frame.cursor > this.maxCursor) {
      this.maxCursor = frame.cursor;
    }
    const id = frame.event.id;
    if (typeof id !== "string" || this.seen.has(id)) {
      return null;
    }
    this.seen.add(id);
    return { event: frame.event, cursor: frame.cursor };
  }

  cursor(): number {
    return this.maxCursor;
  }
}

/** The minimal transport the sync client drives (a WebSocket, or a test double). */
export interface SyncTransport {
  send(data: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface SyncClientOptions {
  topics: readonly string[];
  /** Open a transport. Called on start and after each disconnect (reconnect). */
  connect: () => SyncTransport;
  onEvent: (event: EventEnvelope, cursor: number) => void;
  /**
   * Schedule a reconnect after a drop. Default reconnects immediately; inject to
   * control timing/backoff (or pass a no-op to disable auto-reconnect).
   */
  schedule?: (reconnect: () => void) => void;
}

export interface SyncClient {
  start(): void;
  stop(): void;
  /** Highest cursor processed so far (the reconnect since_cursor). */
  cursor(): number;
}

/**
 * A reconnecting realtime sync client over the #27 WS recovery contract. On every
 * (re)connect it subscribes with the latest cursor, so reconnection catches up the
 * gap; events are deduped by id across the catch-up/live boundary.
 */
export function createSyncClient(opts: SyncClientOptions): SyncClient {
  const state = new SyncState();
  const schedule = opts.schedule ?? ((reconnect): void => reconnect());
  let transport: SyncTransport | null = null;
  let stopped = false;

  function open(): void {
    if (stopped) {
      return;
    }
    const t = opts.connect();
    transport = t;
    t.onMessage((data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return;
      }
      const out = state.accept(raw);
      if (out !== null) {
        opts.onEvent(out.event, out.cursor);
      }
    });
    t.onClose(() => {
      if (!stopped) {
        schedule(open);
      }
    });
    t.send(JSON.stringify(buildSubscribeFrame(opts.topics, state.cursor())));
  }

  return {
    start(): void {
      open();
    },
    stop(): void {
      stopped = true;
      transport?.close();
    },
    cursor(): number {
      return state.cursor();
    },
  };
}
