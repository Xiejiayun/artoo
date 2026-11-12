import { PgliteDbClient } from "@artoo/storage";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { runs, tasks } from "./schema.js";
import { seedPreProjectSquads as seed } from "./migration-test-support.js";

const now = "2026-11-05T00:00:00Z";
const allocation = { version: 1, strategy: "per-run", base_path: "/owned" };
// Storage validates the versioned envelope. This deliberately incomplete fixture
// has no server admission authority and is never sent as a run request.
const assignment = { version: 1, fixture: "immutable original request" };
async function seedTask(client: PgliteDbClient) {
  await seed(client, now);
  await client.db.insert(tasks).values({ id: "task_owned", organizationId: "org_default", projectId: "proj_artoo",
    title: "Preserve the original assignment", status: "ready", createdByType: "user", createdById: "user_owner", createdAt: now, updatedAt: now });
}
const runDefaults = { organizationId: "org_default", taskId: "task_owned", computerId: "computer_local_mock",
  agentInstanceId: "instance_mock_coder", runtimeId: "fixture", status: "queued", createdAt: now };

it("appends an opt-in nullable assignment without rewriting history or replaying the migration", async () => {
  const before = await loadMigrationStatements("0031_goal_planning_capabilities.sql");
  const after = await loadMigrationStatements("0032_owned_result_assignment.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after.length - before.length).toBe(3);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before); await seedTask(client);
    await client.db.execute(sql`INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id,
      runtime_id, status, workspace_root, workspace_branch, created_at)
      VALUES ('run_history', 'org_default', 'task_owned', 'computer_local_mock', 'instance_mock_coder',
        'fixture', 'completed', '/Original//草稿 /', 'Feature/Exact-Case', ${now})`);
    const original = (await client.db.execute(sql`SELECT to_jsonb(r) AS row FROM runs r`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_name = 'runs' AND column_name = 'owned_result_assignment'`)).rows)
      .toEqual([{ column_name: "owned_result_assignment", data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    expect((await client.db.execute(sql`SELECT to_jsonb(r) - 'owned_result_assignment' AS row FROM runs r`)).rows).toEqual(original);
    expect((await client.db.select().from(runs))[0]!.ownedResultAssignment).toBeNull();
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    await client.db.insert(runs).values({ ...runDefaults, id: "run_ordinary" });
    await client.db.update(runs).set({ status: "failed" }).where(eq(runs.id, "run_ordinary"));
    expect((await client.db.select().from(runs).where(eq(runs.id, "run_ordinary")))[0]).toMatchObject({ status: "failed", ownedResultAssignment: null });
  } finally { await client.close(); }
});

it("requires a version-1 allocated assignment at insertion and prevents replacement or legacy downgrade", async () => {
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(await loadMigrationStatements("0032_owned_result_assignment.sql")); await seedTask(client);
    const invalid = [null, "", true, 1, [], {}, { version: null }, { version: "1" }, { version: 2 }];
    let serial = 0;
    for (const value of invalid) {
      await expect(client.db.execute(sql`INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id,
        runtime_id, status, workspace_allocation, owned_result_assignment, created_at)
        VALUES (${`run_bad_${serial++}`}, 'org_default', 'task_owned', 'computer_local_mock', 'instance_mock_coder',
          'fixture', 'queued', ${JSON.stringify(allocation)}::jsonb, ${JSON.stringify(value)}::jsonb, ${now})`)).rejects.toThrow();
    }
    await expect(client.db.insert(runs).values({ ...runDefaults, id: "run_missing_allocation", ownedResultAssignment: assignment })).rejects.toThrow();
    await expect(client.db.insert(runs).values({ ...runDefaults, id: "run_mixed", workspaceAllocation: allocation,
      verificationRequirement: { version: 1 }, ownedResultAssignment: assignment })).rejects.toThrow();
    await client.db.insert(runs).values({ ...runDefaults, id: "run_owned", workspaceAllocation: allocation, ownedResultAssignment: assignment });
    await client.db.insert(runs).values({ ...runDefaults, id: "run_legacy", workspaceAllocation: allocation });
    for (const value of [null, { ...assignment, fixture: "replacement" }]) {
      await expect(client.db.update(runs).set({ ownedResultAssignment: value }).where(eq(runs.id, "run_owned"))).rejects.toThrow();
    }
    await expect(client.db.update(runs).set({ ownedResultAssignment: assignment }).where(eq(runs.id, "run_legacy"))).rejects.toThrow();
    await expect(client.db.update(runs).set({ workspaceAllocation: null }).where(eq(runs.id, "run_owned"))).rejects.toThrow();
    await expect(client.db.update(runs).set({ verificationRequirement: { version: 1 } }).where(eq(runs.id, "run_owned"))).rejects.toThrow();
    await client.db.update(runs).set({ ownedResultAssignment: assignment, status: "running" }).where(eq(runs.id, "run_owned"));
    expect((await client.db.select().from(runs).where(eq(runs.id, "run_owned")))[0]).toMatchObject({ status: "running", ownedResultAssignment: assignment });
    expect((await client.db.select().from(runs).where(eq(runs.id, "run_legacy")))[0]!.ownedResultAssignment).toBeNull();
  } finally { await client.close(); }
});
