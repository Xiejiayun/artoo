// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import {
  agentInstancePresence,
  computerPresence,
  listAgentInstancePresence,
  listComputerPresence,
} from "./services/presence-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #113 slice 2 — presence-service synthesis. Verifies the server gathers facts
 * from runs/tasks/runtime/computer/device + a live-connection predicate and the
 * domain synthesizes agent-instance/computer presence. Does NOT depend on the
 * gated #111 daemon smoke.
 */
const LIVE = () => true;
const DEAD = () => false;

describe("presence-service #113", () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  async function queueARun(): Promise<void> {
    const create = await srv!.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "t", acceptance_criteria: ["a"], required_capabilities: ["code.modify"] },
    });
    const taskId = create.json().task.id as string;
    await srv!.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await srv!.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode).toBeLessThan(300);
    expect(assigned.json().run.computer_id).toBe("computer_local_mock");
  }

  it("idle seeded instance: online + available + idle, no active runs, no secrets", async () => {
    srv = await buildTestServer();
    const p = await agentInstancePresence(srv.ctx, "instance_mock_coder", LIVE);
    expect(p).not.toBeNull();
    expect(p!.connection).toBe("online");
    expect(p!.runtime).toBe("available");
    expect(p!.work).toBe("idle");
    expect(p!.active_runs).toBe(0);
    expect(p!.concurrency_limit).toBe(1);
    expect(p!.health_reason).toBeNull();
    expect(JSON.stringify(p)).not.toMatch(/token|secret|hash|node_token/i);
  });

  it("no live connection => offline + heartbeat_timeout", async () => {
    srv = await buildTestServer();
    const p = await agentInstancePresence(srv.ctx, "instance_mock_coder", DEAD);
    expect(p!.connection).toBe("offline");
    expect(p!.health_reason).toBe("heartbeat_timeout");
  });

  it("a queued run flips work=queued and runtime=busy at capacity 1; active_runs=1", async () => {
    srv = await buildTestServer();
    await queueARun();
    const p = await agentInstancePresence(srv.ctx, "instance_mock_coder", LIVE);
    expect(p!.active_runs).toBe(1);
    expect(p!.work).toBe("queued");
    expect(p!.runtime).toBe("busy"); // 1 active >= limit 1
  });

  it("computer presence rolls up runtimes + active_runs + queue_depth", async () => {
    srv = await buildTestServer();
    await queueARun();
    const c = await computerPresence(srv.ctx, "computer_local_mock", LIVE);
    expect(c).not.toBeNull();
    expect(c!.connection).toBe("online");
    expect(c!.runtimes.some((r) => r.runtime === "mock")).toBe(true);
    expect(c!.active_runs).toBe(1);
    expect(c!.queue_depth).toBe(1); // the queued run
  });

  it("list variants return one row each for the seed", async () => {
    srv = await buildTestServer();
    const agents = await listAgentInstancePresence(srv.ctx, LIVE);
    const computersList = await listComputerPresence(srv.ctx, LIVE);
    expect(agents.length).toBeGreaterThanOrEqual(1);
    expect(agents.some((a) => a.agent_instance_id === "instance_mock_coder")).toBe(true);
    expect(computersList.some((c) => c.computer_id === "computer_local_mock")).toBe(true);
  });
});
