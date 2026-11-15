import { readFile, readdir } from "node:fs/promises";
import {
  appendEvent,
  contextPacks,
  eventLog,
  messages,
  organizations,
  projects,
  rooms,
  schedulerTaskProjections,
  taskEnqueueEvents,
  taskEnqueueSources,
  tasks,
  users,
} from "@artoo/db";
import { ContextPackSchema, CreateTaskRequestSchema } from "@artoo/domain";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { buildEvent } from "./events.js";
import { createTask } from "./services/task-service.js";
import { enqueueDigest, enqueueTask } from "./services/task-enqueue-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("unified transactional task enqueue", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  async function setup(enabled = true) {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: { flags: { unified_enqueue: enabled, task_mirror: enabled } },
          org_other: { flags: { unified_enqueue: enabled } },
        },
      }),
    });
  }
  function request(event = "event-1", comment = "First issue comment", extra: Record<string, unknown> = {}) {
    return CreateTaskRequestSchema.parse({
      project_id: "proj_artoo",
      title: "Issue fix",
      description: "Original immutable intent",
      acceptance_criteria: ["All original cases pass"],
      required_capabilities: ["code.modify"],
      enqueue_source: { version: 1, kind: "issue", key: "repo/issues/1", event_id: event, comment },
      ...extra,
    });
  }
  async function command(taskId: string, name: string, payload?: Record<string, unknown>, expected = 200) {
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/${name}`, payload });
    expect(response.statusCode, response.body).toBe(expected);
    return response.json();
  }
  async function complete(runId: string) {
    const response = await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    expect(response.statusCode, response.body).toBe(200);
  }
  async function context(id: string) {
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, id));
    return ContextPackSchema.parse(pack!.payload);
  }
  it("keeps default-off manual requests unchanged and reports unavailable deduplication", async () => {
    await setup(false);
    const plain = CreateTaskRequestSchema.parse({ project_id: "proj_artoo", title: "Normal task" });
    const a = await createTask(server.ctx, plain),
      b = await createTask(server.ctx, plain);
    expect(a.task.id).not.toBe(b.task.id);
    await expect(createTask(server.ctx, request())).rejects.toThrow("not enabled");
    expect(await server.db.db.select().from(taskEnqueueSources)).toHaveLength(0);
    expect(await server.db.db.select().from(tasks)).toHaveLength(2);
  });
  it("merges three source events, freezes every visible comment, and requires another run for late input", async () => {
    await setup();
    const first = await createTask(server.ctx, request());
    const second = await createTask(server.ctx, request("event-2", "Second issue comment"));
    const third = await createTask(server.ctx, request("event-3", "Third issue comment"));
    expect([second.task.id, third.task.id]).toEqual([first.task.id, first.task.id]);
    expect([second.room.id, third.room.id]).toEqual([first.room.id, first.room.id]);
    expect(await server.db.db.select().from(tasks)).toHaveLength(1);
    expect(await server.db.db.select().from(rooms).where(eq(rooms.type, "task"))).toHaveLength(1);
    expect(await server.db.db.select().from(schedulerTaskProjections)).toHaveLength(1);
    const replay = await createTask(server.ctx, request("event-2", "Second issue comment"));
    expect(replay.task.id).toBe(first.task.id);
    expect(await server.db.db.select().from(taskEnqueueEvents)).toHaveLength(3);
    const visible = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${first.room.id}/messages` });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json().messages.map((row: { body: string }) => row.body)).toEqual([
      "First issue comment",
      "Second issue comment",
      "Third issue comment",
    ]);
    await command(first.task.id, "ready");
    const run1 = (await command(first.task.id, "assign", { mode: "auto" })).run;
    const frozen = await context(run1.context_pack_id);
    expect(frozen.source_inputs?.entries.map((entry) => entry.body)).toEqual([
      "First issue comment",
      "Second issue comment",
      "Third issue comment",
    ]);
    for (const comment of ["First issue comment", "Second issue comment", "Third issue comment"])
      expect(frozen.task.description).toContain(comment);
    expect(frozen.task.description).not.toContain("Late issue comment");
    await createTask(server.ctx, request("event-4", "Late issue comment"));
    expect(await context(run1.context_pack_id)).toEqual(frozen);
    await complete(run1.id);
    await command(first.task.id, "review", { outcome: "accepted" }, 409);
    await command(first.task.id, "review", {
      outcome: "changes_requested",
      comment: "Address the late source comment",
    });
    const run2 = (await command(first.task.id, "assign", { mode: "auto" })).run;
    expect((await context(run2.context_pack_id)).source_inputs?.entries.at(-1)?.body).toBe("Late issue comment");
    await complete(run2.id);
    await command(first.task.id, "review", { outcome: "accepted" });
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, first.task.id)))[0]?.status).toBe("done");
  });
  it("retains exact replay after completion while new events create fresh work", async () => {
    await setup();
    const first = await createTask(server.ctx, request());
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, first.task.id));
    expect((await createTask(server.ctx, request())).task.id).toBe(first.task.id);
    const fresh = await createTask(server.ctx, request("new-after-done", "New trigger after completion"));
    expect(fresh.task.id).not.toBe(first.task.id);
    expect(fresh.task.status).toBe("backlog");
    expect((await createTask(server.ctx, request())).task.id).toBe(first.task.id);
    await server.db.db.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, fresh.task.id));
    expect((await createTask(server.ctx, request("new-after-cancel", "Retry cancelled work"))).task.id).not.toBe(
      fresh.task.id,
    );
  });
  it("rejects changed event content and incompatible active intent without extra messages or tasks", async () => {
    await setup();
    await createTask(server.ctx, request());
    await expect(createTask(server.ctx, request("event-1", "Changed event content"))).rejects.toThrow(
      "different task intent or content",
    );
    for (const extra of [
      { description: "Changed intent" },
      { acceptance_criteria: ["Weakened"] },
      { required_capabilities: ["code.read"] },
      { preferred_effort: "high" },
      { priority: "p0" },
    ]) {
      await expect(createTask(server.ctx, request("new-event", "New comment", extra))).rejects.toThrow(
        "different intent",
      );
    }
    expect(await server.db.db.select().from(tasks)).toHaveLength(1);
    expect(await server.db.db.select().from(messages)).toHaveLength(1);
    expect(await server.db.db.select().from(taskEnqueueEvents)).toHaveLength(1);
  });
  it("isolates tenant, project, initiating actor and target and rejects a foreign parent", async () => {
    await setup();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: now });
    await server.db.db.insert(projects).values([
      { id: "proj_other", organizationId: "org_default", name: "Other", createdAt: now },
      { id: "proj_foreign", organizationId: "org_other", name: "Foreign", createdAt: now },
    ]);
    await server.db.db.insert(users).values([
      {
        id: "user_other",
        organizationId: "org_other",
        email: "other@example.test",
        displayName: "Other",
        role: "admin",
        createdAt: now,
      },
      {
        id: "user_second",
        organizationId: "org_default",
        email: "second@example.test",
        displayName: "Second",
        role: "admin",
        createdAt: now,
      },
    ]);
    const first = await createTask(server.ctx, request());
    const otherProject = await createTask(
      server.ctx,
      request("event-1", "First issue comment", { project_id: "proj_other" }),
    );
    const otherActor = await createTask({ ...server.ctx, actorUserId: "user_second" }, request());
    const otherTarget = await createTask(
      server.ctx,
      request("event-1", "First issue comment", {
        enqueue_source: { ...request().enqueue_source, target_key: "other-target" },
      }),
    );
    const foreign = await createTask(
      { ...server.ctx, organizationId: "org_other", actorUserId: "user_other" },
      request("event-1", "First issue comment", { project_id: "proj_foreign" }),
    );
    expect(new Set([first, otherProject, otherActor, otherTarget, foreign].map((item) => item.task.id)).size).toBe(5);
    await expect(
      createTask(server.ctx, request("parent", "Parent input", { parent_task_id: foreign.task.id })),
    ).rejects.toThrow("same project");
  });
  it("rolls back source binding, Task, projection, room and events with a failed business callback", async () => {
    await setup();
    const before = await server.db.db.select().from(eventLog);
    await expect(
      server.db.transaction(async (tx) => {
        await enqueueTask(
          server.ctx,
          tx,
          {
            id: "rollback_task",
            organizationId: "org_default",
            projectId: "proj_artoo",
            title: "Rollback",
            roomId: "rollback_room",
            status: "backlog",
            createdByType: "user",
            createdById: "user_owner",
            createdAt: server.ctx.clock.nowIso(),
            updatedAt: server.ctx.clock.nowIso(),
          },
          { kind: "manual", key: "rollback", eventId: "rollback" },
          async () => {
            await tx.insert(rooms).values({
              id: "rollback_room",
              organizationId: "org_default",
              projectId: "proj_artoo",
              taskId: "rollback_task",
              type: "task",
              name: "Rollback",
              createdAt: server.ctx.clock.nowIso(),
            });
            await tx.insert(messages).values({
              id: "rollback_message",
              organizationId: "org_default",
              roomId: "rollback_room",
              taskId: "rollback_task",
              actorType: "user",
              actorId: "user_owner",
              kind: "text",
              body: "Rollback message",
              createdAt: server.ctx.clock.nowIso(),
            });
            await appendEvent(
              tx,
              buildEvent(server.ctx, {
                type: "task.created",
                actorType: "user",
                actorId: "user_owner",
                correlationId: "rollback_task",
                projectId: "proj_artoo",
                taskId: "rollback_task",
                roomId: "rollback_room",
              }),
            );
            throw new Error("business callback failed");
          },
        );
      }),
    ).rejects.toThrow("business callback failed");
    expect(await server.db.db.select().from(tasks)).toHaveLength(0);
    expect(await server.db.db.select().from(schedulerTaskProjections)).toHaveLength(0);
    expect(await server.db.db.select().from(taskEnqueueSources)).toHaveLength(0);
    expect(await server.db.db.select().from(taskEnqueueEvents)).toHaveLength(0);
    expect(await server.db.db.select().from(messages)).toHaveLength(0);
    expect(await server.db.db.select().from(rooms).where(eq(rooms.id, "rollback_room"))).toHaveLength(0);
    expect(await server.db.db.select().from(eventLog)).toEqual(before);
  });
  it("retains persisted source inputs after rollback without reinjecting a moderated comment", async () => {
    await setup();
    const first = await createTask(server.ctx, request());
    await createTask(server.ctx, request("event-2", "Still visible"));
    const [removed] = await server.db.db
      .select()
      .from(messages)
      .where(eq(messages.taskId, first.task.id))
      .orderBy(asc(messages.position));
    await server.db.db
      .update(messages)
      .set({ body: "Message removed", moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" })
      .where(eq(messages.id, removed!.id));
    server.ctx.schedulerRollout = undefined;
    await command(first.task.id, "ready");
    const run = (await command(first.task.id, "assign", { mode: "auto" })).run;
    const pack = await context(run.context_pack_id);
    expect(pack.source_inputs?.entries.map((entry) => entry.body)).toEqual(["Still visible"]);
    expect(JSON.stringify(pack)).not.toContain("First issue comment");
    expect(
      (
        await server.db.db
          .select()
          .from(taskEnqueueEvents)
          .where(and(eq(taskEnqueueEvents.taskId, first.task.id), eq(taskEnqueueEvents.messageId, removed!.id)))
      )[0]?.requestDigest,
    ).toMatch(/^sha256:/);
  });
});

it("permits only the unified writer to insert production Task rows", async () => {
  const directory = new URL("./services/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  const matches = await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(new URL(name, directory), "utf8") })),
  );
  expect(matches.filter(({ text }) => /\.insert\s*\(\s*tasks\s*\)/.test(text)).map(({ name }) => name)).toEqual([
    "task-enqueue-service.ts",
  ]);
});

it("normalizes source hash object order while preserving immutable array order", () => {
  expect(enqueueDigest({ b: ["one", "two"], a: { z: 1, A: 2 } })).toBe(
    enqueueDigest({ a: { A: 2, z: 1 }, b: ["one", "two"] }),
  );
  expect(enqueueDigest({ b: ["one", "two"] })).not.toBe(enqueueDigest({ b: ["two", "one"] }));
});
