import type { AddressInfo } from "node:net";

import type {
  CommandAck,
  NodeHeartbeat,
  NodeHello,
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
