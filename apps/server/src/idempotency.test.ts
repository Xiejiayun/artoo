import { createHash } from "node:crypto";
import { eventLog, idempotencyKeys, messages } from "@artoo/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function taskCount(server: TestServer): Promise<number> {
  const res = await server.db.db.execute(sql`select count(*)::int as c from tasks`);
  return (res.rows[0] as { c: number }).c;
}

const PAYLOAD = {
  project_id: "proj_artoo",
  title: "idem task",
  acceptance_criteria: ["ok"],
};

async function createBacklogTask(server: TestServer, title: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { ...PAYLOAD, title },
  });
  return res.json().task.id as string;
}

describe("Idempotency-Key request wrapper", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("replays a POST with the same key without re-running the handler", async () => {
    server = await buildTestServer();
    const headers = { "idempotency-key": "key-1" };
    const first = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers, payload: PAYLOAD });
    const second = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers, payload: PAYLOAD });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    // same task id returned, and only one task actually created
    expect(second.json().task.id).toBe(first.json().task.id);
    expect(await taskCount(server)).toBe(1);
  });

  it("409s when the same key is reused with a different body", async () => {
    server = await buildTestServer();
    const headers = { "idempotency-key": "key-2" };
    await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers, payload: PAYLOAD });
    const conflict = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers,
      payload: { ...PAYLOAD, title: "different" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("conflict");
  });

  it("different keys create distinct tasks (attempt independence)", async () => {
    server = await buildTestServer();
    const a = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "idempotency-key": "key-a" },
      payload: PAYLOAD,
    });
    const b = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      headers: { "idempotency-key": "key-b" },
      payload: PAYLOAD,
    });
    expect(b.json().task.id).not.toBe(a.json().task.id);
    expect(await taskCount(server)).toBe(2);
  });

  it("scopes the same key by actual URL, not just the route template", async () => {
    server = await buildTestServer();
    const taskA = await createBacklogTask(server, "task a");
    const taskB = await createBacklogTask(server, "task b");
    const headers = { "idempotency-key": "same-ready-key" };

    const readyA = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskA}/ready`,
      headers,
    });
    const readyB = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskB}/ready`,
      headers,
    });

    expect(readyA.json().task.id).toBe(taskA);
    expect(readyB.json().task.id).toBe(taskB);
    expect(readyB.json().task.status).toBe("ready");
  });

  it("replays durable messages after a post-commit crash leaves a null response reservation", async () => {
    server = await buildTestServer();
    const task = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: PAYLOAD });
    const roomId = task.json().room.id as string;
    const url = `/api/v1/rooms/${roomId}/messages`;
    const key = "durable-message-retry";
    const headers = { "idempotency-key": key };
    const payload = { body: "Message committed before the response was sent", client_request_id: "durable_message_001" };
    const first = await server.app.inject({ method: "POST", url, headers, payload });
    expect(first.statusCode).toBe(201);
    expect(await server.db.db.select().from(idempotencyKeys)).toHaveLength(0);

    // Reproduce a pre-fix server crashing after its message transaction committed
    // but before onSend cached the HTTP response. A restarted client's retry must
    // read the persisted message instead of being stuck on this old reservation.
    await server.db.db.insert(idempotencyKeys).values({
      scope: `org_default:user_owner:POST:${url}`, key,
      requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      responseJson: null, eventIds: [], createdAt: server.ctx.clock.nowIso(),
    });
    const replay = await server.app.inject({ method: "POST", url, headers, payload });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(await server.db.db.select().from(messages).where(eq(messages.roomId, roomId))).toHaveLength(1);
    expect(await server.db.db.select().from(eventLog).where(and(eq(eventLog.roomId, roomId), eq(eventLog.type, "message.created")))).toHaveLength(1);

    const conflict = await server.app.inject({ method: "POST", url, headers, payload: { ...payload, body: "Changed content" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toContain("client_request_id was already used for a different message");
    expect(await server.db.db.select().from(messages).where(eq(messages.roomId, roomId))).toHaveLength(1);
  });

  it("preserves header-based message replay and conflict checks for clients without a body identity", async () => {
    server = await buildTestServer();
    const task = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: PAYLOAD });
    const roomId = task.json().room.id as string;
    const url = `/api/v1/rooms/${roomId}/messages`;
    const headers = { "idempotency-key": "legacy-message-retry" };
    const payload = { body: "Legacy message" };
    const first = await server.app.inject({ method: "POST", url, headers, payload });
    const replay = await server.app.inject({ method: "POST", url, headers, payload });
    expect(first.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    const reservation = await server.db.db.select().from(idempotencyKeys);
    expect(reservation).toHaveLength(1);
    expect(reservation[0]!.responseJson).toMatchObject({ status: 201 });
    const conflict = await server.app.inject({ method: "POST", url, headers, payload: { body: "Changed legacy message" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.message).toContain("Idempotency-Key reused");
    expect(await server.db.db.select().from(messages).where(eq(messages.roomId, roomId))).toHaveLength(1);
  });

  it("does not exempt malformed body identities from the header reservation", async () => {
    server = await buildTestServer();
    const task = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: PAYLOAD });
    const url = `/api/v1/rooms/${task.json().room.id}/messages`;
    const key = "invalid-body-identity";
    const payload = { body: "Invalid request", client_request_id: "not a valid ID" };
    await server.db.db.insert(idempotencyKeys).values({
      scope: `org_default:user_owner:POST:${url}`, key,
      requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      responseJson: null, eventIds: [], createdAt: server.ctx.clock.nowIso(),
    });
    const result = await server.app.inject({ method: "POST", url, headers: { "idempotency-key": key }, payload });
    expect(result.statusCode).toBe(409);
    expect(result.json().error.message).toContain("still in progress");
    expect(await server.db.db.select().from(messages)).toHaveLength(0);
  });
});
