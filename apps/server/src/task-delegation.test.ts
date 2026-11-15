import { eventLog, projects, rooms, taskDelegations, taskEnqueueEvents, taskEnqueueSources, tasks } from "@artoo/db";
import { CreateTaskRequestSchema } from "@artoo/domain";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { enqueueTask } from "./services/task-enqueue-service.js";
import { getTaskDelegationTree, prepareTaskDelegation } from "./services/task-delegation-service.js";
import { createTask } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("explicit bounded task delegation", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  function rollout(enabled: boolean, override?: boolean) {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: {
            flags: { delegation_limits: enabled, unified_enqueue: true, task_mirror: true },
            ...(override === undefined ? {} : { projects: { proj_artoo: { delegation_limits: override } } }),
          },
        },
      }),
    });
  }
  async function setup(enabled = true) {
    server = await buildTestServer();
    rollout(enabled);
  }
  const request = (title: string, extra = {}) =>
    CreateTaskRequestSchema.parse({
      project_id: "proj_artoo",
      title,
      acceptance_criteria: ["Preserve the requested behavior"],
      ...extra,
    });
  const child = (parent: string, title = "Child", extra = {}) =>
    createTask(
      server.ctx,
      request(title, {
        delegation: { version: 1, parent_task_id: parent },
        ...extra,
      }),
    );
  function values(id: string, parent: string) {
    return {
      id,
      organizationId: server.ctx.organizationId,
      projectId: "proj_artoo",
      parentTaskId: parent,
      title: id,
      status: "backlog",
      createdByType: "user",
      createdById: server.ctx.actorUserId,
      createdAt: server.ctx.clock.nowIso(),
      updatedAt: server.ctx.clock.nowIso(),
    };
  }
  const source = (id: string, parent: string) => ({
    kind: "manual" as const,
    key: id,
    eventId: id,
    delegation: { version: 1 as const, parent_task_id: parent },
  });
  async function snapshot() {
    return {
      tasks: await server.db.db.select().from(tasks),
      rooms: await server.db.db.select().from(rooms),
      edges: await server.db.db.select().from(taskDelegations),
      sources: await server.db.db.select().from(taskEnqueueSources),
      inputs: await server.db.db.select().from(taskEnqueueEvents),
      events: await server.db.db.select().from(eventLog),
    };
  }

  it("preserves long terminal-parent provenance chains with the flag both off and on", async () => {
    await setup(false);
    for (const enabled of [false, true]) {
      rollout(enabled);
      let parent = (await createTask(server.ctx, request("Conversation"))).task;
      for (let depth = 1; depth <= 5; depth++) {
        await server.db.db
          .update(tasks)
          .set({ status: depth % 2 ? "done" : "cancelled" })
          .where(eq(tasks.id, parent.id));
        parent = (
          await createTask(server.ctx, request("Authorized historical follow up", { parent_task_id: parent.id }))
        ).task;
      }
      const tree = await getTaskDelegationTree(server.ctx, parent.id);
      expect(tree.nodes).toEqual([
        { task_id: parent.id, parent_task_id: null, depth: 0, title: parent.title, status: parent.status },
      ]);
    }
    expect(await server.db.db.select().from(taskDelegations)).toEqual([]);
  });

  it("rejects disabled new delegation and conflicting parents without changing any business records", async () => {
    await setup(false);
    const root = (await createTask(server.ctx, request("Root"))).task;
    const before = await snapshot();
    await expect(child(root.id)).rejects.toMatchObject({ details: { reason: "delegation_disabled" } });
    expect(await snapshot()).toEqual(before);
    rollout(true, false);
    await expect(child(root.id)).rejects.toMatchObject({ details: { reason: "delegation_disabled" } });
    await expect(child(root.id, "Conflict", { parent_task_id: "different" })).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("permits depth three, rejects the fourth, and reads immutable history with rollout off", async () => {
    await setup();
    const root = (await createTask(server.ctx, request("Root"))).task;
    const one = (await child(root.id, "One")).task;
    const two = (await child(one.id, "Two")).task;
    const three = (await child(two.id, "Three")).task;
    const before = await snapshot();
    await expect(child(three.id)).rejects.toMatchObject({ details: { reason: "delegation_depth_exceeded", limit: 3 } });
    expect(await snapshot()).toEqual(before);
    rollout(false);
    const result = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${two.id}/delegation-tree` });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({
      version: 1,
      root_task_id: root.id,
      selected_task_id: two.id,
      creation_enabled: false,
      nodes: [
        { task_id: root.id, depth: 0 },
        { task_id: one.id, depth: 1 },
        { task_id: two.id, depth: 2 },
        { task_id: three.id, depth: 3 },
      ],
    });
    expect((await server.app.inject({ method: "GET", url: "/api/v1/tasks/unknown/delegation-tree" })).statusCode).toBe(
      404,
    );
  });

  it("counts same-transaction and terminal history, while replay and active dedupe consume no slots", {
    timeout: 60_000,
  }, async () => {
    await setup();
    const root = (await createTask(server.ctx, request("Root"))).task;
    const input = { enqueue_source: { version: 1, kind: "issue", key: "delegation/1", event_id: "one" } };
    const original = await child(root.id, "Original", input);
    await server.db.transaction(async (tx) => {
      for (let index = 0; index < 28; index++) {
        const id = `delegation_batch_${index}`;
        await enqueueTask(server.ctx, tx, values(id, root.id), source(id, root.id));
      }
    });
    expect((await getTaskDelegationTree(server.ctx, root.id)).nodes).toHaveLength(30);
    expect((await child(root.id, "Original", input)).task.id).toBe(original.task.id);
    expect(
      (await child(root.id, "Original", { enqueue_source: { ...input.enqueue_source, event_id: "two" } })).task.id,
    ).toBe(original.task.id);
    rollout(false);
    expect((await child(root.id, "Original", input)).task.id).toBe(original.task.id);
    rollout(true);
    // Controlled terminal history; no physical execution or closure is claimed.
    await server.db.db.update(tasks).set({ status: "cancelled" }).where(sql`${tasks.id} LIKE 'delegation_batch_%'`);
    const before = await snapshot();
    await expect(child(root.id, "Thirty first")).rejects.toMatchObject({
      details: { reason: "delegation_size_exceeded", limit: 30 },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects terminal/foreign parents and unsafe transactions, and rolls new lineage back with its owner", async () => {
    await setup();
    const root = (await createTask(server.ctx, request("Root"))).task;
    await server.db.db.insert(projects).values({
      id: "delegation_other",
      organizationId: server.ctx.organizationId,
      name: "Other",
      createdAt: server.ctx.clock.nowIso(),
    });
    const foreign = (await createTask(server.ctx, request("Other", { project_id: "delegation_other" }))).task;
    await expect(child(foreign.id)).rejects.toMatchObject({ code: "validation_error" });
    await expect(getTaskDelegationTree({ ...server.ctx, organizationId: "org_other" }, root.id)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      prepareTaskDelegation(server.ctx, server.db.db, values("bare", root.id), source("bare", root.id).delegation),
    ).rejects.toThrow("database transaction");
    await expect(
      server.db.db.transaction(
        (tx) =>
          prepareTaskDelegation(
            server.ctx,
            tx,
            values("repeatable", root.id),
            source("repeatable", root.id).delegation,
          ),
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toThrow("read committed");
    const before = await snapshot();
    await expect(
      server.db.transaction((tx) =>
        enqueueTask(server.ctx, tx, values("rollback_child", root.id), source("rollback_child", root.id), async () => {
          throw new Error("owner audit failed");
        }),
      ),
    ).rejects.toThrow("owner audit failed");
    expect(await snapshot()).toEqual(before);
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, root.id));
    await expect(child(root.id)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
