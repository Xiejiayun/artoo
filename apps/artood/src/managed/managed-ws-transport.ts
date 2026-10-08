import { createHash, randomUUID } from "node:crypto";
import { commandSchema, MANAGED_RECEIPT_CONTRACT, nodeHelloSchema, runEventMessageSchema,
  type NodeHeartbeat, type NodeHello, type NodeSideTransport, type NodeToServerMessage, type RunEventMessage,
  type ServerToNodeMessage } from "@artoo/protocol";
import { DeliveryCancelled, DeliveryDeadline, DeliveryStopped, monotonicMs,
  type ManagedEventChannel, type ManagedExposureContext, type ManagedSession, type RunDeliveryMode } from "./managed-delivery.js";

const HANDSHAKE_MS = 10000, PROBE_INTERVAL_MS = 10000, PROBE_TIMEOUT_MS = 10000;
const MAX_COMMANDS = 16, MAX_COMMAND_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPTS = 64, MAX_RECEIPT_BYTES = 8 * 1024 * 1024, LATE_OBSERVATION_MS = 30000;
const MAX_LEGACY_EVENTS = 1000, MAX_LEGACY_BYTES = 8 * 1024 * 1024, RETENTION_RECEIPT_MS = 30000;
type Timer = ReturnType<typeof setTimeout>;
interface Generation {
  readonly id: number; readonly socket: WebSocket; readonly nonce: string;
  dead: boolean; usable: boolean; openedAt?: number; session?: ManagedSession;
  readyIdentity?: string; handshakeTimer?: Timer; probeTimer?: Timer; heartbeatTimer?: ReturnType<typeof setInterval>;
  probe?: { id: string; deadline: number; timer: Timer };
  commands: Array<{ message: ServerToNodeMessage; bytes: number }>; commandBytes: number;
}
interface ReceiptObserver {
  generation: Generation; hash: string; bytes: number; exposed: boolean;
  resolve(status: "accepted" | "rejected"): void; reject(error: Error): void; timer: Timer;
}
interface LegacyPendingEvent {
  readonly encoded: string; readonly bytes: number; readonly retention: boolean;
  readonly retentionDeadlineTickMs?: number;
  sentGeneration?: Generation; retentionTimer?: Timer;
  resolve(): void; reject(error: Error): void;
}
export interface ManagedWebSocketOptions {
  url: string; hello: NodeHello; namespace: string; WebSocketImpl?: typeof WebSocket;
  heartbeat?: () => NodeHeartbeat; heartbeatIntervalMs?: number; reconnectDelayMs?: number;
  onSessionLost?: (error: Error, previous: ManagedSession | undefined) => void;
  /** False prevents publication when the runner's previous loss episode expired. */
  onSessionUsable?: (session: ManagedSession) => boolean;
  onFatal?: (error: Error) => void;
  /** Trusted local mixed-run routing; absent keeps the managed-only contract. */
  allowLegacyRuns?: boolean;
}
export interface ManagedWebSocketTransport {
  readonly transport: NodeSideTransport;
  readonly channel: ManagedEventChannel;
  readonly ready: Promise<void>;
  readonly connected: boolean;
  readonly currentSession: ManagedSession | undefined;
  readonly diagnostics: Readonly<{ receiptObservers: number; receiptBytes: number; legacyPendingEvents: number;
    legacyPendingBytes: number; bufferedCommands: number; generation: number }>;
  bindRun(runId: string, mode: RunDeliveryMode): void;
  start(): void;
  close(): Promise<void>;
}

