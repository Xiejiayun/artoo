import { performance } from "node:perf_hooks";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PgliteDbClient } from "@artoo/storage";
import { loadMigrationStatements, seed } from "@artoo/db";

// Isolated in-memory measurement. Never reads a configured database URL.
if (process.argv.length > 3) throw new Error("Usage: node scripts/benchmarks/budget-scan.mjs [report-directory]");
const root = resolve(process.argv[2] ?? "artifacts/performance");
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, "budget-scan-"));
console.log(`Reports: ${directory}`);
const database = await PgliteDbClient.create();
try {
  await database.migrate(await loadMigrationStatements());
  await seed(database, "2026-11-14T00:00:00Z");
  const pg = database.db.$client;
  await pg.exec(`
    INSERT INTO goals (id,organization_id,project_id,owner_user_id,title,status,budgets,created_at,updated_at)
    SELECT 'scan_goal_' || i,'org_default','proj_artoo','user_owner','Controlled budget scan',
      CASE WHEN i <= 20 THEN 'running' ELSE 'completed' END,
      CASE WHEN i <= 2 THEN '{"max_elapsed_ms":60000}'::jsonb ELSE '{}'::jsonb END, now(),now()
    FROM generate_series(1,10000) i;
    ANALYZE goals;
  `);
  const queries = {
    previous: "SELECT id,organization_id FROM goals WHERE status=$1",
    withBudgets: "SELECT id,organization_id,budgets,stop_conditions FROM goals WHERE status=$1",
  };
  const report = { engine: "PGlite", node: process.version, fixture: { goals: 10000, running: 20, supportedBudgets: 2 }, queries: {} };
  for (const [name, query] of Object.entries(queries)) {
    await pg.query(query, ["running"]);
    const samples = [];
    let rows;
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      rows = (await pg.query(query, ["running"])).rows;
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const plan = (await pg.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, ["running"])).rows[0]["QUERY PLAN"];
    report.queries[name] = { rows: rows.length, p50_ms: samples[14], p95_ms: samples[28], plan };
  }
  writeFileSync(join(directory, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify(report, null, 2));
} finally { await database.close(); }
