import { sql } from "drizzle-orm";
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
});