/** One qualified connection; only explicitly bound ordinary runs may replay. */
export function createManagedWebSocketTransport(options: ManagedWebSocketOptions): ManagedWebSocketTransport {
  const url = new URL(options.url);
  if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Managed transport requires a WebSocket URL");
  if (url.protocol !== "wss:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Managed remote transport requires TLS");
  if (!options.namespace) throw new Error("Managed transport requires its configured journal namespace");
  const hello = nodeHelloSchema.parse(JSON.parse(JSON.stringify(options.hello)));
  const WS = options.WebSocketImpl ?? WebSocket;
  const handlers = new Set<(message: ServerToNodeMessage) => void>();
  const receiptObservers = new Map<string, ReceiptObserver>();
  const legacyPending = new Map<string, LegacyPendingEvent>();
  const runModes = new Map<string, RunDeliveryMode>();
  const legacySequences = new Map<string, number>();
  const allowLegacyRuns = options.allowLegacyRuns === true;
  const readiness = new Set<() => void>();
  let receiptBytes = 0, legacyPendingBytes = 0, current: Generation | undefined, generation = 0, reconnect: Timer | undefined;
  let started = false, closed = false, everUsable = false, retries = 0, readySettled = false;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => {});
  const key = (runId: string, sequence: number) => JSON.stringify([options.namespace, hello.node_id, runId, sequence]);
  const isCurrent = (g: Generation) => !closed && !g.dead && current === g;
  const hasCapacity = (bytes = 0) => receiptObservers.size < MAX_RECEIPTS && receiptBytes + bytes <= MAX_RECEIPT_BYTES;
  const wake = () => { for (const listener of [...readiness]) listener(); };
  function settleReady(error?: Error): void {
    if (readySettled) return;
    readySettled = true; if (error) rejectReady(error); else resolveReady();
  }
  function settleReceipt(identity: string, status?: "accepted" | "rejected", error?: Error): void {
    const item = receiptObservers.get(identity);
    if (!item) return;
    receiptObservers.delete(identity); receiptBytes -= item.bytes; clearTimeout(item.timer);
    if (error) item.reject(error); else item.resolve(status!);
    wake();
  }
  function bindRun(runId: string, mode: RunDeliveryMode): void {
    if (closed) throw new DeliveryStopped("Managed transport is closed");
    if (!runId || (mode !== "legacy" && mode !== "managed")) throw new Error("Run delivery binding is invalid");
    if (mode === "legacy" && !allowLegacyRuns) throw new Error("Ordinary runs require mixed routing");
    const previous = runModes.get(runId);
    if (previous !== undefined && previous !== mode) throw new Error("Run delivery mode cannot change");
    runModes.set(runId, mode);
    if (mode === "legacy" && previous === undefined) legacySequences.set(runId, -1);
  }
  function assertRunMode(runId: string, mode: RunDeliveryMode): void {
    if (allowLegacyRuns && runModes.get(runId) !== mode) throw new Error(`Run is not bound to ${mode} delivery`);
  }
  function settleLegacy(identity: string, error?: Error): void {
    const item = legacyPending.get(identity);
    if (!item) return;
    legacyPending.delete(identity); legacyPendingBytes -= item.bytes; clearTimeout(item.retentionTimer);
    if (error) item.reject(error); else item.resolve();
  }
  function failLegacy(error: Error): void {
    for (const identity of legacyPending.keys()) settleLegacy(identity, error);
  }
  function expireLegacyRetention(identity: string, item: LegacyPendingEvent): boolean {
    if (item.retentionDeadlineTickMs === undefined || monotonicMs() < item.retentionDeadlineTickMs) return false;
    settleLegacy(identity, new Error(`workspace retention receipt timed out after ${RETENTION_RECEIPT_MS}ms`));
    return true;
  }
  function sendLegacyPending(g: Generation, identity: string, item: LegacyPendingEvent): void {
    if (legacyPending.get(identity) !== item) return;
    if (!isCurrent(g) || !g.usable || g.socket.readyState !== WS.OPEN || item.sentGeneration === g) return;
    // A delayed timer callback cannot authorize a write beyond the first enqueue deadline.
    if (expireLegacyRetention(identity, item)) return;
    // A synchronous receipt is valid only after this exact entry's send begins.
    item.sentGeneration = g;
    try { g.socket.send(item.encoded); }
    catch { lose(g, new DeliveryStopped("Ordinary event write failed on managed session")); }
  }
  function flushLegacy(g: Generation): void {
    for (const [identity, item] of legacyPending) {
      if (!isCurrent(g) || !g.usable) return;
      sendLegacyPending(g, identity, item);
    }
  }
  async function sendLegacy(frame: RunEventMessage, bestEffort: boolean): Promise<void> {
    if (closed) throw new DeliveryStopped("Managed transport is closed");
    const snapshot = runEventMessageSchema.parse(JSON.parse(JSON.stringify(frame)));
    if (bestEffort && snapshot.event.type !== "run.output") throw new Error("best-effort delivery is only supported for run.output");
    if (snapshot.node_id !== hello.node_id) throw new Error("Ordinary event node identity differs");
    assertRunMode(snapshot.run_id, "legacy");
    const encoded = JSON.stringify(snapshot), bytes = Buffer.byteLength(encoded);
    if (Buffer.byteLength(JSON.stringify(snapshot.event)) > 1024 * 1024) throw new Error("Ordinary event exceeds the bounded payload size");
    if (bytes > MAX_COMMAND_BYTES) throw new Error("Ordinary event frame exceeds the bounded frame size");
    const identity = key(snapshot.run_id, snapshot.sequence), previous = legacyPending.get(identity);
    if (previous) {
      if (bestEffort) throw new Error("best-effort output cannot reuse a pending run event sequence");
      if (previous.retention || snapshot.event.type === "run.workspace.retained") throw new Error("workspace retention event is already pending");
      throw new Error("Ordinary run event sequence is already pending");
    }
    if (!bestEffort && (legacyPending.size >= MAX_LEGACY_EVENTS || legacyPendingBytes + bytes > MAX_LEGACY_BYTES)) {
      throw new DeliveryStopped("node event delivery buffer is full");
    }
    // NodeClient owns a strictly increasing stream. One integer per bound run
    // prevents an old/optional ACK from becoming a receipt for a reused tuple.
    // Only internal replay may resend a previously admitted sequence.
    if (snapshot.sequence <= legacySequences.get(snapshot.run_id)!) throw new Error("Ordinary event sequence must strictly increase");
    legacySequences.set(snapshot.run_id, snapshot.sequence);
    const g = current;
    if (bestEffort) {
      // Optional diagnostics consume no receipt/replay capacity, even offline.
      if (g && isCurrent(g) && g.usable && g.socket.readyState === WS.OPEN) {
        try { g.socket.send(encoded); }
        catch (error) { lose(g, new DeliveryStopped("Ordinary diagnostic write failed on managed session")); throw error; }
      }
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const retention = snapshot.event.type === "run.workspace.retained";
      const item: LegacyPendingEvent = { encoded, bytes, retention,
        retentionDeadlineTickMs: retention ? monotonicMs() + RETENTION_RECEIPT_MS : undefined, resolve, reject };
      legacyPending.set(identity, item); legacyPendingBytes += bytes;
      if (item.retentionDeadlineTickMs !== undefined) item.retentionTimer = setTimeout(() => {
        settleLegacy(identity, new Error(`workspace retention receipt timed out after ${RETENTION_RECEIPT_MS}ms`));
      }, Math.max(0, item.retentionDeadlineTickMs - monotonicMs()));
      if (g) sendLegacyPending(g, identity, item);
    });
  }
  function dispose(g: Generation, error: Error): void {
    g.dead = true; g.usable = false;
    clearTimeout(g.handshakeTimer); clearTimeout(g.probeTimer); clearTimeout(g.probe?.timer); clearInterval(g.heartbeatTimer);
    g.commands.length = 0; g.commandBytes = 0; g.probe = undefined;
    for (const [identity, item] of receiptObservers) if (item.generation === g) settleReceipt(identity, undefined, error);
    for (const item of legacyPending.values()) if (item.sentGeneration === g) item.sentGeneration = undefined;
    try { g.socket.close(); } catch { /* Error is already owned by this closed generation. */ }
  }
  function fatal(error: Error): void {
    if (closed) return;
    closed = true; clearTimeout(reconnect);
    if (current) dispose(current, error);
    failLegacy(error); settleReady(error); wake(); options.onFatal?.(error);
  }
  function lose(g: Generation, error: Error, permanent = false): void {
    if (!isCurrent(g)) return;
    const previous = g.usable ? g.session : undefined;
    if (permanent || !everUsable) { fatal(error); return; }
    dispose(g, error);
    options.onSessionLost?.(error, previous); wake();
    if (closed) return;
    const delay = Math.min((options.reconnectDelayMs ?? 1000) * 2 ** retries++, 10000);
    clearTimeout(reconnect); reconnect = setTimeout(connect, delay);
  }
  function raw(g: Generation, message: NodeToServerMessage): void {
    if (!isCurrent(g) || g.socket.readyState !== WS.OPEN) throw new DeliveryStopped("Managed socket is not open");
    if (message.kind === "run.event") throw new Error("Managed event cannot bypass its exposure entry");
    g.socket.send(JSON.stringify(message));
  }
  function heartbeat(g: Generation): void {
    if (!options.heartbeat) return;
    const message = options.heartbeat();
    if (message.kind !== "node.heartbeat" || message.node_id !== hello.node_id) throw new Error("Managed heartbeat identity differs");
    raw(g, message);
  }
  function assertSession(expected?: ManagedSession): ManagedSession {
    const g = current;
    if (!g || !isCurrent(g) || !g.usable || !g.session || g.socket.readyState !== WS.OPEN) throw new DeliveryStopped("Current managed session is not usable");
    if (expected !== undefined && expected !== g.session) throw new DeliveryStopped("Managed startup session was replaced");
    return g.session;
  }
  function deliver(g: Generation, message: ServerToNodeMessage): void {
    if (!isCurrent(g) || !g.usable) return;
    if (message.deadline_at !== undefined && Date.parse(message.deadline_at) <= Date.now()) {
      try { raw(g, { kind: "command.ack", node_id: hello.node_id, command_id: message.id, status: "rejected",
        error_code: "process_start_failed", message: "Command expired before managed session dispatch" }); }
      catch { lose(g, new DeliveryStopped("Managed expired-command response failed")); }
      return;
    }
    for (const handler of [...handlers]) {
      if (!isCurrent(g) || !g.usable) return;
      handler(message);
    }
  }
  function probe(g: Generation): void {
    if (!isCurrent(g) || !g.session || g.probe) return;
    const id = randomUUID(), now = monotonicMs();
    const deadline = g.usable ? now + PROBE_TIMEOUT_MS : Math.min(now + PROBE_TIMEOUT_MS, g.openedAt! + HANDSHAKE_MS);
    const timer = setTimeout(() => lose(g, new DeliveryStopped("Managed peer probe timed out")), Math.max(0, deadline - now));
    g.probe = { id, deadline, timer };
    try { raw(g, { kind: "node.session.probe", node_id: hello.node_id, session_id: g.session.sessionId, probe_id: id }); }
    catch { lose(g, new DeliveryStopped("Managed session probe write failed")); }
  }
  function onMessage(g: Generation, event: MessageEvent): void {
    if (!isCurrent(g)) return;
    const encoded = typeof event.data === "string" ? event.data : String(event.data);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > MAX_COMMAND_BYTES) { lose(g, new DeliveryStopped("Managed inbound frame exceeds bound"), true); return; }
    let value: unknown;
    try { value = JSON.parse(encoded); } catch { return; }
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "node.session.ready") {
      const p = message.payload;
      if (p.version !== 1 || p.node_id !== hello.node_id || p.hello_nonce !== g.nonce
        || p.receipt_contract !== MANAGED_RECEIPT_CONTRACT || p.sequence_max !== 2147483647
        || p.liveness.probe_interval_ms !== PROBE_INTERVAL_MS || p.liveness.probe_timeout_ms !== PROBE_TIMEOUT_MS) {
        lose(g, new DeliveryStopped("Managed receiver session/profile is incompatible"), true); return;
      }
      const identity = JSON.stringify(p);
      if (g.readyIdentity) {
        if (g.readyIdentity !== identity) lose(g, new DeliveryStopped("Managed receiver changed its ready session"), true);
        return; // Duplicate ready never refreshes any clock.
      }
      if (g.openedAt === undefined || monotonicMs() >= g.openedAt + HANDSHAKE_MS) { lose(g, new DeliveryStopped("Managed handshake expired")); return; }
      g.readyIdentity = identity;
      g.session = Object.freeze({ namespace: options.namespace, nodeId: hello.node_id, generation: g.id,
        sessionId: p.session_id, helloNonce: g.nonce });
      probe(g); return;
    }
    if (message.type === "node.session.pong") {
      const p = message.payload, pending = g.probe;
      if (!pending || !g.session || p.node_id !== hello.node_id || p.session_id !== g.session.sessionId || p.probe_id !== pending.id) return;
      if (monotonicMs() >= pending.deadline) { lose(g, new DeliveryStopped("Managed peer pong arrived after deadline")); return; }
      clearTimeout(pending.timer); g.probe = undefined;
      if (!g.usable) {
        if (monotonicMs() >= g.openedAt! + HANDSHAKE_MS) { lose(g, new DeliveryStopped("Managed handshake expired")); return; }
        g.usable = true;
        try { heartbeat(g); }
        catch { lose(g, new DeliveryStopped("Managed heartbeat operation failed")); return; }
        if (options.onSessionUsable?.(g.session) === false) { fatal(new DeliveryStopped("Managed connection-loss episode already expired")); return; }
        if (!isCurrent(g) || !g.usable) return;
        everUsable = true; retries = 0; clearTimeout(g.handshakeTimer); settleReady();
        if (options.heartbeat) g.heartbeatTimer = setInterval(() => {
          if (!isCurrent(g) || !g.usable) return;
          try { heartbeat(g); }
          catch { lose(g, new DeliveryStopped("Managed heartbeat operation failed")); }
        }, options.heartbeatIntervalMs ?? 10000);
        flushLegacy(g);
        if (!isCurrent(g) || !g.usable) return;
        const queued = g.commands.splice(0); g.commandBytes = 0;
        for (const item of queued) deliver(g, item.message);
        wake();
      }
      clearTimeout(g.probeTimer); g.probeTimer = setTimeout(() => probe(g), PROBE_INTERVAL_MS);
      return;
    }
    if (message.type === "run.event.ack") {
      if (!g.usable) return;
      const identity = key(message.payload.run_id, message.payload.sequence);
      if (allowLegacyRuns) {
        const mode = runModes.get(message.payload.run_id);
        if (mode === "legacy") {
          const item = legacyPending.get(identity);
          if (item?.sentGeneration === g && !expireLegacyRetention(identity, item)) {
            settleLegacy(identity, message.payload.status === "accepted"
              ? undefined : new Error(message.payload.message ?? "run event rejected"));
          }
          return;
        }
        if (mode !== "managed") return;
      }
      const item = receiptObservers.get(identity);
      if (!item || item.generation !== g || !item.exposed) return;
      settleReceipt(identity, message.payload.status); return;
    }
    if (g.usable) { deliver(g, message); return; }
    if (g.commands.length >= MAX_COMMANDS || g.commandBytes + bytes > MAX_COMMAND_BYTES) {
      lose(g, new DeliveryStopped("Managed pre-ready command buffer is full"), true); return;
    }
    g.commands.push({ message, bytes }); g.commandBytes += bytes;
  }
  function connect(): void {
    if (closed) return;
    let socket: WebSocket;
    try { socket = new WS(options.url); }
    catch { fatal(new DeliveryStopped("Managed WebSocket construction failed")); return; }
    const g: Generation = { id: ++generation, socket, nonce: randomUUID(), dead: false, usable: false, commands: [], commandBytes: 0 };
    current = g;
    g.handshakeTimer = setTimeout(() => lose(g, new DeliveryStopped("Managed socket-open deadline expired")), HANDSHAKE_MS);
    socket.addEventListener("open", () => {
      if (!isCurrent(g)) { try { socket.close(); } catch {} return; }
      g.openedAt = monotonicMs();
      clearTimeout(g.handshakeTimer);
      g.handshakeTimer = setTimeout(() => lose(g, new DeliveryStopped("Managed ready/first-pong deadline expired")), HANDSHAKE_MS);
      try { raw(g, { ...hello, managed_receipts: { version: 1, nonce: g.nonce, required_contract: MANAGED_RECEIPT_CONTRACT } }); }
      catch { lose(g, new DeliveryStopped("Managed hello write failed")); }
    });
    socket.addEventListener("message", (event) => onMessage(g, event));
    socket.addEventListener("error", () => lose(g, new DeliveryStopped("Managed WebSocket error")));
    socket.addEventListener("close", (event: CloseEvent) => lose(g,
      new DeliveryStopped(event.code === 1008 ? "Managed node credential/session was rejected" : "Managed WebSocket disconnected"), event.code === 1008));
  }

  const channel: ManagedEventChannel = {
    assertCurrentSession: assertSession,
    waitUntilUsable(deadlineTickMs, signal, requiredBytes = 0) {
      return new Promise<ManagedSession>((resolve, reject) => {
        let timer: Timer | undefined, done = false;
        const finish = (error?: unknown, session?: ManagedSession) => {
          if (done) return; done = true; clearTimeout(timer); readiness.delete(check); signal.removeEventListener("abort", check);
          if (error) reject(error); else resolve(session!);
        };
        const check = () => {
          if (signal.aborted) { finish(signal.reason instanceof Error ? signal.reason : new DeliveryCancelled("Managed readiness cancelled")); return; }
          if (closed) { finish(new DeliveryStopped("Managed transport is closed")); return; }
          if (monotonicMs() >= deadlineTickMs) { finish(new DeliveryDeadline("Managed readiness exceeded original event deadline")); return; }
          if (!hasCapacity(requiredBytes)) return;
          try { finish(undefined, assertSession()); } catch { /* A later qualified generation may recover within the same deadline. */ }
        };
        readiness.add(check); signal.addEventListener("abort", check, { once: true });
        timer = setTimeout(check, Math.max(0, deadlineTickMs - monotonicMs())); check();
      });
    },
    exposeOnce(frame, context: ManagedExposureContext) {
      // No await occurs before this one write. No frame is retained for reconnect.
      try {
        context.signal.throwIfAborted();
        const session = assertSession(), g = current!;
        if (!Number.isSafeInteger(context.deadlineTickMs) || context.deadlineTickMs < 0) throw new Error("Managed exposure deadline is invalid");
        if (context.namespace !== options.namespace || context.nodeId !== hello.node_id || frame.node_id !== hello.node_id
          || context.runId !== frame.run_id || context.sequence !== frame.sequence || !context.eventId || !context.attemptId || !context.clockId) throw new Error("Managed exposure context differs");
        const snapshot = runEventMessageSchema.parse(JSON.parse(JSON.stringify(frame)));
        assertRunMode(snapshot.run_id, "managed");
        const body = JSON.stringify(snapshot.event), encoded = JSON.stringify(snapshot), bytes = Buffer.byteLength(encoded);
        if (Buffer.byteLength(body) > 1024 * 1024 || createHash("sha256").update(body).digest("hex") !== context.contentSha256) throw new Error("Managed frame differs from durable event bytes");
        const identity = key(snapshot.run_id, snapshot.sequence), previous = receiptObservers.get(identity);
        if (previous) throw new Error(previous.hash === context.contentSha256 ? "Managed tuple already has an exposed observer" : "Managed pending tuple body changed");
        if (!hasCapacity(bytes)) throw new DeliveryStopped("Managed receipt observation capacity is full");
        context.signal.throwIfAborted(); assertSession(session);
        if (monotonicMs() >= context.deadlineTickMs) throw new DeliveryDeadline("Managed event expired before exposure");
        return new Promise<"accepted" | "rejected">((resolve, reject) => {
          const timer = setTimeout(() => settleReceipt(identity, undefined, new DeliveryStopped("Managed late receipt observation retired")),
            Math.max(0, context.deadlineTickMs + LATE_OBSERVATION_MS - monotonicMs()));
          const observer: ReceiptObserver = { generation: g, hash: context.contentSha256, bytes, exposed: false, resolve, reject, timer };
          receiptObservers.set(identity, observer); receiptBytes += bytes;
          try {
            context.signal.throwIfAborted(); assertSession(session);
            if (monotonicMs() >= context.deadlineTickMs) throw new DeliveryDeadline("Managed event expired before socket write");
            observer.exposed = true; // send invocation is conservatively a possible exposure.
            g.socket.send(encoded);
          } catch (error) {
            settleReceipt(identity, undefined, error instanceof Error ? error : new DeliveryStopped("Managed event send failed"));
            if (observer.exposed) lose(g, new DeliveryStopped("Managed event write failed after possible exposure"));
          }
        });
      } catch (error) { return Promise.reject(error); }
    },
  };
  const transport: NodeSideTransport = {
    acknowledgesRunEvents: true, // Legacy structural check only; actual admission requires channel session proof.
    async send(message, delivery) {
      if (message.kind === "run.event") {
        if (!allowLegacyRuns) throw new Error("Managed run.event must use a durable one-shot claim, never transport.send");
        return sendLegacy(message, delivery?.delivery === "best-effort");
      }
      if (delivery) throw new Error("Managed control does not support event delivery options");
      if (message.kind === "node.hello" || message.kind === "node.session.probe") throw new Error("Managed hello/probe is transport-owned");
      assertSession(); const g = current!;
      try { raw(g, message); }
      catch { lose(g, new DeliveryStopped("Managed control write failed")); throw new DeliveryStopped("Managed control write failed"); }
    },
    subscribe(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    close: async () => close(),
  };
  function close(): void {
    if (closed) return; closed = true; clearTimeout(reconnect);
    const error = new DeliveryStopped("Managed transport closed");
    if (current) dispose(current, error);
    failLegacy(error); handlers.clear(); settleReady(error); wake();
  }
  return { transport, channel, ready, bindRun,
    get connected() { return Boolean(current && isCurrent(current) && current.usable); },
    get currentSession() { return current && isCurrent(current) && current.usable ? current.session : undefined; },
    get diagnostics() { return Object.freeze({ receiptObservers: receiptObservers.size, receiptBytes,
      legacyPendingEvents: legacyPending.size, legacyPendingBytes,
      bufferedCommands: current?.commands.length ?? 0, generation }); },
    start() { if (started || closed) return; started = true; connect(); },
    async close() { close(); },
  };
}
