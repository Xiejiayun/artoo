import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds inactive intents atomically, enforces one pending request and retains cancellation history through backup", async () => {
  const before = await loadMigrationStatements("0067_scheduler_policy_revisions.sql");
  const after = await loadMigrationStatements("0068_scheduler_intents.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(3);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  try {
    await db.migrate(before);
    const now = "2026-06-13T00:00:00.000123Z";
    await seed(db, now);
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT to_regclass('public.scheduler_intents') AS table_name`)).rows).toEqual([
      { table_name: null },
    ]);
    await db.migrate(after);
    await db.migrate(after);
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('intent-task','org_default','proj_artoo','Intent','ready','user','user_owner',${now},${now})`);
    const insert = (id: string, key: string) =>
      db.db.execute(sql`INSERT INTO scheduler_intents
      (id,organization_id,project_id,task_id,agent_id,actor_user_id,request_key,snapshot,snapshot_digest,created_at)
      VALUES (${id},'org_default','proj_artoo','intent-task','agent_mock_coder','user_owner',${key},
      '{"version":1,"execution_authorized":false}'::jsonb,${`sha256:${"a".repeat(64)}`},${now})`);
    await insert("intent-one", "request-one");
    await expect(insert("intent-two", "request-two")).rejects.toThrow();
    for (const change of [
      sql`execution_authorized=true`,
      sql`version=2`,
      sql`state='cancelled'`,
      sql`snapshot='{}'::jsonb`,
      sql`snapshot_digest='invalid'`,
    ])
      await expect(db.db.execute(sql`UPDATE scheduler_intents SET ${change}`)).rejects.toThrow();
    await db.db.execute(
      sql`UPDATE scheduler_intents SET state='cancelled',cancelled_at=${now},cancelled_by_user_id='user_owner'`,
    );
    await expect(insert("intent-replay", "request-one")).rejects.toThrow();
    await insert("intent-two", "request-two");
    const rows = (await db.db.execute(sql`SELECT * FROM scheduler_intents ORDER BY id`)).rows;
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_intents ORDER BY id`)).rows).toEqual(rows);
    expect(rows.map((row: Record<string, unknown>) => row.state)).toEqual(["cancelled", "pending"]);
    expect(rows.every((row: Record<string, unknown>) => row.execution_authorized === false)).toBe(true);
  } finally {
    await restored?.close();
    await db.close();
  }
});
