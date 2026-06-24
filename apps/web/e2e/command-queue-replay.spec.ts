import { expect, test } from "@playwright/test";

import { ApiClient } from "../src/api/client.js";
import { createApiCommandQueue } from "../src/api/commandQueue.js";

/**
 * #27 web dogfood — true client↔server queue replay. The canonical
 * `@artoo/client` command queue (wrapped by the web `createApiCommandQueue`)
 * runs a mutation against the REAL server: while offline the command is queued,
 * on reconnect it is replayed and the server applies it exactly once, and a
 * same-key replay is absorbed by server idempotency (no double-apply, no error).
 */
const SERVER_PORT = process.env.ARTOO_PORT ?? "4010";
const API = `http://127.0.0.1:${SERVER_PORT}/api/v1`;

let seq = 0;
function key(prefix: string): string {
  seq += 1;
  return `cq-${prefix}-${Date.now()}-${seq}`;
}

test("queued mutation replays on reconnect and the server applies it exactly once", async () => {
  // A probe client that is always online (real fetch) for setup + assertions.
  const probe = new ApiClient({ baseUrl: API, credentials: "omit" });

  // The queue's client uses a toggleable fetch so we can simulate going offline.
  let online = true;
  const toggleFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    online ? fetch(input, init) : Promise.reject(new TypeError("offline"))) as typeof fetch;
  const api = new ApiClient({ baseUrl: API, credentials: "omit", fetch: toggleFetch });
  const commands = createApiCommandQueue({ attachOnlineListener: false });

  // Create a backlog task to act on.
  const created = await probe.createTask(
    {
      project_id: "proj_artoo",
      title: `cq replay ${Date.now()}`,
      description: "",
      priority: "p2",
      acceptance_criteria: ["done"],
      required_capabilities: ["code.modify"],
    },
    key("create"),
  );
  const taskId = created.task.id;
  expect(created.task.status).toBe("backlog");

  // Go offline and submit Mark-ready through the queue: it must queue, not fail.
  online = false;
  const readyKey = key("ready");
  const pending = commands.submit(() => api.markReady(taskId, readyKey), { key: readyKey });
  await commands.flush();
  expect(commands.pendingCount()).toBe(1);
  // Nothing applied yet — the task is still backlog on the server.
  expect((await probe.getTask(taskId)).task.status).toBe("backlog");

  // Reconnect: the backlog drains and the server applies the command once.
  online = true;
  await commands.flush();
  await pending;
  expect(commands.pendingCount()).toBe(0);
  expect((await probe.getTask(taskId)).task.status).toBe("ready");

  // Replay the SAME idempotency key (a lost-ack scenario): server idempotency
  // returns the stored response, so it is absorbed — no 409 invalid-state, and
  // the task stays ready (applied exactly once).
  const replay = await commands.submit(() => api.markReady(taskId, readyKey), { key: `${readyKey}-replay` });
  expect((replay as { task: { status: string } }).task.status).toBe("ready");
  expect((await probe.getTask(taskId)).task.status).toBe("ready");
});
