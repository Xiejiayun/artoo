import { goals, organizations, projects, rooms, users } from "@artoo/db";
import { RoomSchema } from "@artoo/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "./auth/auth-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("authoritative room metadata", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function authenticate(userId = "user_owner"): Promise<{ authorization: string }> {
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId });
    return { authorization: `Bearer ${session.raw}` };
  }

  it("returns the stored project and typed routing context independently of URL query parameters", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const headers = await authenticate();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(projects).values({ id: "proj_release", organizationId: "org_default", name: "Release", createdAt: now });
    await server.db.db.insert(goals).values({ id: "goal_release", organizationId: "org_default", projectId: "proj_release", ownerUserId: "user_owner", title: "Ship release", createdAt: now, updatedAt: now });
    await server.db.db.insert(rooms).values([
      { id: "room_release", organizationId: "org_default", projectId: "proj_release", type: "project", name: "Release channel", createdAt: now },
      { id: "room_goal", organizationId: "org_default", projectId: "proj_release", goalId: "goal_release", type: "goal", name: "Release goal", createdAt: now },
      { id: "room_dm", organizationId: "org_default", type: "dm", name: "Direct conversation", createdAt: now },
    ]);
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers, payload: { project_id: "proj_artoo", title: "Review", acceptance_criteria: ["Review done"] } });
    expect(created.statusCode).toBe(201);
    const { task, room: taskRoom } = created.json();
    for (const expected of [
      { id: "room_release", project_id: "proj_release", type: "project", name: "Release channel", task_id: null, goal_id: null },
      { id: "room_goal", project_id: "proj_release", type: "goal", name: "Release goal", task_id: null, goal_id: "goal_release" },
      { id: "room_dm", project_id: null, type: "dm", name: "Direct conversation", task_id: null, goal_id: null },
      { id: taskRoom.id, project_id: "proj_artoo", type: "task", name: taskRoom.name, task_id: task.id, goal_id: null },
    ]) {
      const response = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${expected.id}?project_id=wrong_project&project=wrong_project`, headers });
      expect(response.statusCode).toBe(200);
      const room = RoomSchema.parse(response.json().room);
      expect(room).toEqual({ ...expected, organization_id: "org_default", created_at: expect.any(String) });
    }
  });

  it("requires a real user credential and returns no metadata for missing or foreign rooms", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(users).values({ id: "colleague", organizationId: "org_default", email: "colleague@example.test", displayName: "Colleague", role: "member", createdAt: now });
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: now });
    await server.db.db.insert(projects).values({ id: "proj_secret", organizationId: "org_other", name: "Foreign project", createdAt: now });
    await server.db.db.insert(rooms).values([
      { id: "room_team", organizationId: "org_default", projectId: "proj_artoo", type: "project", name: "Team", createdAt: now },
      { id: "room_foreign", organizationId: "org_other", projectId: "proj_secret", type: "project", name: "Private foreign title", createdAt: now },
    ]);
    const headers = await authenticate("colleague");
    expect((await server.app.inject({ method: "GET", url: "/api/v1/rooms/room_team", headers })).statusCode).toBe(200);
    for (const id of ["room_foreign", "missing"]) {
      const response = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${id}`, headers });
      expect(response.statusCode).toBe(404);
      expect(response.json()).not.toHaveProperty("room");
      expect(response.body).not.toContain("Private foreign title");
      expect(response.body).not.toContain("proj_secret");
    }
    for (const authorization of [undefined, "Bearer invalid"]) {
      const response = await server.app.inject({ method: "GET", url: "/api/v1/rooms/room_team", ...(authorization ? { headers: { authorization } } : {}) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).not.toHaveProperty("room");
    }
  });
});
