import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

describe("literal search migration and embedded extension lifecycle", () => {
  let client: PgliteDbClient;
  afterEach(async () => {
    await client?.close();
  });
  it("upgrades old data, journals all search indexes, and preserves them through backup/restore", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements("0061_presence_audit_context_indexes.sql"));
    await seed(client, "2026-11-14T00:00:00Z");
    await client.db.execute(sql`INSERT INTO tasks (id, organization_id, project_id, title, status, created_by_type, created_by_id, created_at, updated_at)
      VALUES ('search_kept','org_default','proj_artoo','Needle 中文 100%_','backlog','user','user_owner',now(),now())`);
    const statements = await loadMigrationStatements();
    await client.migrate(statements);
    await client.migrate(statements);
    const indexes = await client.db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('tasks_title_trgm_idx','tasks_description_trgm_idx','messages_body_trgm_idx') ORDER BY indexname`,
    );
    expect(indexes.rows).toHaveLength(3);
    for (const index of indexes.rows) expect(index.indexdef).toContain("gin_trgm_ops");
    expect(indexes.rows[0]!.indexdef).toContain("WHERE (moderated_at IS NULL)");
    const archive = await client.backup();
    await client.close();
    client = await PgliteDbClient.create({ archive });
    await client.migrate(statements);
    expect((await client.db.execute(sql`SELECT id FROM tasks WHERE title ILIKE '%needle%'`)).rows).toEqual([
      { id: "search_kept" },
    ]);
    expect((await client.db.execute(sql`SELECT extname FROM pg_extension WHERE extname='pg_trgm'`)).rows).toEqual([
      { extname: "pg_trgm" },
    ]);
  });
  it("uses the same extension in the disposable legacy reference", async () => {
    client = await PgliteDbClient.create();
    const statements = [
      "CREATE EXTENSION pg_trgm",
      "CREATE TABLE search_legacy (body text)",
      "CREATE INDEX search_legacy_trgm ON search_legacy USING gin (body gin_trgm_ops)",
    ];
    for (const statement of statements) await client.db.execute(sql.raw(statement));
    await client.db.execute(sql`INSERT INTO search_legacy VALUES ('kept needle')`);
    await client.adoptLegacyMigrations(statements);
    await client.migrate(statements);
    expect((await client.db.execute(sql`SELECT body FROM search_legacy WHERE body ILIKE '%needle%'`)).rows).toEqual([
      { body: "kept needle" },
    ]);
  });
});
