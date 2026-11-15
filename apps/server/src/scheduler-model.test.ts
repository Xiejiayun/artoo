import {
  computers,
  eventLog,
  organizations,
  projects,
  runs,
  schedulerReconciliations,
  schedulerTaskProjections,
  tasks,
  users,
} from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { mirrorSchedulerTask, reconcileSchedulerProject } from "./services/scheduler-projection-service.js";
import { transitionTask } from "./services/transition-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("scheduler model migration (legacy authority)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  async function setup(enabled = true) {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: { task_mirror: enabled } } },
      }),
    });
  }
  async function submit() {
    const result = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Mirror characterization",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(result.statusCode).toBe(201);
    return result.json().task.id as string;
  }
  async function reconcile(repair: boolean) {
    const result = await server.app.inject({
      method: "POST",
      url: "/api/v1/projects/proj_artoo/scheduler-reconciliations",
      payload: { repair },
    });
    expect(result.statusCode).toBe(200);
    return result.json().reconciliation;
  }
  async function projection(taskId: string) {
    return (
      await server.db.db.select().from(schedulerTaskProjections).where(eq(schedulerTaskProjections.taskId, taskId))
    )[0];
  }
  it("keeps off scopes unchanged, imports actual attempts and excludes historical terminal work", async () => {
    await setup(false);
    const open = await submit(),
      closed = await submit();
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, closed));
    await server.db.db.insert(runs).values(
      ["one", "two"].map((id) => ({
        id,
        organizationId: "org_default",
        taskId: open,
        computerId: "computer_local_mock",
        agentInstanceId: "instance_mock_coder",
        runtimeId: "mock",
        status: "failed",
        createdAt: server.ctx.clock.nowIso(),
      })),
    );
    expect(await server.db.db.select().from(schedulerTaskProjections)).toEqual([]);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/v1/projects/proj_artoo/scheduler-reconciliations",
          payload: { repair: true },
        })
      ).statusCode,
    ).toBe(409);
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"org_default":{"flags":{"task_mirror":true}}}}',
    });
    const before = await server.db.db.select().from(runs);
    const report = await reconcile(true);
    expect(report).toMatchObject({
      sourceCount: 1,
      projectionCount: 0,
      mismatchesBefore: 1,
      repaired: 1,
      mismatchesAfter: 0,
    });
    expect(await projection(open)).toMatchObject({ legacyStatus: "backlog", attemptCount: 2, leaseEpoch: 0 });
    expect(await projection(closed)).toBeUndefined();
    expect(await server.db.db.select().from(runs)).toEqual(before);
    expect(await reconcile(false)).toMatchObject({ mismatchesBefore: 0, repaired: 0 });
  });
  it("mirrors submission, assignment and completion atomically without changing review", async () => {
    await setup();
    const id = await submit();
    expect(await projection(id)).toMatchObject({ legacyStatus: "backlog", attemptCount: 0 });
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(200);
    expect(await projection(id)).toMatchObject({ legacyStatus: "assigned", attemptCount: 1 });
    expect(
      (await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${assigned.json().run.id}/mock-execute` }))
        .statusCode,
    ).toBe(200);
    expect(await projection(id)).toMatchObject({ legacyStatus: "review", attemptCount: 1 });
    await server.db.transaction((tx) =>
      transitionTask(tx, server.ctx, { taskId: id, from: "review", trigger: "accept", now: server.ctx.clock.nowIso() }),
    );
    expect(await projection(id)).toMatchObject({ legacyStatus: "done", attemptCount: 1 });
    expect(await reconcile(false)).toMatchObject({ sourceCount: 1, mismatchesBefore: 0 });
  });
  it("records drift before repair, refuses current ownership, and rolls back legacy writes", async () => {
    await setup();
    const id = await submit();
    await server.db.db
      .update(schedulerTaskProjections)
      .set({ attemptCount: 9, legacyStatus: "ready" })
      .where(eq(schedulerTaskProjections.taskId, id));
    expect(await reconcile(false)).toMatchObject({ mismatchesBefore: 1, repaired: 0, mismatchesAfter: 1 });
    expect(await reconcile(true)).toMatchObject({ mismatchesBefore: 1, repaired: 1, mismatchesAfter: 0 });
    await server.db.db
      .update(schedulerTaskProjections)
      .set({ leaseEpoch: 7 })
      .where(eq(schedulerTaskProjections.taskId, id));
    const events = await server.db.db.select().from(eventLog);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(409);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]!.status).toBe("backlog");
    expect(await server.db.db.select().from(eventLog)).toEqual(events);
    expect(await reconcile(true)).toMatchObject({ mismatchesBefore: 1, repaired: 0, mismatchesAfter: 1 });
    expect((await projection(id))!.leaseEpoch).toBe(7);
    const reports = (
      await server.app.inject({ method: "GET", url: "/api/v1/projects/proj_artoo/scheduler-reconciliations" })
    ).json().reconciliations;
    expect(reports).toHaveLength(3);
    expect(reports.map((r: { mismatchesBefore: number }) => r.mismatchesBefore)).toEqual([1, 1, 1]);
  });
  it("rolls back a new mirror with its source and resumes legacy writes after disabling", async () => {
    await setup();
    const id = await submit();
    await expect(
      server.db.transaction(async (tx) => {
        await tx.update(tasks).set({ status: "ready" }).where(eq(tasks.id, id));
        await mirrorSchedulerTask(server.ctx, tx, id);
        throw new Error("forced failure after mirror");
      }),
    ).rejects.toThrow("forced failure");
    expect((await projection(id))!.legacyStatus).toBe("backlog");
    await server.db.db
      .update(schedulerTaskProjections)
      .set({ leaseEpoch: 1 })
      .where(eq(schedulerTaskProjections.taskId, id));
    server.ctx.schedulerRollout = undefined;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    expect((await projection(id))!.legacyStatus).toBe("backlog");
  });
  it("validates request-scoped administrator and tenant/pin boundaries", async () => {
    await setup();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "other", name: "Other", createdAt: now });
    await server.db.db
      .insert(projects)
      .values({ id: "other_project", organizationId: "other", name: "Other", createdAt: now });
    await server.db.db.insert(computers).values({
      id: "other_computer",
      organizationId: "other",
      displayName: "Other",
      hostname: "Other",
      os: "windows",
      arch: "x64",
      status: "online",
      createdAt: now,
    });
    const policy = {
      version: 1,
      max_concurrent_runs: 2,
      pinned_computer_id: "other_computer",
      required_labels: [],
      required_runtimes: [],
    };
    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: "/api/v1/agents/agent_mock_coder/scheduling-policy",
          payload: policy,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v1/projects/other_project/scheduling-policy" })).statusCode,
    ).toBe(404);
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v1/projects/other_project/scheduler-reconciliations" }))
        .statusCode,
    ).toBe(404);
    await expect(reconcileSchedulerProject(server.ctx, "other_project", true)).rejects.toThrow("project not found");
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, "user_owner"));
    expect(
      (
        await server.app.inject({
          method: "PUT",
          url: "/api/v1/computers/computer_local_mock/scheduling-policy",
          payload: { version: 1, labels: [], max_concurrent_runs: 4 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/api/v1/projects/proj_artoo/scheduler-reconciliations",
          payload: { repair: true },
        })
      ).statusCode,
    ).toBe(403);
    expect(await server.db.db.select().from(schedulerReconciliations)).toEqual([]);
  });
  it("saves strict inactive policies with actor attribution, never modifies legacy resources", async () => {
    await setup();
    const before = await server.db.db.select().from(computers);
    const input = { version: 1, max_concurrent_runs: 4, labels: ["trusted"] };
    const result = await server.app.inject({
      method: "PUT",
      url: "/api/v1/computers/computer_local_mock/scheduling-policy",
      payload: input,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      active: false,
      policy: { policy: input, updatedByUserId: "user_owner", organizationId: "org_default" },
    });
    expect(
      (
        await server.app.inject({ method: "GET", url: "/api/v1/computers/computer_local_mock/scheduling-policy" })
      ).json(),
    ).toEqual(result.json());
    expect(await server.db.db.select().from(computers)).toEqual(before);
    for (const payload of [
      { ...input, version: 2 },
      { ...input, labels: ["a", "a"] },
      { ...input, max_concurrent_runs: 0 },
      { ...input, organization_id: "other" },
    ]) {
      expect(
        (
          await server.app.inject({
            method: "PUT",
            url: "/api/v1/computers/computer_local_mock/scheduling-policy",
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
  });
});
