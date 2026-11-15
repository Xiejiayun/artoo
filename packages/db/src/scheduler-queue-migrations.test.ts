import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds bounded queue metadata without rewriting existing tasks, leases or captured evidence", async () => {
  const before = await loadMigrationStatements("0065_scheduler_shadow_leases.sql");
  const after = await loadMigrationStatements("0066_scheduler_queue_metadata.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(1);
  const db = await PgliteDbClient.create();
  try {
    await db.migrate(before);
    await seed(db, "2026-06-13T00:00:00Z");
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('queue_history','org_default','proj_artoo','History','ready','user','user_owner','2026-06-13T00:00:00.000123Z','2026-06-13T00:00:00.000456Z')`);
    await db.db.execute(sql`INSERT INTO scheduler_shadow_task_heads (task_id,organization_id,project_id,epoch)
      VALUES ('queue_history','org_default','proj_artoo',1)`);
    await db.db.execute(sql`INSERT INTO scheduler_shadow_attempts
      (id,task_id,organization_id,project_id,agent_id,agent_instance_id,computer_id,epoch,state,claimed_at,expires_at,snapshot,ranking)
      VALUES ('shadow_history','queue_history','org_default','proj_artoo','agent_mock_coder','instance_mock_coder','computer_local_mock',1,'claimed',
        '2026-06-13T00:00:00Z','2026-06-13T00:00:30.000123Z','{"version":1}','{"version":1,"execution_authorized":false}')`);
    const snapshot = async () =>
      (
        await db.db.execute(sql`SELECT
      (SELECT jsonb_agg(to_jsonb(t)) FROM tasks t) AS tasks,
      (SELECT jsonb_agg(to_jsonb(r)) FROM runs r) AS runs,
      (SELECT jsonb_agg(to_jsonb(a)) FROM scheduler_shadow_attempts a) AS attempts,
      (SELECT jsonb_agg(to_jsonb(h)) FROM scheduler_shadow_task_heads h) AS heads,
      (SELECT jsonb_agg(to_jsonb(o)) FROM scheduler_shadow_observations o) AS observations`)
      ).rows;
    const original = await snapshot();
    await db.migrate(after);
    await db.migrate(after);
    expect(await snapshot()).toEqual(original);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_task_queue_metadata`)).rows).toEqual([]);
    const insert = (
      version: number,
      revision: number,
      notBefore: number,
      computer: string | null,
      until: number | null,
    ) =>
      db.db.execute(sql`INSERT INTO scheduler_task_queue_metadata
        (task_id,organization_id,project_id,version,revision,not_before_ms,preferred_computer_id,prefer_until_ms,updated_by_user_id,updated_at)
        VALUES ('queue_history','org_default','proj_artoo',${version},${revision},${notBefore},${computer},${until},'user_owner','2026-06-13T00:00:00Z')`);
    await expect(insert(2, 1, 0, null, null)).rejects.toThrow();
    await expect(insert(1, 0, 0, null, null)).rejects.toThrow();
    await expect(insert(1, 9007199254740992, 0, null, null)).rejects.toThrow();
    await expect(insert(1, 1, -1, null, null)).rejects.toThrow();
    await expect(insert(1, 1, 8640000000000001, null, null)).rejects.toThrow();
    await expect(insert(1, 1, 0, "computer_local_mock", null)).rejects.toThrow();
    await expect(insert(1, 1, 0, null, 1000)).rejects.toThrow();
    await expect(insert(1, 1, 0, "computer_local_mock", -1)).rejects.toThrow();
    await insert(1, 1, 0, "computer_local_mock", 1000);
    expect(await snapshot()).toEqual(original);
  } finally {
    await db.close();
  }
});
