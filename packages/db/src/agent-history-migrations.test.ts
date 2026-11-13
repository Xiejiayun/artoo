import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";

it("upgrades history indexes append-only and preserves the migration journal on repeat startup", async () => {
  const before = await loadMigrationStatements("0058_project_squads.sql");
  const after = await loadMigrationStatements("0059_agent_history.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const db = await PgliteDbClient.create();
  try {
    await db.migrate(before);
    const journal = (await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await db.migrate(after);
    const indexes = (await db.db.execute(sql`SELECT indexname FROM pg_indexes WHERE indexname IN ('runs_agent_history_idx', 'event_log_run_history_idx') ORDER BY indexname`)).rows;
    expect(indexes).toEqual([{ indexname: "event_log_run_history_idx" }, { indexname: "runs_agent_history_idx" }]);
    const upgraded = (await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    expect(upgraded).toHaveLength(journal.length + 2);
    await db.migrate(after);
    expect((await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
  } finally { await db.close(); }
});
