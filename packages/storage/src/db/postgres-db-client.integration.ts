import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DbClient, DrizzleDb } from "./db-client.js";
import { PostgresDbClient, type PostgresDbClientOptions } from "./postgres-db-client.js";

const configuredUrl = process.env.ARTOO_POSTGRES_TEST_ADMIN_URL;
if (configuredUrl === undefined || process.env.ARTOO_POSTGRES_TEST_ISOLATED !== "1") {
  throw new Error(
    "This integration suite requires ARTOO_POSTGRES_TEST_ADMIN_URL and ARTOO_POSTGRES_TEST_ISOLATED=1 for a private local PostgreSQL cluster",
  );
}
const adminUrl = new URL(configuredUrl);
if (
  !["postgres:", "postgresql:"].includes(adminUrl.protocol) ||
  !["127.0.0.1", "[::1]", "localhost"].includes(adminUrl.hostname) ||
  adminUrl.port === "6543" ||
  adminUrl.search
) {
  throw new Error("Integration tests require a direct loopback PostgreSQL URL without query parameters");
}

const marker = `artoo-postgres-adapter-test:${randomUUID()}`;
const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: false, connectionTimeoutMillis: 3000 });
const initial = "CREATE TABLE adapter_test (id text PRIMARY KEY, n integer NOT NULL DEFAULT 0)";
const createdRoles: string[] = [];
let databaseName: string;
let databaseUrl: string;
let observer: pg.Client | undefined;
let clients: PostgresDbClient[] = [];
let independentTestPools: pg.Pool[] = [];
type TestDbPort = Pick<DbClient, "db" | "transaction">;

/**
 * One real controller still owns the production session lock. These explicitly
 * test-only backends contend on its private, marked fixture database so SQL
 * mutex/row-lock tests cannot pass merely due to the adapter's single-session
 * transaction queue. They do not establish multi-controller product support.
 */
async function openIndependentTestPort(): Promise<TestDbPort> {
  const ownership = await admin.query<{ marker: string }>(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  if (ownership.rows[0]?.marker !== marker || !/^artoo_adapter_\d+_[a-f0-9]{32}$/.test(databaseName))
    throw new Error("Independent test connection requires this run's owned database");
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    query_timeout: 11000,
  });
  independentTestPools.push(pool);
  const db = drizzle(pool) as unknown as DrizzleDb;
  return { db, transaction: (fn) => db.transaction(fn) };
}

