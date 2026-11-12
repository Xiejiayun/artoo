import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";

it("migrates only unambiguous legacy squad owners and preserves history on replay", async () => {
  const before = await loadMigrationStatements("0056_linux_devices.sql"), after = await loadMigrationStatements("0058_project_squads.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    await client.db.execute(sql`INSERT INTO organizations (id, name, created_at) VALUES ('org', 'Org', now()), ('single', 'Single', now())`);
    await client.db.execute(sql`INSERT INTO projects (id, organization_id, name, default_workspace, created_at) VALUES
      ('p1','org','One','/one',now()), ('p2','org','Two','/two',now()), ('only','single','Only','/only',now())`);
    await client.db.execute(sql`INSERT INTO computers (id, organization_id, display_name, hostname, os, arch, status, created_at) VALUES
      ('c','org','C','c','linux','x64','online',now()), ('s','single','S','s','linux','x64','online',now())`);
    await client.db.execute(sql`INSERT INTO agents (id, organization_id, display_name, kind, status, created_at) VALUES
      ('a','org','Agent','coding','idle',now()), ('b','single','Agent','coding','idle',now())`);
    await client.db.execute(sql`INSERT INTO agent_instances (id, organization_id, computer_id, agent_id, runtime, status, workspace_root, created_at) VALUES
      ('matched','org','c','a','mock','idle','/one',now()), ('ambiguous','org','c','a','mock','idle','/one',now()),
      ('historical','org','c','a','mock','idle','/other',now()), ('unknown','org','c','a','mock','idle','/unknown',now()),
      ('sole','single','s','b','mock','idle','/custom',now())`);
    await client.db.execute(sql`INSERT INTO tasks (id, organization_id, project_id, title, status, created_by_type, created_by_id, created_at, updated_at)
      VALUES ('t','org','p2','History','done','system','test',now(),now())`);
    await client.db.execute(sql`INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id, status, created_at)
      VALUES ('r1','org','t','c','ambiguous','mock','completed',now()), ('r2','org','t','c','historical','mock','completed',now())`);
    const history = (await client.db.execute(sql`SELECT * FROM runs ORDER BY id`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT id, project_id FROM agent_instances ORDER BY id`)).rows).toEqual([
      { id: "ambiguous", project_id: null }, { id: "historical", project_id: "p2" }, { id: "matched", project_id: "p1" },
      { id: "sole", project_id: "only" }, { id: "unknown", project_id: null },
    ]);
    expect((await client.db.execute(sql`SELECT * FROM runs ORDER BY id`)).rows).toEqual(history);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    await expect(client.db.execute(sql`UPDATE agent_instances SET project_id = 'missing' WHERE id = 'matched'`)).rejects.toThrow();
  } finally { await client.close(); }
});
