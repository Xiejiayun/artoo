// @vitest-environment node
import { agentInstances, agentRuntimes, computers, devices, organizations, projects, runs, tasks } from "@artoo/db";
import { RUN_STATUSES, isActiveRunStatus } from "@artoo/domain";
import { performance } from "node:perf_hooks";
import { appendFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("runtime stale window matches scheduler while connection can remain online", async () => {
    srv = await buildTestServer();
    const staleRuntime = new Date(Date.parse(srv.ctx.clock.nowIso()) - 45_000).toISOString();
    await srv.db.db
      .update(agentRuntimes)
      .set({ lastSeenAt: staleRuntime })
      .where(and(eq(agentRuntimes.computerId, "computer_local_mock"), eq(agentRuntimes.runtime, "mock")));

    const p = await agentInstancePresence(srv.ctx, "instance_mock_coder", LIVE);
    expect(p!.connection).toBe("online");
    expect(p!.runtime).toBe("stale");
    expect(p!.health_reason).toBe("heartbeat_timeout");
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

  it("preserves every active run/task state, shared-computer counts, trust and organization boundaries", async () => {
    srv = await buildTestServer();
    const now = srv.ctx.clock.nowIso();
    const [instance] = await srv.db.db.select().from(agentInstances);
    const [computer] = await srv.db.db.select().from(computers);
    await srv.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: now });
    await srv.db.db.insert(projects).values({ id: "proj_other", organizationId: "org_other", name: "Other", createdAt: now });
    await srv.db.db.insert(computers).values({ ...computer!, id: "computer_other", organizationId: "org_other" });
    await srv.db.db.insert(agentInstances).values([
      ...RUN_STATUSES.map((status) => ({ ...instance!, id: `instance_${status}`, config: { concurrency_limit: 2 } })),
      { ...instance!, id: "instance_deleted", deletedAt: now },
      { ...instance!, id: "instance_other", organizationId: "org_other", projectId: "proj_other", computerId: "computer_other" },
    ]);
    const runFacts = RUN_STATUSES.map((status) => ({ status, taskStatus: status === "running" ? "awaiting_approval" : "ready" }));
    await srv.db.db.insert(tasks).values(runFacts.map(({ status, taskStatus }) => ({
      id: `task_${status}`, organizationId: "org_default", projectId: "proj_artoo", title: status, status: taskStatus,
      createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now,
    })));
    await srv.db.db.insert(runs).values(runFacts.map(({ status }) => ({
      id: `run_${status}`, organizationId: "org_default", taskId: `task_${status}`, computerId: instance!.computerId,
      agentInstanceId: `instance_${status}`, runtimeId: "mock", status, createdAt: now,
    })));
    // Foreign organization facts sharing a physical computer must not affect
    // this organization's trust, runtime or run counts.
    await srv.db.db.insert(devices).values([
      { id: "active_device", organizationId: "org_default", computerId: instance!.computerId, displayName: "Active", trust: "active", platform: "windows", appVersion: "test", enrolledByUserId: "user_owner", createdAt: now },
      { id: "foreign_revoked", organizationId: "org_other", computerId: instance!.computerId, displayName: "Foreign", trust: "revoked", platform: "windows", appVersion: "test", enrolledByUserId: "user_owner", createdAt: now },
    ]);
    await srv.db.db.insert(runs).values({ id: "foreign_run", organizationId: "org_other", taskId: "task_running", computerId: instance!.computerId,
      agentInstanceId: "instance_running", runtimeId: "mock", status: "running", createdAt: now });
    await srv.db.db.insert(agentRuntimes).values({ id: "foreign_runtime", organizationId: "org_other", computerId: instance!.computerId, runtime: "foreign", status: "disabled", lastSeenAt: now });
    const list = await listAgentInstancePresence(srv.ctx, LIVE);
    expect(list).toHaveLength(RUN_STATUSES.length + 1);
    for (const status of RUN_STATUSES) {
      const actual = list.find((item) => item.agent_instance_id === `instance_${status}`)!;
      expect(actual).toEqual(await agentInstancePresence(srv.ctx, actual.agent_instance_id, LIVE));
      expect(actual.connection).toBe("online");
      expect(actual.active_runs).toBe(isActiveRunStatus(status) ? 1 : 0);
      expect(actual.work).toBe(status === "running" ? "awaiting_approval" : status === "starting" ? "queued" : isActiveRunStatus(status) ? status : "idle");
    }
    const [presence] = await listComputerPresence(srv.ctx, LIVE);
    expect(presence).toEqual(await computerPresence(srv.ctx, instance!.computerId, LIVE));
    expect(presence).toMatchObject({ active_runs: 5, queue_depth: 2, connection: "online" });
    expect(presence!.runtimes.map((runtime) => runtime.runtime)).not.toContain("foreign");
    await srv.db.db.insert(devices).values({ id: "revoked_device", organizationId: "org_default", computerId: instance!.computerId, displayName: "Revoked", trust: "revoked", platform: "windows", appVersion: "test", enrolledByUserId: "user_owner", createdAt: now });
    expect((await listAgentInstancePresence(srv.ctx, LIVE)).every((item) => item.connection === "revoked")).toBe(true);
    expect((await listComputerPresence(srv.ctx, LIVE))[0]!.connection).toBe("revoked");
  });

  it("measures list query growth against representative retained run history", async () => {
    srv = await buildTestServer();
    const now = srv.ctx.clock.nowIso();
    const [instance] = await srv.db.db.select().from(agentInstances);
    const [computer] = await srv.db.db.select().from(computers);
    const computerIds = [computer!.id, "computer_1", "computer_2", "computer_3"];
    await srv.db.db.insert(computers).values(computerIds.slice(1).map((id) => ({ ...computer!, id })));
    await srv.db.db.insert(agentRuntimes).values(computerIds.slice(1).map((computerId) => ({ id: `runtime_${computerId}`, computerId, organizationId: "org_default", runtime: "mock", status: "available", lastSeenAt: now })));
    const instances = [instance!, ...Array.from({ length: 19 }, (_, i) => ({ ...instance!, id: `instance_${i}`, computerId: computerIds[i % 4]! }))];
    await srv.db.db.insert(agentInstances).values(instances.slice(1));
    await srv.db.db.insert(tasks).values(instances.map((item) => ({ id: `task_${item.id}`, organizationId: "org_default", projectId: "proj_artoo", title: item.id,
      status: "running", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now })));
    await srv.db.db.insert(runs).values(instances.flatMap((item) => Array.from({ length: 51 }, (_, i) => ({
      id: `${item.id}_run_${i}`, organizationId: "org_default", taskId: `task_${item.id}`, computerId: item.computerId,
      agentInstanceId: item.id, runtimeId: "mock", status: i === 0 ? "running" : ["completed", "failed", "cancelled"][i % 3]!, createdAt: now,
    }))));
    const client = (srv.db.db as unknown as { $client: { query(...args: unknown[]): Promise<{ rows: unknown[] }> } }).$client;
    const querySpy = vi.spyOn(client, "query");
    try {
      for (const [name, read, count] of [
        ["agents", () => listAgentInstancePresence(srv!.ctx, LIVE), 20],
        ["computers", () => listComputerPresence(srv!.ctx, LIVE), 4],
      ] as const) {
        await read(); // Warm the PGlite plan/code paths separately from samples.
        const samples: number[] = [];
        let queryCount = 0, returnedRows = 0;
        const sampleCount = process.env.ARTOO_PRESENCE_BENCHMARK_REPORT ? 20 : 1;
        for (let i = 0; i < sampleCount; i++) {
          querySpy.mockClear();
          const started = performance.now();
          const result = await read();
          samples.push(performance.now() - started);
          expect(result).toHaveLength(count);
          queryCount = querySpy.mock.calls.length;
          returnedRows = (await Promise.all(querySpy.mock.results.map((item) => item.value as Promise<{ rows: unknown[] }>))).reduce((sum, item) => sum + item.rows.length, 0);
          expect(queryCount).toBe(name === "agents" ? 5 : 4);
          expect(returnedRows).toBe(name === "agents" ? 48 : 28);
        }
        samples.sort((a, b) => a - b);
        if (process.env.ARTOO_PRESENCE_BENCHMARK_REPORT) appendFileSync(process.env.ARTOO_PRESENCE_BENCHMARK_REPORT,
          JSON.stringify({ scope: "local PGlite, 20 instances / 4 computers / 1000 terminal + 20 active runs", name, queryCount, returnedRows, samples: sampleCount, p95_ms: samples[Math.ceil(sampleCount * 0.95) - 1] }) + "\n");
      }
    } finally { querySpy.mockRestore(); }
  });
});
