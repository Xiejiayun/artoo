import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds nullable resource tombstones without changing historical resources or replaying the upgrade", async () => {
  const before = await loadMigrationStatements("0056_linux_devices.sql");
  const after = await loadMigrationStatements("0057_resource_deletion.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    await seed(client, "2026-11-12T00:00:00.000Z");
    const snapshot = async () => (await client.db.execute(sql`
      SELECT 'computer' AS kind, to_jsonb(c) - 'deleted_at' AS row FROM computers c
      UNION ALL SELECT 'agent', to_jsonb(a) - 'deleted_at' FROM agents a
      UNION ALL SELECT 'instance', to_jsonb(i) - 'deleted_at' FROM agent_instances i
      ORDER BY kind
    `)).rows;
    const journal = async () => (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    const original = await snapshot(), originalJournal = await journal();
    await client.migrate(after);
    expect(await snapshot()).toEqual(original);
    expect((await client.db.execute(sql`
      SELECT deleted_at FROM computers UNION ALL SELECT deleted_at FROM agents UNION ALL SELECT deleted_at FROM agent_instances
    `)).rows).toEqual([{ deleted_at: null }, { deleted_at: null }, { deleted_at: null }]);
    const upgradedJournal = await journal();
    expect(upgradedJournal.slice(0, originalJournal.length)).toEqual(originalJournal);
    await client.db.execute(sql`UPDATE agent_instances SET deleted_at = '2026-11-12T01:00:00Z' WHERE id = 'instance_mock_coder'`);
    await client.migrate(after);
    expect(await journal()).toEqual(upgradedJournal);
    expect(await snapshot()).toEqual(original);
    expect((await client.db.execute(sql`SELECT deleted_at IS NOT NULL AS deleted FROM agent_instances`)).rows).toEqual([{ deleted: true }]);
  } finally { await client.close(); }
});
