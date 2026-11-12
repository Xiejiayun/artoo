import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seedPreProjectSquads as seed } from "./migration-test-support.js";

it("adds transfer storage after 0032 without modifying historical data or replaying existing migrations", async () => {
  const before = await loadMigrationStatements("0032_owned_result_assignment.sql"), after = await loadMigrationStatements("0033_product_source_transfers.sql");
  expect(after.slice(0, before.length)).toEqual(before); expect(after.length - before.length).toBe(4);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before); await seed(client, "2026-11-05T00:00:00Z");
    const history = (await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows).toEqual(history);
    expect((await client.db.execute(sql`SELECT * FROM product_source_transfers`)).rows).toEqual([]);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after); expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    expect((await client.db.execute(sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'product_source_transfers'::regclass AND NOT tgisinternal`)).rows)
      .toEqual([{ tgname: "product_source_transfers_immutable" }]);
  } finally { await client.close(); }
});
