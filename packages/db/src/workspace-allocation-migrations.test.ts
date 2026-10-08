import { createHash } from "node:crypto";
import { loadMigrationStatements } from "./migrations.js";
import { ContextPackSchema } from "@artoo/domain";
import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-06-13T00:00:00.000Z";
const EXACT_ROOT = "/Recorded//Cafe\u0301/草稿 /";
const EXACT_BRANCH = "Feature/Keep-Case";
const QUALIFIED_BODY = '{"payload":{"stream":"stdout","text":"preserved receipt"},"type":"run.output"}';
const QUALIFIED_IDENTITY = "run-event-body-v1:sha256:" + createHash("sha256")
  .update("artoo.run-event.body/v1\0").update(QUALIFIED_BODY).digest("hex");

// Migration-only fixtures intentionally use raw SQL for pre-column histories.
// They do not substitute for authenticated assignment/dispatch in the WS cases.
describe("combined receipt and allocation migration history", () => {
  let client: PgliteDbClient | undefined;
  afterEach(async () => { await client?.close(); client = undefined; });

  async function histories() {
    const baseline = await loadMigrationStatements("0021_workspace_retention.sql");
    const receiver = await loadMigrationStatements("0022_run_event_body_identity.sql");
    const combined = await loadMigrationStatements();
    expect(baseline).toHaveLength(220);
    expect(receiver).toHaveLength(222);
    expect(combined).toHaveLength(223);
    expect(receiver.slice(0, baseline.length)).toEqual(baseline);
    expect(combined.slice(0, receiver.length)).toEqual(receiver);
    // Accepted allocation SQL bytes moved to 0023; checksums use statement bytes,
    // so this is the exact old allocation-only 0022 fork's statement history.
    const allocationSuffix = combined.slice(receiver.length);
    expect(allocationSuffix).toEqual(["ALTER TABLE runs ADD COLUMN workspace_allocation jsonb;"]);
    return { baseline, receiver, combined, allocationOnly: [...baseline, ...allocationSuffix] };
  }

  async function journal(db: PgliteDbClient) {
    return (await db.db.execute(sql`SELECT position, checksum, applied_at::text AS applied_at
      FROM artoo_meta.migrations ORDER BY position`)).rows;
  }

  async function expectHistory(db: PgliteDbClient, statements: readonly string[]) {
    const rows = await journal(db);
    expect(rows).toHaveLength(statements.length);
    expect(rows.map((row: { position: unknown; checksum: unknown }) => ({ position: row.position, checksum: row.checksum }))).toEqual(
      statements.map((statement, position) => ({ position, checksum: createHash("sha256")
        .update(statement.replace(/\r\n/g, "\n").trim()).digest("hex") })),
    );
    return rows;
  }

  async function addedColumns(db: PgliteDbClient) {
    return (await db.db.execute(sql`SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='run_event_ingest' AND column_name='body_identity') OR
       (table_name='runs' AND column_name='workspace_allocation')) ORDER BY table_name, column_name`)).rows;
  }

  async function exactData(db: PgliteDbClient) {
    return {
      organizations: (await db.db.execute(sql`SELECT to_jsonb(t) AS row FROM organizations t ORDER BY id`)).rows,
      projects: (await db.db.execute(sql`SELECT to_jsonb(t) AS row FROM projects t ORDER BY id`)).rows,
      tasks: (await db.db.execute(sql`SELECT to_jsonb(t) AS row FROM tasks t ORDER BY id`)).rows,
      runs: (await db.db.execute(sql`SELECT to_jsonb(t) - 'workspace_allocation' AS row FROM runs t ORDER BY id`)).rows,
      contexts: (await db.db.execute(sql`SELECT to_jsonb(t) AS row FROM context_packs t ORDER BY id`)).rows,
      events: (await db.db.execute(sql`SELECT to_jsonb(t) AS row FROM event_log t ORDER BY position`)).rows,
      receipts: (await db.db.execute(sql`SELECT to_jsonb(t) - 'body_identity' AS row
        FROM run_event_ingest t ORDER BY run_id, sequence`)).rows,
    };
  }

  async function seedRecordedHistory(db: PgliteDbClient, receiptColumnPresent: boolean) {
    const pack = ContextPackSchema.parse({
      task: { id: "task_history", title: "Recorded task", description: "Keep exact historical values",
        acceptance_criteria: ["Preserve before/after rows"] },
      project: { id: "project_history", name: "Recorded project", default_workspace: EXACT_ROOT },
      workspace: { root: EXACT_ROOT, file_scope: ["Src/Exact.ts", "docs/中文.md"] },
      policy: { filesystem_write_scope: [EXACT_ROOT], requires_approval: ["git.push"] },
      memory: { task_summary: "historical context", project_notes: ["Do not normalize Cafe\u0301"] },
      artifacts: { expected: ["patch"] },
    });
    await db.db.execute(sql`INSERT INTO organizations (id,name,created_at)
      VALUES ('org_history','History',${NOW})`);
    await db.db.execute(sql`INSERT INTO projects (id,organization_id,name,default_workspace,created_at)
      VALUES ('project_history','org_history','Recorded project',${EXACT_ROOT},${NOW})`);
    await db.db.execute(sql`INSERT INTO tasks
      (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
      VALUES ('task_history','org_history','project_history','Recorded task','review','user','user_history',${NOW},${NOW})`);
    await db.db.execute(sql`INSERT INTO runs
      (id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,context_pack_id,
       workspace_root,workspace_branch,sequence,created_at,started_at,ended_at)
      VALUES ('run_exact','org_history','task_history','node_history','agent_history','fixture','completed','ctx_history',
        ${EXACT_ROOT},${EXACT_BRANCH},7,${NOW},${NOW},${NOW}),
      ('run_null','org_history','task_history','node_history','agent_history','fixture','failed',NULL,
        NULL,NULL,1,${NOW},${NOW},${NOW})`);
    await db.db.execute(sql`INSERT INTO context_packs
      (id,organization_id,task_id,run_id,payload,source_memory_ids,created_at)
      VALUES ('ctx_history','org_history','task_history','run_exact',${JSON.stringify(pack)}::jsonb,
        '["memory_history"]'::jsonb,${NOW})`);
    for (const [runId, sequence, eventId] of [["run_exact", 7, "event_exact"], ["run_null", 1, "event_null"]] as const) {
      await db.db.execute(sql`INSERT INTO event_log
        (id,organization_id,type,schema_version,actor_type,actor_id,task_id,run_id,correlation_id,sequence,payload,occurred_at)
        VALUES (${eventId},'org_history','run.output','1','agent','agent_history','task_history',${runId},
          'task_history',${sequence},'{"stream":"stdout","text":"preserved receipt"}'::jsonb,${NOW})`);
      if (receiptColumnPresent) {
        // A known complete-body identity is explicitly seeded in the receiver
        // fixture; this does not reconstruct or backfill a historical NULL row.
        await db.db.execute(sql`INSERT INTO run_event_ingest (node_id,run_id,sequence,event_id,created_at,body_identity)
          VALUES ('node_history',${runId},${sequence},${eventId},${NOW},${runId === "run_exact" ? QUALIFIED_IDENTITY : null})`);
      } else {
        await db.db.execute(sql`INSERT INTO run_event_ingest (node_id,run_id,sequence,event_id,created_at)
          VALUES ('node_history',${runId},${sequence},${eventId},${NOW})`);
      }
    }
    return pack;
  }

  it("M01 fresh combined history creates both nullable columns and records the exact ordered journal", async () => {
    const { combined } = await histories();
    client = await PgliteDbClient.create();
    await client.migrate(combined);
    expect(await addedColumns(client)).toEqual([
      { table_name: "run_event_ingest", column_name: "body_identity", data_type: "text", is_nullable: "YES", column_default: null },
      { table_name: "runs", column_name: "workspace_allocation", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    const before = await expectHistory(client, combined);
    await seedRecordedHistory(client, true);
    expect((await client.db.execute(sql`SELECT workspace_allocation FROM runs ORDER BY id`)).rows)
      .toEqual([{ workspace_allocation: null }, { workspace_allocation: null }]);
    await expect(client.db.execute(sql`UPDATE run_event_ingest SET body_identity='not-a-qualified-identity'`)).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT body_identity FROM run_event_ingest ORDER BY run_id`)).rows)
      .toEqual([{ body_identity: QUALIFIED_IDENTITY }, { body_identity: null }]);
    const data = await exactData(client);
    await client.migrate(combined);
    expect(await journal(client)).toEqual(before);
    expect(await exactData(client)).toEqual(data);
  });

  it("M02 receiver 0022 upgrades through allocation 0023 without changing receipts or history", async () => {
    const { receiver, combined } = await histories();
    client = await PgliteDbClient.create();
    await client.migrate(receiver);
    await seedRecordedHistory(client, true);
    const beforeData = await exactData(client), beforeJournal = await expectHistory(client, receiver);
    const beforeReceipts = (await client.db.execute(sql`SELECT to_jsonb(t) AS row FROM run_event_ingest t ORDER BY run_id`)).rows;
    await client.migrate(combined);
    expect(await exactData(client)).toEqual(beforeData);
    expect((await client.db.execute(sql`SELECT to_jsonb(t) AS row FROM run_event_ingest t ORDER BY run_id`)).rows).toEqual(beforeReceipts);
    expect((await client.db.execute(sql`SELECT body_identity FROM run_event_ingest ORDER BY run_id`)).rows)
      .toEqual([{ body_identity: QUALIFIED_IDENTITY }, { body_identity: null }]);
    expect((await client.db.execute(sql`SELECT workspace_allocation FROM runs ORDER BY id`)).rows)
      .toEqual([{ workspace_allocation: null }, { workspace_allocation: null }]);
    const afterJournal = await expectHistory(client, combined);
    expect(afterJournal.slice(0, beforeJournal.length)).toEqual(beforeJournal);
    expect(afterJournal).toHaveLength(beforeJournal.length + 1);
    await client.migrate(combined);
    expect(await journal(client)).toEqual(afterJournal);
  });

  it("M03 allocation-only 0022 fork is rejected without rewriting data, schema or migration history", async () => {
    const { allocationOnly, combined } = await histories();
    client = await PgliteDbClient.create();
    await client.migrate(allocationOnly);
    await seedRecordedHistory(client, false);
    await client.db.execute(sql`UPDATE runs SET workspace_allocation=
      '{"version":1,"strategy":"per-run","base_path":"/Approved//Base/"}'::jsonb WHERE id='run_exact'`);
    const beforeData = await exactData(client), beforeJournal = await expectHistory(client, allocationOnly);
    const beforeRuns = (await client.db.execute(sql`SELECT to_jsonb(t) AS row FROM runs t ORDER BY id`)).rows;
    const beforeColumns = await addedColumns(client);
    expect(beforeColumns).toEqual([
      { table_name: "runs", column_name: "workspace_allocation", data_type: "jsonb", is_nullable: "YES", column_default: null },
    ]);
    await expect(client.migrate(combined)).rejects.toThrow("Migration history changed at statement 221");
    expect(await exactData(client)).toEqual(beforeData);
    expect((await client.db.execute(sql`SELECT to_jsonb(t) AS row FROM runs t ORDER BY id`)).rows).toEqual(beforeRuns);
    expect(await addedColumns(client)).toEqual(beforeColumns);
    expect(await journal(client)).toEqual(beforeJournal);
    await client.migrate(allocationOnly);
    expect(await journal(client)).toEqual(beforeJournal);
  });

  it("M04 nonempty canonical 0021 preserves exact roots, branches, ContextPacks, legacy receipts and NULL allocations through 0023", async () => {
    const { baseline, combined } = await histories();
    client = await PgliteDbClient.create();
    await client.migrate(baseline);
    const pack = await seedRecordedHistory(client, false);
    expect(await addedColumns(client)).toEqual([]);
    const beforeData = await exactData(client), beforeJournal = await expectHistory(client, baseline);
    expect(beforeData.runs).toHaveLength(2);
    expect(beforeData.contexts).toHaveLength(1);
    expect(beforeData.events).toHaveLength(2);
    expect(beforeData.receipts).toHaveLength(2);
    await client.migrate(combined);
    expect(await exactData(client)).toEqual(beforeData);
    expect((await client.db.execute(sql`SELECT id, workspace_root, workspace_branch, context_pack_id, workspace_allocation
      FROM runs ORDER BY id`)).rows).toEqual([
      { id: "run_exact", workspace_root: EXACT_ROOT, workspace_branch: EXACT_BRANCH, context_pack_id: "ctx_history", workspace_allocation: null },
      { id: "run_null", workspace_root: null, workspace_branch: null, context_pack_id: null, workspace_allocation: null },
    ]);
    expect((await client.db.execute(sql`SELECT payload FROM context_packs WHERE id='ctx_history'`)).rows).toEqual([{ payload: pack }]);
    expect((await client.db.execute(sql`SELECT run_id, sequence, event_id, body_identity FROM run_event_ingest ORDER BY run_id`)).rows)
      .toEqual([{ run_id: "run_exact", sequence: 7, event_id: "event_exact", body_identity: null },
        { run_id: "run_null", sequence: 1, event_id: "event_null", body_identity: null }]);
    const afterJournal = await expectHistory(client, combined);
    expect(afterJournal.slice(0, beforeJournal.length)).toEqual(beforeJournal);
    expect(afterJournal).toHaveLength(beforeJournal.length + 3);
    await client.migrate(combined);
    expect(await journal(client)).toEqual(afterJournal);
    expect(await exactData(client)).toEqual(beforeData);
  });
});
