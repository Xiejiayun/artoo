import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeToServerMessage, RunEventMessage, RunStartCommand, RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeClient } from "./node-client.js";
import type { GitExecutor } from "./workspace-binding.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const ackError = "accepted start ACK delivery unavailable";
const retentionPrefix = "Worktree retained for recovery: ";
const runEvents = (messages: NodeToServerMessage[]) =>
  messages.filter((message): message is RunEventMessage => message.kind === "run.event");

function createFixture(ackFailure: false | "sync" | "async", rejectRecovery = false) {
  // Git and process ownership are fake; retained file bytes are real.
  const temporary = mkdtempSync(join(tmpdir(), "artoo-start-ack-unit-"));
  const baseRepo = join(temporary, "base"), workspaceRoot = join(temporary, "run");
  mkdirSync(baseRepo);
  const baseline = join(baseRepo, "tracked.bin"), modified = join(workspaceRoot, "tracked.bin");
  const added = join(workspaceRoot, "new.txt");
  const originalBytes = Buffer.from("original tracked bytes\r\n");
  const modifiedBytes = Buffer.from([0, 255, 1, 13, 10, 65]);
  const newBytes = Buffer.from("unuploaded new bytes — 中文\n");
  writeFileSync(baseline, originalBytes);
  const calls = { starts: 0, streams: 0, stops: 0, live: false };
  const order: string[] = [], gitCalls: string[][] = [];
  const attempted: NodeToServerMessage[] = [], received: NodeToServerMessage[] = [];
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const git: GitExecutor = { async run(args) {
    gitCalls.push([...args]);
    expect(args.at(-1)).toBe(workspaceRoot);
    if (args.includes("add")) {
      mkdirSync(workspaceRoot); copyFileSync(baseline, modified);
    } else if (args.includes("remove")) {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } else throw new Error("Unexpected fake Git operation");
  } };
  const adapter: RuntimeAdapter = {
    runtimeId: "start-ack-unit",
    async start(config) {
      calls.starts++; calls.live = true; order.push("adapter.start");
      writeFileSync(modified, modifiedBytes); writeFileSync(added, newBytes);
      return { runId: config.runId };
    },
    async *streamEvents() {
      calls.streams++; order.push("adapter.stream");
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      calls.live = false;
      yield { type: "run.lifecycle", payload: { phase: "completed" } };
    },
    async stop(handle, reason) {
      expect(handle.runId).toBe("ack-run"); expect(reason).toBe("user_cancelled");
      calls.stops++; order.push("adapter.stop.begin");
      await stopGate;
      calls.live = false; order.push("adapter.stop.end");
    },
    async collectArtifacts() { return []; },
  };
  const channel = createInProcessChannel();
  channel.serverTransport.subscribe((message) => { received.push(message); });
  const client = createNodeClient({ nodeId: "ack-node", adapter, git,
    workspace: { worktreeBaseRepo: baseRepo },
    transport: { ...channel.node, send(message) {
      attempted.push(message);
      if (message.kind === "command.ack" && message.command_id === "ack-start" && message.status === "accepted") {
        order.push("start.ack");
        if (ackFailure === "sync") throw new Error(ackError);
        if (ackFailure === "async") return Promise.reject(new Error(ackError));
      }
      if (message.kind === "run.event") {
        order.push(`event:${message.event.type}`);
        if (rejectRecovery) return Promise.reject(new Error("recovery transport unavailable"));
      }
      return channel.node.send(message);
    } },
  });
  cleanups.push(async () => {
    releaseStop();
    try { await client.stop(true); } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
  const command: RunStartCommand = { kind: "command", id: "ack-start", type: "run.start", idempotency_key: "ack-run:start",
    payload: { run_id: "ack-run", task_id: "ack-task", agent_instance_id: "ack-instance", runtime: adapter.runtimeId,
      workspace: { root: workspaceRoot, branch: "artoo/ack-run" }, context_pack: { id: "ack-context", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: [] } } };
  client.start();
  return { client, channel, command, calls, order, gitCalls, attempted, received, releaseStop,
    baseline, modified, added, workspaceRoot, originalBytes, modifiedBytes, newBytes };
}

function expectRetained(f: ReturnType<typeof createFixture>) {
  expect(readFileSync(f.baseline)).toEqual(f.originalBytes);
  expect(readFileSync(f.modified)).toEqual(f.modifiedBytes);
  expect(readFileSync(f.added)).toEqual(f.newBytes);
  expect(f.gitCalls.some((args) => args.includes("remove"))).toBe(false);
}

describe("accepted start ACK ownership", () => {
  it("keeps start-before-ACK-before-stream ordering when delivery succeeds", async () => {
    const f = createFixture(false);
    await f.channel.serverTransport.send(f.command);
    await f.client.stop();
    expect(f.order.slice(0, 3)).toEqual(["adapter.start", "start.ack", "adapter.stream"]);
    expect(f.calls).toEqual({ starts: 1, streams: 1, stops: 0, live: false });
    expect(f.received[0]).toMatchObject({ kind: "command.ack", command_id: "ack-start", status: "accepted" });
    expect(runEvents(f.received).map((message) => message.sequence)).toEqual([0, 1, 2]);
    expect(runEvents(f.received).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
    expectRetained(f);
  });

  it.each([
    ["sync", false], ["async", false], ["async", true],
  ] as const)("stops the owned handle after %s ACK rejection before failure, retaining bytes even if recovery rejects: %s", async (ackFailure, rejectRecovery) => {
    const f = createFixture(ackFailure, rejectRecovery);
    await f.channel.serverTransport.send(f.command);
    await nextTurn();
    expect(f.calls.stops).toBe(1);
    expect(f.calls.live).toBe(true); // stop has started but has not yet confirmed exit.
    expect(f.calls.streams).toBe(0);
    expect(runEvents(f.attempted)).toEqual([]); // Failure cannot release ownership before stop.
    expectRetained(f);

    f.releaseStop();
    await nextTurn();
    expect(f.calls).toEqual({ starts: 1, streams: 0, stops: 1, live: false });
    expectRetained(f);
    const events = runEvents(f.attempted);
    expect(events.map((message) => message.sequence)).toEqual([0, 1]);
    expect(events[0]?.event.type).toBe("run.output");
    if (events[0]?.event.type !== "run.output") throw new Error("Expected recovery diagnostic");
    expect(JSON.parse(events[0].event.payload.text.slice(retentionPrefix.length))).toEqual({
      run_id: "ack-run", task_id: "ack-task", workspace_root: f.workspaceRoot,
      workspace_branch: "artoo/ack-run", outcome: "incomplete_delivery",
    });
    expect(events[1]?.event).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: ackError } });
    expect(f.order.indexOf("adapter.stop.end")).toBeLessThan(f.order.indexOf("event:run.output"));
    expect(runEvents(f.received)).toHaveLength(rejectRecovery ? 0 : 2);

    await f.channel.serverTransport.send({ ...f.command, id: "ack-duplicate" });
    await f.channel.serverTransport.send({ kind: "command", id: "ack-resume", type: "run.resume",
      idempotency_key: "ack-run:resume", payload: { run_id: "ack-run" } });
    await f.client.stop();
    expect(f.received.find((message) => message.kind === "command.ack" && message.command_id === "ack-duplicate"))
      .toMatchObject({ status: "accepted" });
    expect(f.received.find((message) => message.kind === "command.ack" && message.command_id === "ack-resume"))
      .toMatchObject({ status: "rejected", error_code: "process_exited" });
    await f.client.stop(true);
    expect(f.calls).toEqual({ starts: 1, streams: 0, stops: 1, live: false });
    expectRetained(f);
  });
});
