import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds immutable semantic storage after unchanged v1 storage and preserves existing migration history", async () => {
  const before = await loadMigrationStatements("0033_product_source_transfers.sql");
  const after = await loadMigrationStatements("0034_product_source_semantic_transfers.sql");
  expect(after.slice(0, before.length)).toEqual(before); expect(after.length - before.length).toBe(4);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before); await seed(client, "2026-11-05T00:00:00Z");
    const history = (await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    const byteConstraint = (await client.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'product_source_transfers'::regclass AND conname = 'product_source_transfers_request_chk'`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM projects p ORDER BY id`)).rows).toEqual(history);
    expect((await client.db.execute(sql`SELECT * FROM product_source_semantic_transfers`)).rows).toEqual([]);
    expect((await client.db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'product_source_transfers'::regclass AND conname = 'product_source_transfers_request_chk'`)).rows).toEqual(byteConstraint);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after); expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    expect((await client.db.execute(sql`SELECT tgname FROM pg_trigger WHERE tgrelid = 'product_source_semantic_transfers'::regclass AND NOT tgisinternal`)).rows)
      .toEqual([{ tgname: "product_source_semantic_transfers_immutable" }]);
  } finally { await client.close(); }
});
