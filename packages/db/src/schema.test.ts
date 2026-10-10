import { PgliteDbClient } from "@artoo/storage";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrationStatements } from "./migrations.js";
import { appendEvent } from "./event-writer.js";
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
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
    );
    // Compare the exact migrated inventory with the declared domain schema.
    // A fixed count misses renamed/missing tables and becomes stale on additions.
    const expected = Object.values(schema).filter((value) => is(value, PgTable)).map(getTableName).sort();
    expect(res.rows.map((row: { table_name: string }) => row.table_name)).toEqual(expected);
    const collaboration = await client.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('assistant_turns','run_usage','notifications','discussions') ORDER BY table_name`);
    expect(collaboration.rows.map((row: { table_name: string }) => row.table_name)).toEqual(["assistant_turns", "discussions", "notifications", "run_usage"]);
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

  it("adds nullable receipt identity without reconstructing or replacing legacy history", async () => {
    client = await PgliteDbClient.create();
    const baseline = await loadMigrationStatements("0021_workspace_retention.sql");
    await client.migrate(baseline);
    await client.db.insert(organizations).values({ id: "org_legacy", name: "Legacy", createdAt: NOW });
    await appendEvent(client.db, { id: "event_legacy", organizationId: "org_legacy", type: "run.output",
      schemaVersion: "1", actorType: "agent", actorId: "agent_legacy", correlationId: "task_legacy",
      runId: "run_legacy", sequence: 7, payload: { stream: "stdout", text: "original history" }, occurredAt: NOW });
    await client.db.execute(sql`INSERT INTO run_event_ingest (node_id,run_id,sequence,event_id,created_at)
      VALUES ('node_legacy','run_legacy',7,'event_legacy',${NOW})`);
    const before = await client.db.execute(sql`SELECT * FROM event_log WHERE id='event_legacy'`);
    const all = await loadMigrationStatements();
    await client.migrate(all);
    expect((await client.db.execute(sql`SELECT node_id,run_id,sequence,event_id,body_identity FROM run_event_ingest`)).rows)
      .toEqual([{ node_id: "node_legacy", run_id: "run_legacy", sequence: 7, event_id: "event_legacy", body_identity: null }]);
    expect((await client.db.execute(sql`SELECT * FROM event_log WHERE id='event_legacy'`)).rows).toEqual(before.rows);
    const journal = await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    await client.migrate(all);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(journal.rows);
    await expect(client.migrate(baseline)).rejects.toThrow("Migration history changed");
    await expect(client.db.execute(sql`UPDATE run_event_ingest SET body_identity='caller-supplied'`)).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT body_identity FROM run_event_ingest`)).rows).toEqual([{ body_identity: null }]);
  });

  it("rolls back receipt DDL and migration journal together on an invalid suffix", async () => {
    client = await PgliteDbClient.create();
    const baseline = await loadMigrationStatements("0021_workspace_retention.sql");
    await client.migrate(baseline);
    const before = await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    const all = await loadMigrationStatements();
    await expect(client.migrate([...all, "SELECT artoo_deliberately_missing_migration_function()"])).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name='run_event_ingest' AND column_name='body_identity'`)).rows).toEqual([]);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(before.rows);
    await client.migrate(all);
    expect((await client.db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name='run_event_ingest' AND column_name='body_identity'`)).rows).toEqual([{ column_name: "body_identity" }]);
  });
});
