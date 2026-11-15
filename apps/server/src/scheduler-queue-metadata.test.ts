import {
  computers,
  eventLog,
  organizations,
  projects,
  runs,
  schedulerShadowAttempts,
  schedulerShadowObservations,
  schedulerTaskQueueMetadata,
  tasks,
  users,
} from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { cancelSchedulerShadow, claimSchedulerShadow } from "./services/scheduler-shadow-lease-service.js";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";

const plain = { version: 1 as const, not_before_ms: 0, preferred_computer_id: null, prefer_until_ms: null };

describe("persisted non-executing queue metadata", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  async function setup() {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"org_default":{"flags":{"claim_shadow":true}}}}',
    });
  }
  const put = (id: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: "PUT", url: `/api/v1/tasks/${id}/scheduler-queue-metadata`, payload });
  const get = (id: string) => server.app.inject({ method: "GET", url: `/api/v1/tasks/${id}/scheduler-queue-metadata` });
  async function task(ready = false) {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Queue metadata",
        required_capabilities: ["code.modify"],
        acceptance_criteria: ["ok"],
      },
    });
    expect(response.statusCode).toBe(201);
    const id = response.json().task.id as string;
    if (ready)
      expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    return id;
  }
  async function policies() {
    for (const [url, policy] of [
      ["projects/proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
      [
        "agents/agent_mock_coder",
        {
          version: 1,
          pinned_computer_id: null,
          max_concurrent_runs: 2,
          required_runtimes: ["mock"],
          required_labels: [],
        },
      ],
      ["computers/computer_local_mock", { version: 1, max_concurrent_runs: 2, labels: [] }],
    ] as const)
      expect(
        (await server.app.inject({ method: "PUT", url: `/api/v1/${url}/scheduling-policy`, payload: policy }))
          .statusCode,
      ).toBe(200);
  }
  const claim = (id: string) =>
    claimSchedulerShadow(server.ctx, {
      projectId: "proj_artoo",
      taskId: id,
      options: { mode: "auto", branchBacked: false },
    });

  it("stages explicit revisions and audit attribution without changing legacy Task or execution", async () => {
    await setup();
    const id = await task();
    expect((await get(id)).json()).toEqual({ queue_metadata: null, active: false, execution_authorized: false });
    const original = await server.db.db.select().from(tasks);
    expect((await put(id, plain)).json()).toMatchObject({
      active: false,
      execution_authorized: false,
      queue_metadata: {
        task_id: id,
        project_id: "proj_artoo",
        revision: 1,
        metadata: plain,
        updated_by_user_id: "user_owner",
      },
    });
    const affinity = {
      ...plain,
      not_before_ms: 1000,
      preferred_computer_id: "computer_local_mock",
      prefer_until_ms: 2000,
    };
    expect((await put(id, affinity)).json().queue_metadata).toMatchObject({ revision: 2, metadata: affinity });
    const cleared = await put(id, plain);
    expect(cleared.statusCode).toBe(200);
    expect((await get(id)).json()).toEqual(cleared.json());
    expect(cleared.json().queue_metadata).toMatchObject({ revision: 3, metadata: plain });
    expect(await server.db.db.select().from(tasks)).toEqual(original);
    expect(await server.db.db.select().from(runs)).toEqual([]);
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual([]);
    const events = await server.db.db
      .select()
      .from(eventLog)
      .where(eq(eventLog.type, "scheduler.queue-metadata.updated"));
    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({
      actorType: "user",
      actorId: "user_owner",
      taskId: id,
      payload: { version: 1, revision: 2, metadata: affinity, execution_authorized: false },
    });
  });

  it("checks current administrator, scoped Task/computer and strict versioned input", async () => {
    await setup();
    const id = await task(),
      now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "other", name: "Other", createdAt: now });
    await server.db.db
      .insert(projects)
      .values({ id: "other_project", organizationId: "other", name: "Other", createdAt: now });
    await server.db.db.insert(tasks).values({
      id: "foreign",
      organizationId: "other",
      projectId: "other_project",
      title: "Other",
      status: "ready",
      createdByType: "user",
      createdById: "user_owner",
      createdAt: now,
      updatedAt: now,
    });
    const [computer] = await server.db.db.select().from(computers);
    await server.db.db.insert(computers).values({ ...computer!, id: "foreign_computer", organizationId: "other" });
    await server.db.db.insert(computers).values({ ...computer!, id: "deleted_computer", deletedAt: now });
    expect((await get("foreign")).statusCode).toBe(404);
    expect((await put("foreign", plain)).statusCode).toBe(404);
    for (const preferred of ["foreign_computer", "deleted_computer", "missing"]) {
      expect((await put(id, { ...plain, preferred_computer_id: preferred, prefer_until_ms: 1000 })).statusCode).toBe(
        404,
      );
    }
    for (const extra of [
      { version: 2 },
      { not_before_ms: -1 },
      { prefer_until_ms: 1000 },
      { execution_authorized: true },
    ])
      expect((await put(id, { ...plain, ...extra })).statusCode).toBe(400);
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, "user_owner"));
    expect((await put(id, plain)).statusCode).toBe(403);
    expect(await server.db.db.select().from(schedulerTaskQueueMetadata)).toEqual([]);
    expect(
      await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.queue-metadata.updated")),
    ).toEqual([]);
  });

  it("applies saved timing and exact affinity deadlines to shadow claims only", async () => {
    await setup();
    await policies();
    const id = await task(true),
      now = Date.parse(server.ctx.clock.nowIso());
    expect((await put(id, { ...plain, not_before_ms: now + 1000 })).statusCode).toBe(200);
    const early = await claim(id);
    expect(early.kind).toBe("ineligible");
    if (!("ranking" in early)) throw new Error("Missing explained ranking");
    expect(early.ranking.decisions[0]?.reasons).toContain("not_before");
    server.ctx.clock = fixedClock(new Date(now + 999).toISOString());
    expect((await claim(id)).kind).toBe("ineligible");
    server.ctx.clock = fixedClock(new Date(now + 1000).toISOString());
    const due = await claim(id);
    expect(due.kind).toBe("claimed");
    if (!("binding" in due)) throw new Error("Missing shadow binding");
    expect(due.snapshot.queue_metadata).toEqual({ version: 1, task_id: id, source: "persisted", revision: 1 });
    expect((await cancelSchedulerShadow(server.ctx, due.binding)).kind).toBe("updated");
    const [computer] = await server.db.db.select().from(computers);
    await server.db.db.insert(computers).values({ ...computer!, id: "elsewhere" });
    expect(
      (await put(id, { ...plain, preferred_computer_id: "elsewhere", prefer_until_ms: now + 2000 })).statusCode,
    ).toBe(200);
    const reserved = await claim(id);
    expect(reserved.kind).toBe("ineligible");
    if (!("ranking" in reserved)) throw new Error("Missing affinity explanation");
    expect(reserved.ranking.decisions[0]?.reasons).toContain("soft_affinity");
    server.ctx.clock = fixedClock(new Date(now + 1999).toISOString());
    expect((await claim(id)).kind).toBe("ineligible");
    server.ctx.clock = fixedClock(new Date(now + 2000).toISOString());
    expect((await claim(id)).kind).toBe("claimed");
    expect((await server.db.db.select().from(tasks))[0]?.status).toBe("ready");
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });

  it("captures the original revision, preserves manual behavior and never rewrites older observations", async () => {
    await setup();
    const id = await task(true),
      future = Date.parse(server.ctx.clock.nowIso()) + 60000;
    expect((await put(id, { ...plain, not_before_ms: future })).statusCode).toBe(200);
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(200);
    const [saved] = await server.db.db.select().from(schedulerShadowObservations);
    expect(saved).toMatchObject({
      taskId: id,
      snapshot: {
        not_before_ms: future,
        queue_metadata: { version: 1, task_id: id, source: "persisted", revision: 1 },
      },
      ranking: { execution_authorized: false },
    });
    expect(saved?.ranking.decisions[0]?.reasons).toContain("not_before");
    expect((await put(id, plain)).statusCode).toBe(409);
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${assigned.json().run.id}/mock-execute` }))
        .statusCode,
    ).toBe(200);
    expect((await put(id, plain)).statusCode).toBe(409);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: `/api/v1/tasks/${id}/review`,
          payload: { outcome: "changes_requested", comment: "Re-run with changed preferences" },
        })
      ).statusCode,
    ).toBe(200);
    expect((await put(id, plain)).json().queue_metadata.revision).toBe(2);
    expect(await server.db.db.select().from(schedulerShadowObservations)).toEqual([saved]);
    const history = await server.app.inject({
      method: "GET",
      url: "/api/v1/projects/proj_artoo/scheduler-shadow-observations",
    });
    expect(history.json().observations[0].snapshot).toEqual(saved!.snapshot);
    server.ctx.schedulerRollout = undefined;
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(200);
    expect(await server.db.db.select().from(schedulerShadowObservations)).toEqual([saved]);
  });

  it("rolls metadata back with its audit event and rejects corrupted scope or exhausted revisions", async () => {
    await setup();
    const id = await task(true);
    expect((await put(id, plain)).statusCode).toBe(200);
    const before = await server.db.db.select().from(schedulerTaskQueueMetadata),
      events = await server.db.db.select().from(eventLog);
    const generate = server.ctx.idGen.generate;
    server.ctx.idGen.generate = () => events[0]!.id;
    try {
      expect((await put(id, { ...plain, not_before_ms: 1000 })).statusCode).toBe(500);
    } finally {
      server.ctx.idGen.generate = generate;
    }
    expect(await server.db.db.select().from(schedulerTaskQueueMetadata)).toEqual(before);
    expect(await server.db.db.select().from(eventLog)).toEqual(events);
    await server.db.db
      .insert(projects)
      .values({ id: "wrong", organizationId: "org_default", name: "Wrong", createdAt: server.ctx.clock.nowIso() });
    await server.db.db.update(schedulerTaskQueueMetadata).set({ projectId: "wrong" });
    expect((await get(id)).statusCode).toBe(409);
    await expect(claim(id)).rejects.toThrow("identity mismatch");
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } }))
        .statusCode,
    ).toBe(409);
    expect(await server.db.db.select().from(runs)).toEqual([]);
    await server.db.db
      .update(schedulerTaskQueueMetadata)
      .set({ projectId: "proj_artoo", revision: Number.MAX_SAFE_INTEGER });
    expect((await put(id, plain)).statusCode).toBe(409);
    expect((await get(id)).json().queue_metadata.revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("records an explicit legacy-default origin without backfilling old Task configuration", async () => {
    await setup();
    await policies();
    const id = await task(true),
      value = await claim(id);
    expect(value.kind).toBe("claimed");
    if (!("snapshot" in value)) throw new Error("Missing snapshot");
    expect(value.snapshot).toMatchObject({
      not_before_ms: 0,
      preferred_computer_id: null,
      prefer_until_ms: null,
      queue_metadata: { version: 1, task_id: id, source: "legacy_default", revision: null },
    });
    expect(await server.db.db.select().from(schedulerTaskQueueMetadata)).toEqual([]);
  });
});
