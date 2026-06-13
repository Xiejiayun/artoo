import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

interface Frame {
  type: string;
  topic?: string;
  event?: { type: string; project_id?: string; task_id?: string };
}

async function listen(server: TestServer): Promise<string> {
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  return new URL(address).port;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function connect(
  url: string,
  topics: string[],
): Promise<{ socket: WebSocket; frames: Frame[] }> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    frames.push(JSON.parse(data) as Frame);
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  socket.send(JSON.stringify({ type: "subscribe", topics }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { socket, frames };
}

async function createTask(server: TestServer): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "WS push task", acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

describe("client WS realtime", () => {
  let server: TestServer | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    socket?.close();
    await server?.close();
    server = undefined;
    socket = undefined;
  });

  it("pushes task.created to project subscribers with project_id", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const conn = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, ["project:proj_artoo"]);
    socket = conn.socket;

    await createTask(server);
    await server.publisher.pumpOnce();

    await waitFor(
      () => conn.frames.some((f) => f.type === "event" && f.event?.type === "task.created"),
      "task.created push",
    );
    const frame = conn.frames.find((f) => f.event?.type === "task.created");
    expect(frame?.topic).toBe("project:proj_artoo");
    expect(frame?.event?.project_id).toBe("proj_artoo");
  });

  it("delivers task:{id} updates and stops after unsubscribe", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const taskId = await createTask(server);

    const conn = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, [`task:${taskId}`]);
    socket = conn.socket;

    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    await server.publisher.pumpOnce();
    await waitFor(
      () => conn.frames.some((f) => f.topic === `task:${taskId}` && f.event?.type === "task.updated"),
      "task.updated push",
    );

    conn.socket.send(JSON.stringify({ type: "unsubscribe", topics: [`task:${taskId}`] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const before = conn.frames.length;

    await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    await server.publisher.pumpOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(conn.frames.length).toBe(before);
  });
});