async function open(options: Partial<Omit<PostgresDbClientOptions, "connectionString">> = {}) {
  const client = await PostgresDbClient.create({
    connectionString: databaseUrl,
    allowInsecureLocalhost: true,
    connectionTimeoutMillis: 3000,
    queryTimeoutMillis: 5000,
    ...options,
  });
  clients.push(client);
  return client;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type ShadowBinding = Record<string, unknown> & { epoch: number; task_id: string; attempt_id: string };
type ShadowResult = {
  kind: string;
  binding?: ShadowBinding;
  snapshot?: object;
  ranking?: { decisions: { reasons: string[] }[] };
};
type ShadowService = {
  claimSchedulerShadow(ctx: object, input: object): Promise<ShadowResult>;
  startSchedulerShadow(ctx: object, binding: object): Promise<ShadowResult>;
  renewSchedulerShadow(ctx: object, binding: object): Promise<ShadowResult>;
  finishSchedulerShadow(ctx: object, binding: object): Promise<ShadowResult>;
  cancelSchedulerShadow(ctx: object, binding: object): Promise<ShadowResult>;
};

async function shadowFixture() {
  const schema = (await import(new URL("../../../db/dist/index.js", import.meta.url).href)) as {
    loadMigrationStatements(): Promise<string[]>;
    seed(client: PostgresDbClient, now: string): Promise<unknown>;
  };
  const service = (await import(
    new URL("../../../../apps/server/dist/services/scheduler-shadow-lease-service.js", import.meta.url).href
  )) as ShadowService;
  const first = await open({ queryTimeoutMillis: 10000 });
  await first.migrate(await schema.loadMigrationStatements());
  const second = await openIndependentTestPort();
  let now = "2026-06-13T00:00:00.000Z";
  await schema.seed(first, now);
  const context = (db: TestDbPort) => ({
    db,
    organizationId: "org_default",
    actorUserId: "user_owner",
    clock: { now: () => new Date(now), nowIso: () => now },
    schedulerRollout: { version: 1, workspaces: { org_default: { flags: { claim_shadow: true } } } },
  });
  await observer!.query(
    `INSERT INTO scheduler_project_policies VALUES ('proj_artoo','org_default',$1::jsonb,'user_owner',$2)`,
    [JSON.stringify({ version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }), now],
  );
  await observer!.query(
    `INSERT INTO scheduler_agent_policies VALUES ('agent_mock_coder','org_default',$1::jsonb,'user_owner',$2)`,
    [
      JSON.stringify({
        version: 1,
        pinned_computer_id: "computer_local_mock",
        max_concurrent_runs: 2,
        required_runtimes: ["mock"],
        required_labels: ["test"],
      }),
      now,
    ],
  );
  await observer!.query(
    `INSERT INTO scheduler_computer_policies VALUES ('computer_local_mock','org_default',$1::jsonb,'user_owner',$2)`,
    [JSON.stringify({ version: 1, max_concurrent_runs: 2, labels: ["test"] }), now],
  );
  await observer!.query(
    `INSERT INTO tasks (id,organization_id,project_id,title,status,created_by_type,created_by_id,created_at,updated_at)
    SELECT id,'org_default','proj_artoo',id,'ready','user','user_owner',$1,$1 FROM unnest(ARRAY['task_pg_a','task_pg_b']) AS id`,
    [now],
  );
  const claim = (db: TestDbPort, taskId: string) =>
    service.claimSchedulerShadow(context(db), {
      projectId: "proj_artoo",
      taskId,
      options: { mode: "auto", branchBacked: false },
    });
  return {
    service,
    first,
    second,
    context,
    claim,
    setTime: (value: string) => {
      now = value;
    },
  };
}

async function terminateOwnedBackend(pid: number): Promise<void> {
  const current = await admin.query<{ datname: string }>("SELECT datname FROM pg_stat_activity WHERE pid = $1", [pid]);
  expect(current.rows).toEqual([{ datname: databaseName }]);
  await admin.query("SELECT pg_terminate_backend($1)", [pid]);
}

beforeAll(async () => {
  await admin.connect();
  // These NOLOGIN roles exercise Supabase's effective schema privileges. Only
  // missing roles are created; existing roles are never altered or dropped.
  for (const role of ["anon", "authenticated"]) {
    const existing = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
      await admin.query(`COMMENT ON ROLE "${role}" IS '${marker}'`);
      createdRoles.push(role);
    }
  }
});

