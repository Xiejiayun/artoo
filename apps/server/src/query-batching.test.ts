import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { artifacts, contextPacks, eventLog, messages, organizations, projects, rooms, runs, taskDependencies, tasks } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGoalAuditBundle, getTaskAuditBundle } from "./services/audit-service.js";
import { buildRunContextPack } from "./services/context-pack-service.js";
import { createGoal } from "./services/goal-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("bounded evidence query batches", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  type MeasuredClient = { query(...args: unknown[]): Promise<{ rows: unknown[] }> };
  async function measure<T>(name: string, read: () => Promise<T>, selectedClient?: MeasuredClient) {
    await read();
    const client = selectedClient ?? (server.db.db as unknown as { $client: MeasuredClient }).$client;
    const spy = vi.spyOn(client, "query");
    const samples: number[] = [];
    let result: T | undefined;
    let queryCount = 0;
    let returnedRows = 0;
    try {
      const sampleCount = process.env.ARTOO_QUERY_BATCHING_REPORT ? 10 : 1;
      for (let index = 0; index < sampleCount; index++) {
        spy.mockClear();
        const started = performance.now();
        result = await read();
        samples.push(performance.now() - started);
        queryCount = spy.mock.calls.length;
        returnedRows = (await Promise.all(spy.mock.results.map((entry) => entry.value as Promise<{ rows: unknown[] }>)))
          .reduce((sum, entry) => sum + entry.rows.length, 0);
      }
      samples.sort((left, right) => left - right);
      if (process.env.ARTOO_QUERY_BATCHING_REPORT) appendFileSync(process.env.ARTOO_QUERY_BATCHING_REPORT,
        JSON.stringify({ name, engine: "local PGlite", queryCount, returnedRows, samples: sampleCount,
          p95_ms: samples[Math.ceil(samples.length * 0.95) - 1] }) + "\n");
      return { result: result!, queryCount, returnedRows };
    } finally { spy.mockRestore(); }
  }

  it("keeps latest attempts, scoped dependencies, order and per-task artifact limits in a 101-edge handoff", async () => {
    server = await buildTestServer();
    const db = server.db.db;
    const now = server.ctx.clock.nowIso();
    const base = { organizationId: "org_default", projectId: "proj_artoo", status: "done", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now };
    const predecessors = Array.from({ length: 101 }, (_, index) => ({ ...base, id: `upstream_${String(index).padStart(3, "0")}`, title: `Upstream ${index}` }));
    await db.insert(tasks).values([...predecessors, { ...base, id: "consumer", title: "Consumer", status: "ready" }]);
    await db.insert(organizations).values({ id: "org_foreign", name: "Foreign", createdAt: now });
    await db.insert(projects).values([
      { id: "proj_other", organizationId: "org_default", name: "Other", createdAt: now },
      { id: "proj_foreign", organizationId: "org_foreign", name: "Foreign", createdAt: now },
    ]);
    await db.insert(tasks).values([
      { ...base, id: "private_project", projectId: "proj_other", title: "Private project" },
      { ...base, id: "private_org", organizationId: "org_foreign", projectId: "proj_foreign", title: "Private organization" },
    ]);
    await db.insert(taskDependencies).values([...predecessors.map((item) => item.id), "private_project", "private_org"].map((id) => ({
      id: `dep_${id}`, organizationId: "org_default", fromTaskId: id, toTaskId: "consumer", type: "soft_context", createdAt: now,
    })));
    const runBase = { organizationId: "org_default", computerId: "computer_local_mock", agentInstanceId: "instance_mock_coder", runtimeId: "mock", createdAt: now };
    await db.insert(runs).values(predecessors.map((item) => ({ ...runBase, id: `a_${item.id}`, taskId: item.id, status: "completed" })));
    // Same timestamp exercises the id tie-breaker; newer non-success must hide old success.
    await db.insert(runs).values(["failed", "running", "cancelled", "paused"].map((status, index) => ({
      ...runBase, id: `z_${predecessors[index + 1]!.id}`, taskId: predecessors[index + 1]!.id, status,
    })));
    await db.insert(artifacts).values(predecessors.flatMap((item, index) => Array.from({ length: index === 0 ? 105 : 1 }, (_, artifactIndex) => ({
      id: `${item.id}_artifact_${String(artifactIndex).padStart(3, "0")}`, organizationId: "org_default", taskId: item.id, runId: `a_${item.id}`,
      type: "file", uri: "https://private.invalid?token=never-export", checksum: "sha256:test", metadata: { secret: "never-export" }, createdAt: now,
    }))));
    // Corrupt historical linkage must not import a different task/org's artifact.
    await db.insert(artifacts).values([
      { id: "foreign_artifact", organizationId: "org_foreign", taskId: "private_org", runId: "a_upstream_000", type: "file", uri: "private", createdAt: now },
      { id: "wrong_task_artifact", organizationId: "org_default", taskId: "private_project", runId: "a_upstream_000", type: "file", uri: "private", createdAt: now },
    ]);
    const [consumer] = await db.select().from(tasks).where(eq(tasks.id, "consumer"));
    // PGlite's transaction owns a different query client. Measure that actual
    // client, excluding BEGIN/COMMIT, rather than reporting zero outer queries.
    const pg = (db as unknown as { $client: PGlite }).$client;
    const measured = await pg.transaction(async (client) => {
      const tx = drizzle(client as unknown as PGlite) as unknown as DrizzleDb;
      return measure("context-101-dependencies", () => buildRunContextPack(server.ctx, tx,
        { runId: "run_consumer", task: consumer!, workspaceRoot: null }), client as unknown as MeasuredClient);
    });
    const [stored] = await db.select().from(contextPacks).where(eq(contextPacks.id, measured.result.contextPackId));
    const payload = ContextPackSchema.parse(stored!.payload);
    expect(payload.dependency_context!.truncated).toBe(true);
    const entries = payload.dependency_context!.entries;
    expect(entries.map((entry) => entry.task_id)).toEqual(predecessors.slice(0, 100).map((item) => item.id));
    expect(entries[0]!.artifacts_truncated).toBe(true);
    expect(entries[0]!.artifacts.map((item) => item.id)).toEqual(Array.from({ length: 100 }, (_, index) => `upstream_000_artifact_${String(index).padStart(3, "0")}`));
    for (const entry of entries.slice(1, 5)) expect(entry).toMatchObject({ run_id: null, artifacts: [], artifacts_truncated: false });
    for (const entry of entries.slice(5)) expect(entry).toMatchObject({ run_id: `a_${entry.task_id}`, artifacts_truncated: false, artifacts: [{ run_id: `a_${entry.task_id}` }] });
    expect(JSON.stringify(payload)).not.toMatch(/never-export|foreign_artifact|wrong_task_artifact|Private project|Private organization/);
    expect(measured.queryCount).toBe(10);
    expect(measured.returnedRows).toBe(398);
  });

  it("groups 45 child audit bundles without mixing task/correlation events or leaking another organization", async () => {
    server = await buildTestServer();
    const db = server.db.db;
    const now = server.ctx.clock.nowIso();
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Batch audit" });
    const children = Array.from({ length: 45 }, (_, index) => ({ id: `audit_${String(index).padStart(3, "0")}`, organizationId: "org_default",
      projectId: "proj_artoo", goalId: goal.id, title: `Child ${index}`, status: "ready", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now }));
    await db.insert(tasks).values(children);
    await db.insert(rooms).values(children.map((item) => ({ id: `room_${item.id}`, organizationId: "org_default", taskId: item.id, type: "task", name: item.title, createdAt: now })));
    for (const item of children) await db.update(tasks).set({ roomId: `room_${item.id}` }).where(eq(tasks.id, item.id));
    await db.insert(messages).values(children.map((item) => ({ id: `message_${item.id}`, organizationId: "org_default", roomId: `room_${item.id}`,
      taskId: item.id, actorType: "user", actorId: "user_owner", kind: "text", body: `Evidence ${item.id}`, createdAt: now })));
    await db.insert(organizations).values({ id: "org_foreign", name: "Foreign", createdAt: now });
    await db.insert(eventLog).values([
      { id: "evt_shared", organizationId: "org_default", type: "fixture", actorType: "system", actorId: "fixture", taskId: children[0]!.id, correlationId: children[1]!.id, payload: {}, occurredAt: now, schemaVersion: "v1alpha1" },
      { id: "evt_same", organizationId: "org_default", type: "fixture", actorType: "system", actorId: "fixture", taskId: children[2]!.id, correlationId: children[2]!.id, payload: {}, occurredAt: now, schemaVersion: "v1alpha1" },
      { id: "evt_foreign", organizationId: "org_foreign", type: "fixture", actorType: "system", actorId: "fixture", taskId: children[0]!.id, correlationId: children[0]!.id, payload: {}, occurredAt: now, schemaVersion: "v1alpha1" },
    ]);
    const measured = await measure("audit-45-children", () => getGoalAuditBundle(server.ctx, goal.id));
    expect(measured.result.tasks.map((item) => item.task.id)).toEqual(children.map((item) => item.id));
    for (const item of measured.result.tasks) {
      expect(item.room!.id).toBe(`room_${item.task.id}`);
      expect(item.messages.map((message) => message.body)).toEqual([`Evidence ${item.task.id}`]);
    }
    expect(measured.result.tasks[0]!.events.map((event) => event.id)).toEqual(["evt_shared"]);
    expect(measured.result.tasks[1]!.events.map((event) => event.id)).toEqual(["evt_shared"]);
    expect(measured.result.tasks[2]!.events.map((event) => event.id)).toEqual(["evt_same"]);
    expect(measured.result.tasks.slice(3).every((item) => item.events.length === 0)).toBe(true);
    expect(JSON.stringify(measured.result)).not.toContain("evt_foreign");
    expect(measured.queryCount).toBe(36);
    expect(measured.returnedRows).toBe(140);
    for (const index of [0, 20, 44]) {
      expect(measured.result.tasks[index]).toEqual(await getTaskAuditBundle(server.ctx, children[index]!.id));
    }
    // Both sides must survive when a correlation spans two query batches.
    await db.insert(eventLog).values({ id: "evt_cross_batch", organizationId: "org_default", type: "fixture", actorType: "system", actorId: "fixture",
      taskId: children[19]!.id, correlationId: children[20]!.id, payload: {}, occurredAt: now, schemaVersion: "v1alpha1" });
    const updated = await getGoalAuditBundle(server.ctx, goal.id);
    expect(updated.tasks[19]!.events.map((event) => event.id)).toEqual(["evt_cross_batch"]);
    expect(updated.tasks[20]!.events.map((event) => event.id)).toEqual(["evt_cross_batch"]);
  });
});
