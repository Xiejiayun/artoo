import { PgliteDbClient } from "@artoo/storage";
import { sql, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seedPreProjectSquads as seed } from "./migration-test-support.js";

const h6Tables = [
  "goal_imported_execution_receipts",
  "goal_imported_execution_reviews",
  "goal_imported_execution_review_deliveries",
  "goal_imported_execution_review_receipts",
  "goal_imported_execution_repairs",
  "goal_imported_execution_repair_deliveries",
  "goal_imported_execution_repair_completions",
  "goal_imported_execution_repair_receipts",
].sort();
const h6Functions = [
  "imported_implementation_source",
  "protect_goal_imported_execution_repair_completion",
  "protect_imported_implementation_receipt",
  "protect_goal_imported_execution_review",
  "protect_goal_imported_execution_repair",
].sort();
const h7Tables = [
  "goal_imported_validations",
  "goal_imported_validation_deliveries",
  "goal_imported_validation_completions",
  "goal_imported_validation_receipts",
  "goal_imported_validation_reviews",
  "goal_imported_validation_review_deliveries",
  "goal_imported_validation_review_receipts",
  "goal_imported_validation_publications",
].sort();

async function rows(client: PgliteDbClient, query: SQL): Promise<Record<string, unknown>[]> {
  return (await client.db.execute(query)).rows;
}
async function publicTables(client: PgliteDbClient): Promise<string[]> {
  const result = await rows(client, sql`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return result.map(row => {
    if (typeof row.table_name !== "string") throw Error("Expected a PostgreSQL table name");
    return row.table_name;
  });
}
async function businessRows(client: PgliteDbClient, tables: string[]) {
  const result = [];
  for (const table of tables) {
    result.push({ table, rows: await rows(client, sql`SELECT to_jsonb(history) AS row
      FROM ${sql.identifier("public")}.${sql.identifier(table)} history ORDER BY to_jsonb(history)::text`) });
  }
  return result;
}
async function h6Definition(client: PgliteDbClient) {
  const tables = sql.join(h6Tables.map(name => sql`${name}`), sql`, `);
  const functions = sql.join(h6Functions.map(name => sql`${name}`), sql`, `);
  return {
    tables: await rows(client, sql`SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity,
      c.relforcerowsecurity, c.relreplident, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${tables}) ORDER BY c.relname`),
    columns: await rows(client, sql`SELECT table_name, column_name, ordinal_position, data_type, udt_schema, udt_name,
      is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale, datetime_precision,
      is_identity, is_generated, generation_expression, collation_schema, collation_name
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN (${tables})
      ORDER BY table_name, ordinal_position`),
    constraints: await rows(client, sql`SELECT c.relname, p.conname, p.contype, p.condeferrable, p.condeferred,
      p.convalidated, pg_get_constraintdef(p.oid) AS definition
      FROM pg_constraint p JOIN pg_class c ON c.oid = p.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${tables}) ORDER BY c.relname, p.conname`),
    indexes: await rows(client, sql`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN (${tables}) ORDER BY tablename, indexname`),
    // The function body matters too: an unchanged trigger name can call replaced code.
    triggers: await rows(client, sql`SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition,
      pg_get_functiondef(t.tgfoid) AS function_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${tables}) AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`),
    functions: await rows(client, sql`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
      pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (${functions}) ORDER BY p.proname, arguments`),
  };
}

it("upgrades actual 0039 to 0040 to 0041 to 0042 without changing business history or H6 definitions, and replays idempotently", async () => {
  const boundaries = await Promise.all([
    "0039_goal_imported_design_reviews.sql",
    "0040_goal_imported_executions.sql",
    "0041_goal_imported_execution_reviews.sql",
    "0042_goal_imported_validations.sql",
  ].map(file => loadMigrationStatements(file)));
  const [h4, h5, h6, h7] = boundaries;
  if (!h4 || !h5 || !h6 || !h7) throw Error("Expected all four migration boundaries");
  for (const [before, after] of [[h4, h5], [h5, h6], [h6, h7]] as const) {
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
  }

  // A fresh, self-contained old database: no archived runtime, copied DB, disabled
  // trigger or deleted journal is used to manufacture an upgrade starting point.
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(h4);
    const now = "2026-11-06T00:00:00Z", ids = await seed(client, now);
    await client.db.execute(sql`INSERT INTO tasks
      (id, organization_id, project_id, title, status, created_by_type, created_by_id, created_at, updated_at)
      VALUES ('task_h7_legacy_manual', ${ids.organizationId}, ${ids.projectId}, 'Existing manual task', 'done',
        'user', ${ids.userId}, ${now}, ${now})`);
    await client.db.execute(sql`INSERT INTO runs
      (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id, status, sequence, workspace_root,
        requested_by_user_id, created_at, ended_at)
      VALUES ('run_h7_legacy_manual', ${ids.organizationId}, 'task_h7_legacy_manual', ${ids.computerId},
        ${ids.agentInstanceId}, 'mock', 'completed', 7, 'C:/Original/草稿', ${ids.userId}, ${now}, ${now})`);
    const oldTables = await publicTables(client), history = await businessRows(client, oldTables);
    for (const table of ["projects", "users", "tasks", "runs"]) {
      expect(history.find(item => item.table === table)?.rows.length).toBeGreaterThan(0);
    }
    let journal = await rows(client, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    expect(journal).toHaveLength(h4.length);
    for (const next of [h5, h6]) {
      await client.migrate(next);
      expect(await businessRows(client, oldTables)).toEqual(history);
      const upgraded = await rows(client, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
      expect(upgraded).toHaveLength(next.length);
      expect(upgraded.slice(0, journal.length)).toEqual(journal);
      journal = upgraded;
    }

    const beforeTables = await publicTables(client), before = await h6Definition(client);
    expect(before.tables.map(table => table.relname)).toEqual(h6Tables);
    expect(before.functions.map(fn => fn.proname)).toEqual(h6Functions);
    for (const table of h6Tables) {
      expect(before.columns.some(column => column.table_name === table)).toBe(true);
      expect(before.constraints.some(constraint => constraint.relname === table)).toBe(true);
      expect(before.triggers.some(trigger => trigger.relname === table && trigger.tgenabled === "O")).toBe(true);
    }
    expect(beforeTables.filter(table => h7Tables.includes(table))).toEqual([]);
    // Scope limit: these H6 tables have no historical rows. This test preserves
    // their real DDL and ordinary seeded/manual data; it does not prove upgrade
    // preservation of nonempty H6 review/repair/completion/receipt history.
    expect((await businessRows(client, h6Tables)).every(table => table.rows.length === 0)).toBe(true);

    await client.migrate(h7);
    expect(await businessRows(client, oldTables)).toEqual(history);
    expect(await h6Definition(client)).toEqual(before);
    const afterTables = await publicTables(client);
    expect(afterTables.filter(table => !beforeTables.includes(table))).toEqual(h7Tables);
    expect(beforeTables.filter(table => !afterTables.includes(table))).toEqual([]);
    expect((await businessRows(client, [...h6Tables, ...h7Tables])).every(table => table.rows.length === 0)).toBe(true);
    const upgraded = await rows(client, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    expect(upgraded).toHaveLength(h7.length);
    expect(upgraded.slice(0, journal.length)).toEqual(journal);

    const allRows = await businessRows(client, afterTables);
    await client.migrate(h7);
    expect(await publicTables(client)).toEqual(afterTables);
    expect(await businessRows(client, afterTables)).toEqual(allRows);
    expect(await h6Definition(client)).toEqual(before);
    expect(await rows(client, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).toEqual(upgraded);
  } finally { await client.close(); }
});
