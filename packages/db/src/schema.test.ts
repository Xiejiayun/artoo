import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrationStatements } from "./migrations.js";
import { organizations, projects, runs, tasks } from "./schema.js";

const NOW = "2026-06-13T00:00:00.000Z";

describe("db migrations", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("applies the generated schema on an empty database", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const res = await client.db.execute(
      sql`select count(*)::int as c from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    // 28 domain tables (25 v1 core + devices/device_tokens/pairing_codes from
    // #28). Drizzle adds its own bookkeeping table only when using its migrator;
    // we apply raw statements, so exactly the schema tables exist.
    expect((res.rows[0] as { c: number }).c).toBe(28);
  });

  it("is idempotent enough to re-run check queries after migration", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const res = await client.db.execute(
      sql`select 1 as ok from information_schema.tables where table_name = 'event_log'`,
    );
    expect(res.rows.length).toBe(1);
  });

  it("defaults run sequence to 0 rather than a global generated counter", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    await client.db.insert(organizations).values({ id: "org_1", name: "Org", createdAt: NOW });
    await client.db.insert(projects).values({
      id: "project_1",
      organizationId: "org_1",
      name: "Project",
      createdAt: NOW,
    });
    await client.db.insert(tasks).values({
      id: "task_1",
      organizationId: "org_1",
      projectId: "project_1",
      title: "Task",
      status: "ready",
      createdByType: "user",
      createdById: "user_1",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const inserted = await client.db
      .insert(runs)
      .values({
        id: "run_1",
        organizationId: "org_1",
        taskId: "task_1",
        computerId: "computer_1",
        agentInstanceId: "instance_1",
        runtimeId: "mock",
        status: "queued",
        createdAt: NOW,
      })
      .returning({ sequence: runs.sequence });

    expect(inserted[0]?.sequence).toBe(0);
  });
});
