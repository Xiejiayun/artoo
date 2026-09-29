import { computers, eventLog, fileLeases, runs, tasks } from "@artoo/db";
import { PgliteDbClient } from "@artoo/storage";
import { createInProcessChannel } from "@artoo/testkit";
import type { ServerToNodeMessage } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerContext } from "../context.js";
import { attachNodeBinding, type NodeBinding } from "../node-binding.js";
import { buildTestServer, type TestServer } from "../test-support.js";
import { createGraceWindowManager, type GraceWindowManager } from "../ws/grace-window.js";
import { recoverInterruptedRuns } from "./execution-recovery-service.js";
import { assignTask } from "./lifecycle-service.js";
import { failRunDaemonDisconnect, ingestRunEvent, unconfirmedProcessRunIdsForComputer } from "./run-service.js";

const NODE = "computer_local_mock";

describe("durable interrupted execution recovery", () => {
  let server: TestServer | undefined;
  let restored: PgliteDbClient | undefined;
  let ctx: ServerContext;
  let binding: NodeBinding | undefined;
  let grace: GraceWindowManager | undefined;
  beforeEach(async () => { server = await buildTestServer(); ctx = server.ctx; });
  afterEach(async () => {
    vi.useRealTimers();
    binding?.close(); grace?.close?.();
    await server?.close(); await restored?.close();
    server = undefined; restored = undefined; binding = undefined; grace = undefined;
  });

  async function assigned(started = true, withLease = true) {
    const created = await server!.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Recover standalone execution", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"],
    } });
    const taskId = created.json().task.id as string;
    await server!.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const result = await server!.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: {
      mode: "auto", ...(withLease ? { write_paths: ["src/recovery.ts"] } : {}),
    } });
    expect(result.statusCode).toBe(200);
    const runId = result.json().run.id as string;
    if (started) await ingestRunEvent(ctx, { runId, nodeId: NODE, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    return { taskId, runId };
  }

  async function restartDatabase() {
    // Serialize and destroy the original engine and app. Recovery only has the
    // persisted database, not the original timer, registry, lease cache or app.
    const archive = await server!.db.backup();
    await server!.close(); server = undefined;
    restored = await PgliteDbClient.create({ archive });
    ctx = { ...ctx, db: restored, onRunQueued: undefined };
  }

  function controllableGrace() {
    const timers = new Set<() => void>();
    let expiration = Promise.resolve();
    grace = createGraceWindowManager({ graceMs: 30_000, scheduler: {
      schedule(fn) { timers.add(fn); return fn; }, cancel(handle) { timers.delete(handle as () => void); },
    }, onExpire: (computerId, ids) => {
      expiration = expiration.then(async () => { for (const id of ids) await failRunDaemonDisconnect(ctx, id, computerId); });
      return expiration;
    } });
    return { grace, expire: async () => { for (const fn of [...timers]) fn(); timers.clear(); await expiration; } };
  }

  async function held(runId: string) {
    return ctx.db.db.select().from(fileLeases).where(and(eq(fileLeases.runId, runId), eq(fileLeases.status, "held")));
  }
  async function state(runId: string) { return (await ctx.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!; }
  function wire() {
    const channel = createInProcessChannel();
    const commands: ServerToNodeMessage[] = [];
    channel.node.subscribe((command) => { commands.push(command); });
    binding = attachNodeBinding(ctx, channel.serverTransport, NODE);
    return { channel, commands, binding };
  }

  it("reconstructs a standalone run after server loss; expiry blocks it without freeing its writer", async () => {
    const { taskId, runId } = await assigned();
    await restartDatabase();
    const recovery = controllableGrace();
    expect(await recoverInterruptedRuns(ctx, recovery.grace)).toEqual({ computers: 1, runs: 1 });
    expect((await ctx.db.db.select().from(computers).where(eq(computers.id, NODE)))[0]?.status).toBe("offline");
    expect((await ctx.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.goalId).toBeNull();
    expect(recovery.grace.isArmed(NODE)).toBe(true);
    await recovery.expire();
    expect(await state(runId)).toMatchObject({ status: "failed", failureReason: "daemon_disconnect" });
    expect((await ctx.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("blocked");
    expect(await held(runId)).toHaveLength(1);
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([runId]);

    const { channel, commands, binding: owner } = wire();
    await owner.dispatchRunResume(runId);
    expect(commands.map((command) => command.type)).toEqual(["run.resume"]);
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: commands[0]!.id,
      status: "rejected", error_code: "process_exited", message: "process is absent" });
    await owner.drain();
    expect(await held(runId)).toHaveLength(0);
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([]);
    expect(await ctx.db.db.select().from(eventLog).where(and(eq(eventLog.runId, runId), eq(eventLog.type, "run.failed")))).toHaveLength(1);
  });

  it("recovers queued dispatches with no leases and prevents duplicate assignment until absence is confirmed", async () => {
    const { taskId, runId } = await assigned(false, false);
    await restartDatabase();
    const recovery = controllableGrace();
    await recoverInterruptedRuns(ctx, recovery.grace);
    await recovery.expire();
    expect((await state(runId)).status).toBe("failed");
    expect(await held(runId)).toEqual([]);
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([runId]);
    await expect(assignTask(ctx, taskId, { mode: "auto" })).rejects.toThrow("previous process stopped");

    const { channel, commands, binding: owner } = wire();
    await owner.dispatchRunResume(runId);
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: commands[0]!.id,
      status: "rejected", error_code: "process_exited", message: "no process" });
    await owner.drain();
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([]);
    await ctx.db.db.update(computers).set({ status: "online" }).where(eq(computers.id, NODE));
    expect((await assignTask(ctx, taskId, { mode: "auto" })).run.id).not.toBe(runId);
    expect(commands.every((command) => command.type !== "run.start")).toBe(true);
  });

  it("accepts a surviving active process after restart without launching a second process", async () => {
    const { runId } = await assigned();
    await restartDatabase();
    const recovery = controllableGrace();
    await recoverInterruptedRuns(ctx, recovery.grace);
    const { channel, commands, binding: owner } = wire();
    for (const id of recovery.grace.disarm(NODE)) await owner.dispatchRunResume(id);
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: commands[0]!.id, status: "accepted" });
    await recovery.expire(); await owner.drain();
    expect((await state(runId)).status).toBe("running");
    expect(commands.map((command) => command.type)).toEqual(["run.resume"]);
    expect(await held(runId)).toHaveLength(1);
    await channel.node.send({ kind: "run.event", node_id: NODE, run_id: runId, sequence: 1,
      event: { type: "run.lifecycle", payload: { phase: "completed" } } });
    await owner.drain();
    expect((await state(runId)).status).toBe("completed");
    expect(await held(runId)).toHaveLength(0);
  });

  it.each(["paused", "awaiting_input"])("recovers a %s process and blocks an approval-waiting task on expiry", async (status) => {
    const { taskId, runId } = await assigned();
    await ctx.db.db.update(runs).set({ status }).where(eq(runs.id, runId));
    await ctx.db.db.update(tasks).set({ status: "awaiting_approval" }).where(eq(tasks.id, taskId));
    const recovery = controllableGrace();
    expect(await recoverInterruptedRuns(ctx, recovery.grace)).toEqual({ computers: 1, runs: 1 });
    await recovery.expire();
    expect((await state(runId)).status).toBe("failed");
    expect((await ctx.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("blocked");
    expect(await held(runId)).toHaveLength(1);
  });

  it("treats a rejected probe as uncertainty unless the owner explicitly confirms process exit", async () => {
    const { runId } = await assigned();
    const { channel, commands, binding: owner } = wire();
    await owner.dispatchRunResume(runId);
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: commands[0]!.id,
      status: "rejected", error_code: "internal_error", message: "cannot inspect process" });
    await owner.drain();
    expect((await state(runId)).status).toBe("failed");
    expect(await held(runId)).toHaveLength(1);
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([runId]);
  });

  it("stops a process surviving an expired grace period and retains its lease until stop ACK", async () => {
    const { runId } = await assigned();
    await failRunDaemonDisconnect(ctx, runId, NODE);
    const { channel, commands, binding: owner } = wire();
    await owner.dispatchRunResume(runId);
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: commands[0]!.id, status: "accepted" });
    await vi.waitFor(() => expect(commands.some((command) => command.type === "run.stop")).toBe(true));
    expect(await held(runId)).toHaveLength(1);
    const stop = commands.find((command) => command.type === "run.stop")!;
    await channel.node.send({ kind: "command.ack", node_id: NODE, command_id: stop.id, status: "accepted" });
    await vi.waitFor(async () => expect(await held(runId)).toHaveLength(0));
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([]);
    expect((await state(runId)).status).toBe("failed");
    expect(commands.map((command) => command.type)).toEqual(["run.resume", "run.stop"]);
  });

  it("bounds an unanswered process probe without inferring exit", async () => {
    const { runId } = await assigned();
    const { binding: owner } = wire();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await owner.dispatchRunResume(runId);
    vi.advanceTimersByTime(15_001);
    vi.useRealTimers();
    await owner.drain();
    expect((await state(runId)).status).toBe("failed");
    expect(await held(runId)).toHaveLength(1);
    expect(await unconfirmedProcessRunIdsForComputer(ctx, NODE)).toEqual([runId]);
  });
});
