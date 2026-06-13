import type {
  CommandAck,
  NodeToServerMessage,
  RunEventMessage,
  RunStartCommand,
  RunStopCommand,
  RuntimeAdapter
} from "@artoo/protocol";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
import { describe, expect, it } from "vitest";

import { createNodeClient } from "./node-client.js";

const runStartCommand: RunStartCommand = {
  kind: "command",
  id: "cmd_start_1",
  idempotency_key: "run_1:start",
  type: "run.start",
  payload: {
    run_id: "run_1",
    task_id: "task_1",
    agent_instance_id: "ai_1",
    runtime: "mock-coder",
    workspace: { root: "C:/workspace/artoo" },
    context_pack: { id: "ctx_1", uri: "inline" },
    policy_snapshot: { filesystem_write_scope: ["C:/workspace/artoo"], requires_approval: [] },
    artifact_rules: { paths: ["*.patch"] }
  }
};

const runStopCommand: RunStopCommand = {
  kind: "command",
  id: "cmd_stop_1",
  idempotency_key: "run_1:stop",
  type: "run.stop",
  payload: { run_id: "run_1", reason: "user_cancelled" }
};

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}
function isAck(m: NodeToServerMessage): m is CommandAck {
  return m.kind === "command.ack";
}

describe("artood node client (mock loop)", () => {
  it("acks run.start and streams a monotonic run.event sequence to completion", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["compiling", "tests passed"] });
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, adapter });
    client.start();

    const received: NodeToServerMessage[] = [];
    const done = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed") {
          resolve();
        }
      });
    });

    await channel.serverTransport.send(runStartCommand);
    await done;
    await client.stop();

    const acks = received.filter(isAck);
    const runEvents = received.filter(isRunEvent);

    expect(acks.map((a) => a.status)).toEqual(["accepted"]);
    expect(acks[0]?.command_id).toBe("cmd_start_1");
    expect(runEvents.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(runEvents.every((e) => e.node_id === "computer_1" && e.run_id === "run_1")).toBe(true);
    expect(runEvents.map((e) => e.event.type)).toEqual([
      "run.lifecycle",
      "run.output",
      "run.output",
      "artifact.created",
      "run.lifecycle"
    ]);
    expect(runEvents.at(-1)?.event).toEqual({ type: "run.lifecycle", payload: { phase: "completed" } });
  });

  it("acks run.stop and stops the in-flight adapter, yielding a cancelled lifecycle", async () => {
    const channel = createInProcessChannel();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped: string[] = [];
    const gatedAdapter: RuntimeAdapter = {
      runtimeId: "gated",
      async start(config) {
        return { runId: config.runId };
      },
      async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
        await gate;
        yield { type: "run.lifecycle", payload: { phase: "cancelled" } };
      },
      async stop(handle) {
        stopped.push(handle.runId);
        release?.();
      },
      async collectArtifacts() {
        return [];
      }
    };
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, adapter: gatedAdapter });
    client.start();

    const received: NodeToServerMessage[] = [];
    const started = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isRunEvent(m) && m.event.type === "run.lifecycle" && m.event.payload.phase === "started") {
          resolve();
        }
      });
    });

    await channel.serverTransport.send(runStartCommand);
    await started;
    await channel.serverTransport.send(runStopCommand);
    await client.stop();

    expect(stopped).toEqual(["run_1"]);
    expect(received.filter(isAck).map((a) => a.command_id)).toEqual(["cmd_start_1", "cmd_stop_1"]);
    const phases = received
      .filter(isRunEvent)
      .map((e) => (e.event.type === "run.lifecycle" ? e.event.payload.phase : null));
    expect(phases).toContain("cancelled");
  });

  it("rejects run.start when the adapter cannot start the process", async () => {
    const channel = createInProcessChannel();
    const failingAdapter: RuntimeAdapter = {
      runtimeId: "failing",
      async start() {
        throw new Error("workspace missing");
      },
      async *streamEvents() {
        yield { type: "run.lifecycle", payload: { phase: "started" } };
      },
      async stop() {},
      async collectArtifacts() {
        return [];
      }
    };
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, adapter: failingAdapter });
    client.start();

    const received: NodeToServerMessage[] = [];
    const rejected = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isAck(m) && m.status === "rejected") {
          resolve();
        }
      });
    });

    await channel.serverTransport.send(runStartCommand);
    await rejected;
    await client.stop();

    expect(received.filter(isRunEvent)).toEqual([]);
    expect(received.filter(isAck)).toEqual([
      {
        kind: "command.ack",
        node_id: "computer_1",
        command_id: "cmd_start_1",
        status: "rejected",
        error_code: "process_start_failed",
        message: "workspace missing"
      }
    ]);
  });
});
