import { PgliteDbClient } from "@artoo/storage";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { goalAutomations, goals } from "./schema.js";
import { seed } from "./seed.js";

const now = "2026-11-05T00:00:00Z";
const unknownScope = { version: 1, computer_id: "computer_local_mock", project_id: "proj_artoo", workspace_root: "/product/草稿",
  verification_profile_id: "web", capabilities: null };

it("appends nullable planning snapshots without backfilling history and preserves the journal on repeat upgrade", async () => {
  const before = await loadMigrationStatements("0030_product_release_health.sql");
  const after = await loadMigrationStatements("0031_goal_planning_capabilities.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(1);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    await seed(client, now);
    await client.db.insert(goals).values({ id: "goal_history", organizationId: "org_default", projectId: "proj_artoo",
      ownerUserId: "user_owner", title: "Previously selected planning", objective: "Keep original requirements", status: "planned",
      createdAt: now, updatedAt: now });
    // The historical table cannot be inserted through the new Drizzle column inventory before this migration.
    await client.db.execute(sql`INSERT INTO goal_automations
      (goal_id, organization_id, actor_user_id, policy_version, status, agent_instance_id, computer_id,
       workspace_root, verification_profile_id, execution_mode, team, last_error, created_at, updated_at)
      VALUES ('goal_history','org_default','user_owner','policy_v1','waiting','instance_mock_coder','computer_local_mock',
        '/product/草稿','web','single_agent','{"version":1}','Existing waiting reason',${now},${now})`);
    const original = (await client.db.execute(sql`SELECT to_jsonb(g) AS row FROM goal_automations g`)).rows;
    const originalGoals = await client.db.select().from(goals);
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'goal_automations' AND column_name = 'planning_capability_snapshot'`)).rows)
      .toEqual([{ column_name: "planning_capability_snapshot", data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    expect((await client.db.execute(sql`SELECT to_jsonb(g) - 'planning_capability_snapshot' AS row FROM goal_automations g`)).rows).toEqual(original);
    expect(await client.db.select().from(goals)).toEqual(originalGoals);
    expect((await client.db.execute(sql`SELECT planning_capability_snapshot IS NULL AS unsampled FROM goal_automations`)).rows)
      .toEqual([{ unsampled: true }]);
    expect((await client.db.select({ planningCapabilitySnapshot: goalAutomations.planningCapabilitySnapshot }).from(goalAutomations))[0]!.planningCapabilitySnapshot).toBeNull();
    expect((await client.db.execute(sql`SELECT conname, contype FROM pg_constraint
      WHERE conrelid = 'goal_automations'::regclass AND conname = 'goal_automations_planning_capability_snapshot_chk'`)).rows)
      .toEqual([{ conname: "goal_automations_planning_capability_snapshot_chk", contype: "c" }]);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    expect((await client.db.execute(sql`SELECT planning_capability_snapshot IS NULL AS unsampled FROM goal_automations`)).rows)
      .toEqual([{ unsampled: true }]);
  } finally { await client.close(); }
});

it("distinguishes SQL NULL from JSON null and enforces a numeric version-1 object without SQL UNKNOWN escapes", async () => {
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(await loadMigrationStatements("0031_goal_planning_capabilities.sql"));
    await seed(client, now);
    await client.db.insert(goals).values({ id: "goal_new", organizationId: "org_default", projectId: "proj_artoo",
      ownerUserId: "user_owner", title: "New planning", createdAt: now, updatedAt: now });
    // Keep this historical fixture independent of columns introduced after migration 0031.
    await client.db.execute(sql`INSERT INTO goal_automations
      (goal_id, organization_id, actor_user_id, policy_version, status, verification_profile_id, created_at, updated_at)
      VALUES ('goal_new','org_default','user_owner','policy_v1','planning','web',${now},${now})`);
    expect((await client.db.select({ planningCapabilitySnapshot: goalAutomations.planningCapabilitySnapshot }).from(goalAutomations))[0]!.planningCapabilitySnapshot).toBeNull();
    await client.db.update(goalAutomations).set({ planningCapabilitySnapshot: unknownScope }).where(eq(goalAutomations.goalId, "goal_new"));
    expect((await client.db.select({ planningCapabilitySnapshot: goalAutomations.planningCapabilitySnapshot }).from(goalAutomations))[0]!.planningCapabilitySnapshot).toEqual(unknownScope);
    expect((await client.db.execute(sql`SELECT planning_capability_snapshot IS NULL AS unsampled,
      planning_capability_snapshot -> 'capabilities' = 'null'::jsonb AS captured_unknown FROM goal_automations`)).rows)
      .toEqual([{ unsampled: false, captured_unknown: true }]);

    const invalid = [null, "", "snapshot", true, false, 1, 0, [], [{ version: 1 }], {},
      { capabilities: null }, { version: null }, { version: "1" }, { version: true }, { version: false },
      { version: 0 }, { version: 2 }, { version: 1.1 }, { version: [] }, { version: {} }];
    for (const value of invalid) {
      // Cast a bound JSON string so JSON null is tested as JSONB, never substituted with SQL NULL.
      let failure: unknown;
      try { await client.db.execute(sql`UPDATE goal_automations SET planning_capability_snapshot = ${JSON.stringify(value)}::jsonb WHERE goal_id = 'goal_new'`); }
      catch (error) { failure = error; }
      expect(failure, `Unexpectedly accepted ${JSON.stringify(value)}`).toBeDefined();
      const cause = (failure as { cause?: unknown }).cause ?? failure;
      expect(cause).toMatchObject({ code: "23514" });
      expect((cause as Error).message).toContain("goal_automations_planning_capability_snapshot_chk");
      expect((await client.db.select({ planningCapabilitySnapshot: goalAutomations.planningCapabilitySnapshot }).from(goalAutomations))[0]!.planningCapabilitySnapshot).toEqual(unknownScope);
    }
    // The database enforces the versioned envelope; complete capability/identity parsing belongs to domain admission.
    await client.db.execute(sql`UPDATE goal_automations SET planning_capability_snapshot = '{"version":1.0}'::jsonb WHERE goal_id = 'goal_new'`);
    expect((await client.db.select({ planningCapabilitySnapshot: goalAutomations.planningCapabilitySnapshot }).from(goalAutomations))[0]!.planningCapabilitySnapshot).toEqual({ version: 1 });
    await client.db.update(goalAutomations).set({ planningCapabilitySnapshot: null }).where(eq(goalAutomations.goalId, "goal_new"));
    expect((await client.db.execute(sql`SELECT planning_capability_snapshot IS NULL AS unsampled FROM goal_automations`)).rows)
      .toEqual([{ unsampled: true }]);
  } finally { await client.close(); }
});
