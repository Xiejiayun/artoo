import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds bounded policy revisions, preserves existing data and restores them from backup", async () => {
  const before = await loadMigrationStatements("0066_scheduler_queue_metadata.sql");
  const after = await loadMigrationStatements("0067_scheduler_policy_revisions.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(3);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  try {
    await db.migrate(before);
    const now = "2026-06-13T00:00:00.000123Z";
    await seed(db, now);
    const policies = [
      [
        "scheduler_project_policies",
        "project_id",
        "proj_artoo",
        { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
      ],
      [
        "scheduler_agent_policies",
        "agent_id",
        "agent_mock_coder",
        { version: 1, pinned_computer_id: null, required_runtimes: [], required_labels: [], max_concurrent_runs: 2 },
      ],
      [
        "scheduler_computer_policies",
        "computer_id",
        "computer_local_mock",
        { version: 1, labels: [], max_concurrent_runs: 2 },
      ],
    ] as const;
    for (const [table, column, id, policy] of policies) {
      await db.db.execute(sql`INSERT INTO ${sql.identifier(table)} (${sql.identifier(column)},organization_id,policy,updated_by_user_id,updated_at)
        VALUES (${id},'org_default',${JSON.stringify(policy)}::jsonb,'user_owner',${now})`);
    }
    const snapshot = async () =>
      Promise.all(
        policies.map(
          async ([table]) =>
            (await db.db.execute(sql`SELECT to_jsonb(p) - 'revision' AS value FROM ${sql.identifier(table)} p`)).rows,
        ),
      );
    const original = await snapshot();
    const journal = (await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect(
      (
        await db.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name LIKE 'scheduler_%_policies' AND column_name='revision'`)
      ).rows,
    ).toEqual([]);
    expect(await snapshot()).toEqual(original);
    expect((await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(journal);
    await db.migrate(after);
    await db.migrate(after);
    expect(await snapshot()).toEqual(original);
    for (const [table] of policies) {
      expect((await db.db.execute(sql`SELECT revision::int FROM ${sql.identifier(table)}`)).rows).toEqual([
        { revision: 1 },
      ]);
      for (const invalid of [0, -1, 9007199254740992]) {
        await expect(db.db.execute(sql`UPDATE ${sql.identifier(table)} SET revision=${invalid}`)).rejects.toThrow();
      }
      await db.db.execute(sql`UPDATE ${sql.identifier(table)} SET revision=7`);
    }
    expect(await snapshot()).toEqual(original);
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    for (const [table] of policies) {
      expect((await restored.db.execute(sql`SELECT revision::int FROM ${sql.identifier(table)}`)).rows).toEqual([
        { revision: 7 },
      ]);
    }
  } finally {
    await restored?.close();
    await db.close();
  }
});
