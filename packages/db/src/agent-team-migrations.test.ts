import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";

it("appends team/review storage without changing legacy migration history", async () => {
  const before = await loadMigrationStatements("0026_goal_automation.sql"), after = await loadMigrationStatements("0027_agent_team.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(5);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    const columns = (await client.db.execute(sql`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'goal_automations' AND column_name IN ('execution_mode','team','release_profile_id') ORDER BY column_name`)).rows;
    expect(columns).toEqual([
      { column_name: "execution_mode", is_nullable: "NO", column_default: "'single_agent'::text" },
      { column_name: "release_profile_id", is_nullable: "YES", column_default: null },
      { column_name: "team", is_nullable: "YES", column_default: null },
    ]);
    expect((await client.db.execute(sql`SELECT * FROM autonomous_reviews`)).rows).toEqual([]);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
  } finally { await client.close(); }
});
