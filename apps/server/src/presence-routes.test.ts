// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #113 slice 3 — presence read API. Thin routes over the synthesis service.
 * No live node is registered in the test server, so connection reads `offline`
 * (correct: no daemon socket). Shape + status + 404 + device backward-compat.
 */
describe("presence routes #113", () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  const CONNECTION = ["online", "stale", "offline", "revoked"];
  const WORK = ["idle", "queued", "running", "awaiting_input", "awaiting_approval", "blocked", "paused"];
  const RUNTIME = ["available", "busy", "disabled", "stale", "missing"];

  it("GET /agent-instances/presence lists synthesized presence", async () => {
    srv = await buildTestServer();
    const res = await srv.app.inject({ method: "GET", url: "/api/v1/agent-instances/presence" });
    expect(res.statusCode).toBe(200);
    const list = res.json().presence as Array<Record<string, unknown>>;
    expect(list.some((p) => p.agent_instance_id === "instance_mock_coder")).toBe(true);
  });

  it("GET /agent-instances/:id/presence returns the full read-model shape", async () => {
    srv = await buildTestServer();
    const res = await srv.app.inject({ method: "GET", url: "/api/v1/agent-instances/instance_mock_coder/presence" });
    expect(res.statusCode).toBe(200);
    const p = res.json().presence;
    expect(p.agent_instance_id).toBe("instance_mock_coder");
    expect(CONNECTION).toContain(p.connection);
    expect(WORK).toContain(p.work);
    expect(RUNTIME).toContain(p.runtime);
    expect(typeof p.concurrency_limit).toBe("number");
    expect(typeof p.active_runs).toBe("number");
    expect(p.source).toBeDefined();
    expect(typeof p.as_of).toBe("string");
    expect(JSON.stringify(p)).not.toMatch(/token|secret|hash/i);
  });

  it("GET /agent-instances/:id/presence => 404 for unknown id", async () => {
    srv = await buildTestServer();
    const res = await srv.app.inject({ method: "GET", url: "/api/v1/agent-instances/nope/presence" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /computers/presence + /computers/:id/presence shape", async () => {
    srv = await buildTestServer();
    const list = await srv.app.inject({ method: "GET", url: "/api/v1/computers/presence" });
    expect(list.statusCode).toBe(200);
    expect((list.json().presence as Array<{ computer_id: string }>).some((c) => c.computer_id === "computer_local_mock")).toBe(true);

    const one = await srv.app.inject({ method: "GET", url: "/api/v1/computers/computer_local_mock/presence" });
    expect(one.statusCode).toBe(200);
    const c = one.json().presence;
    expect(CONNECTION).toContain(c.connection);
    expect(Array.isArray(c.runtimes)).toBe(true);
    expect(typeof c.active_runs).toBe("number");
    expect(typeof c.queue_depth).toBe("number");

    expect((await srv.app.inject({ method: "GET", url: "/api/v1/computers/nope/presence" })).statusCode).toBe(404);
  });

  it("GET /devices/:id/presence keeps the backward-compatible shape", async () => {
    srv = await buildTestServer();
    const res = await srv.app.inject({ method: "GET", url: "/api/v1/devices/any_device/presence" });
    expect(res.statusCode).toBe(200);
    const p = res.json().presence;
    // unchanged #28 contract
    expect(p).toHaveProperty("device_id");
    expect(p).toHaveProperty("state");
    expect(p).toHaveProperty("last_seen_at");
  });
});
