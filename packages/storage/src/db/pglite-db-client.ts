import { createHash } from "node:crypto";
import { access, mkdir, realpath, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";

import type { DbClient, DrizzleDb } from "./db-client.js";
import { applyMigrationJournal } from "./migration-journal.js";

export interface PgliteDbClientOptions {
  /** Persist to this directory. Omitted = ephemeral in-memory database. */
  dataDir?: string;
  /** Restore a snapshot into a new directory (or an in-memory instance). */
  archive?: Uint8Array;
}

/**
 * Embedded Postgres (PGlite) implementation of {@link DbClient} for dev/test —
 * no Docker, no server. Runs standard Postgres SQL, so migrations written here
 * also run against a real Postgres in production.
 */
export class PgliteDbClient implements DbClient {
  readonly #pg: PGlite;
  readonly #releaseLock: (() => Promise<void>) | undefined;
  readonly db: DrizzleDb;

  private constructor(pg: PGlite, releaseLock?: () => Promise<void>) {
    this.#pg = pg;
    this.#releaseLock = releaseLock;
    this.db = drizzle(pg) as unknown as DrizzleDb;
  }

  static async create(options: PgliteDbClientOptions = {}): Promise<PgliteDbClient> {
    if (options.archive !== undefined && options.dataDir !== undefined) {
      const exists = await access(options.dataDir).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error("Restore requires a new database directory; existing data will not be overwritten");
    }
    const lock = options.dataDir === undefined ? undefined : await acquireDataLock(options.dataDir);
    try {
      const pg = await PGlite.create({
        extensions: { pg_trgm },
        ...(lock === undefined ? {} : { dataDir: lock.directory }),
        ...(options.archive === undefined ? {} : { loadDataDir: new Blob([Uint8Array.from(options.archive)]) }),
      });
      return new PgliteDbClient(pg, lock?.release);
    } catch (error) {
      await lock?.release();
      throw error;
    }
  }

  async transaction<T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    return this.db.transaction(fn as (tx: DrizzleDb) => Promise<T>);
  }

  async migrate(statements: readonly string[]): Promise<void> {
    // The complete, append-only migration history is supplied on every boot.
    // Journal and DDL commit together: a failed upgrade cannot leave a partially
    // applied schema or mark an unapplied statement as successful.
    await this.#pg.transaction(async (tx) => {
      await applyMigrationJournal(
        {
          execute: (statement) => tx.exec(statement),
          query: (statement, parameters) => tx.query<Record<string, unknown>>(statement, parameters),
        },
        statements,
      );
    });
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.#pg.query<{ ok: number }>("select 1 as ok");
    return result.rows[0]?.ok === 1;
  }

  /** Transactionally consistent PGlite archive. Deployment tooling also copies
   * the artifact store while the server is stopped to form a complete backup. */
  async backup(): Promise<Uint8Array> {
    return new Uint8Array(await (await this.#pg.dumpDataDir("gzip")).arrayBuffer());
  }

  /** Explicit one-time adoption for an old unjournaled database. A disposable
   * reference schema must match exactly; data is neither replaced nor inferred. */
  async adoptLegacyMigrations(statements: readonly string[]): Promise<void> {
    const reference = await PGlite.create({ extensions: { pg_trgm } });
    try {
      for (const statement of statements) await reference.exec(statement);
      const expected = await schemaFingerprint(reference);
      await this.#pg.transaction(async (tx) => {
        if ((await schemaFingerprint(tx)) !== expected) {
          throw new Error(
            "Legacy schema does not exactly match this release. Adoption refused; use its original release to migrate first",
          );
        }
        await tx.exec(
          "CREATE SCHEMA IF NOT EXISTS artoo_meta; CREATE TABLE IF NOT EXISTS artoo_meta.migrations (position integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
        );
        const existing = await tx.query("SELECT position FROM artoo_meta.migrations LIMIT 1");
        if (existing.rows.length > 0) throw new Error("Database already has a migration journal");
        for (const [position, statement] of statements.entries()) {
          const checksum = createHash("sha256").update(statement.replace(/\r\n/g, "\n").trim()).digest("hex");
          await tx.query("INSERT INTO artoo_meta.migrations (position, checksum) VALUES ($1, $2)", [
            position,
            checksum,
          ]);
        }
      });
    } finally {
      await reference.close();
    }
  }

  async close(): Promise<void> {
    await this.#pg.close();
    await this.#releaseLock?.();
  }
}

/** PGlite cannot safely share a data directory between processes. An exclusive
 * adjacent directory also covers backup/adoption tools; crash locks are never
 * silently stolen. Operators can recover a dead lock after checking its owner. */
async function acquireDataLock(dataDir: string): Promise<{ directory: string; release: () => Promise<void> }> {
  const resolved = resolve(dataDir);
  await mkdir(dirname(resolved), { recursive: true });
  const canonical = await realpath(resolved).catch(() =>
    realpath(dirname(resolved)).then((parent) => join(parent, basename(resolved))),
  );
  const lockDir = `${canonical}.artoo-lock`;
  try {
    await mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Database is locked: ${lockDir}. Stop the server before storage operations. After a crash, use storage unlock only after its recorded owner has exited.`,
    );
  }
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
  try {
    await writeFile(join(lockDir, "owner.json"), owner, { flag: "wx" });
  } catch (error) {
    await rmdir(lockDir).catch(() => {});
    throw error;
  }
  return {
    directory: canonical,
    release: async () => {
      // Idempotent close; never remove a replacement lock owned by someone else.
      if ((await readFile(join(lockDir, "owner.json"), "utf8").catch(() => null)) !== owner) return;
      await unlink(join(lockDir, "owner.json"));
      await rmdir(lockDir);
    },
  };
}

async function schemaFingerprint(database: { query: PGlite["query"] }): Promise<string> {
  const queries = [
    "SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,is_identity,is_generated FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    "SELECT c.relname,p.conname,pg_get_constraintdef(p.oid) AS definition FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname,p.conname",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname",
    "SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','v','m','S') ORDER BY c.relname",
    "SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY event_object_table,trigger_name",
  ];
  const results = [];
  for (const query of queries) results.push((await database.query(query)).rows);
  return JSON.stringify(results);
}
