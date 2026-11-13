import { performance } from 'node:perf_hooks';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PgliteDbClient } from '@artoo/storage';
import { loadMigrationStatements, seed } from '@artoo/db';

// Always use an isolated in-memory database. This benchmark never reads a database URL.
// Optional argument selects the reports' parent directory; each run gets a new directory.
if (process.argv.length > 3) throw new Error('Usage: node scripts/benchmarks/presence-indexes.mjs [report-directory]');
const outputRoot = resolve(process.argv[2] ?? 'artifacts/performance');
mkdirSync(outputRoot, { recursive: true });
const reportDirectory = mkdtempSync(join(outputRoot, 'presence-indexes-'));
console.log(`Reports: ${reportDirectory}`);
const database = await PgliteDbClient.create();
const report = { engine: 'PGlite', node: process.version, fixture: { tasks: 100, messages: 20000, runs: 20000, activeRuns: 206 }, phases: [] };
try {
  await database.migrate(await loadMigrationStatements('0060_list_query_indexes.sql'));
  await seed(database, '2026-11-13T00:00:00Z');
  const pg = database.db.$client;
  await pg.exec(`
    INSERT INTO tasks (id, organization_id, project_id, title, status, created_by_type, created_by_id, created_at, updated_at)
    SELECT 'task_' || i, 'org_default', 'proj_artoo', 'load fixture ' || i, 'running', 'user', 'user_owner', now(), now() FROM generate_series(1,100) i;
    INSERT INTO rooms (id, organization_id, project_id, type, name, created_at) VALUES ('load_room','org_default','proj_artoo','project','Load',now());
    INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id, status, created_at)
    SELECT 'run_' || lpad(i::text,6,'0'), 'org_default', 'task_' || (1 + i % 100), 'computer_' || (i % 4), 'instance_' || (i % 20), 'mock',
      CASE WHEN i % 97 = 0 THEN 'running' ELSE 'completed' END, TIMESTAMPTZ '2026-11-13T00:00:00Z' + i * INTERVAL '1 second'
    FROM generate_series(1,20000) i;
    INSERT INTO messages (id, organization_id, room_id, task_id, actor_type, actor_id, kind, body, created_at)
    SELECT 'message_' || lpad(i::text,6,'0'), 'org_default', 'load_room', 'task_' || (1 + i % 100), 'user', 'user_owner', 'text', 'load fixture',
      TIMESTAMPTZ '2026-11-13T00:00:00Z' + i * INTERVAL '1 second' FROM generate_series(1,20000) i;
    ANALYZE runs; ANALYZE tasks; ANALYZE messages;
  `);
  const queries = {
    taskMessages: ['SELECT * FROM messages WHERE organization_id=$1 AND task_id=$2 ORDER BY created_at,id', ['org_default','task_42']],
    latestTaskRun: ['SELECT * FROM runs WHERE organization_id=$1 AND task_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', ['org_default','task_42']],
    computerActive: ['SELECT status FROM runs WHERE organization_id=$1 AND computer_id=$2 AND status NOT IN ($3,$4,$5)', ['org_default','computer_1','completed','failed','cancelled']],
    instanceActive: ['SELECT runs.status,tasks.status FROM runs INNER JOIN tasks ON tasks.id=runs.task_id WHERE runs.organization_id=$1 AND tasks.organization_id=$1 AND runs.agent_instance_id=$2 AND runs.status NOT IN ($3,$4,$5)', ['org_default','instance_1','completed','failed','cancelled']],
    allActive: ['SELECT runs.agent_instance_id,runs.status,tasks.status FROM runs INNER JOIN tasks ON tasks.id=runs.task_id WHERE runs.organization_id=$1 AND tasks.organization_id=$1 AND runs.status NOT IN ($2,$3,$4)', ['org_default','completed','failed','cancelled']],
  };
  async function measure(name) {
    const phase = { name, indexBytes: (await pg.query("SELECT indexrelname,pg_relation_size(indexrelid)::integer AS bytes FROM pg_stat_user_indexes WHERE indexrelname LIKE '%candidate%' OR indexrelname IN ('messages_org_task_created_idx','runs_org_task_created_idx') ORDER BY indexrelname")).rows, queries: {} };
    for (const [key,[statement,parameters]] of Object.entries(queries)) {
      await pg.query(statement,parameters);
      const samples=[];
      let rowCount;
      for(let i=0;i<20;i++) { const started=performance.now(); const result=await pg.query(statement,parameters); samples.push(performance.now()-started); rowCount=result.rows.length; }
      samples.sort((a,b)=>a-b);
      const explained=await pg.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+statement,parameters);
      phase.queries[key]={rowCount,p95_ms:samples[18],explain:explained.rows[0]['QUERY PLAN']};
    }
    report.phases.push(phase);
    // Keep completed phases even if a later phase fails, and never replace evidence.
    writeFileSync(join(reportDirectory, `${name}.json`), JSON.stringify(phase, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({name,queries:Object.fromEntries(Object.entries(phase.queries).map(([key,value])=>[key,{rowCount:value.rowCount,p95_ms:value.p95_ms}]))}));
  }
  await measure('baseline');
  await pg.exec(`CREATE INDEX messages_org_task_created_idx ON messages (organization_id,task_id,created_at,id);
    CREATE INDEX runs_org_task_created_idx ON runs (organization_id,task_id,created_at DESC,id DESC);
    CREATE INDEX runs_computer_status_candidate ON runs (organization_id,computer_id,status); ANALYZE runs; ANALYZE messages;`);
  await measure('composite_status');
  await pg.exec(`DROP INDEX runs_computer_status_candidate;
    CREATE INDEX runs_active_candidate ON runs (organization_id,computer_id,agent_instance_id) WHERE status NOT IN ('completed','failed','cancelled'); ANALYZE runs;`);
  await measure('partial_active');
  writeFileSync(join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
} finally { await database.close(); }
