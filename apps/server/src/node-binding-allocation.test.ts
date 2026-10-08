import { agentInstances, computers, contextPacks, fileLeases, runs, tasks } from "@artoo/db";
import type { NodeTransport, RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const COMPUTER = "computer_local_mock", INSTANCE = "ai_dispatch";
const FEATURE = "workspace-allocation.per-run-v1";
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Deferred real DB/binding tests. No node process, WebSocket, credentials,
// filesystem materialization, or durable writer-ownership claim is involved.
describe("persisted allocation start dispatch", () => {
  let server: TestServer, current: NodeBinding;
  const bindings: NodeBinding[] = [], sent: ServerToNodeMessage[] = [], releases: (() => void)[] = [];
  function wire(features: readonly string[] = [FEATURE], send?: (message: ServerToNodeMessage) => Promise<void>) {
    const transport: NodeTransport = {
      async send(message) { sent.push(structuredClone(message)); await send?.(message); },
      subscribe() { return () => {}; }, async close() {},
    };
    let binding: NodeBinding;
    binding = attachNodeBinding(server.ctx, transport, COMPUTER, features, () => server.nodeRegistry.get(COMPUTER) === binding);
    bindings.push(binding); server.nodeRegistry.register(COMPUTER, binding);
    return binding;
  }
  beforeEach(async () => {
    server = await buildTestServer();
    const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    if (!seed) throw new Error("Missing seeded instance");
    await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed.id));
    await server.db.db.insert(agentInstances).values({ ...seed, id: INSTANCE, workspaceRoot: "/Legacy/Exact",
      config: { concurrency_limit: 3, worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/Approved//Exact/" } } });
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, COMPUTER));
    current = wire(); server.ctx.onRunQueued = async () => {};
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    for (const binding of bindings.splice(0)) binding.close();
    sent.length = 0; await server?.close();
  });
  async function queued(allocated = true) {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Persisted dispatch", acceptance_criteria: ["Keep immutable values"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: {
      mode: "manual", agent_instance_id: INSTANCE, ...(allocated ? { branch_backed: true } : {}), write_paths: ["src/work"],
    } });
    expect(response.statusCode).toBe(200);
    return response.json().run as { id: string; task_id: string; context_pack_id: string };
  }
  async function state(run: { id: string; task_id: string }) {
    return { run: (await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0],
      task: (await server.db.db.select().from(tasks).where(eq(tasks.id, run.task_id)))[0],
      leases: await server.db.db.select().from(fileLeases).orderBy(fileLeases.id) };
  }
  const starts = () => sent.filter((message): message is RunStartCommand => message.type === "run.start");

  it("replays exact persisted payload/key despite later instance configuration drift", async () => {
    const run = await queued(), original = await state(run);
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    await current.dispatchRunStart(run.id);
    // Defensive fixture mutation; the admin route normally blocks active changes.
    await server.db.db.update(agentInstances).set({ workspaceRoot: "/Different/Current",
      config: { worktree_workspace_base: { version: 99, basePath: "/Unrelated" } } }).where(eq(agentInstances.id, INSTANCE));
    await current.dispatchRunStart(run.id);
    const [first, replay] = starts();
    expect(starts()).toHaveLength(2);
    expect(first!.payload).toEqual(replay!.payload);
    expect(first!.id).not.toBe(replay!.id);
    expect(first!.idempotency_key).toBe(`${run.id}:start`);
    expect(replay!.idempotency_key).toBe(first!.idempotency_key);
    expect(first!.payload.workspace).toEqual({ root: original.run!.workspaceRoot, branch: original.run!.workspaceBranch });
    expect(first!.payload.workspace_allocation).toEqual(original.run!.workspaceAllocation);
    expect(first!.payload.context_pack).toEqual({ id: run.context_pack_id, payload: pack!.payload });
    expect(first!.payload.policy_snapshot.filesystem_write_scope).toEqual([original.run!.workspaceRoot]);
    expect(await state(run)).toEqual(original);
  });

  it.each([
    { workspaceRoot: null }, { workspaceBranch: null }, { contextPackId: null },
    { workspaceAllocation: { version: 2, strategy: "per-run", base_path: "/Approved" } },
    { workspaceAllocation: { version: 1, strategy: "per-run", base_path: "/Different" } },
  ])("blocks malformed new-mode state without fallback, status change or lease release", async (patch) => {
    const run = await queued();
    await server.db.db.update(runs).set(patch).where(eq(runs.id, run.id));
    const before = await state(run);
    await expect(current.dispatchRunStart(run.id)).rejects.toMatchObject({ code: "conflict", details: { run_id: run.id, dispatch: "blocked" } });
    expect(starts()).toHaveLength(0);
    expect(await state(run)).toEqual(before);
    expect(before.leases).toHaveLength(1);
    expect(before.leases[0]!.status).toBe("held");
  });

  it("rejects a mismatched stored ContextPack without using a URI", async () => {
    const run = await queued();
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    const payload = structuredClone(pack!.payload) as { workspace: { root: string } };
    payload.workspace.root = "/Wrong/Root";
    await server.db.db.update(contextPacks).set({ payload }).where(eq(contextPacks.id, run.context_pack_id));
    const before = await state(run);
    await expect(current.dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "context_value_mismatch" } });
    expect(starts()).toHaveLength(0); expect(await state(run)).toEqual(before);
  });

  it("keeps instance-root and URI fallbacks only for explicit null-record legacy runs", async () => {
    const run = await queued(false);
    await server.db.db.update(runs).set({ workspaceRoot: null, contextPackId: null }).where(eq(runs.id, run.id));
    current = wire([]);
    await current.dispatchRunStart(run.id);
    const command = starts()[0]!;
    expect(command.payload.workspace).toEqual({ root: "/Legacy/Exact" });
    expect(command.payload).not.toHaveProperty("workspace_allocation");
    expect(command.payload.context_pack.uri).toMatch(/^artoo:\/\/contextpack\//);
    expect(command.payload.context_pack).not.toHaveProperty("payload");
  });

  it("unsupported current support rejects before send without pretending the queued run never started", async () => {
    const run = await queued(), before = await state(run);
    current = wire([]);
    await expect(current.dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "unsupported_execution_feature" } });
    expect(starts()).toHaveLength(0); expect(await state(run)).toEqual(before);
  });

  it.each(["closed", "replaced"] as const)("does not send through a %s binding", async (mode) => {
    const run = await queued(), original = current, before = await state(run);
    if (mode === "closed") original.close(); else current = wire();
    expect(original.supportsExecutionFeature(FEATURE)).toBe(false);
    await expect(original.dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: `binding_${mode}` } });
    expect(starts()).toHaveLength(0); expect(await state(run)).toEqual(before);
  });

  it("coalesces simultaneous calls only while this binding's start send remains in flight", async () => {
    const run = await queued(), entered = gate(), hold = gate(); releases.push(hold.release);
    current = wire([FEATURE], async () => { entered.release(); await hold.promise; });
    const first = current.dispatchRunStart(run.id); await entered.promise;
    const second = current.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(1);
    hold.release(); await Promise.all([first, second]);
    await current.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.payload).toEqual(starts()[0]!.payload);
    expect(starts()[1]!.idempotency_key).toBe(starts()[0]!.idempotency_key);
  });

  it("does not classify replacement during send as proof that no command was delivered", async () => {
    const run = await queued(), before = await state(run), entered = gate(), hold = gate(); releases.push(hold.release);
    const old = wire([FEATURE], async () => { entered.release(); await hold.promise; });
    const pending = old.dispatchRunStart(run.id); await entered.promise;
    current = wire([]); hold.release(); await pending;
    expect(starts()).toHaveLength(1); expect(await state(run)).toEqual(before);
    await expect(current.dispatchRunStart(run.id)).rejects.toMatchObject({ details: { reason: "unsupported_execution_feature" } });
    expect(await state(run)).toEqual(before);
  });

  it("keeps uncertain run/lease state when the transport throws after accepting a frame", async () => {
    const run = await queued(), before = await state(run);
    current = wire([FEATURE], async () => { throw new Error("ambiguous send failure"); });
    await expect(current.dispatchRunStart(run.id)).rejects.toThrow("ambiguous send failure");
    expect(starts()).toHaveLength(1); expect(await state(run)).toEqual(before);
  });
});
