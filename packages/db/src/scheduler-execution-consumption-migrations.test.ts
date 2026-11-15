import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";

it("upgrades pending/cancelled history atomically and preserves exact terminal consumption through backup", async () => {
  const before = await loadMigrationStatements("0070_task_delegations.sql"),
    after = await loadMigrationStatements("0071_scheduler_execution_consumption.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(2);
  const db = await PgliteDbClient.create();
  let restored: PgliteDbClient | undefined;
  const now = "2026-06-13T00:00:00.000123Z";
  try {
    await db.migrate(before);
    await seed(db, now);
    await db.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('claim-task','org_default','proj_artoo','Claim','ready','user','user_owner',${now},${now})`);
    const insert = (id: string) =>
      db.db.execute(sql`INSERT INTO scheduler_execution_requests
      (id,organization_id,project_id,task_id,agent_id,actor_user_id,request_key,snapshot,snapshot_digest,created_at)
      VALUES (${id},'org_default','proj_artoo','claim-task','agent_mock_coder','user_owner',${id},
      ${JSON.stringify({
        version: 2,
        organization_id: "org_default",
        project_id: "proj_artoo",
        task_id: "claim-task",
        actor_user_id: "user_owner",
        request: { version: 2, permission: "execute_once", agent_id: "agent_mock_coder", request_key: id },
        ai_sharing: { consent_id: null, policy_version: "fixture-policy" },
      })}::jsonb,${`sha256:${"a".repeat(64)}`},${now})`);
    await insert("cancelled");
    await db.db.execute(
      sql`UPDATE scheduler_execution_requests SET state='cancelled',cancelled_at=${now},cancelled_by_user_id='user_owner'`,
    );
    await insert("pending");
    const old = (await db.db.execute(sql`SELECT id,state,snapshot FROM scheduler_execution_requests ORDER BY id`)).rows;
    await expect(db.migrate([...after, "SELECT 1/0"])).rejects.toThrow();
    expect(
      (
        await db.db.execute(
          sql`SELECT column_name FROM information_schema.columns WHERE table_name='scheduler_execution_requests' AND column_name='consumed_run_id'`,
        )
      ).rows,
    ).toEqual([]);
    await db.migrate(after);
    await db.migrate(after);
    expect(
      (await db.db.execute(sql`SELECT id,state,snapshot FROM scheduler_execution_requests ORDER BY id`)).rows,
    ).toEqual(old);
    await db.db.execute(sql`INSERT INTO devices (id,organization_id,display_name,platform,app_version,computer_id,enrolled_by_user_id,trust,created_at)
      VALUES ('claim-device','org_default','proj_artoo','linux','fixture','computer_local_mock','user_owner','active',${now})`);
    await db.db.execute(sql`INSERT INTO runs (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,created_at,requested_by_user_id,ai_data_sharing_policy_version,
      workspace_root,workspace_branch,workspace_allocation) VALUES ('claim-run','org_default','claim-task','computer_local_mock','instance_mock_coder','codex','queued',${now},'user_owner','fixture-policy',
      '/fixture/claim','artoo/run-claim-run','{"version":1,"strategy":"per-run","base_path":"/fixture"}'::jsonb)`);
    const consume = () =>
      db.db.execute(sql`UPDATE scheduler_execution_requests SET state='consumed',consumed_run_id='claim-run',consumed_device_id='claim-device',
      consumed_session_id='session',consumed_at=${now} WHERE id='pending'`);
    // Both relational identity and actual isolation metadata are required by SQL.
    await db.db.execute(sql`UPDATE runs SET requested_by_user_id=NULL WHERE id='claim-run'`);
    await expect(consume()).rejects.toThrow();
    await db.db.execute(
      sql`UPDATE runs SET requested_by_user_id='user_owner',workspace_allocation=NULL WHERE id='claim-run'`,
    );
    await expect(consume()).rejects.toThrow();
    await db.db.execute(
      sql`UPDATE runs SET workspace_allocation='{"version":1,"strategy":"per-run","base_path":"/fixture"}'::jsonb WHERE id='claim-run'`,
    );
    await consume();
    // Consumed history frees the pending slot but never its original request key.
    await insert("next");
    await expect(insert("pending")).rejects.toThrow();
    for (const change of [
      sql`consumed_session_id=NULL`,
      sql`consumed_session_id='replacement'`,
      sql`consumed_at=now()`,
      sql`state='pending',consumed_run_id=NULL,consumed_device_id=NULL,consumed_session_id=NULL,consumed_at=NULL`,
    ])
      await expect(
        db.db.execute(sql`UPDATE scheduler_execution_requests SET ${change} WHERE id='pending'`),
      ).rejects.toThrow();
    const rows = (await db.db.execute(sql`SELECT * FROM scheduler_execution_requests ORDER BY id`)).rows;
    restored = await PgliteDbClient.create({ archive: await db.backup() });
    await restored.migrate(after);
    expect((await restored.db.execute(sql`SELECT * FROM scheduler_execution_requests ORDER BY id`)).rows).toEqual(rows);
    await expect(restored.db.execute(sql`DELETE FROM scheduler_execution_requests`)).rejects.toThrow();
  } finally {
    await restored?.close();
    await db.close();
  }
});
