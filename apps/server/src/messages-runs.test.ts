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
