import type { AddressInfo } from "node:net";

import type {
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  ProductReleaseHealthMessage,
  RunStartCommand,
  ServerToNodeMessage
} from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { createWebSocketTransport } from "./ws-transport.js";

const hello: NodeHello = {
  kind: "node.hello",
  node_id: "computer_1",
  protocol_version: "2026-06-11",
  artood_version: "0.1.0",
  machine: { hostname: "h", os: "windows", arch: "x64" }
};

const runStart: RunStartCommand = {
  kind: "command",
  id: "cmd_1",
  idempotency_key: "run_1:start",
  type: "run.start",
  payload: {
    run_id: "run_1",
    task_id: "task_1",
    agent_instance_id: "ai_1",
    runtime: "codex",
    workspace: { root: "C:/ws" },
    context_pack: { id: "ctx_1", uri: "inline" },
    policy_snapshot: { filesystem_write_scope: ["C:/ws"], requires_approval: [] },
    artifact_rules: { paths: ["*.patch"] }
  }
};

function healthFrame(): ProductReleaseHealthMessage {
  const digest = `sha256:${"a".repeat(64)}`, at = new Date().toISOString();
  return { kind: "product.release.health", node_id: hello.node_id, payload: { version: 1, event_id: "health_1", sequence: 1,
    request: { version: 1, release_id: "release_1", goal_id: "goal_1", project_id: "project_1", run_id: "run_1",
      release_profile_id: "release", verification_profile_id: "verify", verification_request_id: "request_1",
      verification_profile_digest: digest, subject_digest: digest },
    release_profile_digest: digest, artifact_digest: digest, state: "healthy", active_release_id: "release_1",
    active_artifact_digest: digest, consecutive_failures: 0, health_checks: [{ path: "/", status_code: 200,
      body_digest: digest, passed: true, checked_at: at }], recovery_checks: [], checked_at: at } };
}

async function waitUntil(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  wss: WebSocketServer;
  url: string;
  received: unknown[];
  connection: Promise<WsServerSocket>;
}

