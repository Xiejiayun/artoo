import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DrizzleDb } from "./db-client.js";
import { PostgresDbClient, type PostgresDbClientOptions } from "./postgres-db-client.js";

const configuredUrl = process.env.ARTOO_POSTGRES_TEST_ADMIN_URL;
if (configuredUrl === undefined || process.env.ARTOO_POSTGRES_TEST_ISOLATED !== "1") {
  throw new Error("This integration suite requires ARTOO_POSTGRES_TEST_ADMIN_URL and ARTOO_POSTGRES_TEST_ISOLATED=1 for a private local PostgreSQL cluster");
}
const adminUrl = new URL(configuredUrl);
if (!["postgres:", "postgresql:"].includes(adminUrl.protocol)
  || !["127.0.0.1", "[::1]", "localhost"].includes(adminUrl.hostname) || adminUrl.port === "6543" || adminUrl.search) {
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

async function open(options: Partial<Omit<PostgresDbClientOptions, "connectionString">> = {}) {
  const client = await PostgresDbClient.create({
    connectionString: databaseUrl, allowInsecureLocalhost: true,
    connectionTimeoutMillis: 3000, queryTimeoutMillis: 5000, ...options,
  });
  clients.push(client);
  return client;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
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
  observer = undefined;
  databaseName = `artoo_adapter_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.query(`COMMENT ON DATABASE "${databaseName}" IS '${marker}'`);
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  databaseUrl = url.toString();
  observer = new pg.Client({ connectionString: databaseUrl, ssl: false, connectionTimeoutMillis: 3000 });
  await observer.connect();
  await observer!.query("REVOKE ALL ON SCHEMA public FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM anon, authenticated");
});

afterEach(async () => {
  const closed = await Promise.allSettled([...clients.map((client) => client.close()), observer?.end()]);
  const ownership = await admin.query<{ marker: string }>(
    "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1", [databaseName],
  );
  if (ownership.rows[0]?.marker !== marker || !/^artoo_adapter_\d+_[a-f0-9]{32}$/.test(databaseName)) {
    throw new Error("Test database ownership changed; retaining it instead of deleting it");
  }
  await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Adapter cleanup failed");
});

afterAll(async () => {
  try {
    for (const role of createdRoles) {
      const ownership = await admin.query<{ marker: string }>(
        "SELECT shobj_description(oid, 'pg_authid') AS marker FROM pg_roles WHERE rolname = $1", [role],
      );
      if (ownership.rows[0]?.marker !== marker) throw new Error("Test role ownership changed; retaining it");
      await admin.query(`DROP ROLE "${role}"`);
    }
  } finally { await admin.end(); }
});

describe("PostgresDbClient with a real PostgreSQL server", () => {
  it("applies the production migration history only after the actual Supabase prerequisite SQL", async () => {
    // Load the built production loader instead of introducing a db -> storage
    // -> db source dependency. This suite is explicitly run after npm run build.
    const moduleUrl = new URL("../../../db/dist/index.js", import.meta.url);
    const schema = await import(moduleUrl.href) as Record<string, unknown> & { loadMigrationStatements(): Promise<string[]> };
    const statements = await schema.loadMigrationStatements();
    const client = await open();
    await observer!.query("GRANT USAGE ON SCHEMA public TO PUBLIC, anon, authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage; GRANT USAGE ON SCHEMA auth, storage TO anon, authenticated");
    await expect(client.migrate(statements)).rejects.toThrow("deployment security prerequisite");
    expect((await observer!.query("SELECT to_regnamespace('artoo_meta')::text AS name")).rows).toEqual([{ name: null }]);
    const prerequisite = await readFile(new URL("../../../../deploy/azure/supabase-private-schema.sql", import.meta.url), "utf8");
    await observer!.query(prerequisite);
    await client.migrate(statements);
    await client.migrate(statements);
    const expected = Object.values(schema).filter((value) => is(value, PgTable)).map(getTableName).sort();
    expect(expected.length).toBeGreaterThan(0);
    const tables = await observer!.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name");
    expect(tables.rows.map((row) => row.name)).toEqual(expected);
    expect((await observer!.query("SELECT count(*)::int AS n FROM artoo_meta.migrations")).rows).toEqual([{ n: statements.length }]);
    const permissions = await observer!.query("SELECT rolname, has_schema_privilege(oid, 'public', 'USAGE') AS public, has_schema_privilege(oid, 'auth', 'USAGE') AS auth, has_schema_privilege(oid, 'storage', 'USAGE') AS storage FROM pg_roles WHERE rolname IN ('anon', 'authenticated') ORDER BY rolname");
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
    expect((await client.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([{ id: "saved", n: 1, note: "new" }]);
    expect((await client.db.execute(sql`SELECT count(*)::int AS n FROM artoo_meta.migrations`)).rows).toEqual([{ n: 2 }]);
    expect(await client.healthCheck()).toBe(true);
  });

  it("commits and rolls back complete transactions", async () => {
    const client = await open();
    await client.migrate([initial]);
    await client.transaction(async (tx) => { await tx.execute(sql`INSERT INTO adapter_test VALUES ('committed', 1)`); });
    await expect(client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('aborted', 2)`);
      throw new Error("abort this transaction");
    })).rejects.toThrow("abort this transaction");
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "committed" }]);
  });

  it("preserves direct Drizzle transaction isolation, read-only mode and savepoints", async () => {
    const client = await open();
    await client.migrate([initial]);
    await client.db.transaction(async (tx) => {
      const result = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly`);
      expect(result.rows).toEqual([{ isolation: "repeatable read", readonly: "on" }]);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await expect(client.db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('read-only', 1)`);
    }, { accessMode: "read only" })).rejects.toThrow();
    await client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('outer', 1)`);
      await expect(tx.transaction(async (nested) => {
        await nested.execute(sql`INSERT INTO adapter_test VALUES ('inner', 1)`);
        throw new Error("rollback savepoint");
      })).rejects.toThrow("rollback savepoint");
    });
    expect((await client.db.execute(sql`SELECT id FROM adapter_test`)).rows).toEqual([{ id: "outer" }]);
  });

  it("keeps an independent query outside another request's transaction", async () => {
    const client = await open();
    await client.migrate([initial]);
    const entered = deferred(), release = deferred();
    const aborted = client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('transaction', 1)`);
      entered.resolve();
      await release.promise;
      throw new Error("rollback isolated request");
    }).catch((error: unknown) => error);
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
    await client.transaction(async (tx) => { leaked = tx; await tx.execute(sql`SELECT 1`); });
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
    await expect(client.migrate([initial, "CREATE TABLE incomplete (n integer)", "this is invalid SQL"])).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT to_regclass('public.incomplete') AS name`)).rows).toEqual([{ name: null }]);
    expect((await client.db.execute(sql`SELECT count(*)::int AS n FROM artoo_meta.migrations`)).rows).toEqual([{ n: 1 }]);
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
    expect((await client.db.execute(sql`SELECT to_regnamespace('artoo_meta')::text AS name`)).rows).toEqual([{ name: null }]);
  });

  it("checks Supabase effective public-schema privileges before creating any DDL", async () => {
    const client = await open();
    for (const role of ["anon", "authenticated"]) {
      await observer!.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await expect(client.migrate([initial])).rejects.toThrow("deployment security prerequisite");
      expect((await observer!.query("SELECT to_regnamespace('artoo_meta')::text AS name")).rows).toEqual([{ name: null }]);
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
    const active = Promise.resolve(client.db.execute(sql`SELECT pg_sleep(4)`)).then(() => "unexpected success", (error: unknown) => error);
    await vi.waitFor(async () => {
      const state = await observer!.query<{ wait_event: string }>("SELECT wait_event FROM pg_stat_activity WHERE pid = $1", [pid]);
      expect(state.rows[0]?.wait_event).toBe("PgSleep");
    }, { timeout: 3000 });
    const queued = Promise.resolve(client.db.execute(sql`INSERT INTO adapter_test VALUES ('queued', 1)`)).then(() => "unexpected success", (error: unknown) => error);
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
    const entered = deferred(), resume = deferred();
    let pid: number | undefined;
    const transaction = client.transaction(async (tx) => {
      pid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('uncommitted', 1)`);
      entered.resolve();
      await resume.promise;
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('stale', 1)`);
    }).then(() => "unexpected success", (error: unknown) => error);
    try {
      await entered.promise;
      await terminateOwnedBackend(pid!);
      await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1), { timeout: 3000 });
      expect(await Promise.race([client.close().then(() => "closed"), delay(1000).then(() => "stuck")])).toBe("closed");
      const next = await open();
      expect((await next.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
    } finally { resume.resolve(); }
    expect(await transaction).toBeInstanceOf(Error);
  });

  it("fences a failed Drizzle BEGIN and closes without an abandoned checkout", async () => {
    const fatal = vi.fn();
    const client = await open({ onFatal: fatal });
    // Exercise the real driver's pre-finally failure path, not a mock pool.
    await expect(client.db.transaction(async () => undefined, {
      isolationLevel: "invalid test isolation" as "serializable",
    })).rejects.toThrow();
    expect(await client.healthCheck()).toBe(false);
    expect(fatal).toHaveBeenCalledTimes(1);
    const queued = Promise.resolve(client.db.execute(sql`SELECT 1`)).then(() => "unexpected success", (error: unknown) => error);
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
    await expect(client.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO adapter_test VALUES ('timed-out', 1)`);
      await tx.execute(sql`SELECT pg_sleep(1)`);
    })).rejects.toThrow();
    expect((await client.db.execute(sql`SELECT * FROM adapter_test`)).rows).toEqual([]);
    expect(await client.healthCheck()).toBe(true);
    expect(fatal).not.toHaveBeenCalled();
  });

  it("does not silently downgrade the default verified TLS connection", async () => {
    // The test launcher starts a fresh local cluster without TLS certificates.
    await expect(PostgresDbClient.create({ connectionString: databaseUrl, connectionTimeoutMillis: 1000 }))
      .rejects.toThrow("PostgreSQL connection failed");
  });
});
