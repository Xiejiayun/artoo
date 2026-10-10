import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";

let client: PgliteDbClient | undefined;
afterEach(async () => { await client?.close(); client = undefined; });

it("upgrades 0023 through AI consent without rewriting historical runs or their migration journal", async () => {
  client = await PgliteDbClient.create();
  const before = await loadMigrationStatements("0023_workspace_allocation.sql");
  const consent = await loadMigrationStatements("0024_ai_data_sharing_consent.sql");
  expect(consent.slice(0, before.length)).toEqual(before);
  expect(consent.length - before.length).toBe(9);
  expect((await loadMigrationStatements()).slice(0, consent.length)).toEqual(consent);
  await client.migrate(before);
  await client.db.execute(sql`INSERT INTO organizations (id,name,created_at) VALUES ('org_history','History','2026-10-10T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO projects (id,organization_id,name,created_at) VALUES ('project_history','org_history','History','2026-10-10T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
    VALUES ('task_history','org_history','project_history','Original task','review','user','legacy_user','2026-10-10T00:00:00Z','2026-10-10T00:00:00Z')`);
  await client.db.execute(sql`INSERT INTO runs (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,sequence,workspace_root,workspace_branch,created_at)
    VALUES ('run_history','org_history','task_history','legacy_computer','legacy_agent','mock','completed',9,'/Original//Café/草稿 /','Feature/Keep-Case','2026-10-10T00:00:00Z')`);
  const original = (await client.db.execute(sql`SELECT to_jsonb(r) AS row FROM runs r`)).rows;
  const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
  await client.migrate(consent);
  expect((await client.db.execute(sql`SELECT to_jsonb(r) - 'requested_by_user_id' - 'ai_data_sharing_consent_id' - 'ai_data_sharing_policy_version' AS row FROM runs r`)).rows).toEqual(original);
  expect((await client.db.execute(sql`SELECT requested_by_user_id,ai_data_sharing_consent_id,ai_data_sharing_policy_version FROM runs`)).rows)
    .toEqual([{ requested_by_user_id: null, ai_data_sharing_consent_id: null, ai_data_sharing_policy_version: null }]);
  const columns = (await client.db.execute(sql`SELECT table_name,column_name,is_nullable,column_default FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name IN ('runs','assistant_turns','discussions') AND column_name LIKE 'ai_data_sharing_%')
      OR (table_name='runs' AND column_name='requested_by_user_id')) ORDER BY table_name,column_name`)).rows;
  expect(columns).toEqual([
    ['assistant_turns','ai_data_sharing_consent_id'], ['assistant_turns','ai_data_sharing_policy_version'],
    ['discussions','ai_data_sharing_consent_id'], ['discussions','ai_data_sharing_policy_version'],
    ['runs','ai_data_sharing_consent_id'], ['runs','ai_data_sharing_policy_version'], ['runs','requested_by_user_id'],
  ].map(([table_name,column_name]) => ({ table_name,column_name,is_nullable:'YES',column_default:null })));
  const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
  expect(upgraded.slice(0, journal.length)).toEqual(journal);
  expect(upgraded).toHaveLength(consent.length);
  await client.migrate(consent);
  expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
});
