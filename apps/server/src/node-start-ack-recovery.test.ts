import { createNodeClient, type NodeClient } from "@artoo/artood";
import { eventLog, fileLeases, runs } from "@artoo/db";
import type { Run } from "@artoo/domain";
import type { NodeSideTransport, NodeToServerMessage, NodeTransport, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { getRun } from "./services/run-service.js";
import { getTaskSnapshot } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
let server: TestServer | undefined, client: NodeClient | undefined, binding: NodeBinding | undefined;
let releaseStop: (() => void) | undefined;
afterEach(async () => {
  releaseStop?.();
  await client?.stop(true);
  binding?.close();
  await server?.close();
  server = undefined; client = undefined; binding = undefined; releaseStop = undefined;
});

async function runningFixture(failure: "start_ack" | "after_started") {
  server = await buildTestServer({ workspaceRoot: "/owned/start-ack-recovery" });
  const enteredStop = gate(), stopped = gate(); releaseStop = stopped.release;
  const counts = { starts: 0, streams: 0, stops: 0 };
  const attempted: NodeToServerMessage[] = [], gitCalls: string[][] = [];
  const receipts = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let nodeReceive: ((message: ServerToNodeMessage) => void) | undefined;
  let serverReceive: ((message: NodeToServerMessage) => void) | undefined;
  let startCommandId: string | undefined;
  const serverTransport: NodeTransport = {
    async send(message) {
      if (message.type === "run.start") startCommandId = message.id;
      if (message.type === "run.event.ack") {
        const receipt = receipts.get(message.payload.sequence);
        if (!receipt) throw new Error("receipt has no pending sender");
        receipts.delete(message.payload.sequence);
        if (message.payload.status === "accepted") receipt.resolve();
        else receipt.reject(new Error(message.payload.message));
      } else nodeReceive?.(message);
    },
    subscribe(handler) { serverReceive = handler; return () => { serverReceive = undefined; }; },
    async close() {},
  };
  const transport: NodeSideTransport = {
    acknowledgesRunEvents: true,
    async send(message) {
      attempted.push(message);
      if (failure === "start_ack" && message.kind === "command.ack" && message.command_id === startCommandId && message.status === "accepted") {
        throw new Error("start acknowledgement unavailable");
      }
      if (message.kind === "run.event") {
        // Resolution comes from the real binding's receipt after PGlite commit.
        const committed = new Promise<void>((resolve, reject) => receipts.set(message.sequence, { resolve, reject }));
        serverReceive?.(message);
        await committed;
      } else serverReceive?.(message);
    },
    subscribe(handler) { nodeReceive = handler; return () => { nodeReceive = undefined; }; },
  };
  const adapter: RuntimeAdapter = {
    runtimeId: "mock",
    async start(config) { counts.starts++; return { runId: config.runId }; },
    async *streamEvents() {
      counts.streams++;
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      throw new Error("stream failed after start");
    },
    async stop() { counts.stops++; enteredStop.release(); await stopped.promise; },
    async collectArtifacts() { return []; },
  };
  binding = attachNodeBinding(server.ctx, serverTransport, "computer_local_mock");
  server.ctx.onRunQueued = (id) => binding!.dispatchRunStart(id);
  client = createNodeClient({ nodeId: "computer_local_mock", transport, adapter,
    workspace: { worktreeBaseRepo: "/owned/base" }, git: { async run(args) { gitCalls.push([...args]); } } });
  client.start();
  const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title: "start acknowledgment recovery", acceptance_criteria: ["recover safely"], required_capabilities: ["code.modify"],
  } })).json().task;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready` })).statusCode).toBe(200);
  const assignment = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`,
    payload: { mode: "auto", branch_backed: true, write_paths: ["src/result.ts"] } });
  expect(assignment.statusCode).toBe(200);
  const run = assignment.json().run as Run;
  await enteredStop.promise;
  return { run, counts, attempted, gitCalls, releaseStop: stopped.release, pendingReceipts: receipts, resend: transport.send };
}

