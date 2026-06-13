import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

describe("server core HTTP", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("GET /bootstrap returns the seeded org, user and project", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({ method: "GET", url: "/api/v1/bootstrap" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.organization.id).toBe("org_default");
    expect(body.user.id).toBe("user_owner");
    expect(body.projects.map((p: { id: string }) => p.id)).toContain("proj_artoo");
    expect(body.actor).toEqual({ type: "user", id: "user_owner" });
  });

  it("POST /tasks creates a task + task room atomically and emits two events", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Build approval inbox",
        acceptance_criteria: ["pending approvals visible"],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.task.status).toBe("backlog");
    expect(body.task.title).toBe("Build approval inbox");
    expect(body.room.type).toBe("task");
    // task<->room cross-reference is consistent
    expect(body.room.task_id).toBe(body.task.id);
    expect(body.task.room_id).toBe(body.room.id);

    const events = await server.db.db.execute(
      sql`select type from event_log where task_id = ${body.task.id} order by position`,
    );
    const types = (events.rows as { type: string }[]).map((r) => r.type);
    expect(types).toEqual(["task.created", "room.created"]);
  });

  it("POST /tasks rolls back fully when the project does not exist (no task, no event)", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_missing", title: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    const counts = await server.db.db.execute(
      sql`select (select count(*) from tasks)::int as tasks, (select count(*) from event_log)::int as events`,
    );
    expect(counts.rows[0]).toEqual({ tasks: 0, events: 0 });
  });

  it("POST /tasks returns 400 on an invalid payload (missing title)", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("GET /tasks/:id returns a snapshot; 404 for unknown id", async () => {
    server = await buildTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "Snapshot me" },
    });
    const taskId = created.json().task.id;

    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();
    expect(body.task.id).toBe(taskId);
    expect(body.room.id).toBe(created.json().room.id);
    expect(body.runs).toEqual([]);
    expect(body.approvals).toEqual([]);
    expect(body.artifacts).toEqual([]);

    const missing = await server.app.inject({ method: "GET", url: "/api/v1/tasks/task_missing" });
    expect(missing.statusCode).toBe(404);
  });
});
