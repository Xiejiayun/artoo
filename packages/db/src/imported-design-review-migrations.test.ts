import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("appends H4 provenance/reservations after unchanged H3/local revision history and replays idempotently", async () => {
  const before = await loadMigrationStatements("0038_product_design_revisions.sql"), after = await loadMigrationStatements("0039_goal_imported_design_reviews.sql");
  expect(after.slice(0, before.length)).toEqual(before); expect(after.length).toBeGreaterThan(before.length);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before); await seed(client, "2026-11-06T00:00:00Z");
    const rows = (await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows).toEqual(rows);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after); expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    expect((await client.db.execute(sql`SELECT * FROM goal_imported_design_completions`)).rows).toEqual([]);
    expect((await client.db.execute(sql`SELECT * FROM goal_imported_design_reviews`)).rows).toEqual([]);
    expect((await client.db.execute(sql`SELECT tgname FROM pg_trigger WHERE tgrelid='goal_imported_design_reviews'::regclass AND NOT tgisinternal`)).rows)
      .toEqual([{ tgname: "goal_imported_design_reviews_protected" }]);
  } finally { await client.close(); }
});
