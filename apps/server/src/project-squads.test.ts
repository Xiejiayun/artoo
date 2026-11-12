import { agentInstances, agentRuntimes, agents, organizations, projects, runs, tasks, users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoal } from "./services/goal-service.js";
import { startDiscussion } from "./services/discussion-service.js";
import { enqueueAssistantTurn } from "./services/assistant-service.js";

describe("project squad isolation", () => {
  let server: TestServer;
  const instanceId = "instance_mock_coder";
  beforeEach(async () => {
    server = await buildTestServer();
    await server.db.db.insert(projects).values({ id: "proj_second", organizationId: "org_default", name: "Second", createdAt: server.ctx.clock.nowIso() });
  });
  afterEach(async () => { await server.close(); });
  const move = (projectId: string | null) => server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${instanceId}/project`, payload: { project_id: projectId } });
  async function ready(projectId: string) {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: { project_id: projectId, title: "Project work", acceptance_criteria: ["done"] } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    return taskId;
  }
  const assign = (id: string, mode: "manual" | "auto") => server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`,
    payload: { mode, ...(mode === "manual" ? { agent_instance_id: instanceId } : {}) } });

  it("starts new projects empty and rejects both automatic and pinned cross-project assignments", async () => {
    const id = await ready("proj_second");
    for (const mode of ["auto", "manual"] as const) {
      const response = await assign(id, mode);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("squad is empty");
    }
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]?.status).toBe("ready");
    const snapshot = (await server.app.inject("/api/v1/bootstrap")).json();
    expect(snapshot.agent_instances[0]).toMatchObject({ id: instanceId, project_id: "proj_artoo" });
    expect((await move("proj_second")).json().agent_instance).toMatchObject({ project_id: "proj_second", workspace_root: "C:/workspace/artoo" });
    expect((await assign(await ready("proj_artoo"), "manual")).statusCode).toBe(409);
    expect((await assign(id, "auto")).statusCode).toBe(200);
    expect((await move("proj_artoo")).statusCode).toBe(409);
    expect((await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId)))[0]?.projectId).toBe("proj_second");
  });

  it("keeps identities reusable while newly registered instances have independent projects and roots", async () => {
    await server.db.db.update(agentRuntimes).set({ capabilities: ["code.modify", "test.run"] }).where(eq(agentRuntimes.id, "runtime_mock"));
    const response = await server.app.inject({ method: "POST", url: "/api/v1/computers/computer_local_mock/instances",
      payload: { project_id: "proj_second", agent_id: "agent_mock_coder", runtime: "mock", workspace_root: "C:/second" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().agent_instance).toMatchObject({ project_id: "proj_second", agent_id: "agent_mock_coder", workspace_root: "C:/second" });
    expect(await server.db.db.select().from(agents)).toHaveLength(1);
    expect((await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId)))[0]?.projectId).toBe("proj_artoo");
    expect((await assign(await ready("proj_second"), "auto")).json().run.agent_instance_id).toBe(response.json().agent_instance.id);
  });

  it("leaves unassigned inventory ineligible and validates project ownership at both write boundaries", async () => {
    expect((await move(null)).statusCode).toBe(200);
    expect((await assign(await ready("proj_artoo"), "manual")).statusCode).toBe(409);
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: server.ctx.clock.nowIso() });
    await server.db.db.insert(projects).values({ id: "proj_foreign", organizationId: "org_other", name: "Private", createdAt: server.ctx.clock.nowIso() });
    for (const projectId of ["proj_foreign", "missing"]) {
      expect((await move(projectId)).statusCode).toBe(404);
      expect((await server.app.inject({ method: "POST", url: "/api/v1/computers/computer_local_mock/instances",
        payload: { project_id: projectId, runtime: "mock", workspace_root: "C:/second" } })).statusCode).toBe(404);
    }
    for (const value of ["", 123, {}, undefined]) {
      expect((await server.app.inject({ method: "PATCH", url: `/api/v1/agent-instances/${instanceId}/project`, payload: { project_id: value } })).statusCode).toBe(400);
    }
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, server.ctx.actorUserId));
    expect((await move("proj_artoo")).statusCode).toBe(403);
  });

  it("rejects planning participants from another project and fences changes during a discussion", async () => {
    const [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "peer" });
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Plan", objective: "Make a plan", acceptance_criteria: ["done"] });
    const request = { participants: [{ agent_instance_id: instanceId, role: "Author" }, { agent_instance_id: "peer", role: "Reviewer" }], rounds: 1, max_minutes: 5 };
    await server.db.db.update(agentInstances).set({ projectId: "proj_second" }).where(eq(agentInstances.id, "peer"));
    await expect(startDiscussion(server.ctx, goal.id, request)).rejects.toThrow("this project's squad");
    await server.db.db.update(agentInstances).set({ projectId: "proj_artoo" }).where(eq(agentInstances.id, "peer"));
    await startDiscussion(server.ctx, goal.id, request);
    expect((await move("proj_second")).statusCode).toBe(409);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it("rejects a conversation's explicit agent from another project before persisting a turn", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_second", title: "Second", objective: "Work here", acceptance_criteria: ["done"] });
    await expect(enqueueAssistantTurn(server.ctx, goal.room_id!, { body: "Please help", client_request_id: "foreign-agent", agent_instance_id: instanceId }))
      .rejects.toThrow("this project's squad");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it("retains disconnect fences even after a run is marked failed", async () => {
    const taskId = await ready("proj_artoo");
    const run = (await assign(taskId, "manual")).json().run;
    await server.db.db.update(runs).set({ status: "failed", failureReason: "daemon_disconnect" })
      .where(and(eq(runs.id, run.id), eq(runs.organizationId, server.ctx.organizationId)));
    expect((await move("proj_second")).statusCode).toBe(409);
  });

  it("keeps deleted instances outside project membership edits and explicit conversation execution", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Project work", objective: "Work here", acceptance_criteria: ["done"] });
    expect((await server.app.inject({ method: "DELETE", url: `/api/v1/agent-instances/${instanceId}` })).statusCode).toBe(200);
    expect((await move("proj_second")).statusCode).toBe(404);
    await expect(enqueueAssistantTurn(server.ctx, goal.room_id!, { body: "Please help", client_request_id: "deleted-agent", agent_instance_id: instanceId }))
      .rejects.toThrow("this project's squad");
    expect((await assign(await ready("proj_artoo"), "auto")).statusCode).toBe(409);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
    const [instance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId));
    expect(instance).toMatchObject({ projectId: "proj_artoo" });
    expect(new Date(instance!.deletedAt!).toISOString()).toBe(server.ctx.clock.nowIso());
  });
});