beforeEach(async () => {
  clients = [];
  independentTestPools = [];
  observer = undefined;
  databaseName = `artoo_adapter_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  observer = new pg.Client({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 3000 });
  await observer.connect();
  await observer!.query(
    "REVOKE ALL ON SCHEMA public FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM anon, authenticated",
  );
});

afterEach(async () => {
  const closed = await Promise.allSettled([
    ...clients.map((client) => client.close()),
    ...independentTestPools.map((pool) => pool.end()),
    observer?.end(),
  ]);
  const ownership = await admin.query<{ marker: string }>(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
    [databaseName],
  );
  if (ownership.rows[0]?.marker !== marker || !/^artoo_adapter_\d+_[a-f0-9]{32}$/.test(databaseName)) {
    throw new Error("Test database ownership changed; retaining it instead of deleting it");
  }
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Adapter cleanup failed",
    );
});

afterAll(async () => {
  try {
    for (const role of createdRoles) {
      const ownership = await admin.query<{ marker: string }>(
        "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1",
        [role],
      );
      if (ownership.rows[0]?.marker !== marker) throw new Error("Test role ownership changed; retaining it");
      await admin.query(`DROP ROLE "${role}"`);
    }
  } finally {
    await admin.end();
  }
});

describe("PostgresDbClient with a real PostgreSQL server", () => {
  it("reads persisted versioned queue timing from the shadow claim transaction on actual PostgreSQL", async () => {
    const f = await shadowFixture();
    const now = Date.parse("2026-06-13T00:00:00Z");
    await observer!.query(
      `INSERT INTO scheduler_task_queue_metadata
      (task_id,organization_id,project_id,version,revision,not_before_ms,preferred_computer_id,prefer_until_ms,updated_by_user_id,updated_at)
      VALUES ('task_pg_a','org_default','proj_artoo',1,1,$1,'computer_local_mock',$2,'user_owner',$3)`,
      [now + 1, now + 2000, "2026-06-13T00:00:00Z"],
    );
    const early = await f.claim(f.second, "task_pg_a");
    expect(early.kind).toBe("ineligible");
    expect(early.ranking?.decisions[0]?.reasons).toContain("not_before");
    expect(early.snapshot).toMatchObject({
      not_before_ms: now + 1,
      preferred_computer_id: "computer_local_mock",
      prefer_until_ms: now + 2000,
      queue_metadata: { version: 1, task_id: "task_pg_a", source: "persisted", revision: 1 },
    });
    f.setTime("2026-06-13T00:00:00.001Z");
    expect((await f.claim(f.first, "task_pg_a")).kind).toBe("claimed");
    expect((await observer!.query("SELECT * FROM runs")).rows).toEqual([]);
    expect((await observer!.query("SELECT revision::int FROM scheduler_task_queue_metadata")).rows).toEqual([
      { revision: 1 },
    ]);
  });
  it("serializes shadow-only claims across independent connections and enforces each capacity level", async () => {
    const f = await shadowFixture();
    const pidA = (await f.first.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    const pidB = (await f.second.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    expect(pidA).not.toBe(pidB);
    await observer!.query("BEGIN");
    try {
      await observer!.query("SELECT pg_advisory_xact_lock(1095914312, hashtext('org_default'))");
      expect((await f.claim(f.first, "task_pg_a")).kind).toBe("busy");
      expect((await observer!.query("SELECT * FROM scheduler_shadow_attempts")).rows).toEqual([]);
    } finally {
      await observer!.query("ROLLBACK");
    }
    await observer!.query("BEGIN");
    try {
      await observer!.query("SELECT id FROM tasks WHERE id='task_pg_a' FOR UPDATE");
      expect((await f.claim(f.first, "task_pg_a")).kind).toBe("task_unavailable");
    } finally {
      await observer!.query("ROLLBACK");
    }
    const same = await Promise.all([f.claim(f.first, "task_pg_a"), f.claim(f.second, "task_pg_a")]);
    expect(same.filter((result) => result.kind === "claimed")).toHaveLength(1);
    expect((await f.claim(f.second, "task_pg_a")).kind).toBe("already_claimed");
    await f.service.cancelSchedulerShadow(f.context(f.first), same.find((result) => result.binding)!.binding!);
    for (const kind of ["project", "agent", "computer"] as const) {
      // Only fixed table identifiers are interpolated; data remains parameterized.
      const table = `scheduler_${kind}_policies`;
      await observer!.query(`UPDATE ${table} SET policy = jsonb_set(policy,'{max_concurrent_runs}','1')`);
      const values = await Promise.all([f.claim(f.first, "task_pg_a"), f.claim(f.second, "task_pg_b")]);
      expect(values.filter((result) => result.kind === "claimed")).toHaveLength(1);
      const winner = values.find((result) => result.binding)!.binding!;
      const loser = winner.task_id === "task_pg_a" ? "task_pg_b" : "task_pg_a";
      const rejected = await f.claim(f.second, loser);
      expect(rejected.kind).toBe("ineligible");
      expect(rejected.ranking?.decisions[0]?.reasons).toContain(`${kind}_capacity`);
      expect((await f.service.cancelSchedulerShadow(f.context(f.first), winner)).kind).toBe("updated");
      await observer!.query(`UPDATE ${table} SET policy = jsonb_set(policy,'{max_concurrent_runs}','2')`);
    }
    expect((await observer!.query("SELECT status FROM tasks ORDER BY id")).rows).toEqual([
      { status: "ready" },
      { status: "ready" },
    ]);
    for (const table of ["runs", "file_leases", "scheduler_task_projections"])
      expect((await observer!.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  });
  it("fences expired shadow owners at PostgreSQL microsecond precision without settling real executions", async () => {
    const f = await shadowFixture();
    const initial = await f.claim(f.first, "task_pg_a"),
      binding = initial.binding!;
    expect(initial.kind).toBe("claimed");
    await observer!.query("UPDATE scheduler_shadow_attempts SET expires_at = claimed_at + interval '0.0005 seconds'");
    expect((await f.service.startSchedulerShadow(f.context(f.second), binding)).kind).toBe("updated");
    f.setTime("2026-06-13T00:00:00.001Z");
    expect((await f.service.renewSchedulerShadow(f.context(f.first), binding)).kind).toBe("stale");
    const current = await f.claim(f.second, "task_pg_a");
    expect(current.kind).toBe("claimed");
    expect(current.binding?.epoch).toBe(binding.epoch + 1);
    for (const method of [
      "startSchedulerShadow",
      "renewSchedulerShadow",
      "finishSchedulerShadow",
      "cancelSchedulerShadow",
    ] as const) {
      expect((await f.service[method](f.context(f.first), binding)).kind).toBe("stale");
      expect((await f.service[method](f.context(f.first), { ...current.binding, computer_id: "foreign" })).kind).toBe(
        "stale",
      );
    }
    expect(
      (
        await observer!.query(
          "SELECT epoch::int, state, execution_authorized FROM scheduler_shadow_attempts ORDER BY epoch",
        )
      ).rows,
    ).toEqual([
      { epoch: 1, state: "expired", execution_authorized: false },
      { epoch: 2, state: "claimed", execution_authorized: false },
    ]);
    expect((await observer!.query("SELECT * FROM runs")).rows).toEqual([]);
    expect((await observer!.query("SELECT * FROM file_leases")).rows).toEqual([]);
    expect((await observer!.query("SELECT * FROM scheduler_task_projections")).rows).toEqual([]);
  });
  it("serializes independent task enqueue transactions without losing source comments or replay identities", async () => {
    // Built production services exercise PostgreSQL's real row/unique locks,
    // rather than PGlite's process-local transaction serialization.
    const schema = (await import(new URL("../../../db/dist/index.js", import.meta.url).href)) as {
      loadMigrationStatements(): Promise<string[]>;
      seed(client: PostgresDbClient, now: string): Promise<unknown>;
    };
    const service = (await import(
      new URL("../../../../apps/server/dist/services/task-service.js", import.meta.url).href
    )) as {
      createTask(ctx: object, request: object): Promise<{ task: { id: string }; room: { id: string } }>;
    };
    const client = await open({ queryTimeoutMillis: 10000 });
    await client.migrate(await schema.loadMigrationStatements());
    const now = new Date().toISOString();
    await schema.seed(client, now);
    const ctx = {
      db: client,
      organizationId: "org_default",
      actorUserId: "user_owner",
      clock: { now: () => new Date(now), nowIso: () => now },
      idGen: { generate: (prefix: string) => `${prefix}_${randomUUID()}` },
      schedulerRollout: {
        version: 1,
        workspaces: { org_default: { flags: { unified_enqueue: true, task_mirror: true } } },
      },
    };
    const contexts = [
      ctx,
      { ...ctx, db: await openIndependentTestPort() },
      { ...ctx, db: await openIndependentTestPort() },
    ];
    const backendIds = await Promise.all(
      contexts.map(async (context) => (await context.db.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid),
    );
    expect(new Set(backendIds).size).toBe(3);
    const request = (event: string, description = "Preserve all accepted requirements") => ({
      project_id: "proj_artoo",
      title: "Concurrent issue",
      description,
      priority: "p2",
      acceptance_criteria: ["All cases pass"],
      required_capabilities: [],
      enqueue_source: {
        version: 1,
        kind: "issue",
        key: "repo/issue/1",
        event_id: event,
        target_key: "default",
        comment: event,
      },
    });
    const results = await Promise.all(
      ["first", "second", "third"].map((event, index) => service.createTask(contexts[index]!, request(event))),
    );
    expect(new Set(results.map((result) => result.task.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.room.id)).size).toBe(1);
    const taskId = results[0]!.task.id;
    expect((await observer!.query("SELECT count(*)::int AS n FROM tasks")).rows).toEqual([{ n: 1 }]);
    expect((await observer!.query("SELECT count(*)::int AS n FROM rooms WHERE type='task'")).rows).toEqual([{ n: 1 }]);
    expect((await observer!.query("SELECT body FROM messages WHERE task_id=$1 ORDER BY body", [taskId])).rows).toEqual([
      { body: "first" },
      { body: "second" },
      { body: "third" },
    ]);
    const retries = await Promise.all(contexts.map((context) => service.createTask(context, request("second"))));
    expect(retries.every((result) => result.task.id === taskId)).toBe(true);
    expect((await observer!.query("SELECT count(*)::int AS n FROM task_enqueue_events")).rows).toEqual([{ n: 3 }]);
    const conflicts = await Promise.allSettled(
      ["one", "two"].map((event, index) =>
        service.createTask(contexts[index]!, request(event, "Incompatible changed intent")),
      ),
    );
    expect(
      conflicts.every((result) => result.status === "rejected" && result.reason.message.includes("different intent")),
    ).toBe(true);
    await observer!.query("UPDATE tasks SET status='done' WHERE id=$1", [taskId]);
    const fresh = await Promise.all(
      ["after-1", "after-2", "after-3"].map((event, index) => service.createTask(contexts[index]!, request(event))),
    );
    expect(new Set(fresh.map((result) => result.task.id)).size).toBe(1);
    expect(fresh[0]!.task.id).not.toBe(taskId);
    expect((await service.createTask(ctx, request("first"))).task.id).toBe(taskId);
    expect((await observer!.query("SELECT count(*)::int AS n FROM tasks")).rows).toEqual([{ n: 2 }]);
  });
  it("applies the production migration history only after the actual Supabase prerequisite SQL", async () => {
    // Load the built production loader instead of introducing a db -> storage
    // -> db source dependency. This suite is explicitly run after npm run build.
    const moduleUrl = new URL("../../../db/dist/index.js", import.meta.url);
    const schema = (await import(moduleUrl.href)) as Record<string, unknown> & {
      loadMigrationStatements(): Promise<string[]>;
    };
    const statements = await schema.loadMigrationStatements();
    const client = await open();
    await observer!.query(
      "GRANT USAGE ON SCHEMA public TO PUBLIC, anon, authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage; GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated",
    );
    await expect(client.migrate(statements)).rejects.toThrow("deployment security prerequisite");
    expect((await observer!.query("SELECT to_regnamespace('artoo_meta')::text AS name")).rows).toEqual([
      { name: null },
    ]);
    const prerequisite = await readFile(
      new URL("../../../../deploy/azure/supabase-private-schema.sql", import.meta.url),
      "utf8",
    );
    await observer!.query(prerequisite);
    await client.migrate(statements);
    await client.migrate(statements);
    const expected = Object.values(schema)
      .filter((value) => is(value, PgTable))
      .map(getTableName)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    const tables = await observer!.query<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(expected);
    expect((await observer!.query("SELECT count(*)::int AS n FROM artoo_meta.migrations")).rows).toEqual([
      { n: statements.length },
    ]);
    const permissions = await observer!.query(
      "SELECT rolname, has_schema_privilege(oid, 'public', 'USAGE') AS public, has_schema_privilege(oid, 'auth', 'USAGE') AS auth, has_schema_privilege(oid, 'storage', 'USAGE') AS storage FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname",
    );
    expect(permissions.rows).toEqual([
      { rolname: "anon", public: false, auth: true, storage: true },
      { rolname: "authenticated", public: false, auth: true, storage: true },
    ]);
    expect(await client.healthCheck()).toBe(true);
  });

  it("reopens durable data and applies only appended, unchanged migrations", async () => {
    let client = await open();
    await client.migrate([initial]);
    await client.db.execute(sql`INSERT INTO adapter_test VALUES ('saved', 1)`);
    await client.close();
    client = await open();
    const history = [initial, "ALTER TABLE adapter_test ADD COLUMN note text DEFAULT 'new'"];
    await client.migrate(history);
    await client.migrate(history);
    expect((await client.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([
      { id: "saved", n: 1, note: "new" },
    ]);
    expect((await client.db.execute(sql`SELECT count(*)::int AS n FROM artoo_meta.migrations`)).rows).toEqual([
      { n: 2 },
    ]);
    expect(await client.healthCheck()).toBe(true);
  });

  it("commits and rolls back complete transactions", async () => {
    const client = await open();
    await client.migrate([initial]);
    await client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('committed', 1)`);
    });
    await expect(
      client.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO adapter_test VALUES ('aborted', 2)`);
        throw new Error("abort this transaction");
      }),
    ).rejects.toThrow("abort this transaction");
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "committed" }]);
  });

  it("preserves direct Drizzle transaction isolation, read-only mode and savepoints", async () => {
    const client = await open();
    await client.migrate([initial]);
    await client.db.transaction(
      async (tx) => {
        const result = await tx.execute(
          sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly`,
        );
        expect(result.rows).toEqual([{ isolation: "repeatable read", readonly: "on" }]);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    await expect(
      client.db.transaction(
        async (tx) => {
          await tx.execute(sql`INSERT INTO adapter_test VALUES ('read-only', 1)`);
        },
        { accessMode: "read only" },
      ),
    ).rejects.toThrow();
    await client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('outer', 1)`);
      await expect(
        tx.transaction(async (nested) => {
          await nested.execute(sql`INSERT INTO adapter_test VALUES ('inner', 1)`);
          throw new Error("rollback savepoint");
        }),
      ).rejects.toThrow("rollback savepoint");
    });
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "outer" }]);
  });

  it("keeps an independent query outside another request's transaction", async () => {
    const client = await open();
    await client.migrate([initial]);
    const entered = deferred(),
      release = deferred();
    const aborted = client
      .transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO adapter_test VALUES ('transaction', 1)`);
        entered.resolve();
        await release.promise;
        throw new Error("rollback isolated request");
      })
      .catch((error: unknown) => error);
    await entered.promise;
    const independent = Promise.resolve(client.db.execute(sql`INSERT INTO adapter_test VALUES ('independent', 2)`));
    expect(await Promise.race([independent.then(() => "settled"), delay(50).then(() => "queued")])).toBe("queued");
    release.resolve();
    expect(await aborted).toBeInstanceOf(Error);
    await independent;
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "independent" }]);
  });

  it("rejects a transaction handle retained beyond its checkout", async () => {
    const client = await open();
    await client.migrate([initial]);
    let leaked: DrizzleDb | undefined;
    await client.transaction(async (tx) => {
      leaked = tx;
      await tx.execute(sql`SELECT 1`);
    });
    await client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('new-owner', 1)`);
      await expect(leaked!.execute(sql`INSERT INTO adapter_test VALUES ('leaked', 1)`)).rejects.toThrow();
    });
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "new-owner" }]);
  });

  it("keeps the session and owner lock after recoverable autocommit SQL errors", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    await client.migrate([initial]);
    const before = (await client.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows;
    await client.db.execute(sql`INSERT INTO adapter_test VALUES ('unique', 1)`);
    await expect(client.db.execute(sql`INSERT INTO adapter_test VALUES ('unique', 2)`)).rejects.toThrow();
    await expect(client.db.execute(sql`SELECT FROM this is invalid`)).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT n FROM adapter_test`)).rows).toEqual([{ n: 1 }]);
    expect((await client.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows).toEqual(before);
    expect(await client.healthCheck()).toBe(true);
    expect(fatal).not.toHaveBeenCalled();
  });

  it("rolls DDL and journal back together after a failed migration", async () => {
    const client = await open();
    await client.migrate([initial]);
    await expect(
      client.migrate([initial, "CREATE TABLE incomplete (n integer)", "this is invalid SQL"]),
    ).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT to_regclass('public.incomplete') AS name`)).rows).toEqual([
      { name: null },
    ]);
    expect((await client.db.execute(sql`SELECT count(*)::int AS n FROM artoo_meta.migrations`)).rows).toEqual([
      { n: 1 },
    ]);
    await client.migrate([initial, "CREATE TABLE complete (n integer)"]);
  });

  it("refuses edited history and database downgrades", async () => {
    const client = await open();
    await client.migrate([initial]);
    await expect(client.migrate(["CREATE TABLE changed (n integer)"])).rejects.toThrow("Migration history changed");
    await expect(client.migrate([])).rejects.toThrow("Migration history changed");
    expect(await client.healthCheck()).toBe(true);
  });

  it("refuses an untracked public schema without adopting or changing it", async () => {
    const client = await open();
    await client.db.execute(sql`CREATE TABLE untracked (n integer)`);
    await client.db.execute(sql`INSERT INTO untracked VALUES (42)`);
    await expect(client.migrate([initial])).rejects.toThrow("untracked legacy schema");
    expect((await client.db.execute(sql`SELECT * FROM untracked`)).rows).toEqual([{ n: 42 }]);
    expect((await client.db.execute(sql`SELECT to_regnamespace('artoo_meta')::text AS name`)).rows).toEqual([
      { name: null },
    ]);
  });

  it("checks Supabase effective public-schema privileges before creating any DDL", async () => {
    const client = await open();
    for (const role of ["anon", "authenticated"]) {
      await observer!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await expect(client.migrate([initial])).rejects.toThrow("deployment security prerequisite");
      expect((await observer!.query("SELECT to_regnamespace('artoo_meta')::text AS name")).rows).toEqual([
        { name: null },
      ]);
      await observer!.query(`REVOKE USAGE ON SCHEMA public FROM "${role}"`);
    }
    await observer!.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
    await expect(client.migrate([initial])).rejects.toThrow("deployment security prerequisite");
    await observer!.query("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
    await client.migrate([initial]);
  });

  it("admits only one server until the original session closes", async () => {
    const first = await open();
    await expect(open()).rejects.toThrow("Another Artoo server owns");
    expect(await first.healthCheck()).toBe(true);
    await first.close();
    expect(await (await open()).healthCheck()).toBe(true);
  });

  it("fences an idle disconnected session instead of transparently reconnecting", async () => {
    const fatal = vi.fn();
    const first = await open({ onFatal: fatal });
    await first.migrate([initial]);
    const pid = Number((await first.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
    await terminateOwnedBackend(pid);
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(await first.healthCheck()).toBe(false);
    await expect(first.db.execute(sql`INSERT INTO adapter_test VALUES ('stale', 1)`)).rejects.toThrow();
    const next = await open();
    expect(await next.healthCheck()).toBe(true);
    expect((await next.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
    await expect(first.db.transaction(async (tx) => tx.execute(sql`SELECT 1`))).rejects.toThrow();
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("rejects active and queued work after a connection loss without replaying writes", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    await client.migrate([initial]);
    const pid = Number((await client.db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
    const active = Promise.resolve(client.db.execute(sql`SELECT pg_sleep(4)`)).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await vi.waitFor(
      async () => {
        const state = await observer!.query<{ wait_event: string }>(
          "SELECT wait_event FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        expect(state.rows[0]?.wait_event).toBe("PgSleep");
      },
      { timeout: 3000 },
    );
    const queued = Promise.resolve(client.db.execute(sql`INSERT INTO adapter_test VALUES ('queued', 1)`)).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    await terminateOwnedBackend(pid);
    expect(await active).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(fatal).toHaveBeenCalledTimes(1);
    const replacement = await open();
    expect((await replacement.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
  });

  it("closes a fenced checkout even while its transaction callback is suspended", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    await client.migrate([initial]);
    const entered = deferred(),
      resume = deferred();
    let pid: number | undefined;
    const transaction = client
      .transaction(async (tx) => {
        pid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
        await tx.execute(sql`INSERT INTO adapter_test VALUES ('uncommitted', 1)`);
        entered.resolve();
        await resume.promise;
        await tx.execute(sql`INSERT INTO adapter_test VALUES ('stale', 1)`);
      })
      .then(
        () => "unexpected success",
        (error: unknown) => error,
      );
    try {
      await entered.promise;
      await terminateOwnedBackend(pid!);
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(await Promise.race([client.close().then(() => "closed"), delay(1000).then(() => "stuck")])).toBe("closed");
      const next = await open();
      expect((await next.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
    } finally {
      resume.resolve();
    }
    expect(await transaction).toBeInstanceOf(Error);
  });

  it("fences a failed Drizzle BEGIN and closes without an abandoned checkout", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    // Exercise the real driver's pre-finally failure path, not a mock pool.
    await expect(
      client.db.transaction(async () => undefined, {
        isolationLevel: "invalid test isolation" as "serializable",
      }),
    ).rejects.toThrow();
    expect(await client.healthCheck()).toBe(false);
    expect(fatal).toHaveBeenCalledTimes(1);
    const queued = Promise.resolve(client.db.execute(sql`SELECT 1`)).then(
      () => "unexpected success",
      (error: unknown) => error,
    );
    expect(await Promise.race([client.close().then(() => "closed"), delay(1000).then(() => "stuck")])).toBe("closed");
    expect(await queued).toBeInstanceOf(Error);
    expect(await (await open()).healthCheck()).toBe(true);
  });

  it("detects a lost advisory lock through readiness and fences the old owner", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    await client.db.execute(sql`SELECT pg_advisory_unlock_all()`);
    expect(await client.healthCheck()).toBe(false);
    expect(fatal).toHaveBeenCalledTimes(1);
    await expect(client.db.execute(sql`SELECT 1`)).rejects.toThrow();
  });

  it("rolls back a server-side statement timeout without treating it as a reconnect", async () => {
    const fatal = vi.fn();
    const client = await open({ queryTimeoutMillis: 100, onFatal: fatal });
    await client.migrate([initial]);
    await expect(
      client.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO adapter_test VALUES ('timed-out', 1)`);
        await tx.execute(sql`SELECT pg_sleep(1)`);
      }),
    ).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
    expect(await client.healthCheck()).toBe(true);
    expect(fatal).not.toHaveBeenCalled();
  });

  it("does not silently downgrade the default verified TLS connection", async () => {
    // The test launcher starts a fresh local cluster without TLS certificates.
    await expect(
      PostgresDbClient.create({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 }),
    ).rejects.toThrow("PostgreSQL connection failed");
  });
});
