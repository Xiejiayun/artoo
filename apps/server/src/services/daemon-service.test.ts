import { computers } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { listDaemons } from "./daemon-service.js";

describe("daemon presence comes from live execution connection and heartbeat", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  it("does not confuse persisted online resources or runtimes with a connected daemon", async () => {
    const result = await server.app.inject({ method: "GET", url: "/api/v1/daemons" });
    expect(result.statusCode).toBe(200);
    expect(result.json().daemons[0]).toMatchObject({ status: "offline", connected: false, last_heartbeat_at: "2026-06-13T00:00:00.000Z" });
    expect((await listDaemons(server.ctx, () => true, () => false))[0]?.status).toBe("online");
  });
  it("distinguishes stale heartbeats, reconnecting, missing heartbeat and disabled devices", async () => {
    server.ctx.clock = fixedClock("2026-06-13T00:00:31.000Z");
    expect((await listDaemons(server.ctx, () => true, () => false))[0]).toMatchObject({ status: "stale", heartbeat_age_ms: 31000 });
    expect((await listDaemons(server.ctx, () => false, () => true))[0]?.status).toBe("reconnecting");
    await server.db.db.update(computers).set({ lastHeartbeatAt: null }).where(eq(computers.id, "computer_local_mock"));
    expect((await listDaemons(server.ctx, () => true, () => false))[0]).toMatchObject({ status: "stale", heartbeat_age_ms: null });
    await server.db.db.update(computers).set({ status: "disabled" }).where(eq(computers.id, "computer_local_mock"));
    expect((await listDaemons(server.ctx, () => true, () => true))[0]?.status).toBe("disabled");
    expect(await listDaemons({ ...server.ctx, organizationId: "foreign" }, () => true, () => true)).toEqual([]);
  });
});
