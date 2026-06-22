import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";
import { currentCursor } from "./services/sync-service.js";

/**
 * #27 v2-B slice 2a — read cursor. Clients use the org's highest
 * event_log.position as the WS since_cursor hydration/tail baseline. Command
 * base_version values come from resource snapshots, not this global cursor.
 */
describe("sync cursor read", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function createTask(s: TestServer, title: string): Promise<void> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title, acceptance_criteria: ["x"] },
    });
    expect(res.statusCode).toBe(201);
  }

  it("currentCursor is a non-negative number and advances as events are appended", async () => {
    server = await buildTestServer();
    const c0 = await currentCursor(server.ctx);
    expect(Number.isInteger(c0)).toBe(true);
    expect(c0).toBeGreaterThanOrEqual(0);

    await createTask(server, "Cursor advances 1");
    const c1 = await currentCursor(server.ctx);
    expect(c1).toBeGreaterThan(c0);

    await createTask(server, "Cursor advances 2");
    const c2 = await currentCursor(server.ctx);
    expect(c2).toBeGreaterThan(c1);
  });

  it("GET /api/v1/sync/cursor returns the current cursor matching currentCursor()", async () => {
    server = await buildTestServer();
    await createTask(server, "Route cursor");
    const expected = await currentCursor(server.ctx);

    const res = await server.app.inject({ method: "GET", url: "/api/v1/sync/cursor" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { cursor: number };
    expect(body.cursor).toBe(expected);
  });
});
