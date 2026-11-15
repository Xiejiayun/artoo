import { computers, eventLog, organizations, projects, runs } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";
import { failRunDaemonDisconnect, ingestRunEvent } from "./services/run-service.js";

describe("scheduler baseline through existing task entrypoints", () => {
  let server: TestServer;
  const origin = Date.parse("2026-06-13T00:00:00.000Z");
  const at = (seconds: number) => {
    server.ctx.clock = fixedClock(new Date(origin + seconds * 1000).toISOString());
  };
  afterEach(async () => {
    await server?.close();
  });

  async function submit() {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "baseline",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json().task;
    expect(task.status).toBe("backlog");
    expect(created.json().room.task_id).toBe(task.id);
    return task.id as string;
  }
  async function ready(taskId: string) {
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  }
  async function assign(taskId: string) {
    const response = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    expect(response.statusCode).toBe(200);
    return response.json().run.id as string;
  }
  async function observe(query = "") {
    const response = await server.app.inject({
      method: "GET",
      url: `/api/v1/projects/proj_artoo/scheduler-observations${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it("reports unknown for no samples and rejects invalid or cross-organization reads", async () => {
    server = await buildTestServer();
    const data = await observe();
    expect(data.queue).toEqual({ assignments: 0, samples: 0, mean_ms: null, max_ms: null });
    expect(data.failure.rate).toBeNull();
    await server.db.db
      .insert(organizations)
      .values({ id: "org_other", name: "other", createdAt: server.ctx.clock.nowIso() });
    await server.db.db
      .insert(projects)
      .values({ id: "proj_other", organizationId: "org_other", name: "other", createdAt: server.ctx.clock.nowIso() });
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v1/projects/proj_other/scheduler-observations" }))
        .statusCode,
    ).toBe(404);
    for (const query of [
      "?hanging_after_ms=0",
      "?from=no",
      "?to=2099-01-01T00:00:00Z",
      "?unknown=true",
      "?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z",
    ]) {
      expect(
        (await server.app.inject({ method: "GET", url: `/api/v1/projects/proj_artoo/scheduler-observations${query}` }))
          .statusCode,
      ).toBe(400);
    }
  });

  it("preserves submit, execute and human review while measuring persisted timings", async () => {
    server = await buildTestServer();
    const task = await submit();
    at(2);
    await ready(task);
    at(5);
    const runId = await assign(task);
    // A duplicate assignment does not create another attempt or metric sample.
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(409);
    at(7);
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 0,
      event: { kind: "lifecycle", phase: "started" },
    });
    at(19);
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 1,
      event: { kind: "lifecycle", phase: "completed" },
    });
    const snapshot = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${task}` })).json();
    expect(snapshot.task.status).toBe("review");
    expect(snapshot.runs).toHaveLength(1);
    at(20);
    const before = await server.db.db.select().from(eventLog);
    const data = await observe();
    expect(data.queue).toEqual({ assignments: 1, samples: 1, mean_ms: 3000, max_ms: 3000 });
    expect(data.execution).toEqual({ samples: 1, mean_ms: 12000, max_ms: 12000 });
    expect(data.failure).toEqual({ terminal_runs: 1, failed_runs: 0, rate: 0 });
    expect(await server.db.db.select().from(eventLog)).toEqual(before);
  });

  it("keeps failure/retry as distinct queue cycles and respects the observation window", async () => {
    server = await buildTestServer();
    const task = await submit();
    at(1);
    await ready(task);
    at(3);
    const first = await assign(task);
    at(4);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${first}/mock-execute?outcome=failed` }))
        .statusCode,
    ).toBe(200);
    at(10);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task}/retry` })).statusCode).toBe(200);
    at(16);
    const second = await assign(task);
    at(20);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${second}/mock-execute` })).statusCode,
    ).toBe(200);
    at(21);
    const all = await observe();
    expect(all.queue).toEqual({ assignments: 2, samples: 2, mean_ms: 4000, max_ms: 6000 });
    expect(all.failure).toEqual({ terminal_runs: 2, failed_runs: 1, rate: 0.5 });
    const recent = await observe("?from=2026-06-13T00:00:10Z");
    expect(recent.queue.samples).toBe(1);
    expect(recent.queue.mean_ms).toBe(6000);
    expect(recent.failure.failed_runs).toBe(0);
  });

  it("keeps offline scheduling blocked and disconnected process closure unknown", async () => {
    server = await buildTestServer();
    const task = await submit();
    await ready(task);
    const runId = await assign(task);
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 0,
      event: { kind: "lifecycle", phase: "started" },
    });
    at(10);
    expect((await observe("?hanging_after_ms=5000")).current.hanging_tasks).toBe(1);
    // Existing grace expiry callback; this never proves the external process exited.
    await failRunDaemonDisconnect(server.ctx, runId, "computer_local_mock");
    await server.db.db.update(computers).set({ status: "offline" }).where(eq(computers.id, "computer_local_mock"));
    at(11);
    expect((await observe()).current).toEqual({ hanging_tasks: 0, unconfirmed_disconnect_runs: 1 });
    const another = await submit();
    await ready(another);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${another}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(409);
    // Current retry only resets task state. Assignment still fences an uncertain process.
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task}/retry` })).statusCode).toBe(200);
    await server.db.db
      .update(computers)
      .set({ status: "online", lastHeartbeatAt: server.ctx.clock.nowIso() })
      .where(eq(computers.id, "computer_local_mock"));
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(409);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]?.failureReason).toBe(
      "daemon_disconnect",
    );
  });
});
