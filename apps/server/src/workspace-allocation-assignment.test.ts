import { agentInstances, approvals, computers, contextPacks, eventLog, fileLeases, runs, schedulerDecisions, tasks } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import { allocateWorkspaceRoot, type NodeTransport } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const INSTANCE = "ai_target", COMPUTER = "computer_local_mock";
const FEATURE = "workspace-allocation.per-run-v1";
const LEGACY = "/Legacy//Exact-Cafe\u0301/";
const setting = { version: 1, strategy: "per-run", basePath: "/Approved//Base/" };

// Runtime execution is pending. Real migrated DB/route tests cover persistence;
// Task5 dispatch and real PostgreSQL locking require separate validation.
describe("new assignment workspace snapshots", () => {
  let server: TestServer, binding: NodeBinding;
  beforeEach(async () => {
    server = await buildTestServer();
    const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    if (!seed) throw new Error("Missing real seeded instance");
    await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed.id));
    await server.db.db.insert(agentInstances).values({ ...seed, id: INSTANCE, workspaceRoot: LEGACY,
      config: { concurrency_limit: 2, worktree_workspace_base: setting } });
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, COMPUTER));
    const transport: NodeTransport = {
      async send() { throw new Error("This persistence test must not dispatch a command"); },
      subscribe() { return () => {}; }, async close() {},
    };
    binding = attachNodeBinding(server.ctx, transport, COMPUTER, [FEATURE]);
    server.nodeRegistry.register(COMPUTER, binding);
    // Do not accidentally exercise the not-yet-implemented Task5 contract.
    server.ctx.onRunQueued = async () => {};
  });
  afterEach(async () => { binding?.close(); await server?.close(); });

  async function ready() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Allocation snapshot", acceptance_criteria: ["Preserve the recorded identity"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const id = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    return id;
  }
  const assign = (taskId: string, options: Record<string, unknown> = {}) => server.app.inject({ method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "manual", agent_instance_id: INSTANCE, ...options } });
  async function configure(value: unknown) {
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 2,
      ...(value === undefined ? {} : { worktree_workspace_base: value }) } }).where(eq(agentInstances.id, INSTANCE));
  }
  async function snapshot(taskId: string) {
    return { task: (await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0],
      runs: await server.db.db.select().from(runs).orderBy(runs.id), packs: await server.db.db.select().from(contextPacks).orderBy(contextPacks.id),
      decisions: await server.db.db.select().from(schedulerDecisions).orderBy(schedulerDecisions.id), approvals: await server.db.db.select().from(approvals).orderBy(approvals.id),
      leases: await server.db.db.select().from(fileLeases).orderBy(fileLeases.id), events: await server.db.db.select().from(eventLog).orderBy(eventLog.position) };
  }
  async function pack(runId: string) {
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, runId));
    if (!stored) throw new Error("Missing persisted ContextPack");
    return ContextPackSchema.parse(stored.payload);
  }

  it("ignores allocation settings for ordinary assignment even without feature support", async () => {
    binding.close(); await configure({ version: 99, arbitrary: true });
    const response = await assign(await ready());
    expect(response.statusCode).toBe(200);
    expect(response.json().run).toMatchObject({ workspace_root: LEGACY, workspace_branch: null });
    expect(response.json().run).not.toHaveProperty("workspace_allocation");
  });

  it.each([LEGACY, null])("preserves an absent setting's legacy branch root: %s", async (workspaceRoot) => {
    await configure(undefined); binding.close();
    await server.db.db.update(agentInstances).set({ workspaceRoot }).where(eq(agentInstances.id, INSTANCE));
    const response = await assign(await ready(), { branch_backed: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().run.workspace_root).toBe(workspaceRoot);
    expect(response.json().run.workspace_branch).toBe(`artoo/run-${response.json().run.id}`);
    expect(response.json().run).not.toHaveProperty("workspace_allocation");
  });

  it("auto selection filters unsupported configured branches but keeps ordinary eligibility", async () => {
    const [original] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, INSTANCE));
    await server.db.db.insert(agentInstances).values({ ...original!, id: "ai_zz_legacy", config: {}, workspaceRoot: "/Other/Legacy/" });
    binding.close();
    const branch = await assign(await ready(), { mode: "auto", agent_instance_id: null, branch_backed: true });
    expect(branch.statusCode).toBe(200);
    expect(branch.json().run).toMatchObject({ agent_instance_id: "ai_zz_legacy", workspace_root: "/Other/Legacy/" });
    const ordinary = await assign(await ready(), { mode: "auto", agent_instance_id: null });
    expect(ordinary.statusCode).toBe(200);
    expect(ordinary.json().run).toMatchObject({ agent_instance_id: INSTANCE, workspace_root: LEGACY });
  });

  it.each([
    { os: "linux", basePath: "/Approved//Cafe\u0301/草稿 /", branch: { branch_backed: true } },
    { os: "windows", basePath: "C:\\Approved\\MiXeD\\", branch: { workspace_branch: "Feature/Keep-Case" } },
  ])("uses recorded $os and persists one root/record/ContextPack snapshot", async ({ os, basePath, branch }) => {
    const config = { ...setting, basePath }; await configure(config);
    await server.db.db.update(computers).set({ os }).where(eq(computers.id, COMPUTER));
    const response = await assign(await ready(), { ...branch, write_paths: ["Src/Exact"] });
    expect(response.statusCode).toBe(200);
    const run = response.json().run;
    const expected = allocateWorkspaceRoot({ workspaceRoot: LEGACY, branchBacked: true, targetComputerOs: os,
      agentInstanceId: INSTANCE, runId: run.id, worktreeBase: config });
    expect(run.workspace_root).toBe(expected);
    expect(run.workspace_branch).toBe("workspace_branch" in branch ? branch.workspace_branch : `artoo/run-${run.id}`);
    expect(run.workspace_allocation).toEqual({ version: 1, strategy: "per-run", base_path: basePath });
    const persisted = (await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]!;
    expect(persisted.workspaceRoot).toBe(expected);
    expect(persisted.workspaceAllocation).toEqual(run.workspace_allocation);
    const context = await pack(run.id);
    expect(context.workspace.root).toBe(expected);
    expect(context.policy.filesystem_write_scope).toEqual(["Src/Exact"]);
    expect((await server.db.db.select().from(fileLeases))[0]!.path).toBe("src/exact");
  });

  it("new run IDs use new roots; later config leaves historical run/ContextPack intact", async () => {
    const firstResponse = await assign(await ready(), { branch_backed: true });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json().run;
    await server.db.db.update(runs).set({ status: "completed" }).where(eq(runs.id, first.id));
    const oldRun = (await server.db.db.select().from(runs).where(eq(runs.id, first.id)))[0];
    const oldPack = (await server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, first.id)))[0];
    const nextSetting = { ...setting, basePath: "/Next/Exact/" };
    const changed = await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${INSTANCE}/worktree-workspace-base`, payload: nextSetting });
    expect(changed.statusCode).toBe(200);
    const response = await assign(await ready(), { branch_backed: true });
    expect(response.statusCode).toBe(200);
    const second = response.json().run;
    expect(second.id).not.toBe(first.id);
    expect(second.workspace_root).not.toBe(first.workspace_root);
    expect(second.workspace_branch).not.toBe(first.workspace_branch);
    expect(second.workspace_allocation.base_path).toBe(nextSetting.basePath);
    expect((await pack(second.id)).policy.filesystem_write_scope).toEqual([second.workspace_root]);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, first.id)))[0]).toEqual(oldRun);
    expect((await server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, first.id)))[0]).toEqual(oldPack);
  });

  it.each([null, { ...setting, version: 2 }, { ...setting, basePath: "/bad/../path" }, { ...setting, basePath: "/" + "x".repeat(4095) }])(
    "rejects invalid configuration with no surviving transactional effects", async (invalid) => {
      await configure(invalid); const taskId = await ready();
      const request = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/execution-approval`, payload: { summary: "Approved execution", risk: "high" } });
      expect(request.statusCode).toBe(201);
      expect((await server.app.inject({ method: "POST", url: `/api/v1/approvals/${request.json().approval.id}/resolve`, payload: { decision: "approved" } })).statusCode).toBe(200);
      const before = await snapshot(taskId);
      expect((await assign(taskId, { branch_backed: true, write_paths: ["src/work"] })).statusCode).toBe(400);
      expect(await snapshot(taskId)).toEqual(before);
    });

  it("rejects unsupported OS and lost current support without orphan rows", async () => {
    const taskId = await ready(), before = await snapshot(taskId);
    await server.db.db.update(computers).set({ os: "unsupported" }).where(eq(computers.id, COMPUTER));
    expect((await assign(taskId, { branch_backed: true })).statusCode).toBe(400);
    expect(await snapshot(taskId)).toEqual(before);
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, COMPUTER));
    binding.close();
    expect((await assign(taskId, { workspace_branch: "Feature/Exact" })).statusCode).toBe(409);
    expect(await snapshot(taskId)).toEqual(before);
  });

  it("preserves approval gates before creating allocation rows", async () => {
    const taskId = await ready();
    const approval = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/execution-approval`, payload: { summary: "Review first", risk: "high" } });
    expect(approval.statusCode).toBe(201);
    const before = await snapshot(taskId);
    expect((await assign(taskId, { branch_backed: true })).statusCode).toBe(409);
    expect(await snapshot(taskId)).toEqual(before);
  });

  it("keeps logical conflicts across different bases while preserving disjoint scopes", async () => {
    const [original] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, INSTANCE));
    await server.db.db.insert(agentInstances).values({ ...original!, id: "ai_other",
      config: { worktree_workspace_base: { ...setting, basePath: "/Different/Base/" } } });
    const first = await assign(await ready(), { branch_backed: true, write_paths: ["Src/Shared"] });
    expect(first.statusCode).toBe(200);
    const taskId = await ready(), before = await snapshot(taskId);
    expect((await assign(taskId, { agent_instance_id: "ai_other", branch_backed: true, write_paths: ["src/shared/child"] })).statusCode).toBe(409);
    expect(await snapshot(taskId)).toEqual(before);
    const disjoint = await assign(taskId, { agent_instance_id: "ai_other", branch_backed: true, write_paths: ["Src/Other"] });
    expect(disjoint.statusCode).toBe(200);
    expect(disjoint.json().run.workspace_root).not.toBe(first.json().run.workspace_root);
    expect((await server.db.db.select().from(fileLeases)).map((lease) => lease.path).sort()).toEqual(["src/other", "src/shared"]);
  });

  it("rolls back the broad ContextPack fallback when a write path is invalid", async () => {
    const taskId = await ready(), before = await snapshot(taskId);
    expect((await assign(taskId, { branch_backed: true, write_paths: ["../escape"] })).statusCode).toBe(400);
    expect(await snapshot(taskId)).toEqual(before);
  });
});
