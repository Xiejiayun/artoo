import { createHash } from "node:crypto";
import { messages, organizations, taskEnqueueEvents, taskEnqueueSources, tasks } from "@artoo/db";
import { CreateTaskRequestSchema } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { freezeTaskSourceInputs, readTaskSourceInputs } from "./services/task-source-input-service.js";
import { createTask } from "./services/task-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("bounded persisted source inputs", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  async function setup() {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: { unified_enqueue: true } } },
      }),
    });
    const result = await createTask(
      server.ctx,
      CreateTaskRequestSchema.parse({
        project_id: "proj_artoo",
        title: "Bounded source history",
        enqueue_source: { version: 1, kind: "issue", key: "history/1", event_id: "initial" },
      }),
    );
    const [source] = await server.db.db.select().from(taskEnqueueSources);
    return { ...result, source: source! };
  }
  async function addInputs(
    fixture: Awaited<ReturnType<typeof setup>>,
    inputs: { body: string; moderated?: boolean }[],
  ) {
    const rows = inputs.map((input, index) => ({
      id: `msg_history_${index}`,
      organizationId: "org_default",
      roomId: fixture.room.id,
      taskId: fixture.task.id,
      actorType: "user",
      actorId: "user_owner",
      kind: "comment",
      body: input.body,
      // These unrelated message fields must not travel with the source context.
      payload: { unrelated: "x".repeat(1024) },
      moderatedAt: input.moderated ? server.ctx.clock.nowIso() : null,
      moderatedByUserId: input.moderated ? "user_owner" : null,
      createdAt: server.ctx.clock.nowIso(),
    }));
    await server.db.db.insert(messages).values(rows);
    await server.db.db.insert(taskEnqueueEvents).values(
      rows.map((row, index) => ({
        sourceId: fixture.source.id,
        eventKey: `event_${index}`,
        taskId: fixture.task.id,
        requestDigest: `sha256:${"0".repeat(64)}`,
        messageId: row.id,
        createdAt: row.createdAt,
      })),
    );
    return rows;
  }
  function read(taskId: string) {
    return server.db.transaction((tx) => readTaskSourceInputs(server.ctx, tx, taskId));
  }

  it("requires a transaction for freezing while preserving plain snapshot reads", async () => {
    const fixture = await setup();
    await expect(freezeTaskSourceInputs(server.ctx, server.db.db, fixture.task.id)).rejects.toMatchObject({
      code: "conflict",
      message: "Freezing source inputs requires a database transaction",
    });
    expect(await readTaskSourceInputs(server.ctx, server.db.db, fixture.task.id)).toBeUndefined();
  });

  it("freezes the same bounded digest and preserves explicit overflow and moderated-empty semantics", async () => {
    const fixture = await setup();
    const rows = await addInputs(
      fixture,
      Array.from({ length: 1300 }, (_, index) => ({
        body: `Comment ${index}`,
        moderated: index % 13 !== 12,
      })),
    );
    const freeze = () =>
      server.db.transaction(async (tx) => {
        await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, fixture.task.id)).for("update");
        return freezeTaskSourceInputs(server.ctx, tx, fixture.task.id);
      });
    expect(await freeze()).toEqual(await read(fixture.task.id));
    // Making one existing fixture row visible proves the locking path still rejects 101.
    await server.db.db
      .update(messages)
      .set({ moderatedAt: null, moderatedByUserId: null })
      .where(eq(messages.id, rows[0]!.id));
    await expect(freeze()).rejects.toMatchObject({
      code: "conflict",
      message: "Persisted source inputs exceed the execution context limit",
    });
    await server.db.db
      .update(messages)
      .set({ moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" });
    expect(await freeze()).toEqual(await read(fixture.task.id));
    expect((await freeze())?.entries).toEqual([]);
  });

  it("bounds materialized rows after long moderated history without changing visible order or digest", async () => {
    const fixture = await setup();
    const rows = await addInputs(
      fixture,
      Array.from({ length: 1300 }, (_, index) => ({ body: `Comment ${index}`, moderated: index % 13 !== 12 })),
    );
    // Observe actual SQL through the driver's public logger and replay that SQL
    // against the same real fixture to measure the rows transferred by each read.
    const client = (server.db.db as DrizzleDb & { $client: PGlite }).$client;
    const queries: { text: string; params: unknown[] }[] = [];
    const observed = drizzle(client, {
      logger: { logQuery: (text, params) => queries.push({ text, params }) },
    }) as unknown as DrizzleDb;
    const actual = await observed.transaction((tx) => readTaskSourceInputs(server.ctx, tx, fixture.task.id));
    const expected = rows.flatMap((row, index) =>
      row.moderatedAt
        ? []
        : [{ event_id: `event_${index}`, message_id: row.id, body: row.body, actor_id: row.actorId }],
    );
    expect(expected).toHaveLength(100);
    expect(actual).toEqual({
      version: 1,
      entries: expected,
      digest: `sha256:${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}`,
    });
    const reads = queries.filter((query) => query.text.includes('from "task_enqueue_events"'));
    expect(reads.length).toBeGreaterThan(0);
    for (const query of reads) {
      const transferred = await client.query(query.text, query.params);
      expect(transferred.rows.length).toBeLessThanOrEqual(101);
      expect(JSON.stringify(transferred.rows)).not.toContain('"unrelated"');
    }
    await server.db.db
      .update(messages)
      .set({ moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" })
      .where(eq(messages.taskId, fixture.task.id));
    queries.length = 0;
    expect(await observed.transaction((tx) => readTaskSourceInputs(server.ctx, tx, fixture.task.id))).toEqual({
      version: 1,
      entries: [],
      digest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    });
    const emptyReads = queries.filter((query) => query.text.includes('from "task_enqueue_events"'));
    expect(emptyReads.length).toBeGreaterThan(0);
    for (const query of emptyReads) {
      const transferred = await client.query(query.text, query.params);
      expect(transferred.rows.length).toBeLessThanOrEqual(1);
      expect(JSON.stringify(transferred.rows)).not.toContain('"unrelated"');
    }
  });

  it("distinguishes no joined source from an entirely moderated source history", async () => {
    const fixture = await setup();
    // The initial source event has no message and is not itself a source input.
    expect(await read(fixture.task.id)).toBeUndefined();
    await addInputs(fixture, [{ body: "Removed source input", moderated: true }]);
    server.ctx.schedulerRollout = undefined;
    expect(await read(fixture.task.id)).toEqual({
      version: 1,
      entries: [],
      digest: `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    });
  });

  it("rejects the 101st visible input instead of truncating the context", async () => {
    const fixture = await setup();
    await addInputs(
      fixture,
      Array.from({ length: 101 }, (_, index) => ({ body: `Visible ${index}` })),
    );
    await expect(read(fixture.task.id)).rejects.toThrow("Persisted source inputs exceed the execution context limit");
  });

  it("preserves the exact aggregate character boundary", async () => {
    const fixture = await setup();
    const rows = await addInputs(
      fixture,
      Array.from({ length: 11 }, () => ({ body: "x".repeat(20000) })),
    );
    await server.db.db
      .update(messages)
      .set({ moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" })
      .where(eq(messages.id, rows[10]!.id));
    expect((await read(fixture.task.id))?.entries.reduce((sum, entry) => sum + entry.body.length, 0)).toBe(200000);
    await server.db.db
      .update(messages)
      .set({ body: "x", moderatedAt: null, moderatedByUserId: null })
      .where(eq(messages.id, rows[10]!.id));
    await expect(read(fixture.task.id)).rejects.toThrow("Persisted source inputs exceed the execution context limit");
  });

  it("keeps both visible and historical existence reads scoped to the message tenant and task", async () => {
    const fixture = await setup();
    const rows = await addInputs(fixture, [{ body: "In scope" }, { body: "Different task" }]);
    const other = await createTask(
      server.ctx,
      CreateTaskRequestSchema.parse({ project_id: "proj_artoo", title: "Other task" }),
    );
    // Deliberately malformed historical references must not become source input.
    await server.db.db.update(messages).set({ taskId: other.task.id }).where(eq(messages.id, rows[1]!.id));
    expect((await read(fixture.task.id))?.entries.map((entry) => entry.body)).toEqual(["In scope"]);
    await server.db.db.insert(organizations).values({
      id: "org_source_other",
      name: "Other source tenant",
      createdAt: server.ctx.clock.nowIso(),
    });
    await server.db.db.update(messages).set({ organizationId: "org_source_other" }).where(eq(messages.id, rows[0]!.id));
    expect(await read(fixture.task.id)).toBeUndefined();
  });
});
