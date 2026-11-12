import { agentInstances, agentRuntimes, agents, appendEvent, computers, deviceTokens, eventLog, organizations, runs, users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildEvent } from "./events.js";
import { resolveNodeToken } from "./services/device-service.js";
import { createGoal } from "./services/goal-service.js";
import { createDiscussionDispatcher, startDiscussion } from "./services/discussion-service.js";
import { recordHeartbeatRuntimes } from "./services/runtime-registry-service.js";
import { bootstrap } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import type { NodeBinding } from "./node-binding.js";

const computerId = "computer_local_mock", agentId = "agent_mock_coder", instanceId = "instance_mock_coder";
const paths = [`computers/${computerId}`, `agents/${agentId}`, `agent-instances/${instanceId}`];

describe("resource deletion and expiry", () => {
  let server: TestServer;
  afterEach(async () => { vi.unstubAllEnvs(); await server?.close(); });
  const remove = (path: string) => server.app.inject({ method: "DELETE", url: `/api/v1/${path}` });

  async function queueRun() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Lifecycle deletion guard", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"],
    } });
    const taskId = created.json().task.id;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "manual", agent_instance_id: instanceId } });
    expect(assigned.statusCode).toBe(200);
    return { taskId, runId: assigned.json().run.id as string };
  }

  it("deletes an instance once, retains its identity and denies enable and configuration resurrection", async () => {
    server = await buildTestServer();
    expect((await remove(paths[2]!)).statusCode).toBe(200);
    expect((await remove(paths[2]!)).statusCode).toBe(200);
    const snapshot = (await server.app.inject("/api/v1/bootstrap")).json();
    expect(snapshot.agent_instances).toEqual([]);
    expect(snapshot.agents.map((row: { id: string }) => row.id)).toContain(agentId);
    expect((await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${instanceId}`, payload: { enabled: true } })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "DELETE", url: `/api/v1/agent-instances/${instanceId}/worktree-workspace-base` })).statusCode).toBe(404);
    expect((await server.app.inject(`/api/v1/agent-instances/${instanceId}/presence`)).statusCode).toBe(404);
    const events = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "agent_instance.deleted"));
    expect(events).toHaveLength(1);
    expect((await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId)))[0]).toMatchObject({ status: "disabled", deletedAt: expect.any(String) });
  });

  it("deletes an Agent and every workspace instance without removing the computer", async () => {
    server = await buildTestServer();
    await recordHeartbeatRuntimes(server.ctx, computerId, [{ runtime: "mock", status: "available", capabilities: ["code.modify", "test.run"] }]);
    const second = await server.app.inject({ method: "POST", url: `/api/v1/computers/${computerId}/instances`, payload: { agent_id: agentId, runtime: "mock", workspace_root: "C:/second" } });
    expect(second.statusCode).toBe(201);
    expect((await remove(paths[1]!)).statusCode).toBe(200);
    const snapshot = (await server.app.inject("/api/v1/bootstrap")).json();
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.agent_instances).toEqual([]);
    expect(snapshot.computers).toHaveLength(1);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/computers/${computerId}/instances`, payload: { agent_id: agentId, runtime: "mock", workspace_root: "C:/third" } })).statusCode).toBe(404);
  });

  it("deletes a computer, revokes credentials and disconnects its live binding", async () => {
    server = await buildTestServer();
    const pairing = (await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: { intended_platform: "windows" } })).json();
    const claim = (await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: { code: pairing.code, platform: "windows", app_version: "test", display_name: "Disposable computer" } })).json();
    const enrolled = await server.app.inject({ method: "POST", url: `/api/v1/devices/${claim.device.id}/enroll`, payload: {} });
    expect(enrolled.statusCode).toBe(200);
    const id = enrolled.json().computer_id;
    expect(await resolveNodeToken(server.ctx, claim.node_token)).not.toBeNull();
    const close = vi.fn();
    server.nodeRegistry.register(id, { close } as unknown as NodeBinding);
    expect((await remove(`computers/${id}`)).statusCode).toBe(200);
    expect(close).toHaveBeenCalledOnce();
    expect(server.nodeRegistry.get(id)).toBeUndefined();
    expect(await resolveNodeToken(server.ctx, claim.node_token)).toBeNull();
    const tokens = await server.db.db.select().from(deviceTokens).where(eq(deviceTokens.deviceId, claim.device.id));
    expect(tokens.every((token) => token.status === "revoked")).toBe(true);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${claim.device.id}/enroll`, payload: {} })).statusCode).toBe(409);
    expect((await remove(paths[0]!)).statusCode).toBe(200);
    await expect(recordHeartbeatRuntimes(server.ctx, computerId, [])).rejects.toThrow("computer not found");
    const snapshot = (await server.app.inject("/api/v1/bootstrap")).json();
    expect(snapshot.computers).toEqual([]);
    expect(snapshot.agent_instances).toEqual([]);
    expect((await server.app.inject("/api/v1/daemons")).json().daemons).toEqual([]);
    expect((await server.app.inject("/api/v1/computers/presence")).json().presence).toEqual([]);
  });

  it("requires administrator authorization and hides resources belonging to another organization", async () => {
    server = await buildTestServer();
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, "user_owner"));
    for (const path of paths) expect((await remove(path)).statusCode).toBe(403);
    await server.db.db.update(users).set({ role: "owner" }).where(eq(users.id, "user_owner"));
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: server.ctx.clock.nowIso() });
    const [computer] = await server.db.db.select().from(computers).where(eq(computers.id, computerId));
    const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, agentId));
    await server.db.db.insert(computers).values({ ...computer!, id: "computer_other", organizationId: "org_other" });
    await server.db.db.insert(agents).values({ ...agent!, id: "agent_other", organizationId: "org_other" });
    for (const path of ["computers/computer_other", "agents/agent_other", "agent-instances/unknown"]) expect((await remove(path)).statusCode).toBe(404);
    expect((await server.db.db.select().from(computers).where(eq(computers.id, "computer_other")))[0]!.deletedAt).toBeNull();
  });

  it("closes a live development node and rejects reconnection to its deleted computer", async () => {
    server = await buildTestServer();
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const url = address.replace(/^http/, "ws") + "/api/v1/node?token=dev";
    const hello = { kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11", artood_version: "test", machine: { hostname: "local", os: "windows", arch: "x64" } };
    const socket = new WebSocket(url);
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    try {
      await new Promise<void>((resolve) => socket.addEventListener("open", () => { socket.send(JSON.stringify(hello)); resolve(); }));
      await vi.waitFor(() => expect(server.nodeRegistry.get(computerId)).toBeDefined());
      expect((await remove(paths[0]!)).statusCode).toBe(200);
      expect(await closed).toBe(1008);
      const retry = new WebSocket(url);
      const rejected = new Promise<number>((resolve) => retry.addEventListener("close", (event) => resolve(event.code)));
      retry.addEventListener("open", () => retry.send(JSON.stringify(hello)));
      try { expect(await rejected).toBe(1008); } finally { retry.close(); }
      expect(server.nodeRegistry.get(computerId)).toBeUndefined();
      expect((await server.db.db.select().from(computers).where(eq(computers.id, computerId)))[0]!.status).toBe("disabled");
    } finally { socket.close(); }
  });

  it("keeps planning participants until cancellation and rejects deleted participants in a later discussion", async () => {
    server = await buildTestServer();
    const [instance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId));
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "instance_peer" });
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Lifecycle planning", objective: "Make a plan", acceptance_criteria: ["review"] });
    const input = { participants: [{ agent_instance_id: instanceId, role: "Author" }, { agent_instance_id: "instance_peer", role: "Reviewer" }], rounds: 1, max_minutes: 5 };
    const discussion = await startDiscussion(server.ctx, goal.id, input);
    for (const path of paths) expect((await remove(path)).statusCode).toBe(409);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/discussions/${discussion.id}/cancel` })).statusCode).toBe(200);
    expect((await remove(paths[2]!)).statusCode).toBe(409);
    const dispatcher = createDiscussionDispatcher(server.ctx, async () => { throw new Error("This planning fixture has not started a process"); });
    await dispatcher.pump();
    await dispatcher.stop();
    expect((await remove(paths[2]!)).statusCode).toBe(200);
    await expect(startDiscussion(server.ctx, goal.id, input)).rejects.toThrow("participant");
  });

  it("blocks active and unconfirmed disconnected processes and retains historical runs after confirmed exit", async () => {
    server = await buildTestServer();
    const { taskId, runId } = await queueRun();
    for (const path of paths) expect((await remove(path)).statusCode).toBe(409);
    await server.db.db.update(runs).set({ status: "failed", failureReason: "daemon_disconnect" }).where(eq(runs.id, runId));
    for (const path of paths) expect((await remove(path)).statusCode).toBe(409);
    await server.db.transaction(async (tx) => { await appendEvent(tx, buildEvent(server.ctx, { type: "run.reconciled", actorType: "system", actorId: "system", correlationId: runId, runId, taskId, payload: { process_exit_confirmed: true } })); });
    expect((await remove(paths[0]!)).statusCode).toBe(200);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!.agentInstanceId).toBe(instanceId);
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: { project_id: "proj_artoo", title: "Cannot reuse deleted computer", acceptance_criteria: ["ok"] } });
    const nextTaskId = created.json().task.id;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${nextTaskId}/ready` })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${nextTaskId}/assign`, payload: { mode: "manual", agent_instance_id: instanceId } })).statusCode).toBe(409);
  });

  it("expires idle resources, restores after a heartbeat and keeps manual disable settings", async () => {
    server = await buildTestServer();
    const future = new Date(Date.parse(server.ctx.clock.nowIso()) + 31 * 86400000);
    server.ctx.clock = { now: () => future, nowIso: () => future.toISOString() };
    const expired = await bootstrap(server.ctx);
    for (const row of [...expired.computers, ...expired.agents, ...expired.agent_instances]) expect(row.lifecycle?.state).toBe("expired");
    // Missing runtime rows retain compatibility only within the inactivity window.
    await server.db.db.delete(agentRuntimes).where(and(eq(agentRuntimes.computerId, computerId), eq(agentRuntimes.runtime, "mock")));
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: { project_id: "proj_artoo", title: "Expired computer cannot run", acceptance_criteria: ["ok"] } });
    const taskId = created.json().task.id;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "manual", agent_instance_id: instanceId } })).statusCode).toBe(409);
    await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, instanceId));
    await server.db.db.update(computers).set({ lastHeartbeatAt: future.toISOString() }).where(eq(computers.id, computerId));
    await recordHeartbeatRuntimes(server.ctx, computerId, [{ runtime: "mock", status: "available", capabilities: ["code.modify"] }]);
    const restored = await bootstrap(server.ctx, () => true);
    for (const row of [...restored.computers, ...restored.agents, ...restored.agent_instances]) expect(row.lifecycle?.state).toBe("active");
    expect(restored.agent_instances[0]!.status).toBe("disabled");
    expect(restored.computers[0]!.lifecycle?.expires_at).toBe(new Date(future.getTime() + 30 * 86400000).toISOString());
    vi.stubEnv("ARTOO_RESOURCE_EXPIRY_DAYS", "7");
    expect((await bootstrap(server.ctx)).computers[0]!.lifecycle?.inactivity_timeout_ms).toBe(7 * 86400000);
  });
});
