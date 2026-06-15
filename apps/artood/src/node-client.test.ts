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

import { createAdapterRegistry } from "./adapter-registry.js";
import { createNodeClient } from "./node-client.js";
import type { GitExecutor } from "./workspace-binding.js";

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

describe("artood node client (multi-runtime registry)", () => {
  it("routes run.start to the adapter registered for its runtime", async () => {
    const channel = createInProcessChannel();
    const registry = createAdapterRegistry([
      { runtime: "mock-coder", adapter: createMockAdapter({ outputLines: ["x"] }), capabilities: ["code.modify"] }
    ]);
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, registry });
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

    await channel.serverTransport.send(runStartCommand); // runtime: "mock-coder"
    await done;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({ status: "accepted", command_id: "cmd_start_1" });
    expect(received.filter(isRunEvent).at(-1)?.event).toEqual({
      type: "run.lifecycle",
      payload: { phase: "completed" }
    });
  });

  it("rejects run.start for an unknown runtime with runtime_missing (no fallback)", async () => {
    const channel = createInProcessChannel();
    const registry = createAdapterRegistry([
      { runtime: "mock-coder", adapter: createMockAdapter() }
    ]);
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, registry });
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

    const ghostRuntime: RunStartCommand = {
      ...runStartCommand,
      payload: { ...runStartCommand.payload, runtime: "ghost-runtime" }
    };
    await channel.serverTransport.send(ghostRuntime);
    await rejected;
    await client.stop();

    expect(received.filter(isRunEvent)).toEqual([]);
    const ack = received.filter(isAck)[0];
    expect(ack).toMatchObject({ status: "rejected", error_code: "runtime_missing" });
  });
});

describe("artood node client (worktree materialization, task #19)", () => {
  function fakeGit(failOn?: string): GitExecutor & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      async run(args) {
        calls.push([...args]);
        if (failOn && args.includes(failOn)) {
          throw new Error(`git ${failOn} failed`);
        }
      }
    };
  }

  function worktreeStart(branch: string | undefined): RunStartCommand {
    return {
      ...runStartCommand,
      payload: {
        ...runStartCommand.payload,
        workspace: { root: "C:/ws/run_1", branch },
        policy_snapshot: { ...runStartCommand.payload.policy_snapshot, filesystem_write_scope: ["C:/ws"] }
      }
    };
  }

  // An adapter whose start() always throws, to exercise the post-materialization
  // failure path (the worktree must be cleaned up).
  const failingStartAdapter: RuntimeAdapter = {
    runtimeId: "mock-coder",
    async start() {
      throw new Error("spawn failed");
    },
    async *streamEvents() {},
    async stop() {},
    async collectArtifacts() {
      return [];
    }
  };

  const addCall = ["-C", "C:/repo", "worktree", "add", "-b", "task/run_1", "C:/ws/run_1"];
  const removeCall = ["-C", "C:/repo", "worktree", "remove", "--force", "C:/ws/run_1"];

  it("materializes a worktree before the run and removes it after completion", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["building"] });
    const git = fakeGit();
    const client = createNodeClient({
      nodeId: "computer_1",
      transport: channel.node,
      adapter,
      git,
      workspace: { worktreeBaseRepo: "C:/repo" }
    });
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
    await channel.serverTransport.send(worktreeStart("task/run_1"));
    await done;
    await client.stop(); // awaits the run task's finally, where cleanup runs

    expect(received.filter(isAck)[0]).toMatchObject({ status: "accepted" });
    expect(git.calls).toEqual([addCall, removeCall]);
  });

  it("rejects a branch-backed run with process_start_failed when no base repo is configured", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["x"] });
    const git = fakeGit();
    const client = createNodeClient({ nodeId: "computer_1", transport: channel.node, adapter, git });
    client.start();

    const received: NodeToServerMessage[] = [];
    const rejected = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isAck(m) && m.status === "rejected") resolve();
      });
    });
    await channel.serverTransport.send(worktreeStart("task/run_1"));
    await rejected;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({
      status: "rejected",
      error_code: "process_start_failed"
    });
    expect(received.filter(isRunEvent)).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it("rejects with process_start_failed and starts no run if materialization fails", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["x"] });
    const git = fakeGit("add"); // worktree add throws
    const client = createNodeClient({
      nodeId: "computer_1",
      transport: channel.node,
      adapter,
      git,
      workspace: { worktreeBaseRepo: "C:/repo" }
    });
    client.start();

    const received: NodeToServerMessage[] = [];
    const rejected = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isAck(m) && m.status === "rejected") resolve();
      });
    });
    await channel.serverTransport.send(worktreeStart("task/run_1"));
    await rejected;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({
      status: "rejected",
      error_code: "process_start_failed"
    });
    expect(received.filter(isRunEvent)).toEqual([]);
    expect(git.calls).toEqual([addCall]); // add attempted, no remove (nothing created)
  });

  it("rejects before git if the worktree root is outside the policy write scope", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["x"] });
    const git = fakeGit();
    const client = createNodeClient({
      nodeId: "computer_1",
      transport: channel.node,
      adapter,
      git,
      workspace: { worktreeBaseRepo: "C:/repo" }
    });
    client.start();

    const received: NodeToServerMessage[] = [];
    const rejected = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isAck(m) && m.status === "rejected") resolve();
      });
    });
    await channel.serverTransport.send({
      ...worktreeStart("task/run_1"),
      payload: {
        ...worktreeStart("task/run_1").payload,
        policy_snapshot: { filesystem_write_scope: ["C:/other"], requires_approval: [] }
      }
    });
    await rejected;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({
      status: "rejected",
      error_code: "process_start_failed"
    });
    expect(received.filter(isRunEvent)).toEqual([]);
    expect(git.calls).toEqual([]);
  });

  it("removes the worktree if the adapter fails to start after materialization", async () => {
    const channel = createInProcessChannel();
    const git = fakeGit();
    const client = createNodeClient({
      nodeId: "computer_1",
      transport: channel.node,
      adapter: failingStartAdapter,
      git,
      workspace: { worktreeBaseRepo: "C:/repo" }
    });
    client.start();

    const received: NodeToServerMessage[] = [];
    const rejected = new Promise<void>((resolve) => {
      channel.serverTransport.subscribe((m) => {
        received.push(m);
        if (isAck(m) && m.status === "rejected") resolve();
      });
    });
    await channel.serverTransport.send(worktreeStart("task/run_1"));
    await rejected;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({
      status: "rejected",
      error_code: "process_start_failed"
    });
    expect(git.calls).toEqual([addCall, removeCall]);
  });

  it("runs an ordinary (branchless) workspace with no git calls", async () => {
    const channel = createInProcessChannel();
    const adapter = createMockAdapter({ outputLines: ["building"] });
    const git = fakeGit();
    const client = createNodeClient({
      nodeId: "computer_1",
      transport: channel.node,
      adapter,
      git,
      workspace: { worktreeBaseRepo: "C:/repo" }
    });
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
    await channel.serverTransport.send(worktreeStart(undefined)); // no branch
    await done;
    await client.stop();

    expect(received.filter(isAck)[0]).toMatchObject({ status: "accepted" });
    expect(git.calls).toEqual([]);
  });
});
