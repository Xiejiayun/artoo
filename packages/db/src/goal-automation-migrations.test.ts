import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";

let client: PgliteDbClient | undefined;
afterEach(async () => { await client?.close(); client = undefined; });

it("adds opt-in automation without rewriting historical runs and preserves the migration journal on repeat", async () => {
  client = await PgliteDbClient.create();
  const before = await loadMigrationStatements("0025_team_content_moderation.sql");
  const after = await loadMigrationStatements("0026_goal_automation.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(4);
  await client.migrate(before);
  await client.db.execute(sql`INSERT INTO organizations (id,name,created_at) VALUES ('org_history','History','2026-11-03T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO projects (id,organization_id,name,created_at) VALUES ('project_history','org_history','History','2026-11-03T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
    VALUES ('task_history','org_history','project_history','Original task','review','user','legacy_user','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO runs (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,sequence,workspace_root,created_at)
    VALUES ('run_history','org_history','task_history','node_history','agent_history','mock','completed',7,'/Original/草稿','2026-11-03T00:00:00Z')`);
  const original = (await client.db.execute(sql`SELECT to_jsonb(r) AS row FROM runs r`)).rows;
  const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
  await client.migrate(after);
  expect((await client.db.execute(sql`SELECT to_jsonb(r) - 'verification_requirement' AS row FROM runs r`)).rows).toEqual(original);
  expect((await client.db.execute(sql`SELECT verification_requirement FROM runs`)).rows).toEqual([{ verification_requirement: null }]);
  expect((await client.db.execute(sql`SELECT * FROM goal_automations`)).rows).toEqual([]);
  expect((await client.db.execute(sql`SELECT * FROM run_evidence`)).rows).toEqual([]);
  const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
  expect(upgraded.slice(0, journal.length)).toEqual(journal);
  await client.migrate(after);
  expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
  await client.db.execute(sql`INSERT INTO event_log (id,organization_id,type,schema_version,actor_type,actor_id,correlation_id,occurred_at)
    VALUES ('event_evidence','org_history','run.verification','2026-06-11','system','node_history','task_history','2026-11-03T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO run_evidence (id,organization_id,run_id,request_id,payload,event_id,created_at)
    VALUES ('evidence_1','org_history','run_history','request_1','{}','event_evidence','2026-11-03T00:00:00Z')`);
  await expect(client.db.execute(sql`INSERT INTO run_evidence (id,organization_id,run_id,request_id,payload,event_id,created_at)
    VALUES ('evidence_2','org_history','run_history','request_1','{}','event_evidence','2026-11-03T00:00:00Z')`)).rejects.toThrow();
  expect((await client.db.execute(sql`SELECT id FROM run_evidence`)).rows).toEqual([{ id: "evidence_1" }]);
});
