import path from "node:path";
import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";
import { goalResearchDestinationPools, goalResearchDestinationSlots, goalResearchRevisions } from "./schema.js";

it("upgrades actual 0052 without rewriting existing rows or triggers and keeps the new research tables guarded", async () => {
  const old = await loadMigrationStatements("0052_clean_publication.sql"), next = await loadMigrationStatements("0053_goal_research_revisions.sql");
  expect(next.slice(0, old.length)).toEqual(old);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(old);
    const now = "2026-11-08T00:00:00Z", ids = await seed(client, now);
    await client.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('revision_legacy_manual',${ids.organizationId},${ids.projectId},'Existing manual task','done','user',${ids.userId},${now},${now})`);
    const tables: { tablename: string }[] = (await client.db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    const snapshot = async () => Promise.all(tables.map(async ({ tablename }) => ({ table: tablename,
      rows: (await client.db.execute(sql`SELECT to_jsonb(history) AS row FROM ${sql.identifier(String(tablename))} history ORDER BY to_jsonb(history)::text`)).rows })));
    const triggers = async () => (await client.db.execute(sql`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid),pg_get_functiondef(t.tgfoid)
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname NOT LIKE 'goal_research_%' ORDER BY c.relname,t.tgname`)).rows;
    const history = await snapshot(), definitions = await triggers();
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(next);
    expect(await snapshot()).toEqual(history); expect(await triggers()).toEqual(definitions);
    const schemas = [goalResearchDestinationPools, goalResearchDestinationSlots, goalResearchRevisions].map(table => getTableConfig(table));
    for (const schema of schemas) {
      const actual = (await client.db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid=${schema.name}::regclass ORDER BY conname`)).rows.map((row: { conname: string }) => row.conname);
      for (const item of [...schema.uniqueConstraints, ...schema.checks]) expect(actual).toContain(item.name);
      expect((await client.db.execute(sql`SELECT * FROM ${sql.identifier(schema.name)}`)).rows).toEqual([]);
      expect((await client.db.execute(sql`SELECT tgenabled FROM pg_trigger WHERE tgrelid=${schema.name}::regclass AND NOT tgisinternal`)).rows).toEqual([{ tgenabled: "O" }]);
    }
    const migrated = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(migrated.slice(0, journal.length)).toEqual(journal); expect(migrated).toHaveLength(next.length);
    await client.migrate(next);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(migrated);
    // Both sides derive comparison keys; no comparison key is used as an execution path.
    for (const root of ["C:/Prepared/Root", "c:\\Prepared\\child\\..\\Root\\", "C:/Prepared/./Root", "C:/", "/destination/product",
      "\\\\server\\share", "\\\\server\\share\\a\\..\\ROOT\\", "C:/..//Root", "C:/产品/Root"]) {
      const normalized = path.win32.normalize(root), filesystemRoot = path.win32.parse(normalized).root, trimmed = normalized.replace(/[\\/]+$/, "");
      const expected = (trimmed.length < filesystemRoot.length ? filesystemRoot : trimmed).toLowerCase();
      expect((await client.db.execute(sql`SELECT research_windows_workspace_key(${root}) AS value`)).rows).toEqual([{ value: expected }]);
    }
    await expect(client.db.execute(sql`SELECT research_windows_workspace_key('relative/workspace')`)).rejects.toThrow();
  } finally { await client.close(); }
}, 60000);
