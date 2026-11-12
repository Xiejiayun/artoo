import { PgliteDbClient } from "@artoo/storage";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { assistantRunDispatches, assistantTurns, messages, rooms, tasks } from "./schema.js";
import { seedPreProjectSquads as seed } from "./migration-test-support.js";

it("preserves legacy assistant delivery uncertainty and appends constrained versioned dispatch intents", async () => {
  const before = await loadMigrationStatements("0028_product_releases.sql");
  const after = await loadMigrationStatements("0029_assistant_run_dispatches.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const client = await PgliteDbClient.create(), now = "2026-11-04T00:00:00Z";
  try {
    await client.migrate(before);
    await seed(client, now);
    await client.db.insert(tasks).values({ id: "task_old", organizationId: "org_default", projectId: "proj_artoo", title: "Existing intent",
      status: "assigned", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now });
    await client.db.insert(rooms).values({ id: "room_old", organizationId: "org_default", projectId: "proj_artoo", taskId: "task_old",
      type: "task", name: "Existing conversation", createdAt: now });
    await client.db.insert(messages).values({ id: "message_old", organizationId: "org_default", roomId: "room_old", taskId: "task_old",
      actorType: "user", actorId: "user_owner", kind: "text", body: "Original request", createdAt: now });
    // Use the historical column set: the current Drizzle runs table may contain later migrations.
    await client.db.execute(sql`INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id, status, created_at)
      VALUES ('run_old', 'org_default', 'task_old', 'computer_local_mock', 'instance_mock_coder', 'mock', 'queued', ${now})`);
    await client.db.insert(assistantTurns).values({ id: "turn_old", organizationId: "org_default", roomId: "room_old", taskId: "task_old",
      actorUserId: "user_owner", clientRequestId: "original-request", userMessageId: "message_old", runId: "run_old", status: "running", createdAt: now, updatedAt: now });
    const readRuns = async () => (await client.db.execute(sql`SELECT to_jsonb(r) AS row FROM runs r ORDER BY id`)).rows;
    const originalRuns = await readRuns(), originalTurns = await client.db.select().from(assistantTurns);
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect(await readRuns()).toEqual(originalRuns);
    expect(await client.db.select().from(assistantTurns)).toEqual(originalTurns);
    expect(await client.db.select().from(assistantRunDispatches)).toEqual([]);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);

    const intent = { runId: "run_old", organizationId: "org_default", turnId: "turn_old", version: 1, state: "prepared", createdAt: now };
    await expect(client.db.insert(assistantRunDispatches).values({ ...intent, version: 2 })).rejects.toThrow();
    await expect(client.db.insert(assistantRunDispatches).values({ ...intent, state: "exposed" })).rejects.toThrow();
    await expect(client.db.insert(assistantRunDispatches).values({ ...intent, exposedAt: now })).rejects.toThrow();
    await client.db.insert(assistantRunDispatches).values(intent);
    await expect(client.db.insert(assistantRunDispatches).values(intent)).rejects.toThrow();
    await expect(client.db.update(assistantRunDispatches).set({ state: "exposed" }).where(eq(assistantRunDispatches.runId, "run_old"))).rejects.toThrow();
    await client.db.update(assistantRunDispatches).set({ state: "exposed", exposedAt: now }).where(eq(assistantRunDispatches.runId, "run_old"));
    await expect(client.db.update(assistantRunDispatches).set({ state: "prepared" }).where(eq(assistantRunDispatches.runId, "run_old"))).rejects.toThrow();
    expect((await client.db.select().from(assistantRunDispatches))[0]?.state).toBe("exposed");
  } finally { await client.close(); }
});
