import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds explicit immutable lineage without changing legacy Task rows, parents or prior migration history", async () => {
  const before = await loadMigrationStatements("0069_scheduler_execution_requests.sql");
  const after = await loadMigrationStatements("0070_task_delegations.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(6);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  try {
    await db.migrate(before);
    const now = "2026-06-13T00:00:00.000123Z";
    await seed(db, now);
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,parent_task_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('root','org_default','proj_artoo',NULL,'Root','backlog','user','user_owner',${now},${now}),
      ('old-child','org_default','proj_artoo','root','Old provenance','done','user','user_owner',${now},${now}),
      ('child','org_default','proj_artoo','root','Explicit','backlog','user','user_owner',${now},${now}),
      ('grandchild','org_default','proj_artoo','child','Explicit','backlog','user','user_owner',${now},${now})`);
    const old = (await db.db.execute(sql`SELECT * FROM tasks ORDER BY id`)).rows;
    const journal = (await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT to_regclass('public.task_delegations') AS name`)).rows).toEqual([
      { name: null },
    ]);
    expect((await db.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(journal);
    await db.migrate(after);
    await db.migrate(after);
    expect((await db.db.execute(sql`SELECT * FROM tasks ORDER BY id`)).rows).toEqual(old);
    expect((await db.db.execute(sql`SELECT * FROM task_delegations`)).rows).toEqual([]);
    const insert = (child: string, parent: string, root: string, depth: number, version = 1) =>
      db.db.execute(sql`
      INSERT INTO task_delegations(task_id,organization_id,project_id,parent_task_id,root_task_id,depth,version,initiated_by_user_id,created_at)
      VALUES (${child},'org_default','proj_artoo',${parent},${root},${depth},${version},'user_owner',${now})`);
    await expect(insert("child", "root", "root", 1, 2)).rejects.toThrow();
    await expect(insert("child", "child", "root", 1)).rejects.toThrow();
    await expect(insert("grandchild", "child", "root", 2)).rejects.toThrow();
    await insert("child", "root", "root", 1);
    await insert("grandchild", "child", "root", 2);
    for (const change of [sql`depth=3`, sql`root_task_id='child'`, sql`version=2`, sql`created_at=now()`])
      await expect(db.db.execute(sql`UPDATE task_delegations SET ${change}`)).rejects.toThrow();
    await expect(db.db.execute(sql`DELETE FROM task_delegations`)).rejects.toThrow();
    await expect(db.db.execute(sql`UPDATE tasks SET parent_task_id='old-child' WHERE id='child'`)).rejects.toThrow();
    await db.db.execute(sql`UPDATE tasks SET status='cancelled' WHERE id='child'`);
    // Legacy provenance remains mutable as before; no legacy row was reclassified.
    await db.db.execute(sql`UPDATE tasks SET parent_task_id=NULL WHERE id='old-child'`);
    const rows = (await db.db.execute(sql`SELECT * FROM task_delegations ORDER BY task_id`)).rows;
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    expect((await restored.db.execute(sql`SELECT * FROM task_delegations ORDER BY task_id`)).rows).toEqual(rows);
    await expect(restored.db.execute(sql`DELETE FROM task_delegations`)).rejects.toThrow();
    await expect(restored.migrate(before)).rejects.toThrow("Migration history changed");
  } finally {
    await restored?.close();
    await db.close();
  }
});
