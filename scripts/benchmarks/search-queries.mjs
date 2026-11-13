import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { loadMigrationStatements } from "@artoo/db";

// Disposable memory-only database; never reads a connection string or installation.
if (process.argv.length > 3) throw new Error("Usage: node scripts/benchmarks/search-queries.mjs [report-directory]");
const root = resolve(process.argv[2] ?? "artifacts/performance");
mkdirSync(root, { recursive: true });
const output = mkdtempSync(join(root, "search-queries-"));
console.log(`Reports: ${output}`);
const pg = await PGlite.create({ extensions: { pg_trgm } });
const report = {
  engine: "PGlite",
  node: process.version,
  fixture: { messages: 20000, tasks: 5000, memories: 5000 },
  phases: [],
};
try {
  for (const statement of await loadMigrationStatements("0061_presence_audit_context_indexes.sql"))
    await pg.exec(statement);
  await pg.exec(`
    INSERT INTO organizations VALUES ('org_search','Search fixture',now());
    INSERT INTO projects (id,organization_id,name,created_at) VALUES ('project_search','org_search','Search fixture',now());
    INSERT INTO rooms (id,organization_id,project_id,type,name,created_at)
      SELECT 'room_'||i,'org_search','project_search','project','Search fixture',now() FROM generate_series(0,9) i;
    INSERT INTO messages (id,organization_id,room_id,actor_type,actor_id,kind,body,created_at)
      SELECT 'msg_'||i,'org_search','room_'||(i % 10),'user','fixture','text',
        CASE WHEN i % 997=0 THEN 'rare_search_needle ' ELSE 'ordinary project discussion ' END || repeat('longer body ',20)||i,now()
      FROM generate_series(1,20000) i;
    INSERT INTO tasks (id,organization_id,project_id,title,description,status,created_by_type,created_by_id,created_at,updated_at)
      SELECT 'task_'||i,'org_search','project_search','Task '||i,
        CASE WHEN i % 997=0 THEN 'rare_search_needle ' ELSE 'ordinary task ' END || repeat('description ',20),
        'backlog','user','fixture',now(),now() FROM generate_series(1,5000) i;
    INSERT INTO memories (id,organization_id,project_id,status,scope,author_type,author_id,text,payload,tags,created_at)
      SELECT 'mem_'||i,'org_search','project_search','accepted','project','user','fixture',
        CASE WHEN i % 997=0 THEN 'rare_search_needle ' ELSE 'ordinary memory ' END || repeat('knowledge ',20),
        jsonb_build_object('rule','structured knowledge '||i),'["team"]'::jsonb,now() FROM generate_series(1,5000) i;
    ANALYZE messages; ANALYZE tasks; ANALYZE memories;
  `);
  const statements = {
    messages: [
      "SELECT * FROM messages WHERE organization_id=$1 AND room_id=$2 AND moderated_at IS NULL AND body ILIKE $3 ORDER BY position DESC LIMIT 51",
      ["org_search", "room_0"],
    ],
    tasks: [
      "SELECT * FROM tasks WHERE organization_id=$1 AND project_id=$2 AND (title ILIKE $3 OR description ILIKE $3) ORDER BY created_at,id LIMIT 50",
      ["org_search", "project_search"],
    ],
    memories: [
      "SELECT * FROM memories WHERE organization_id=$1 AND project_id=$2 AND (text ILIKE $3 OR payload::text ILIKE $3 OR tags::text ILIKE $3) ORDER BY created_at,id LIMIT 50",
      ["org_search", "project_search"],
    ],
  };
  let baseline;
  async function measure(name) {
    const phase = {
      name,
      indexBytes: (
        await pg.query(
          "SELECT indexrelname, pg_relation_size(indexrelid)::integer AS bytes FROM pg_stat_user_indexes WHERE indexrelname LIKE '%search_candidate' ORDER BY indexrelname",
        )
      ).rows,
      queries: {},
    };
    for (const [table, [statement, prefix]] of Object.entries(statements)) {
      for (const [kind, pattern] of Object.entries({
        rare: "%rare\\_search\\_needle%",
        missing: "%no_such_match%",
        short: "%a%",
      })) {
        const key = `${table}.${kind}`,
          parameters = [...prefix, pattern];
        const first = await pg.query(statement, parameters);
        const ids = first.rows.map((row) => row.id);
        if (baseline) assert.deepEqual(ids, baseline.queries[key].ids);
        const samples = [];
        for (let i = 0; i < 10; i++) {
          const start = performance.now();
          await pg.query(statement, parameters);
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        phase.queries[key] = {
          ids,
          p50_ms: samples[4],
          p95_ms: samples[9],
          explain: (await pg.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, parameters)).rows[0][
            "QUERY PLAN"
          ],
        };
      }
    }
    report.phases.push(phase);
    writeFileSync(join(output, `${name}.json`), JSON.stringify(phase, null, 2), { flag: "wx" });
    console.log(
      JSON.stringify({
        name,
        queries: Object.fromEntries(
          Object.entries(phase.queries).map(([key, result]) => [
            key,
            { rows: result.ids.length, p50_ms: result.p50_ms, p95_ms: result.p95_ms },
          ]),
        ),
      }),
    );
    return phase;
  }
  baseline = await measure("existing_indexes");
  await pg.exec(`CREATE EXTENSION pg_trgm;
    CREATE INDEX messages_body_search_candidate ON messages USING gin (body gin_trgm_ops) WHERE moderated_at IS NULL;
    CREATE INDEX tasks_title_search_candidate ON tasks USING gin (title gin_trgm_ops);
    CREATE INDEX tasks_description_search_candidate ON tasks USING gin (description gin_trgm_ops);
    CREATE INDEX memories_text_search_candidate ON memories USING gin (text gin_trgm_ops);
    CREATE INDEX memories_payload_search_candidate ON memories USING gin ((payload::text) gin_trgm_ops);
    CREATE INDEX memories_tags_search_candidate ON memories USING gin ((tags::text) gin_trgm_ops);
    ANALYZE messages; ANALYZE tasks; ANALYZE memories;
  `);
  await measure("trigram_candidates");
  await pg.exec(`DROP INDEX memories_text_search_candidate;
    DROP INDEX memories_payload_search_candidate;
    DROP INDEX memories_tags_search_candidate;
    ANALYZE memories;
  `);
  await measure("selected_message_task_indexes");
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
} finally {
  await pg.close();
}