describe("node start-ACK delivery recovery across the real server state machine", () => {
  it.each(["queued", "starting"] as const)("settles a stopped pre-stream %s failure as failed/ready without fabricating a started lifecycle", async (initialStatus) => {
    const f = await runningFixture("start_ack");
    if (initialStatus === "starting") await server!.db.db.update(runs).set({ status: "starting" }).where(eq(runs.id, f.run.id));
    expect(f.counts).toEqual({ starts: 1, streams: 0, stops: 1 });
    expect((await getRun(server!.ctx, f.run.id)).status).toBe(initialStatus);
    expect((await getTaskSnapshot(server!.ctx, f.run.task_id)).task.status).toBe("assigned");
    const held = await server!.db.db.select().from(fileLeases).where(eq(fileLeases.runId, f.run.id));
    expect(held).toHaveLength(1); expect(held[0]!.status).toBe("held");
    expect(f.attempted.filter((message) => message.kind === "run.event")).toEqual([]);

    f.releaseStop(); await client!.stop(); await binding!.drain();
    const actual = await getRun(server!.ctx, f.run.id);
    const snapshot = await getTaskSnapshot(server!.ctx, f.run.task_id);
    expect({ run: actual.status, task: snapshot.task.status }).toEqual({ run: "failed", task: "ready" });
    expect(actual.failure_reason).toBe("start acknowledgement unavailable");
    expect(actual.ended_at).not.toBeNull();
    expect(actual.workspace_retention).toMatchObject({ outcome: "incomplete_delivery", workspace_root: f.run.workspace_root, workspace_branch: f.run.workspace_branch });
    const runEvents = await server!.db.db.select().from(eventLog).where(eq(eventLog.runId, f.run.id));
    expect(runEvents.filter((event) => event.type === "run.started")).toEqual([]);
    const failed = runEvents.filter((event) => event.type === "run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ failure_reason: actual.failure_reason, recoverable: true });
    const leases = await server!.db.db.select().from(fileLeases).where(eq(fileLeases.runId, f.run.id));
    expect(leases[0]!.status).toBe("released");
    expect(f.pendingReceipts.size).toBe(0);
    expect(f.gitCalls).toHaveLength(1); expect(f.gitCalls[0]).not.toContain("remove");
    const failedFrame = f.attempted.find((message) => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "failed")!;
    await f.resend(failedFrame); await binding!.drain();
    expect((await server!.db.db.select().from(eventLog).where(and(eq(eventLog.runId, f.run.id), eq(eventLog.type, "run.failed"))))).toHaveLength(1);
    expect((await getTaskSnapshot(server!.ctx, f.run.task_id)).task.status).toBe("ready");
  });

  it("keeps an already-started execution failure on the existing failed/blocked path", async () => {
    const f = await runningFixture("after_started");
    expect(f.counts).toEqual({ starts: 1, streams: 1, stops: 1 });
    expect((await getRun(server!.ctx, f.run.id)).status).toBe("running");
    const held = await server!.db.db.select().from(fileLeases).where(eq(fileLeases.runId, f.run.id));
    expect(held[0]!.status).toBe("held");
    f.releaseStop(); await client!.stop(); await binding!.drain();
    const actual = await getRun(server!.ctx, f.run.id);
    expect({ run: actual.status, task: (await getTaskSnapshot(server!.ctx, f.run.task_id)).task.status }).toEqual({ run: "failed", task: "blocked" });
    expect(actual.failure_reason).toBe("stream failed after start");
    expect((await server!.db.db.select().from(eventLog).where(and(eq(eventLog.runId, f.run.id), eq(eventLog.type, "run.started"))))).toHaveLength(1);
    expect((await server!.db.db.select().from(fileLeases).where(eq(fileLeases.runId, f.run.id)))[0]!.status).toBe("released");
  });
});
