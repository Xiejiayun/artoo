import { canonicalReleaseJson, ProductReleaseReceiptSchema, ProductReleaseRequestSchema,
  type ProductReleaseReceipt, type ProductReleaseRequest, type ProductReleaseRetrySourceV1 } from "@artoo/domain";
import { PgliteDbClient, type DrizzleDb } from "@artoo/storage";
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed, type SeedIds } from "./seed.js";

const now = "2026-11-06T00:00:00.000Z", later = "2026-11-06T00:00:01.000Z";
const digest = `sha256:${"a".repeat(64)}`, otherDigest = `sha256:${"b".repeat(64)}`;
const endpoint = "http://127.0.0.1:18182/", deviceId = "device_h8_fixture", tokenLookup = "h8-controlled-lookup";
const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonicalReleaseJson(value)).digest("hex")}`;
const query = async (db: DrizzleDb, statement: SQL): Promise<Record<string, unknown>[]> => (await db.execute(statement)).rows;

// This finally belongs to the ORIGINAL test callback. A Vitest timeout cannot run
// it in parallel with an unfinished query. Every test owns a different database;
// there are no shared beforeEach/afterEach handles or unawaited operations.
async function withDatabase(body: (client: PgliteDbClient) => Promise<void>): Promise<void> {
  const client = await PgliteDbClient.create();
  try { await body(client); } finally { await client.close(); }
}
async function upgraded(client: PgliteDbClient) {
  await client.migrate(await loadMigrationStatements("0043_product_release_retries.sql"));
  return seed(client, now, { workspaceRoot: "C:/H8/产品/🚀" });
}
async function rejection(operation: Promise<unknown>, pattern: RegExp): Promise<void> {
  let failure: unknown;
  try { await operation; } catch (error) { failure = error; }
  expect(failure, "The database operation must reject").toBeDefined();
  const messages: string[] = [], seen = new Set<unknown>();
  for (let error = failure; error && !seen.has(error); error = (error as { cause?: unknown }).cause) {
    seen.add(error); messages.push(String((error as { message?: unknown }).message ?? error));
  }
  expect(messages.join("\n")).toMatch(pattern);
}
async function event(db: DrizzleDb, ids: SeedIds, values: {
  id: string; type: string; actor: string; goal: string; run: string; correlation: string; payload: unknown;
}) {
  await db.execute(sql`INSERT INTO event_log
    (id, organization_id, project_id, type, schema_version, actor_type, actor_id, goal_id, run_id, correlation_id, payload, occurred_at)
    VALUES (${values.id}, ${ids.organizationId}, ${ids.projectId}, ${values.type}, '1', 'system', ${values.actor},
      ${values.goal}, ${values.run}, ${values.correlation}, ${json(values.payload)}, ${now})`);
}
async function paired(db: DrizzleDb, ids: SeedIds) {
  await db.execute(sql`INSERT INTO devices (id, organization_id, display_name, platform, app_version, computer_id,
    enrolled_by_user_id, trust, created_at) VALUES (${deviceId}, ${ids.organizationId}, 'Controlled H8 database sender',
    'windows', 'test', ${ids.computerId}, ${ids.userId}, 'active', ${now})`);
  await db.execute(sql`INSERT INTO device_tokens (id, organization_id, device_id, kind, token_lookup, token_hash, status, created_at)
    VALUES ('token_h8_fixture', ${ids.organizationId}, ${deviceId}, 'node', ${tokenLookup}, 'fixture-not-a-real-credential', 'active', ${now})`);
}
async function releaseGraph(db: DrizzleDb, ids: SeedIds, suffix: string, maxRetries = 2) {
  const goalId = `goal_${suffix}`, planId = `plan_${suffix}`, runId = `run_${suffix}`, taskId = `task_${suffix}`;
  const releaseId = `release_${suffix}`, evidenceId = `evidence_${suffix}`, verificationId = `final_${suffix}`;
  await db.execute(sql`INSERT INTO goals (id, organization_id, project_id, owner_user_id, title, status, budgets, created_at, updated_at)
    VALUES (${goalId}, ${ids.organizationId}, ${ids.projectId}, ${ids.userId}, 'Controlled publication history', 'running',
      ${json({ max_retries: maxRetries })}, ${now}, ${now})`);
  await db.execute(sql`INSERT INTO plans (id, organization_id, goal_id, version, author_type, author_id, status, created_at, accepted_at)
    VALUES (${planId}, ${ids.organizationId}, ${goalId}, 1, 'user', ${ids.userId}, 'accepted', ${now}, ${now})`);
  await db.execute(sql`UPDATE goals SET current_plan_id=${planId} WHERE id=${goalId}`);
  await db.execute(sql`INSERT INTO tasks (id, organization_id, project_id, goal_id, source_plan_id, title, status,
    created_by_type, created_by_id, created_at, updated_at)
    VALUES (${taskId}, ${ids.organizationId}, ${ids.projectId}, ${goalId}, ${planId}, 'Existing final author', 'done',
      'user', ${ids.userId}, ${now}, ${now})`);
  const requirement = { version: 1, request_id: verificationId, profile_id: "default" };
  await db.execute(sql`INSERT INTO runs (id, organization_id, task_id, computer_id, agent_instance_id, runtime_id,
    status, sequence, workspace_root, requested_by_user_id, ai_data_sharing_policy_version, verification_requirement, created_at, ended_at)
    VALUES (${runId}, ${ids.organizationId}, ${taskId}, ${ids.computerId}, ${ids.agentInstanceId}, 'mock', 'completed', 3,
      'C:/H8/产品/🚀', ${ids.userId}, 'controlled-local-policy', ${json(requirement)}, ${now}, ${now})`);
  const evidence = { ...requirement, outcome: "passed", profile_digest: digest, subject_digest: digest,
    checks: [{ id: "controlled-final", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [] };
  await event(db, ids, { id: `event_${evidenceId}`, type: "run.verification", actor: ids.computerId,
    goal: goalId, run: runId, correlation: runId, payload: evidence });
  await db.execute(sql`INSERT INTO run_evidence (id, organization_id, run_id, request_id, payload, event_id, created_at)
    VALUES (${evidenceId}, ${ids.organizationId}, ${runId}, ${verificationId}, ${json(evidence)}, ${`event_${evidenceId}`}, ${now})`);
  await db.execute(sql`INSERT INTO goal_automations (goal_id, organization_id, actor_user_id, policy_version, status, plan_id,
    agent_instance_id, computer_id, workspace_root, verification_profile_id, release_profile_id, created_at, updated_at)
    VALUES (${goalId}, ${ids.organizationId}, ${ids.userId}, 'controlled-local-policy', 'executing', ${planId},
      ${ids.agentInstanceId}, ${ids.computerId}, 'C:/H8/产品/🚀', 'default', 'site', ${now}, ${now})`);
  const request = ProductReleaseRequestSchema.parse({ version: 1, release_id: releaseId, goal_id: goalId, project_id: ids.projectId,
    run_id: runId, release_profile_id: "site", verification_request_id: verificationId,
    verification_profile_id: "default", verification_profile_digest: digest, subject_digest: digest });
  await db.execute(sql`INSERT INTO product_releases (id, organization_id, goal_id, project_id, computer_id, run_id,
    evidence_id, status, request, receipt, created_at, updated_at)
    VALUES (${releaseId}, ${ids.organizationId}, ${goalId}, ${ids.projectId}, ${ids.computerId}, ${runId}, ${evidenceId},
      'queued', ${json(request)}, NULL, ${now}, ${now})`);
  return { ids, goalId, planId, runId, taskId, releaseId, evidenceId, request };
}
type ReleaseFixture = Awaited<ReturnType<typeof releaseGraph>>;
const health = () => [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: now }];
const sourceProjection = (id: string): ProductReleaseRetrySourceV1 => ({ version: 1, source_id: `source_${id}`,
  closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } });
function receiptFor(request: ProductReleaseRequest, outcome: ProductReleaseReceipt["outcome"], retrySource?: ProductReleaseRetrySourceV1) {
  return ProductReleaseReceiptSchema.parse({ request, release_profile_digest: digest, artifact_digest: digest, outcome,
    endpoint: outcome === "published" ? endpoint : null, previous_release_id: null, health_checks: outcome === "published" ? health() : [],
    reason: 'Controlled history: 中文 🚀 "quoted" \\ path\nnext line', ...(retrySource ? { retry_source: retrySource } : {}) });
}
async function complete(db: DrizzleDb, f: ReleaseFixture, receipt: ProductReleaseReceipt) {
  await db.execute(sql`UPDATE product_releases SET status=${receipt.outcome}, receipt=${json(receipt)}, updated_at=${later}
    WHERE id=${receipt.request.release_id}`);
  const receiptEventId = `completed_${receipt.request.release_id}`;
  await event(db, f.ids, { id: receiptEventId, type: "product.release.completed", actor: f.ids.computerId,
    goal: f.goalId, run: f.runId, correlation: receipt.request.release_id,
    payload: { release_id: receipt.request.release_id, receipt, request_digest: hash(receipt.request), receipt_digest: hash(receipt) } });
  return receiptEventId;
}
async function insertSource(db: DrizzleDb, f: ReleaseFixture, receipt: ProductReleaseReceipt, receiptEventId: string,
  changes: Partial<{ requestDigest: string; receiptDigest: string; projection: unknown; sourceId: string; computerId: string; eventId: string }> = {}) {
  const projection = receipt.retry_source;
  if (!projection) throw Error("The controlled source fixture needs a projection");
  await db.execute(sql`INSERT INTO product_release_retry_sources
    (release_id, organization_id, computer_id, device_id, token_lookup, session_id, source_id, request_digest, receipt_digest,
      projection, receipt_event_id, received_at)
    VALUES (${receipt.request.release_id}, ${f.ids.organizationId}, ${changes.computerId ?? f.ids.computerId}, ${deviceId}, ${tokenLookup},
      'h8-original-session', ${changes.sourceId ?? projection.source_id}, ${changes.requestDigest ?? hash(receipt.request)},
      ${changes.receiptDigest ?? hash(receipt)}, ${json(changes.projection ?? projection)}, ${changes.eventId ?? receiptEventId}, ${later})`);
}
async function settledFailure(db: DrizzleDb, ids: SeedIds, suffix: string, maxRetries = 2) {
  const f = await releaseGraph(db, ids, suffix, maxRetries), receipt = receiptFor(f.request, "failed", sourceProjection(f.releaseId));
  const receiptEventId = await complete(db, f, receipt); await insertSource(db, f, receipt, receiptEventId);
  return { ...f, receipt, receiptEventId };
}
function nextAttempt(f: ReleaseFixture, receipt: ProductReleaseReceipt, id = `${f.releaseId}_retry`, attempt = 1) {
  const authorizationId = `authorized_${id}`;
  const retry = { version: 1 as const, root_release_id: f.releaseId, previous_release_id: f.releaseId, generation: 1,
    source_id: receipt.retry_source?.source_id ?? "invented-legacy-source", previous_request_digest: hash(receipt.request), previous_receipt_digest: hash(receipt),
    authorization: { event_id: authorizationId, goal_id: f.goalId, actor_user_id: f.ids.userId, attempt_index: attempt } };
  return { id, goalId: f.goalId, computerId: f.ids.computerId, rootId: f.releaseId, previousId: f.releaseId, generation: 1,
    authorizationId, request: ProductReleaseRequestSchema.parse({ ...f.request, release_id: id, retry }),
    payload: { release_id: id, root_release_id: f.releaseId, previous_release_id: f.releaseId, generation: 1, source_id: retry.source_id,
      previous_request_digest: retry.previous_request_digest, previous_receipt_digest: retry.previous_receipt_digest,
      actor_user_id: f.ids.userId, previous_retry_count: attempt - 1, attempt_index: attempt,
      session: { computerId: f.ids.computerId, deviceId, tokenLookup, sessionId: "h8-original-session" } } };
}
type Attempt = ReturnType<typeof nextAttempt>;
async function queue(db: DrizzleDb, f: ReleaseFixture, attempt: Attempt) {
  await db.execute(sql`UPDATE goals SET retry_count=${attempt.payload.attempt_index} WHERE id=${f.goalId}`);
  await event(db, f.ids, { id: attempt.authorizationId, type: "product.release.retry-authorized", actor: "goal_runner",
    goal: attempt.goalId, run: f.runId, correlation: attempt.id, payload: attempt.payload });
  await db.execute(sql`INSERT INTO product_releases (id, organization_id, goal_id, project_id, computer_id, run_id, evidence_id,
    status, request, publication_generation, root_release_id, retry_of_release_id, retry_authorization_event_id, created_at, updated_at)
    VALUES (${attempt.id}, ${f.ids.organizationId}, ${attempt.goalId}, ${f.ids.projectId}, ${attempt.computerId}, ${f.runId}, ${f.evidenceId},
      'queued', ${json(attempt.request)}, ${attempt.generation}, ${attempt.rootId}, ${attempt.previousId}, ${attempt.authorizationId}, ${later}, ${later})`);
}
async function releaseRows(db: DrizzleDb) {
  return query(db, sql`SELECT id, status, request, receipt, request::text AS request_text, receipt::text AS receipt_text,
    publication_generation, root_release_id, retry_of_release_id, retry_authorization_event_id FROM product_releases ORDER BY id`);
}

const h7Tables = ["goal_imported_validations", "goal_imported_validation_deliveries", "goal_imported_validation_completions",
  "goal_imported_validation_receipts", "goal_imported_validation_reviews", "goal_imported_validation_review_deliveries",
  "goal_imported_validation_review_receipts", "goal_imported_validation_publications"].sort();
const h7Functions = ["protect_imported_validation_delivery", "protect_imported_validation_receipt", "protect_imported_validation_completion",
  "imported_validation_source", "protect_imported_validation", "protect_imported_validation_review", "protect_imported_validation_publication"].sort();
async function h7Definition(db: DrizzleDb) {
  const tables = sql.join(h7Tables.map(name => sql`${name}`), sql`, `), functions = sql.join(h7Functions.map(name => sql`${name}`), sql`, `);
  return {
    tables: await query(db, sql`SELECT relname,relkind,relpersistence,relrowsecurity,relforcerowsecurity,relreplident,reloptions
      FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN (${tables}) ORDER BY relname`),
    columns: await query(db, sql`SELECT table_name,column_name,ordinal_position,data_type,udt_schema,udt_name,is_nullable,column_default,
      character_maximum_length,numeric_precision,numeric_scale,datetime_precision,is_identity,is_generated,generation_expression,collation_schema,collation_name
      FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${tables}) ORDER BY table_name, ordinal_position`),
    constraints: await query(db, sql`SELECT c.relname, p.conname, p.contype, p.condeferrable, p.condeferred, p.convalidated,
      pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid
      WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${tables})
        AND p.conname<>'goal_imported_validation_publication_goal_uniq' ORDER BY c.relname, p.conname`),
    indexes: await query(db, sql`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN (${tables})
      AND indexname NOT IN ('goal_imported_validation_publication_goal_uniq','goal_imported_validation_publication_goal_idx') ORDER BY tablename,indexname`),
    triggers: await query(db, sql`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,pg_get_functiondef(t.tgfoid) AS function_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND c.relname IN (${tables})
      AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`),
    functions: await query(db, sql`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN (${functions}) ORDER BY p.proname,arguments`),
  };
}
async function tables(db: DrizzleDb) {
  return (await query(db, sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).map(row => String(row.tablename));
}
async function history(db: DrizzleDb, names: string[], upgraded = false) {
  const result = [];
  for (const name of names) {
    const row = name === "product_releases" && upgraded
      ? sql`to_jsonb(history)-'publication_generation'-'root_release_id'-'retry_of_release_id'-'retry_authorization_event_id'`
      : sql`to_jsonb(history)`;
    result.push({ table: name, rows: await query(db, sql`SELECT ${row} AS row FROM ${sql.identifier("public")}.${sql.identifier(name)} history ORDER BY (${row})::text`) });
  }
  return result;
}

it("upgrades nonempty 0042 publication, receipt, health and event history without rewriting old JSON or H7 functions, then replays", async () => {
  await withDatabase(async client => {
    const before = await loadMigrationStatements("0042_goal_imported_validations.sql"), after = await loadMigrationStatements("0043_product_release_retries.sql");
    expect(after.slice(0, before.length)).toEqual(before); expect(after.length).toBeGreaterThan(before.length);
    await client.migrate(before); const ids = await seed(client, now), db = client.db;
    const published = await releaseGraph(db, ids, "legacy_published"), failed = await releaseGraph(db, ids, "legacy_failed");
    await releaseGraph(db, ids, "legacy_queued");
    const publishedReceipt = receiptFor(published.request, "published"), failedReceipt = receiptFor(failed.request, "failed");
    await complete(db, published, publishedReceipt); await complete(db, failed, failedReceipt);
    const healthPayload = { version: 1, event_id: "legacy_health_event", sequence: 1, request: published.request,
      release_profile_digest: digest, artifact_digest: digest, state: "healthy", active_release_id: published.releaseId,
      active_artifact_digest: digest, consecutive_failures: 0, health_checks: health(), recovery_checks: [], checked_at: now };
    await event(db, ids, { id: "legacy_health_event", type: "product.release.health", actor: ids.computerId,
      goal: published.goalId, run: published.runId, correlation: published.releaseId, payload: healthPayload });
    await db.execute(sql`INSERT INTO product_release_health_reports (event_id,organization_id,release_id,computer_id,version,sequence,payload,received_at)
      VALUES ('legacy_health_event',${ids.organizationId},${published.releaseId},${ids.computerId},1,1,${json(healthPayload)},${now})`);
    const oldTables = await tables(db), oldRows = await history(db, oldTables), definition = await h7Definition(db);
    const jsonBefore = await query(db, sql`SELECT id,request::text AS request,receipt::text AS receipt FROM product_releases ORDER BY id`);
    const journal = await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    for (const name of ["product_releases", "product_release_health_reports", "event_log", "runs", "goals"])
      expect(oldRows.find(item => item.table === name)?.rows.length).toBeGreaterThan(0);
    expect(definition.functions.map(item => item.proname)).toEqual(h7Functions);
    expect(definition.tables.map(item => item.relname)).toEqual(h7Tables);
    expect(definition.triggers).toHaveLength(h7Tables.length);
    await client.migrate(after);
    expect(await history(db, oldTables, true)).toEqual(oldRows);
    expect(await query(db, sql`SELECT id,request::text AS request,receipt::text AS receipt FROM product_releases ORDER BY id`)).toEqual(jsonBefore);
    expect(await h7Definition(db)).toEqual(definition);
    expect((await tables(db)).filter(name => !oldTables.includes(name))).toEqual(["product_release_retry_sources"]);
    expect(await query(db, sql`SELECT * FROM product_release_retry_sources`)).toEqual([]);
    const lineage = await query(db, sql`SELECT publication_generation,root_release_id,retry_of_release_id,retry_authorization_event_id FROM product_releases`);
    expect(lineage).toHaveLength(3); expect(lineage.every(row => row.publication_generation === 0 && row.root_release_id === null
      && row.retry_of_release_id === null && row.retry_authorization_event_id === null)).toBe(true);
    expect(await query(db, sql`SELECT conname FROM pg_constraint WHERE conname='goal_imported_validation_publication_goal_uniq'`)).toEqual([]);
    const replacement = await query(db, sql`SELECT indisunique,pg_get_indexdef(indexrelid) AS definition FROM pg_index
      WHERE indexrelid='goal_imported_validation_publication_goal_idx'::regclass`);
    expect(replacement).toHaveLength(1); expect(replacement[0]!.indisunique).toBe(false);
    expect(replacement[0]!.definition).toContain("(organization_id, goal_id)");
    const upgradedJournal = await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    expect(upgradedJournal).toHaveLength(after.length); expect(upgradedJournal.slice(0, journal.length)).toEqual(journal);
    const allTables = await tables(db), allRows = await history(db, allTables);
    await client.migrate(after);
    expect(await history(db, allTables)).toEqual(allRows); expect(await h7Definition(db)).toEqual(definition);
    expect(await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).toEqual(upgradedJournal);
  });
}, 120000);

it("matches Domain canonical release JSON for safe scalars, nested arrays and Unicode values, and rejects unsupported domains", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client), f = await releaseGraph(client.db, ids, "canonical");
    const samples = ['null', 'true', 'false', '0', '-0', '1.0', '1e1', '-9007199254740991', '9007199254740991',
      '"中文 \\ud83d\\ude80"', JSON.stringify("\b\f\n\r\t\u0001\"\\/"),
      '{"z":[1.0,null,{"b":"中文 🚀","a":"\\u2028\\u2029"}],"a":true}',
      JSON.stringify(f.request), JSON.stringify(receiptFor(f.request, "failed", sourceProjection(f.releaseId)))];
    for (const raw of samples) {
      const value: unknown = JSON.parse(raw), expected = canonicalReleaseJson(value);
      const rows = await query(client.db, sql`SELECT artoo_release_retry_json_v1(${raw}::jsonb) AS canonical,
        artoo_release_retry_digest_v1(${raw}::jsonb) AS digest`);
      expect(rows).toEqual([{ canonical: expected, digest: hash(value) }]);
    }
    for (const raw of ['1.25', '1e-7', '9007199254740992', '-9007199254740992', '{"中文":1}', '{"\\ud83d\\ude80":1}'])
      await rejection(query(client.db, sql`SELECT artoo_release_retry_digest_v1(${raw}::jsonb)`), /safe integer|ASCII object keys/);
  });
}, 120000);

it("commits one successor with unchanged final evidence, blocks a fork and publishes without rewriting predecessor history", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const f = await settledFailure(client.db, ids, "one_retry", 2), original = await releaseRows(client.db);
    const attempts = await query(client.db, sql`SELECT * FROM runs ORDER BY id`), next = nextAttempt(f, f.receipt);
    const duplicateInitial = { ...f.request, release_id: "duplicate_initial" };
    await rejection(client.db.execute(sql`INSERT INTO product_releases
      (id,organization_id,goal_id,project_id,computer_id,run_id,evidence_id,status,request,created_at,updated_at)
      VALUES ('duplicate_initial',${ids.organizationId},${f.goalId},${ids.projectId},${ids.computerId},${f.runId},${f.evidenceId},
        'queued',${json(duplicateInitial)},${later},${later})`), /product_releases_goal_generation_uniq/);
    await client.transaction(tx => queue(tx, f, next));
    const both = await releaseRows(client.db); expect(both).toHaveLength(2); expect(both.find(row => row.id === f.releaseId)).toEqual(original[0]);
    expect(both.find(row => row.id === next.id)).toMatchObject({ status: "queued", request: next.request, receipt: null,
      publication_generation: 1, root_release_id: f.releaseId, retry_of_release_id: f.releaseId, retry_authorization_event_id: next.authorizationId });
    const fork = nextAttempt(f, f.receipt, "forbidden_fork", 2);
    await rejection(client.transaction(tx => queue(tx, f, fork)), /Publication retry differs/);
    expect(await query(client.db, sql`SELECT retry_count FROM goals WHERE id=${f.goalId}`)).toEqual([{ retry_count: 1 }]);
    expect(await query(client.db, sql`SELECT id FROM event_log WHERE type='product.release.retry-authorized'`)).toEqual([{ id: next.authorizationId }]);
    const receipt = receiptFor(next.request, "published"); await complete(client.db, f, receipt);
    expect((await releaseRows(client.db)).find(row => row.id === f.releaseId)).toEqual(original[0]);
    expect((await releaseRows(client.db)).find(row => row.id === next.id)).toMatchObject({ status: "published", receipt });
    expect(await query(client.db, sql`SELECT * FROM runs ORDER BY id`)).toEqual(attempts);
    const beforeReplay = await releaseRows(client.db);
    await rejection(client.db.execute(sql`UPDATE product_releases SET receipt=${json({ ...f.receipt, reason: "changed after successor commit" })}
      WHERE id=${f.releaseId}`), /cannot be rewritten/);
    expect(await releaseRows(client.db)).toEqual(beforeReplay);
    await client.db.execute(sql`UPDATE product_releases SET receipt=${json(f.receipt)},status='failed' WHERE id=${f.releaseId}`);
    expect(await releaseRows(client.db)).toEqual(beforeReplay);
  });
}, 120000);

it("rejects changed source, digest, session, goal, node, profile and generation without spending a retry", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const f = await settledFailure(client.db, ids, "boundaries"), other = await releaseGraph(client.db, ids, "other_goal");
    const original = await releaseRows(client.db);
    const changes: Array<[string, (next: Attempt) => void]> = [
      ["source", next => { next.request.retry!.source_id = "wrong-source"; next.payload.source_id = "wrong-source"; }],
      ["request digest", next => { next.request.retry!.previous_request_digest = otherDigest; next.payload.previous_request_digest = otherDigest; }],
      ["receipt digest", next => { next.request.retry!.previous_receipt_digest = otherDigest; next.payload.previous_receipt_digest = otherDigest; }],
      ["session", next => { next.payload.session.sessionId = "replacement-session"; }],
      ["goal", next => { next.goalId = other.goalId; next.request.goal_id = other.goalId; next.request.retry!.authorization.goal_id = other.goalId; }],
      ["node", next => { next.computerId = "different-computer"; }],
      ["profile", next => { next.request.release_profile_id = "changed-profile"; }],
      ["subject", next => { next.request.subject_digest = otherDigest; }],
      ["generation", next => { next.generation = 2; next.request.retry!.generation = 2; next.payload.generation = 2; }],
      ["root", next => { next.rootId = other.releaseId; next.request.retry!.root_release_id = other.releaseId; next.payload.root_release_id = other.releaseId; }],
      ["actor", next => { next.request.retry!.authorization.actor_user_id = "another-user"; next.payload.actor_user_id = "another-user"; }],
    ];
    for (const [name, change] of changes) {
      const next = nextAttempt(f, f.receipt, `rejected_${name.replaceAll(" ", "_")}`); change(next);
      await rejection(client.transaction(tx => queue(tx, f, next)), /Publication retry differs/);
      expect(await releaseRows(client.db), name).toEqual(original);
      expect(await query(client.db, sql`SELECT retry_count FROM goals WHERE id=${f.goalId}`), name).toEqual([{ retry_count: 0 }]);
    }
    expect(await query(client.db, sql`SELECT id FROM event_log WHERE type='product.release.retry-authorized'`)).toEqual([]);
  });
}, 120000);

it("rejects exhausted budgets, paused goals and revoked paired credentials while leaving the original attempt intact", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const f = await settledFailure(client.db, ids, "budget", 1), original = await releaseRows(client.db);
    await rejection(client.transaction(tx => queue(tx, f, nextAttempt(f, f.receipt, "over_budget", 2))), /Publication retry differs/);
    for (const mutation of [sql`UPDATE goals SET status='paused' WHERE id=${f.goalId}`,
      sql`UPDATE devices SET trust='revoked',revoked_at=${later} WHERE id=${deviceId}`,
      sql`UPDATE device_tokens SET expires_at=${now} WHERE token_lookup=${tokenLookup}`]) {
      await rejection(client.transaction(async tx => { await tx.execute(mutation); await queue(tx, f, nextAttempt(f, f.receipt)); }), /Publication retry differs/);
      expect(await releaseRows(client.db)).toEqual(original);
    }
    expect(await query(client.db, sql`SELECT retry_count,status FROM goals WHERE id=${f.goalId}`)).toEqual([{ retry_count: 0, status: "running" }]);
  });
}, 120000);

it("admits only an exact paired terminal source and keeps legacy receipts without a source ineligible", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const legacy = await releaseGraph(client.db, ids, "no_source"), oldReceipt = receiptFor(legacy.request, "failed");
    await complete(client.db, legacy, oldReceipt);
    await rejection(client.transaction(tx => queue(tx, legacy, nextAttempt(legacy, oldReceipt))), /Publication retry differs/);
    const f = await releaseGraph(client.db, ids, "source_admission"), receipt = receiptFor(f.request, "failed", sourceProjection(f.releaseId));
    const receiptEventId = await complete(client.db, f, receipt);
    // Receipt provenance still records after a pause; only a new retry requires a running goal.
    await client.db.execute(sql`UPDATE goals SET status='paused' WHERE id=${f.goalId}`);
    for (const changes of [{ requestDigest: otherDigest }, { receiptDigest: otherDigest }, { sourceId: "another-source" },
      { computerId: "another-computer" }, { eventId: `completed_${legacy.releaseId}` },
      { projection: { ...receipt.retry_source!, closure: "unconfirmed" } }]) {
      await rejection(insertSource(client.db, f, receipt, receiptEventId, changes), /Publication retry source lacks/);
      expect(await query(client.db, sql`SELECT * FROM product_release_retry_sources`)).toEqual([]);
    }
    await insertSource(client.db, f, receipt, receiptEventId);
    expect(await query(client.db, sql`SELECT release_id,request_digest,receipt_digest,projection FROM product_release_retry_sources`))
      .toEqual([{ release_id: f.releaseId, request_digest: hash(receipt.request), receipt_digest: hash(receipt), projection: receipt.retry_source }]);
  });
}, 120000);

it("protects committed request, receipt, status, source and lineage from update or delete", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const f = await settledFailure(client.db, ids, "immutable"), before = await releaseRows(client.db);
    for (const statement of [sql`UPDATE product_releases SET receipt=${json({ ...f.receipt, reason: "rewritten" })} WHERE id=${f.releaseId}`,
      sql`UPDATE product_releases SET status='queued',receipt=NULL WHERE id=${f.releaseId}`,
      sql`UPDATE product_releases SET request=${json({ ...f.request, subject_digest: otherDigest })} WHERE id=${f.releaseId}`,
      sql`UPDATE product_releases SET publication_generation=1 WHERE id=${f.releaseId}`,
      sql`DELETE FROM product_releases WHERE id=${f.releaseId}`]) {
      await rejection(client.db.execute(statement), /immutable|cannot be rewritten/); expect(await releaseRows(client.db)).toEqual(before);
    }
    const source = await query(client.db, sql`SELECT * FROM product_release_retry_sources`);
    for (const statement of [sql`UPDATE product_release_retry_sources SET session_id='changed' WHERE release_id=${f.releaseId}`,
      sql`DELETE FROM product_release_retry_sources WHERE release_id=${f.releaseId}`]) {
      await rejection(client.db.execute(statement), /retry sources are immutable/);
      expect(await query(client.db, sql`SELECT * FROM product_release_retry_sources`)).toEqual(source);
    }
  });
}, 120000);

it("requires a real matching restored publication and its historical recovery content before recording a retry source", async () => {
  await withDatabase(async client => {
    const ids = await upgraded(client); await paired(client.db, ids);
    const published = await releaseGraph(client.db, ids, "restored_original"), publishedReceipt = receiptFor(published.request, "published");
    await complete(client.db, published, publishedReceipt);
    for (const [name, activeId, activeDigest, bodyDigest] of [
      ["missing", "nonexistent-release", digest, digest], ["artifact", published.releaseId, otherDigest, digest],
      ["content", published.releaseId, digest, otherDigest], ["valid", published.releaseId, digest, digest],
      ["valid_null", published.releaseId, digest, digest],
    ] as const) {
      const f = await releaseGraph(client.db, ids, `restore_${name}`);
      const receipt = ProductReleaseReceiptSchema.parse({ ...receiptFor(f.request, "rolled_back"), endpoint: name === "valid_null" ? null : endpoint, previous_release_id: activeId,
        recovery_checks: health().map(check => ({ ...check, body_digest: bodyDigest })),
        retry_source: { version: 1, source_id: `restore_${name}`, closure: "local-release-settled.v1",
          recovery: { kind: "previous-restored", active_release_id: activeId, active_artifact_digest: activeDigest } } });
      const receiptEventId = await complete(client.db, f, receipt);
      if (name.startsWith("valid")) await insertSource(client.db, f, receipt, receiptEventId);
      else await rejection(insertSource(client.db, f, receipt, receiptEventId), /[Rr]estor|[Pp]revious|[Rr]ecovery/);
    }
    expect(await query(client.db, sql`SELECT source_id FROM product_release_retry_sources ORDER BY source_id`))
      .toEqual([{ source_id: "restore_valid" }, { source_id: "restore_valid_null" }]);
  });
}, 120000);

it("upgrades the actual legacy release status constraint through H9 without rewriting publication history", async () => {
  await withDatabase(async client => {
    const before = await loadMigrationStatements("0044_goal_source_recovery.sql");
    const after = await loadMigrationStatements("0046_product_recovery_publication_retry.sql");
    expect(after.slice(0, before.length)).toEqual(before);
    await client.migrate(before); const ids = await seed(client, now), db = client.db;
    const queued = await releaseGraph(db, ids, "h9_status_queued");
    for (const outcome of ["published", "failed"] as const) {
      const existing = await releaseGraph(db, ids, `h9_status_${outcome}`);
      await complete(db, existing, receiptFor(existing.request, outcome));
    }
    const statusConstraints = () => query(db, sql`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid='product_releases'::regclass AND contype='c'
        AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='product_releases'::regclass AND attname='status')]
      ORDER BY conname`);
    const legacy = await statusConstraints();
    expect(legacy).toHaveLength(1); expect(legacy[0]!.conname).toBe("product_releases_status_check");
    expect(String(legacy[0]!.definition)).not.toContain("interrupted");
    const rows = await releaseRows(db), journal = await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    expect(rows.map(row => row.status).sort()).toEqual(["failed", "published", "queued"]);
    await client.migrate(after);
    expect(await releaseRows(db)).toEqual(rows);
    const current = await statusConstraints();
    expect(current).toHaveLength(1); expect(current[0]!.conname).toBe("product_releases_status_chk");
    for (const status of ["queued", "published", "rolled_back", "failed", "interrupted"])
      expect(String(current[0]!.definition)).toContain(`'${status}'::text`);
    expect(await query(db, sql`SELECT conname FROM pg_constraint
      WHERE conrelid='product_releases'::regclass AND conname='product_releases_status_check'`)).toEqual([]);
    // Extending the status domain does not grant interruption without its real recovery lineage.
    await rejection(db.execute(sql`UPDATE product_releases SET status='interrupted' WHERE id=${queued.releaseId}`),
      /Publication interruption requires exact complete recovery closure/);
    expect(await releaseRows(db)).toEqual(rows);
    const upgradedJournal = await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    expect(upgradedJournal).toHaveLength(after.length); expect(upgradedJournal.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after);
    expect(await releaseRows(db)).toEqual(rows);
    expect(await statusConstraints()).toEqual(current);
    expect(await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).toEqual(upgradedJournal);
  });
}, 120000);

it("refuses an H9 upgrade with a missing legacy release status constraint and rolls back its DDL and journal", async () => {
  await withDatabase(async client => {
    const before = await loadMigrationStatements("0044_goal_source_recovery.sql");
    const after = await loadMigrationStatements("0046_product_recovery_publication_retry.sql");
    await client.migrate(before); const ids = await seed(client, now), db = client.db;
    await releaseGraph(db, ids, "h9_status_schema_drift");
    // Deliberate database drift: the migration must not silently skip an absent guard.
    await db.execute(sql`ALTER TABLE product_releases DROP CONSTRAINT product_releases_status_check`);
    const columns = () => query(db, sql`SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='product_releases' ORDER BY ordinal_position`);
    const originalColumns = await columns(), rows = await releaseRows(db);
    const journal = await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`);
    await rejection(client.migrate(after), /constraint "product_releases_status_check" of relation "product_releases" does not exist/);
    expect(await columns()).toEqual(originalColumns);
    expect(await releaseRows(db)).toEqual(rows);
    expect(await query(db, sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).toEqual(journal);
    expect(await query(db, sql`SELECT conname FROM pg_constraint
      WHERE conrelid='product_releases'::regclass AND conname IN ('product_releases_status_chk','product_releases_recovery_predecessor_uniq')`)).toEqual([]);
  });
}, 120000);
