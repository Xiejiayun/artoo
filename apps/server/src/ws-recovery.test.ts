import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

interface Frame {
  type: string;
  topic?: string;
  cursor?: number;
  event?: { type: string; project_id?: string; task_id?: string };
}

interface Conn {
  socket: WebSocket;
  frames: Frame[];
}

async function listen(server: TestServer): Promise<string> {
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  return new URL(address).port;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function connect(url: string, topics: string[], sinceCursor?: number): Promise<Conn> {
  const socket = new WebSocket(url);
  const frames: Frame[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    frames.push(JSON.parse(data) as Frame);
  });
  await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  const sub: Record<string, unknown> = { type: "subscribe", topics };
  if (sinceCursor !== undefined) {
    sub.since_cursor = sinceCursor;
  }
  socket.send(JSON.stringify(sub));
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { socket, frames };
}

async function createTask(server: TestServer, title: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title, acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

const maxCursor = (frames: Frame[]): number =>
  frames.reduce((m, f) => (typeof f.cursor === "number" && f.cursor > m ? f.cursor : m), 0);

describe("#27 WS recovery (cursor catch-up)", () => {
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets.splice(0)) {
      s.close();
    }
    await server?.close();
    server = undefined;
  });

  it("tags live event frames with a monotonic cursor (event_log.position)", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const c = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, ["project:proj_artoo"]);
    sockets.push(c.socket);

    await createTask(server, "A");
    await server.publisher.pumpOnce();
    await waitFor(() => c.frames.some((f) => f.event?.type === "task.created"), "live push");

    const frame = c.frames.find((f) => f.event?.type === "task.created");
    expect(typeof frame?.cursor).toBe("number");
    expect(frame!.cursor!).toBeGreaterThan(0);
  });

  it("replays only events after since_cursor; never re-sends acked history", async () => {
    server = await buildTestServer();
    const port = await listen(server);

    // Observe task A live to learn the cursor up to A.
    const live = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, ["project:proj_artoo"]);
    sockets.push(live.socket);
    const taskA = await createTask(server, "A");
    await server.publisher.pumpOnce();
    await waitFor(() => live.frames.some((f) => f.event?.task_id === taskA), "A live");
    const cursorAfterA = maxCursor(live.frames);
    expect(cursorAfterA).toBeGreaterThan(0);

    // Append task B (positions after cursorAfterA).
    const taskB = await createTask(server, "B");
    await server.publisher.pumpOnce();

    // A fresh client reconnecting with since_cursor = cursorAfterA catches up B only.
    const recovered = await connect(
      `ws://127.0.0.1:${port}/api/v1/ws`,
      ["project:proj_artoo"],
      cursorAfterA,
    );
    sockets.push(recovered.socket);
    await waitFor(() => recovered.frames.some((f) => f.event?.task_id === taskB), "B catch-up");

    // B replayed; A never re-sent; every catch-up frame is strictly after the cursor.
    expect(recovered.frames.some((f) => f.event?.task_id === taskB && f.event?.type === "task.created")).toBe(true);
    expect(recovered.frames.some((f) => f.event?.task_id === taskA)).toBe(false);
    expect(recovered.frames.every((f) => (f.cursor ?? Infinity) > cursorAfterA)).toBe(true);
  });

  it("filters catch-up by subscribed topic", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const taskA = await createTask(server, "A");
    const taskB = await createTask(server, "B");
    await server.publisher.pumpOnce();

    // Subscribe ONLY to task:taskB with since_cursor=0 -> only taskB's events replay.
    const c = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, [`task:${taskB}`], 0);
    sockets.push(c.socket);
    await waitFor(() => c.frames.some((f) => f.event?.task_id === taskB), "taskB catch-up");

    expect(c.frames.every((f) => f.topic === `task:${taskB}`)).toBe(true);
    expect(c.frames.some((f) => f.event?.task_id === taskA)).toBe(false);
  });

  it("recovers missed events across a disconnect/reconnect", async () => {
    server = await buildTestServer();
    const port = await listen(server);

    const first = await connect(`ws://127.0.0.1:${port}/api/v1/ws`, ["project:proj_artoo"]);
    const taskA = await createTask(server, "A");
    await server.publisher.pumpOnce();
    await waitFor(() => first.frames.some((f) => f.event?.task_id === taskA), "A before disconnect");
    const lastCursor = maxCursor(first.frames);

    // Disconnect, then more events happen while offline.
    first.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const taskB = await createTask(server, "B");
    await server.publisher.pumpOnce();

    // Reconnect with the last cursor -> catch up exactly the missed B.
    const second = await connect(
      `ws://127.0.0.1:${port}/api/v1/ws`,
      ["project:proj_artoo"],
      lastCursor,
    );
    sockets.push(second.socket);
    await waitFor(() => second.frames.some((f) => f.event?.task_id === taskB), "B after reconnect");
    expect(second.frames.some((f) => f.event?.task_id === taskA)).toBe(false);
  });
});
