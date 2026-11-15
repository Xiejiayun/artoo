import { PgliteDbClient } from "@artoo/storage";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { schedulerTaskProjections } from "./scheduler-schema.js";
import { runs, tasks } from "./schema.js";
import { seed } from "./seed.js";

describe("additive scheduler migration", () => {
  const clients: PgliteDbClient[] = [];
  afterEach(async () => {
    for (const client of clients) await client.close();
    clients.length = 0;
  });
  it("preserves legacy data/journal on upgrade failure, upgrades and restores a full backup", async () => {
    const client = await PgliteDbClient.create();
    clients.push(client);
    const baseline = await loadMigrationStatements("0062_literal_search_indexes.sql");
    await client.migrate(baseline);
    const now = "2026-06-13T00:00:00.000Z";
    await seed(client, now);
    await client.db.insert(tasks).values({
      id: "existing",
      organizationId: "org_default",
      projectId: "proj_artoo",
      title: "Existing task",
      status: "running",
      createdByType: "user",
      createdById: "user_owner",
      createdAt: now,
      updatedAt: now,
    });
    await client.db.insert(runs).values({
      id: "existing_run",
      organizationId: "org_default",
      taskId: "existing",
      computerId: "computer_local_mock",
      agentInstanceId: "instance_mock_coder",
      runtimeId: "mock",
      status: "running",
      createdAt: now,
    });
    const originalTasks = await client.db.select().from(tasks),
      originalRuns = await client.db.select().from(runs);
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    const all = await loadMigrationStatements();
    expect(all.slice(0, baseline.length)).toEqual(baseline);
    await expect(client.migrate([...all, "SELECT 1/0"])).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(journal);
    expect(
      (await client.db.execute(sql`SELECT to_regclass('public.scheduler_task_projections') AS name`)).rows,
    ).toEqual([{ name: null }]);
    expect(await client.db.select().from(tasks)).toEqual(originalTasks);
    expect(await client.db.select().from(runs)).toEqual(originalRuns);
    await client.migrate(all);
    expect(
      (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows.slice(
        0,
        journal.length,
      ),
    ).toEqual(journal);
    // DDL migration does not fabricate histories or timestamps.
    expect(await client.db.select().from(schedulerTaskProjections)).toEqual([]);
    await client.db.insert(schedulerTaskProjections).values({
      taskId: "existing",
      organizationId: "org_default",
      projectId: "proj_artoo",
      legacyStatus: "running",
      attemptCount: 1,
      sourceUpdatedAt: now,
      syncedAt: now,
    });
    for (const invalid of [{ version: 2 }, { leaseEpoch: -1 }, { attemptCount: -1 }, { legacyStatus: "queued" }]) {
      await expect(
        client.db.update(schedulerTaskProjections).set(invalid).where(eq(schedulerTaskProjections.taskId, "existing")),
      ).rejects.toThrow();
    }
    const archive = await client.backup();
    const restored = await PgliteDbClient.create({ archive });
    clients.push(restored);
    await restored.migrate(all);
    expect(await restored.db.select().from(tasks)).toEqual(originalTasks);
    expect(await restored.db.select().from(runs)).toEqual(originalRuns);
    expect(await restored.db.select().from(schedulerTaskProjections)).toEqual(
      await client.db.select().from(schedulerTaskProjections),
    );
    await restored.migrate(all);
  }, 120_000);
});
