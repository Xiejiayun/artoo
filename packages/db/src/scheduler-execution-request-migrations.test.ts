import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("adds separate conditional execution requests atomically and preserves immutable history through backup", async () => {
  const before = await loadMigrationStatements("0068_scheduler_intents.sql");
  const after = await loadMigrationStatements("0069_scheduler_execution_requests.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(5);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  try {
    await db.migrate(before);
    const now = "2026-06-13T00:00:00.000123Z";
    await seed(db, now);
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect((await db.db.execute(sql`SELECT to_regclass('public.scheduler_execution_requests') AS name`)).rows).toEqual([
      { name: null },
    ]);
    await db.migrate(after);
    await db.migrate(after);
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('request-task','org_default','proj_artoo','Request','ready','user','user_owner',${now},${now})`);
    await db.db.execute(sql`INSERT INTO scheduler_intents
      (id,organization_id,project_id,task_id,agent_id,actor_user_id,request_key,snapshot,snapshot_digest,created_at)
      VALUES ('old','org_default','proj_artoo','request-task','agent_mock_coder','user_owner','old',
      '{"version":1,"execution_authorized":false}'::jsonb,${`sha256:${"a".repeat(64)}`},${now})`);
    const old = (await db.db.execute(sql`SELECT * FROM scheduler_intents`)).rows;
    const insert = (id: string, key: string, override = {}) => {
      const snapshot = {
        version: 2,
        organization_id: "org_default",
        project_id: "proj_artoo",
        task_id: "request-task",
        actor_user_id: "user_owner",
        request: { version: 2, permission: "execute_once", agent_id: "agent_mock_coder", request_key: key },
        ...override,
      };
      return db.db.execute(sql`INSERT INTO scheduler_execution_requests
        (id,organization_id,project_id,task_id,agent_id,actor_user_id,request_key,snapshot,snapshot_digest,created_at)
        VALUES (${id},'org_default','proj_artoo','request-task','agent_mock_coder','user_owner',${key},
        ${JSON.stringify(snapshot)}::jsonb,${`sha256:${"b".repeat(64)}`},${now})`);
    };
    for (const override of [
      { version: 1 },
      { task_id: "other" },
      { actor_user_id: "other" },
      { request: { version: 2 } },
    ])
      await expect(insert("invalid", "invalid", override)).rejects.toThrow();
    await insert("one", "key-one");
    await expect(insert("two", "key-two")).rejects.toThrow();
    for (const change of [
      sql`version=1`,
      sql`state='consumed'`,
      sql`state='cancelled'`,
      sql`snapshot='{}'::jsonb`,
      sql`snapshot_digest=${`sha256:${"c".repeat(64)}`}`,
      sql`request_key='rewritten'`,
      sql`created_at=now()`,
    ])
      await expect(db.db.execute(sql`UPDATE scheduler_execution_requests SET ${change}`)).rejects.toThrow();
    const immutableFailure = { cause: { message: "Scheduling execution request history is immutable" } };
    await expect(db.db.execute(sql`DELETE FROM scheduler_execution_requests`)).rejects.toMatchObject(immutableFailure);
    await db.db.execute(
      sql`UPDATE scheduler_execution_requests SET state='cancelled',cancelled_at=${now},cancelled_by_user_id='user_owner'`,
    );
    await expect(
      db.db.execute(
        sql`UPDATE scheduler_execution_requests SET state='pending',cancelled_at=NULL,cancelled_by_user_id=NULL`,
      ),
    ).rejects.toMatchObject(immutableFailure);
    await expect(db.db.execute(sql`UPDATE scheduler_execution_requests SET cancelled_at=now()`)).rejects.toMatchObject(
      immutableFailure,
    );
    await expect(insert("replay", "key-one")).rejects.toThrow();
    await insert("two", "key-two");
    const rows = (await db.db.execute(sql`SELECT * FROM scheduler_execution_requests ORDER BY id`)).rows;
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_execution_requests ORDER BY id`)).rows).toEqual(rows);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_intents`)).rows).toEqual(old);
    await expect(restored.db.execute(sql`DELETE FROM scheduler_execution_requests`)).rejects.toMatchObject(
      immutableFailure,
    );
    expect(rows.map((row: Record<string, unknown>) => row.state)).toEqual(["cancelled", "pending"]);
  } finally {
    await restored?.close();
    await db.close();
  }
});
