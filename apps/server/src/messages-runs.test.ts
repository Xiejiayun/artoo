import { eventLog } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(server: TestServer): Promise<{ taskId: string; roomId: string }> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "msg/run task",
      acceptance_criteria: ["ok"],
      required_capabilities: ["code.modify"],
    },
  });
  const body = res.json();
  return { taskId: body.task.id as string, roomId: body.room.id as string };
}

describe("messages + runs endpoints", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("posts and lists room messages", async () => {
    server = await buildTestServer();
    const { roomId } = await createTask(server);

    const posted = await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/messages`,
      payload: { kind: "text", body: "hello from the user" },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().message.body).toBe("hello from the user");
    expect(posted.json().message.actor_type).toBe("user");

    const list = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/messages` });
    expect(list.statusCode).toBe(200);
    const bodies = (list.json().messages as { body: string }[]).map((m) => m.body);
    expect(bodies).toContain("hello from the user");

    const missing = await server.app.inject({
      method: "GET",
      url: "/api/v1/rooms/room_missing/messages",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("persists @mentions/assignments and emits a metadata-only message.mention event (#114)", async () => {
    server = await buildTestServer();
    const { roomId } = await createTask(server);

    const posted = await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/messages`,
      payload: {
        kind: "status_update",
        body: "hey @codex please review — secret-in-body should not leak to the event",
        mentions: [{ actor_type: "agent", actor_id: "SkywalkerCodex" }],
        assignments: [{ assignee_type: "agent", assignee_id: "SkywalkerCodex", action: "review #114" }],
      },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().message.payload.mentions).toHaveLength(1);
    expect(posted.json().message.payload.assignments[0].assignee_id).toBe("SkywalkerCodex");

    const rows = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "message.mention")));
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.mentions).toEqual([{ actor_type: "agent", actor_id: "SkywalkerCodex" }]);
    // Secret-safe: the message body never appears in the mention event payload.
    expect(JSON.stringify(payload)).not.toContain("secret-in-body");
  });

  it("emits no message.mention event when there are no refs (#114)", async () => {
    server = await buildTestServer();
    const { roomId } = await createTask(server);
    await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/messages`,
      payload: { kind: "text", body: "plain message" },
    });
    const rows = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "message.mention")));
    expect(rows).toHaveLength(0);
  });

  it("gets a run and cancels it", async () => {
    server = await buildTestServer();
    const { taskId } = await createTask(server);
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    const runId = assigned.json().run.id as string;

    const got = await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().run.status).toBe("queued");

    const cancelled = await server.app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe("cancelled");

    const after = await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(after.json().run.status).toBe("cancelled");
    const task = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(task.json().task.status).toBe("cancelled");
  });
});