async function startServer(): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const received: unknown[] = [];
  const connection = new Promise<WsServerSocket>((resolve) => {
    wss.once("connection", (socket) => {
      socket.on("message", (raw: Buffer) => received.push(JSON.parse(raw.toString())));
      resolve(socket);
    });
  });
  return { wss, url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`, received, connection };
}

let activeServer: WebSocketServer | undefined;
afterEach(() => {
  activeServer?.close();
  activeServer = undefined;
  fakeClientSockets.length = 0;
});

const fakeClientSockets: FakeClientWebSocket[] = [];

class FakeClientWebSocket {
  static readonly OPEN = 1;

  readonly sent: string[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    fakeClientSockets.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  open(): void {
    this.readyState = FakeClientWebSocket.OPEN;
    this.emit("open", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("createWebSocketTransport", () => {
  it("replays a health report after disconnect and waits for its exact committed receipt", async () => {
    const harness = await startServer(); activeServer = harness.wss;
    const reports: ProductReleaseHealthMessage[] = []; let current: WsServerSocket | undefined;
    harness.wss.on("connection", (socket) => {
      current = socket;
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString());
        if (frame.kind !== "product.release.health") return;
        reports.push(frame);
        if (reports.length === 1) socket.close(1012, "interrupted before commit");
      });
    });
    const transport = createWebSocketTransport({ url: harness.url, hello, reconnectDelayMs: 10 });
    try {
      await transport.ready;
      let delivered = false;
      const delivery = transport.send(healthFrame()).then(() => { delivered = true; });
      await waitUntil(() => reports.length === 2);
      expect(delivered).toBe(false); expect(reports[1]).toEqual(reports[0]);
      const ack = { kind: "command", id: "health_ack", idempotency_key: "health_ack", type: "product.release.health.ack",
        payload: { event_id: "other_event", release_id: "release_1", sequence: 1, status: "accepted" } };
      current!.send(JSON.stringify(ack));
      await new Promise((resolve) => setTimeout(resolve, 20)); expect(delivered).toBe(false);
      ack.payload.event_id = "health_1"; current!.send(JSON.stringify(ack));
      await delivery; expect(delivered).toBe(true);
    } finally { await transport.close(); }
  });

  it("expires health receipt waits instead of silently treating a socket write as a commit", async () => {
    const transport = createWebSocketTransport({ url: "ws://fixture.invalid", hello,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket, releaseHealthReceiptTimeoutMs: 20 });
    try {
      fakeClientSockets.at(-1)!.open(); await transport.ready;
      await expect(transport.send(healthFrame())).rejects.toThrow("health receipt timed out");
    } finally { await transport.close(); }
  });
  it("reconnects and replays an unacknowledged terminal event before resolving delivery", async () => {
    const harness = await startServer();
    activeServer = harness.wss;
    const events: unknown[] = [];
    const firstFrames: unknown[] = [];
    let connections = 0;
    harness.wss.on("connection", (socket) => {
      let first = true;
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as { kind: string; run_id: string; sequence: number };
        if (first) { firstFrames.push(frame); first = false; }
        if (frame.kind !== "run.event") return;
        events.push(frame);
        if (events.length === 1) { socket.close(1012, "temporary restart before commit receipt"); return; }
        socket.send(JSON.stringify({
          kind: "command", id: "receipt", idempotency_key: "receipt", type: "run.event.ack",
          payload: { run_id: frame.run_id, sequence: frame.sequence, status: "accepted" },
        }));
      });
    });
    const transport = createWebSocketTransport({ url: harness.url, hello, acknowledgeRunEvents: true, reconnectDelayMs: 10,
      onConnected: () => { connections++; } });
    await transport.ready;
    await transport.send({ kind: "run.event", node_id: hello.node_id, run_id: "run_1", sequence: 9,
      event: { type: "run.lifecycle", payload: { phase: "completed" } },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
    expect(firstFrames).toHaveLength(2);
    expect(connections).toBe(2);
    expect(firstFrames.every((frame) => (frame as { kind: string }).kind === "node.hello")).toBe(true);
    await transport.close();
  });

  it("sends node.hello first, relays Server->Node commands, and frames Node->Server out", async () => {
    const harness = await startServer();
    activeServer = harness.wss;

    const transport = createWebSocketTransport({ url: harness.url, hello });
    await transport.ready;
    const serverSocket = await harness.connection;

    // node.hello is the first frame the server sees
    await waitUntil(() => harness.received.length >= 1);
    expect(harness.received[0]).toMatchObject({ kind: "node.hello", node_id: "computer_1" });

    // Server -> Node command is parsed and delivered to subscribers
    const inbound: ServerToNodeMessage[] = [];
    transport.subscribe((m) => inbound.push(m));
    serverSocket.send(JSON.stringify(runStart));
    await waitUntil(() => inbound.length >= 1);
    expect(inbound[0]).toMatchObject({ type: "run.start", payload: { run_id: "run_1" } });

    // Node -> Server frame goes out as bare protocol JSON
    const ack: CommandAck = {
      kind: "command.ack",
      node_id: "computer_1",
      command_id: "cmd_1",
      status: "accepted",
      message: null
    };
    await transport.send(ack);
    await waitUntil(() => harness.received.length >= 2);
    expect(harness.received.at(-1)).toMatchObject({ kind: "command.ack", status: "accepted" });

    await transport.close();
  });

  it("drops invalid Server->Node frames instead of delivering them", async () => {
    const harness = await startServer();
    activeServer = harness.wss;

    const transport = createWebSocketTransport({ url: harness.url, hello });
    await transport.ready;
    const serverSocket = await harness.connection;

    const inbound: ServerToNodeMessage[] = [];
    transport.subscribe((m) => inbound.push(m));
    serverSocket.send(JSON.stringify({ kind: "command", type: "run.explode", payload: {} }));
    serverSocket.send("not json at all");
    serverSocket.send(JSON.stringify(runStart));
    await waitUntil(() => inbound.length >= 1);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.type).toBe("run.start");

    await transport.close();
  });

  it("emits node.heartbeat on the configured interval", async () => {
    const harness = await startServer();
    activeServer = harness.wss;

    let sequence = 0;
    const transport = createWebSocketTransport({
      url: harness.url,
      hello,
      heartbeatIntervalMs: 15,
      heartbeat: (): NodeHeartbeat => ({
        kind: "node.heartbeat",
        node_id: "computer_1",
        sequence: sequence++,
        resources: { cpu_load: 0.1, memory_used_pct: 20, disk_free_gb: 100 },
        runtimes: [{ runtime: "codex", status: "available", capabilities: [] }],
        running_instances: []
      })
    });
    await transport.ready;
    await harness.connection;

    await waitUntil(() => harness.received.filter((m) => (m as { kind?: string }).kind === "node.heartbeat").length >= 2);
    await transport.close();
  });

  it("rejects ready when the socket closes before open", async () => {
    const transport = createWebSocketTransport({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });
    fakeClientSockets[0]?.close();
    await expect(transport.ready).rejects.toThrow("websocket closed before ready");
  });
});
