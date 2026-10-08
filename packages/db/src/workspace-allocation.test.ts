import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { loadMigrationStatements } from "./migrations.js";
import { organizations, projects, runs, tasks } from "./schema.js";

const NOW = "2026-10-03T00:00:00.000Z";
const runDefaults = {
  organizationId: "org_allocation", taskId: "task_allocation", computerId: "computer_allocation",
  agentInstanceId: "ai_allocation", runtimeId: "mock", status: "queued", createdAt: NOW,
};
const legacy = [
  { id: "run_legacy_null", workspaceRoot: null, workspaceBranch: null },
  { id: "run_legacy_posix", workspaceRoot: "/Legacy//Café/草稿 /", workspaceBranch: "Feature/Keep-É" },
  { id: "run_legacy_windows", workspaceRoot: "C:\\Work\\MiXeD\\草稿\\", workspaceBranch: "Feature/Windows-Case" },
  { id: "run_legacy_root_only", workspaceRoot: "relative legacy root ", workspaceBranch: null },
  { id: "run_legacy_branch_only", workspaceRoot: null, workspaceBranch: "artoo/run-Legacy" },
];
const newRuns = [
  { id: "run_new_posix", workspaceRoot: "/Recorded//Café/Run-A/", workspaceBranch: "Feature/Run-A", workspaceAllocation: {"version": 1, "strategy": "per-run", "base_path": "/Approved//Café/草稿 /"} },
  { id: "run_new_windows", workspaceRoot: "C:\\Recorded\\MiXeD\\Run-B\\", workspaceBranch: "Feature/Run-B", workspaceAllocation: {"version": 1, "strategy": "per-run", "base_path": "C:\\Approved\\MiXeD\\草稿\\"} },
];

it("upgrades the real 0021 schema without rewriting legacy workspaces and preserves JSONB records across disk reopen", async () => {
  const temporaryRoot = process.env.ARTOO_ALLOCATION_TEST_TMPDIR ?? tmpdir();
  await mkdir(temporaryRoot, { recursive: true });
  const ownedDirectory = await mkdtemp(join(temporaryRoot, "artoo-allocation-upgrade-"));
  const dataDir = join(ownedDirectory, "db");
  let client: PgliteDbClient | undefined;
  try {
    const prior = await loadMigrationStatements("0021_workspace_retention.sql");
    const latest = await loadMigrationStatements();
    client = await PgliteDbClient.create({ dataDir });
    await client.migrate(prior);
    expect((await client.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'workspace_allocation'`)).rows).toEqual([]);
    await client.db.insert(organizations).values({ id: "org_allocation", name: "Allocation", createdAt: NOW });
    await client.db.insert(projects).values({ id: "project_allocation", organizationId: "org_allocation", name: "Allocation", createdAt: NOW });
    await client.db.insert(tasks).values({ id: "task_allocation", organizationId: "org_allocation", projectId: "project_allocation",
      title: "Stored workspace identity", status: "ready", createdByType: "user", createdById: "user_allocation", createdAt: NOW, updatedAt: NOW });
    // Insert only the pre-allocation 0021 columns; using the new Drizzle shape
    // incorrectly require the column before the upgrade under test.
    for (const row of legacy) {
      await client.db.execute(sql`INSERT INTO runs
        (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id, status, workspace_root, workspace_branch, created_at)
        VALUES (${row.id}, 'org_allocation', 'task_allocation', 'computer_allocation', 'ai_allocation', 'mock', 'queued',
          ${row.workspaceRoot}, ${row.workspaceBranch}, ${NOW})`);
    }
    const readLegacyIdentity = async () => (await client!.db.execute(sql`SELECT id, workspace_root, workspace_branch FROM runs ORDER BY id`)).rows;
    const originalIdentity = legacy.map((row) => ({ id: row.id, workspace_root: row.workspaceRoot, workspace_branch: row.workspaceBranch }))
      .sort((a, b) => a.id.localeCompare(b.id));
    expect(await readLegacyIdentity()).toEqual(originalIdentity);
    await client.close(); client = undefined;

    client = await PgliteDbClient.create({ dataDir });
    expect(await readLegacyIdentity()).toEqual(originalIdentity);
    await client.migrate(latest);
    expect((await client.db.execute(sql`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'workspace_allocation'`)).rows)
      .toEqual([{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
    expect(await readLegacyIdentity()).toEqual(originalIdentity);
    const readStored = async () => client!.db.select({ id: runs.id, workspaceRoot: runs.workspaceRoot,
      workspaceBranch: runs.workspaceBranch, workspaceAllocation: runs.workspaceAllocation }).from(runs).orderBy(runs.id);
    expect(await readStored()).toEqual(legacy.map((row) => ({ ...row, workspaceAllocation: null })).sort((a, b) => a.id.localeCompare(b.id)));

    await client.db.insert(runs).values(newRuns.map((row) => ({ ...runDefaults, ...row })));
    await client.db.insert(runs).values({ ...runDefaults, id: "run_new_legacy_omitted", workspaceRoot: null, workspaceBranch: null });
    await client.db.insert(runs).values({ ...runDefaults, id: "run_new_explicit_null", workspaceRoot: "/Legacy/Still-Exact", workspaceBranch: null, workspaceAllocation: null });
    const expected = [
      ...legacy.map((row) => ({ ...row, workspaceAllocation: null })), ...newRuns,
      { id: "run_new_legacy_omitted", workspaceRoot: null, workspaceBranch: null, workspaceAllocation: null },
      { id: "run_new_explicit_null", workspaceRoot: "/Legacy/Still-Exact", workspaceBranch: null, workspaceAllocation: null },
    ].sort((a, b) => a.id.localeCompare(b.id));
    expect(await readStored()).toEqual(expected);
    await client.close(); client = undefined;

    client = await PgliteDbClient.create({ dataDir });
    expect(await readStored()).toEqual(expected);
    await client.migrate(latest);
    expect(await readStored()).toEqual(expected);
  } finally {
    await client?.close();
    await rm(ownedDirectory, { recursive: true, force: true });
  }
});
