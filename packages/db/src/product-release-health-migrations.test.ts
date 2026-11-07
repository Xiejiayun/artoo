import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { organizations, productReleaseHealthReports } from "./schema.js";
import { seed } from "./seed.js";

it("appends health observation storage without rewriting publication receipts or earlier migration history", async () => {
  const before = await loadMigrationStatements("0029_assistant_run_dispatches.sql");
  const after = await loadMigrationStatements("0030_product_release_health.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    await seed(client, "2026-11-04T00:00:00Z");
    const original = await client.db.select().from(organizations);
    const columns = (await client.db.execute(sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'product_releases' ORDER BY ordinal_position`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect(await client.db.select().from(organizations)).toEqual(original);
    expect((await client.db.execute(sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_name = 'product_releases' ORDER BY ordinal_position`)).rows).toEqual(columns);
    expect(await client.db.select().from(productReleaseHealthReports)).toEqual([]);
    const constraints = (await client.db.execute(sql`SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'product_release_health_reports'::regclass ORDER BY conname`)).rows;
    expect(constraints).toEqual(expect.arrayContaining([
      { conname: "product_release_health_sequence_uniq", contype: "u" },
      { conname: "product_release_health_version_chk", contype: "c" },
      { conname: "product_release_health_sequence_chk", contype: "c" },
    ]));
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
  } finally { await client.close(); }
});
