import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("appends shadow storage without rewriting legacy Task/Run/projection history or granting execution", async () => {
  const before = await loadMigrationStatements("0064_task_enqueue.sql"),
    after = await loadMigrationStatements("0065_scheduler_shadow_leases.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(6);
  const db = await PgliteDbClient.create();
  try {
    await db.migrate(before);
    await seed(db, "2026-06-13T00:00:00Z");
    await db.db.execute(sql`INSERT INTO tasks (id, organization_id, project_id, title, status, created_by_type, created_by_id, created_at, updated_at)
      VALUES ('task_history','org_default','proj_artoo','History','ready','user','user_owner','2026-06-13T00:00:00.000123Z','2026-06-13T00:00:00.000456Z')`);
    await db.db.execute(
      sql`INSERT INTO scheduler_task_projections VALUES ('task_history','org_default','proj_artoo',1,'ready',0,0,'2026-06-13T00:00:00.000456Z','2026-06-13T00:00:00Z')`,
    );
    const snapshot = async () =>
      (
        await db.db.execute(sql`SELECT
      (SELECT jsonb_agg(to_jsonb(t)) FROM tasks t) AS tasks,
      (SELECT jsonb_agg(to_jsonb(r)) FROM runs r) AS runs,
      (SELECT jsonb_agg(to_jsonb(p)) FROM scheduler_task_projections p) AS projections`)
      ).rows;
    const original = await snapshot();
    await db.migrate(after);
    await db.migrate(after);
    expect(await snapshot()).toEqual(original);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_shadow_task_heads`)).rows).toEqual([]);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_shadow_attempts`)).rows).toEqual([]);
    expect((await db.db.execute(sql`SELECT * FROM scheduler_shadow_observations`)).rows).toEqual([]);
    await db.db.execute(
      sql`INSERT INTO scheduler_shadow_task_heads (task_id,organization_id,project_id) VALUES ('task_history','org_default','proj_artoo')`,
    );
    const insert = (epoch: number, authority: boolean) =>
      db.db.execute(sql`INSERT INTO scheduler_shadow_attempts
      (id,task_id,organization_id,project_id,agent_id,agent_instance_id,computer_id,epoch,state,claimed_at,expires_at,execution_authorized,snapshot,ranking)
      VALUES ('shadow','task_history','org_default','proj_artoo','agent_mock_coder','instance_mock_coder','computer_local_mock',${epoch},'claimed',
        '2026-06-13T00:00:00Z','2026-06-13T00:00:30Z',${authority},'{"version":1}','{"version":1,"execution_authorized":false}')`);
    await expect(insert(1, true)).rejects.toThrow();
    await expect(insert(9007199254740992, false)).rejects.toThrow();
    await insert(1, false);
    await expect(db.db.execute(sql`UPDATE scheduler_shadow_attempts SET state='finished'`)).rejects.toThrow();
    expect(await snapshot()).toEqual(original);
  } finally {
    await db.close();
  }
});
