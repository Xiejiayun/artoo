import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CommandAck,
  NodeHello,
  NodeToServerMessage,
  RunEventMessage,
  RunStartCommand
} from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createArtoodNode } from "./node-runner.js";
import { createProcessAdapter } from "./process-adapter.js";

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
});

describe("createArtoodNode (WS + ProcessAdapter end-to-end)", () => {
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
