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
  /** Reconnect after an established connection drops; policy rejection is terminal. */
  reconnectDelayMs?: number;
  /** Wait for server commit receipts and replay unacknowledged run events. */
  acknowledgeRunEvents?: boolean;
  /** Deadline from first enqueue for the negotiated retention event receipt. */
  retentionReceiptTimeoutMs?: number;
  onFatalDisconnect?: () => void;
}

export interface WebSocketNodeTransport extends NodeSideTransport {
  readonly connected: boolean;
  /** Resolves once the socket is open and node.hello has been sent. */
  readonly ready: Promise<void>;
  /** Always present here (overrides the optional base close). */
  close(): Promise<void>;
}

export function createWebSocketTransport(options: WebSocketTransportOptions): WebSocketNodeTransport {
  const WS = options.WebSocketImpl ?? WebSocket;
  const acknowledgesRunEvents = options.acknowledgeRunEvents === true;
  const handlers = new Set<(message: ServerToNodeMessage) => void>();
  const pending = new Map<string, { message: NodeToServerMessage; resolve: () => void; reject: (error: Error) => void; retentionTimer?: ReturnType<typeof setTimeout> }>();
  let socket: WebSocket;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let readySettled = false;
  let connectedOnce = false;
  let closed = false;
  let retries = 0;
  let counter = 0;
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const eventKey = (runId: string, sequence: number) => runId + ':' + sequence;
  function settleReady(error?: Error): void {
    if (readySettled) return;
    readySettled = true;
    if (error) rejectReady(error); else resolveReady();
  }
  function clearHeartbeat(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  function settlePending(key: string, error?: Error): void {
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    if (item.retentionTimer) clearTimeout(item.retentionTimer);
    if (error) item.reject(error); else item.resolve();
  }
  function failPending(error: Error): void {
    for (const key of pending.keys()) settlePending(key, error);
  }
  function sendRaw(message: NodeToServerMessage): void {
    if (socket.readyState !== WS.OPEN) throw new Error('websocket is not open');
    socket.send(JSON.stringify(message));
  }
  function flush(): void {
    for (const [key, item] of pending) {
      try { sendRaw(item.message); } catch { return; }
      if (item.message.kind !== 'run.event' || !acknowledgesRunEvents) {
        settlePending(key);
      }
    }
  }
  function connect(): void {
    if (closed) return;
    socket = new WS(options.url);
    const thisSocket = socket;
    thisSocket.addEventListener('open', () => {
      if (closed) { thisSocket.close(); return; }
      connectedOnce = true;
      retries = 0;
      sendRaw(options.hello);
      flush();
      const beat = options.heartbeat;
      if (beat) heartbeatTimer = setInterval(() => {
        if (socket.readyState === WS.OPEN) sendRaw(beat());
      }, options.heartbeatIntervalMs ?? 10_000);
      settleReady();
    });
    thisSocket.addEventListener('message', (event: MessageEvent) => {
      let parsed: unknown;
      try { parsed = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
      const result = commandSchema.safeParse(parsed);
      if (!result.success) return;
      if (result.data.type === 'run.event.ack') {
        const receipt = result.data.payload;
        const key = eventKey(receipt.run_id, receipt.sequence);
        settlePending(key, receipt.status === 'accepted' ? undefined : new Error(receipt.message ?? 'run event rejected'));
        return;
      }
      for (const handler of [...handlers]) handler(result.data);
    });
    thisSocket.addEventListener('error', () => {
      if (!connectedOnce) settleReady(new Error('websocket error'));
    });
    thisSocket.addEventListener('close', (event: CloseEvent) => {
      clearHeartbeat();
      if (closed) return;
      if (!connectedOnce || event.code === 1008) {
        closed = true;
        const error = new Error(!connectedOnce ? 'websocket closed before ready' : 'node credential rejected or revoked');
        settleReady(error);
        failPending(error);
        options.onFatalDisconnect?.();
        return;
      }
      const delay = Math.min((options.reconnectDelayMs ?? 1000) * 2 ** retries++, 10_000);
      reconnectTimer = setTimeout(connect, delay);
    });
  }
  connect();

  return {
    ready,
    acknowledgesRunEvents,
    get connected(): boolean { return !closed && socket.readyState === WS.OPEN; },
    async send(message, delivery): Promise<void> {
      const bestEffort = delivery?.delivery === 'best-effort';
      if (bestEffort && (message.kind !== 'run.event' || message.event.type !== 'run.output')) {
        throw new Error('best-effort delivery is only supported for run.output');
      }
      if (closed) throw new Error('websocket is closed');
      if (bestEffort && message.kind === 'run.event') {
        // An optional frame must not make its ACK settle a required event.
        if (pending.has(eventKey(message.run_id, message.sequence))) {
          throw new Error('best-effort output cannot reuse a pending run event sequence');
        }
        // Optional diagnostics never occupy required receipt/replay capacity.
        if (socket.readyState === WS.OPEN) sendRaw(message);
        return;
      }
      if (message.kind === 'node.heartbeat') {
        if (socket.readyState === WS.OPEN) sendRaw(message);
        return;
      }
      if (pending.size >= 1000) throw new Error('node event delivery buffer is full');
      const key = message.kind === 'run.event' ? eventKey(message.run_id, message.sequence) : 'frame:' + counter++;
      // Never replace a receipt-bearing retention entry under the same key: its
      // deadline and promise belong to that first enqueue, including replays.
      const previous = pending.get(key);
      if (previous && ((message.kind === 'run.event' && message.event.type === 'run.workspace.retained')
        || (previous.message.kind === 'run.event' && previous.message.event.type === 'run.workspace.retained'))) {
        throw new Error('workspace retention event is already pending');
      }
      return new Promise<void>((resolve, reject) => {
        const item: { message: NodeToServerMessage; resolve: () => void; reject: (error: Error) => void; retentionTimer?: ReturnType<typeof setTimeout> } = { message, resolve, reject };
        pending.set(key, item);
        if (message.kind === 'run.event' && message.event.type === 'run.workspace.retained' && acknowledgesRunEvents) {
          const timeoutMs = options.retentionReceiptTimeoutMs ?? 30_000;
          item.retentionTimer = setTimeout(() => {
            settlePending(key, new Error(`workspace retention receipt timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        if (socket.readyState === WS.OPEN) {
          try {
            sendRaw(message);
            if (message.kind !== 'run.event' || !acknowledgesRunEvents) settlePending(key);
          } catch { /* replay after reconnect */ }
        }
      });
    },
    subscribe(handler): Unsubscribe {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    async close(): Promise<void> {
      closed = true;
      clearHeartbeat();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      handlers.clear();
      const error = new Error('websocket closed');
      settleReady(error);
      failPending(error);
      socket.close();
    },
  };
}
