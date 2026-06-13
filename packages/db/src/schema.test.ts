import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrationStatements } from "./migrations.js";

describe("db migrations", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("applies the generated schema on an empty database", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const res = await client.db.execute(
      sql`select count(*)::int as c from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    // 21 domain tables (drizzle adds its own bookkeeping table only when using
    // its migrator; we apply raw statements, so exactly the schema tables exist).
    expect((res.rows[0] as { c: number }).c).toBe(21);
  });

  it("is idempotent enough to re-run check queries after migration", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const res = await client.db.execute(
      sql`select 1 as ok from information_schema.tables where table_name = 'event_log'`,
    );
    expect(res.rows.length).toBe(1);
  });
});
