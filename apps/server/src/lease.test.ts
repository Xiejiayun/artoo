import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { buildTestServer, type TestServer } from "./test-support.js";

const PROJECT = "proj_artoo";

async function createTask(server: TestServer, title: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: PROJECT, title, acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

interface AcquireBody {
  task_id: string;
  path: string;
  mode: "read" | "write";
  run_id?: string;
  holder_type?: "run" | "task" | "agent" | "system";
  holder_id?: string;
  expires_at?: string;
}

async function acquire(server: TestServer, body: AcquireBody) {
  return server.app.inject({ method: "POST", url: "/api/v1/leases", payload: body });
}

async function listLeases(server: TestServer, status?: string) {
  const url = status ? `/api/v1/projects/${PROJECT}/leases?status=${status}` : `/api/v1/projects/${PROJECT}/leases`;
  return (await server.app.inject({ method: "GET", url })).json().leases as {
    id: string;
    status: string;
  }[];
}

describe("file leases (#12 Phase A)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("read/read coexist on overlapping paths", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    expect((await acquire(server, { task_id: a, path: "src/foo", mode: "read" })).statusCode).toBe(201);
    expect(
      (await acquire(server, { task_id: b, path: "src/foo/bar.ts", mode: "read" })).statusCode,
    ).toBe(201);
  });

  it("write/write and read/write conflict (409) on overlapping paths", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    expect((await acquire(server, { task_id: a, path: "src/foo", mode: "write" })).statusCode).toBe(201);

    const ww = await acquire(server, { task_id: b, path: "src/foo/bar.ts", mode: "write" });
    expect(ww.statusCode).toBe(409);
    expect(ww.json().error.code).toBe("conflict");

    const rw = await acquire(server, { task_id: b, path: "src/foo/bar.ts", mode: "read" });
    expect(rw.statusCode).toBe(409);
  });

  it("non-overlapping paths coexist regardless of mode (segment-aware)", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    expect((await acquire(server, { task_id: a, path: "src/foo", mode: "write" })).statusCode).toBe(201);
    expect((await acquire(server, { task_id: b, path: "src/bar", mode: "write" })).statusCode).toBe(201);
    // `src/foobar` is a sibling, not contained by `src/foo`.
    expect((await acquire(server, { task_id: b, path: "src/foobar", mode: "write" })).statusCode).toBe(201);
  });

  it("release frees the scope for a new writer", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    const first = await acquire(server, { task_id: a, path: "src/foo", mode: "write" });
    const leaseId = first.json().lease.id as string;
    // contended while held
    expect((await acquire(server, { task_id: b, path: "src/foo", mode: "write" })).statusCode).toBe(409);
    // release, then the scope is free
    const released = await server.app.inject({ method: "DELETE", url: `/api/v1/leases/${leaseId}` });
    expect(released.statusCode).toBe(200);
    expect(released.json().lease.status).toBe("released");
    expect((await acquire(server, { task_id: b, path: "src/foo", mode: "write" })).statusCode).toBe(201);
  });

  it("an expired lease does not gate a new acquire", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    expect(
      (
        await acquire(server, {
          task_id: a,
          path: "src/foo",
          mode: "write",
          expires_at: "2000-01-01T00:00:00.000Z",
        })
      ).statusCode,
    ).toBe(201);
    // the prior lease is already expired, so a fresh write acquires cleanly
    expect((await acquire(server, { task_id: b, path: "src/foo", mode: "write" })).statusCode).toBe(201);
    expect(await listLeases(server, "expired")).toHaveLength(1);
    expect(await listLeases(server, "held")).toHaveLength(1);
    const expiredEvents = await server.db.db.execute(
      sql`select type from event_log where type = 'lease.expired'`,
    );
    expect(expiredEvents.rows).toHaveLength(1);
  });

  it("rejects malicious paths before storage (400)", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    for (const path of ["../escape", "/etc/passwd", "C:\\Windows\\system32", "src/../../x"]) {
      const res = await acquire(server, { task_id: a, path, mode: "write" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_error");
    }
    expect(await listLeases(server)).toHaveLength(0); // nothing was stored
  });

  it("acquire is idempotent for the same holder/path/mode", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const first = await acquire(server, { task_id: a, path: "src/foo", mode: "write" });
    const second = await acquire(server, { task_id: a, path: "src/foo", mode: "write" });
    expect(second.json().lease.id).toBe(first.json().lease.id);
    expect(await listLeases(server, "held")).toHaveLength(1); // no duplicate row
  });

  it("does not treat the same explicit holder on another task as idempotent", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    const b = await createTask(server, "b");
    const holder = { holder_type: "agent" as const, holder_id: "agent_1" };
    expect((await acquire(server, { task_id: a, path: "src/foo", mode: "write", ...holder })).statusCode).toBe(201);
    const second = await acquire(server, { task_id: b, path: "src/foo", mode: "write", ...holder });
    expect(second.statusCode).toBe(409);
    expect(await listLeases(server, "held")).toHaveLength(1);
  });

  it("requires explicit holder type and id to be provided together", async () => {
    server = await buildTestServer();
    const a = await createTask(server, "a");
    expect(
      (await acquire(server, { task_id: a, path: "src/foo", mode: "write", holder_type: "agent" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await acquire(server, { task_id: a, path: "src/foo", mode: "write", holder_id: "agent_1" }))
        .statusCode,
    ).toBe(400);
  });

  it("rejects invalid lease status filters", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/projects/${PROJECT}/leases?status=holding`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
