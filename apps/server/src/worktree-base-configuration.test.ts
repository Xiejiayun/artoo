import { agentInstances, appendEvent, computers, eventLog, organizations, runs, tasks, users } from "@artoo/db";
import type { NodeTransport } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSession, provisionUser } from "./auth/auth-service.js";
import { buildEvent } from "./events.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const INSTANCE = "instance_mock_coder", COMPUTER = "computer_local_mock";
const URL = `/api/v1/agent-instances/${INSTANCE}/worktree-workspace-base`;
const FEATURE = "workspace-allocation.per-run-v1";
const setting = { version: 1, strategy: "per-run", basePath: "C:/Approved//MiXeD/草稿/" };

// Real migrated PGlite, production routes/auth/idempotency/events and real node
// bindings/registry. The unused transport prevents execution or network traffic.
// Session qualification below is an explicit fixture prerequisite. Actual
// ready/first-pong qualification belongs to the separate WebSocket gate.
describe("administrator worktree base configuration", () => {
  let server: TestServer;
  let owner: Awaited<ReturnType<typeof sessionFor>>;
  const bindings: NodeBinding[] = [];

  async function sessionFor(role: "owner" | "admin" | "member") {
    const email = `${role}@example.com`;
    const { userId } = await provisionUser(server.ctx, { subject: email, email, emailVerified: true, displayName: role });
    await server.db.db.update(users).set({ role }).where(eq(users.id, userId));
    return { userId, ...(await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId })) };
  }
  function bind(features: readonly string[] = [FEATURE], computerId = COMPUTER,
    qualification: { state: "hello" | "ready" | "active" } = { state: "active" }) {
    const transport: NodeTransport = {
      async send() { throw new Error("Configuration must not dispatch node commands"); },
      subscribe() { return () => {}; },
      async close() {},
    };
    const binding: NodeBinding = attachNodeBinding(server.ctx, transport, computerId, features,
      () => qualification.state === "active" && server.nodeRegistry.get(computerId) === binding);
    bindings.push(binding); server.nodeRegistry.register(computerId, binding);
    return binding;
  }
  const headers = () => ({ authorization: `Bearer ${owner.raw}` });
  const patch = (payload: unknown = setting, extraHeaders: Record<string, string> = {}) =>
    server.app.inject({ method: "PATCH", url: URL, headers: { ...headers(), "content-type": "application/json", ...extraHeaders }, payload: JSON.stringify(payload) });
  const clear = (extraHeaders: Record<string, string> = {}) =>
    server.app.inject({ method: "DELETE", url: URL, headers: { ...headers(), ...extraHeaders } });
  async function instance() {
    const [row] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, INSTANCE));
    if (!row) throw new Error("Expected the real seeded instance");
    return row;
  }
  const events = () => server.db.db.select().from(eventLog).where(and(
    eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "agent_instance.updated"), eq(eventLog.correlationId, INSTANCE),
  )).orderBy(eventLog.position);
  async function run(status: string, failureReason: string | null = null, instanceId = INSTANCE) {
    const now = server.ctx.clock.nowIso(), taskId = server.ctx.idGen.generate("task"), runId = server.ctx.idGen.generate("run");
    await server.db.transaction(async (tx) => {
      await tx.insert(tasks).values({ id: taskId, organizationId: "org_default", projectId: "proj_artoo",
        title: "Configuration guard", status: "blocked", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now });
      await tx.insert(runs).values({ id: runId, organizationId: "org_default", taskId, computerId: COMPUTER,
        agentInstanceId: instanceId, runtimeId: "mock", status, failureReason, workspaceRoot: "C:/Historical/Exact/",
        workspaceBranch: "Feature/Historical", createdAt: now });
    });
    return { taskId, runId };
  }

  beforeEach(async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    owner = await sessionFor("owner");
    bind();
  });
  afterEach(async () => {
    for (const binding of bindings.splice(0)) binding.close();
    await server?.close();
  });

  it.each(["owner", "admin"] as const)("allows %s and attributes only dedicated before/after settings", async (role) => {
    const actor = role === "owner" ? owner : await sessionFor(role);
    const response = await server.app.inject({ method: "PATCH", url: URL,
      headers: { authorization: `Bearer ${actor.raw}` }, payload: setting });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent_instance.config).toEqual({ worktree_workspace_base: setting });
    const saved = await events();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ actorId: actor.userId, actorType: "user", correlationId: INSTANCE,
      payload: { agent_instance_id: INSTANCE, computer_id: COMPUTER, worktree_workspace_base: { before: null, after: setting } } });
    expect(saved[0]!.payload).toEqual({ agent_instance_id: INSTANCE, computer_id: COMPUTER,
      worktree_workspace_base: { before: null, after: setting } });
  });

  it.each(["PATCH", "DELETE"] as const)("denies members before revealing instance existence on %s", async (method) => {
    const actor = await sessionFor("member");
    for (const id of [INSTANCE, "missing_instance"]) {
      const response = await server.app.inject({ method, url: `/api/v1/agent-instances/${id}/worktree-workspace-base`,
        headers: { authorization: `Bearer ${actor.raw}` }, ...(method === "PATCH" ? { payload: setting } : {}) });
      expect(response.statusCode).toBe(403);
    }
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
  });

  it.each(["instance", "computer"] as const)("keeps the selected %s in the current organization", async (foreign) => {
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: now });
    if (foreign === "instance") {
      await server.db.db.update(agentInstances).set({ organizationId: "org_other" }).where(eq(agentInstances.id, INSTANCE));
    } else {
      await server.db.db.update(computers).set({ organizationId: "org_other" }).where(eq(computers.id, COMPUTER));
    }
    expect((await patch()).statusCode).toBe(404);
    expect((await clear()).statusCode).toBe(404);
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
  });

  it("uses the selected computer OS and preserves exact valid spelling", async () => {
    expect((await patch({ ...setting, basePath: "/posix/base" })).statusCode).toBe(400);
    expect((await patch()).statusCode).toBe(200);
    expect((await instance()).config).toEqual({ worktree_workspace_base: setting });
    await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, COMPUTER));
    expect((await patch()).statusCode).toBe(400);
    const posix = { ...setting, basePath: "/Approved//Cafe\u0301/草稿 /" };
    expect((await patch(posix)).statusCode).toBe(200);
    expect((await instance()).config).toEqual({ worktree_workspace_base: posix });
    await server.db.db.update(computers).set({ os: "unknown" }).where(eq(computers.id, COMPUTER));
    expect((await patch(posix)).statusCode).toBe(400);
    expect((await instance()).config).toEqual({ worktree_workspace_base: posix });
  });

  it.each([
    ["null", null], ["unknown version", { ...setting, version: 2 }],
    ["unknown strategy", { ...setting, strategy: "shared" }], ["missing base", { version: 1, strategy: "per-run" }],
    ["extra approval", { ...setting, approved: true }], ["generic config", { config: { worktree_workspace_base: setting } }],
    ["relative target", { ...setting, basePath: "relative/work" }], ["dot segment", { ...setting, basePath: "C:/base/../other" }],
  ])("rejects %s without altering configuration or events", async (_label, input) => {
    expect((await patch(input)).statusCode).toBe(400);
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
  });

  it.each(["absent", "unknown", "closed", "legacy-replacement", "other-computer"] as const)("fails closed for %s current support", async (mode) => {
    server.nodeRegistry.unregister(COMPUTER);
    if (mode === "unknown") bind(["different-feature.v1"]);
    if (mode === "closed") bind().close();
    if (mode === "legacy-replacement") { bind(); bind([]); }
    if (mode === "other-computer") bind([FEATURE], "computer_other");
    expect((await patch()).statusCode).toBe(409);
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
  });

  it("requires the managed fixture to be qualified before configuration", async () => {
    const qualification: { state: "hello" | "ready" | "active" } = { state: "hello" };
    bind([FEATURE], COMPUTER, qualification);
    expect((await patch()).statusCode).toBe(409);
    qualification.state = "ready";
    expect((await patch()).statusCode).toBe(409);
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
    qualification.state = "active";
    expect((await patch()).statusCode).toBe(200);
    expect((await instance()).config).toEqual({ worktree_workspace_base: setting });
    expect(await events()).toHaveLength(1);
  });

  it("preserves unrelated config and historical runs; same setting and absent DELETE are no-ops", async () => {
    const retained = { concurrency_limit: 3, provider_options: { mode: "keep", labels: ["A", "B"] } };
    await server.db.db.update(agentInstances).set({ config: retained }).where(eq(agentInstances.id, INSTANCE));
    await run("completed");
    const oldRuns = await server.db.db.select().from(runs);
    const originalRoot = (await instance()).workspaceRoot;
    expect((await patch()).statusCode).toBe(200);
    expect((await patch({ basePath: setting.basePath, strategy: "per-run", version: 1 })).statusCode).toBe(200);
    expect((await instance()).config).toEqual({ ...retained, worktree_workspace_base: setting });
    expect(await events()).toHaveLength(1);
    server.nodeRegistry.unregister(COMPUTER);
    expect((await clear()).statusCode).toBe(200);
    expect((await clear()).statusCode).toBe(200);
    expect((await instance()).config).toEqual(retained);
    expect((await instance()).workspaceRoot).toBe(originalRoot);
    expect(await server.db.db.select().from(runs)).toEqual(oldRuns);
    const saved = await events();
    expect(saved).toHaveLength(2);
    expect(saved[1]!.payload).toEqual({ agent_instance_id: INSTANCE, computer_id: COMPUTER,
      worktree_workspace_base: { before: setting, after: null } });
  });

  it("rejects configuration data on DELETE and leaves the generic PATCH contract unchanged", async () => {
    expect((await server.app.inject({ method: "DELETE", url: URL, headers: headers(), payload: setting })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${INSTANCE}`,
      headers: headers(), payload: { config: { worktree_workspace_base: setting } } })).statusCode).toBe(400);
    expect((await instance()).config).toEqual({});
  });

  it.each(["queued", "starting", "running", "awaiting_input", "paused"])("blocks both configuration methods while a run is %s", async (status) => {
    await run(status);
    expect((await patch()).statusCode).toBe(409);
    expect((await clear()).statusCode).toBe(409);
    expect((await instance()).config).toEqual({});
    expect(await events()).toHaveLength(0);
  });

  it("blocks an uncertain disconnected process without leases until explicit exit evidence", async () => {
    const { runId, taskId } = await run("failed", "daemon_disconnect");
    expect((await patch()).statusCode).toBe(409);
    expect((await clear()).statusCode).toBe(409);
    for (const confirmed of [false, "true"]) {
      await server.db.transaction((tx) => appendEvent(tx, buildEvent(server.ctx, {
        type: "run.reconciled", actorType: "system", actorId: "control_plane", correlationId: taskId, taskId, runId,
        payload: { process_exit_confirmed: confirmed },
      })));
      expect((await patch()).statusCode).toBe(409);
    }
    await server.db.transaction((tx) => appendEvent(tx, buildEvent(server.ctx, {
      type: "run.reconciled", actorType: "system", actorId: "control_plane", correlationId: taskId, taskId, runId,
      payload: { process_exit_confirmed: true },
    })));
    expect((await patch()).statusCode).toBe(200);
    expect((await clear()).statusCode).toBe(200);
  });

  it("does not conflate a sibling instance's uncertain run with this instance", async () => {
    await server.db.db.insert(agentInstances).values({ ...await instance(), id: "instance_sibling" });
    await run("failed", "daemon_disconnect", "instance_sibling");
    expect((await patch()).statusCode).toBe(200);
    expect((await clear()).statusCode).toBe(200);
  });

  it("reuses existing Idempotency-Key semantics without duplicating configuration events", async () => {
    const key = { "Idempotency-Key": "configure-worktree-base" };
    const first = await patch(setting, key);
    expect(first.statusCode).toBe(200);
    expect((await patch(setting, key)).json()).toEqual(first.json());
    expect((await patch({ ...setting, basePath: "C:/different" }, key)).statusCode).toBe(409);
    expect(await events()).toHaveLength(1);
    const deleteKey = { "Idempotency-Key": "delete-worktree-base" };
    const removed = await clear(deleteKey);
    expect(removed.statusCode).toBe(200);
    expect((await clear(deleteKey)).json()).toEqual(removed.json());
    expect(await events()).toHaveLength(2);
  });

  it.each(["PATCH", "DELETE"] as const)("checks current admin authority before a cached %s success", async (method) => {
    if (method === "DELETE") expect((await patch()).statusCode).toBe(200);
    const actor = await sessionFor("admin");
    const request = { method, url: URL,
      headers: { authorization: `Bearer ${actor.raw}`, "Idempotency-Key": `cached-${method}` },
      ...(method === "PATCH" ? { payload: setting } : {}) };
    const first = await server.app.inject(request);
    expect(first.statusCode).toBe(200);
    expect((await server.app.inject(request)).json()).toEqual(first.json());
    const count = (await events()).length;
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, actor.userId));
    expect((await server.app.inject(request)).statusCode).toBe(403);
    expect(await events()).toHaveLength(count);
  });

  // PGlite serializes its client operations. This checks event/config consistency,
  // not PostgreSQL row-lock concurrency; see POSTGRES-CONCURRENCY-PLAN.md.
  it("keeps event/config values consistent for concurrent requests in the PGlite fixture", async () => {
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 2 } }).where(eq(agentInstances.id, INSTANCE));
    const variants = [setting, { ...setting, basePath: "C:/Second/Base" }];
    const responses = await Promise.all(variants.map((value) => patch(value)));
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    const saved = await events();
    expect(saved).toHaveLength(2);
    const first = saved[0]!.payload as { worktree_workspace_base: { before: unknown; after: unknown } };
    const second = saved[1]!.payload as { worktree_workspace_base: { before: unknown; after: unknown } };
    expect(first.worktree_workspace_base.before).toBeNull();
    expect(second.worktree_workspace_base.before).toEqual(first.worktree_workspace_base.after);
    expect(variants).toContainEqual(second.worktree_workspace_base.after);
    expect((await instance()).config).toEqual({ concurrency_limit: 2, worktree_workspace_base: second.worktree_workspace_base.after });
  });
});
