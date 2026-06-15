import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  NodeToServerMessage,
  RuntimeAdapter,
  RunEventMessage,
  RunStartCommand
} from "@artoo/protocol";
import { nodeHeartbeatSchema } from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createAdapterRegistry } from "./adapter-registry.js";
import { createArtoodNode } from "./node-runner.js";
import { createProcessAdapter } from "./process-adapter.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";

const fixture = fileURLToPath(new URL("../test-fixtures/mock-agent.mjs", import.meta.url));

const hello: NodeHello = {
  kind: "node.hello",
  node_id: "computer_1",
  protocol_version: "2026-06-11",
  artood_version: "0.1.0",
  machine: { hostname: "h", os: "windows", arch: "x64" }
};

function makeRunStart(workspace: string): RunStartCommand {
  return {
    kind: "command",
    id: "cmd_1",
    idempotency_key: "run_1:start",
    type: "run.start",
    payload: {
      run_id: "run_1",
      task_id: "task_1",
      agent_instance_id: "ai_1",
      runtime: "codex",
      workspace: { root: workspace },
      context_pack: { id: "ctx_1", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] },
      artifact_rules: { paths: ["*.patch"] }
    }
  };
}

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}
function isAck(m: NodeToServerMessage): m is CommandAck {
  return m.kind === "command.ack";
}

async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let activeServer: WebSocketServer | undefined;
afterEach(() => {
  activeServer?.close();
  activeServer = undefined;
  fakeClientSockets.length = 0;
});

const idleAdapter: RuntimeAdapter = {
  runtimeId: "idle",
  async start(config) {
    return { runId: config.runId };
  },
  async *streamEvents() {},
  async stop() {},
  async collectArtifacts() {
    return [];
  }
};

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

describe("createArtoodNode (WS + ProcessAdapter end-to-end)", () => {
  it("does not open the WebSocket until start is called", async () => {
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      adapter: idleAdapter,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });

    expect(fakeClientSockets).toHaveLength(0);
    const started = node.start();
    expect(fakeClientSockets).toHaveLength(1);
    fakeClientSockets[0]?.open();
    await started;
    expect(fakeClientSockets[0]?.sent[0]).toBe(JSON.stringify(hello));

    await node.stop();
  });

  it("runs the full node loop: hello -> run.start -> process adapter -> run.event -> completed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "artoo-node-"));
    try {
      const wss = new WebSocketServer({ port: 0 });
      activeServer = wss;
      await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
      const port = (wss.address() as AddressInfo).port;

      const received: NodeToServerMessage[] = [];
      wss.once("connection", (socket) => {
        socket.on("message", (raw: Buffer) => {
          const message = JSON.parse(raw.toString()) as NodeToServerMessage;
          received.push(message);
          // Server dispatches run.start only after node.hello (registration rule).
          if (message.kind === "node.hello") {
            socket.send(JSON.stringify(makeRunStart(workspace)));
          }
        });
      });

      const adapter = createProcessAdapter({
        command: [process.execPath, fixture, "--workspace", "{{workspace_root}}", "--context", "{{context_pack_path}}"],
        allowedRoots: [workspace],
        artifacts: [{ type: "patch", path: "changes.patch" }]
      });
      const node = createArtoodNode({ url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`, hello, adapter });
      await node.start();

      await waitUntil(() =>
        received.some(
          (m) => isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed"
        )
      );

      const acks = received.filter(isAck);
      const runEvents = received.filter(isRunEvent);

      expect(acks[0]).toMatchObject({ status: "accepted", command_id: "cmd_1" });
      // sequence is per-run monotonic from 0
      expect(runEvents.map((e) => e.sequence)).toEqual(runEvents.map((_, i) => i));
      expect(runEvents.every((e) => e.run_id === "run_1" && e.node_id === "computer_1")).toBe(true);
      expect(runEvents.some((e) => e.event.type === "artifact.created")).toBe(true);
      expect(runEvents.at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });

      await node.stop();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("createArtoodNode registry heartbeat wiring", () => {
  function heartbeatFrames(socket: FakeClientWebSocket): NodeToServerMessage[] {
    return socket.sent
      .map((s) => JSON.parse(s) as NodeToServerMessage)
      .filter((m) => m.kind === "node.heartbeat");
  }

  it("auto-wires a heartbeat advertising registry capability tags in registry mode", async () => {
    const registry = createAdapterRegistry([
      codexRuntime({ allowedRoots: ["/ws"] }),
      claudeCodeRuntime({ allowedRoots: ["/ws"] })
    ]);
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      registry,
      heartbeatIntervalMs: 5,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });
    const started = node.start();
    fakeClientSockets[0]?.open();
    await started;

    const socket = fakeClientSockets[0]!;
    await waitUntil(() => heartbeatFrames(socket).length > 0);
    const parsed = nodeHeartbeatSchema.parse(heartbeatFrames(socket)[0]);
    expect(parsed.node_id).toBe("computer_1");
    expect(parsed.runtimes).toEqual([
      { runtime: "codex", status: "available", capabilities: ["code.read", "code.modify"] },
      {
        runtime: "claude-code",
        status: "available",
        capabilities: ["code.read", "code.modify", "code.review"]
      }
    ]);

    await node.stop();
  });

  it("lets an explicit heartbeat option override the registry default", async () => {
    const registry = createAdapterRegistry([codexRuntime({ allowedRoots: ["/ws"] })]);
    const explicit = (): NodeHeartbeat => ({
      kind: "node.heartbeat",
      node_id: "computer_1",
      sequence: 0,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 0 },
      runtimes: [],
      running_instances: []
    });
    const node = createArtoodNode({
      url: "ws://example.invalid/api/v1/node?token=dev",
      hello,
      registry,
      heartbeat: explicit,
      heartbeatIntervalMs: 5,
      WebSocketImpl: FakeClientWebSocket as unknown as typeof WebSocket
    });
    const started = node.start();
    fakeClientSockets[0]?.open();
    await started;

    const socket = fakeClientSockets[0]!;
    await waitUntil(() => heartbeatFrames(socket).length > 0);
    // Empty runtimes proves the explicit producer was used, not the registry default.
    expect(nodeHeartbeatSchema.parse(heartbeatFrames(socket)[0]).runtimes).toEqual([]);

    await node.stop();
  });
});
