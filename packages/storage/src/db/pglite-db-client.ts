import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

import type { DbClient, DrizzleDb } from "./db-client.js";

export interface PgliteDbClientOptions {
  /** Persist to this directory. Omitted = ephemeral in-memory database. */
  dataDir?: string;
}

/**
 * Embedded Postgres (PGlite) implementation of {@link DbClient} for dev/test —
 * no Docker, no server. Runs standard Postgres SQL, so migrations written here
 * also run against a real Postgres in production.
 */
export class PgliteDbClient implements DbClient {
  readonly #pg: PGlite;
  readonly db: DrizzleDb;

  private constructor(pg: PGlite) {
    this.#pg = pg;
    this.db = drizzle(pg) as unknown as DrizzleDb;
  }

  static async create(options: PgliteDbClientOptions = {}): Promise<PgliteDbClient> {
    const pg =
      options.dataDir === undefined
        ? await PGlite.create()
        : await PGlite.create({ dataDir: options.dataDir });
    return new PgliteDbClient(pg);
  }

  async transaction<T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    return this.db.transaction(fn as (tx: DrizzleDb) => Promise<T>);
  }

  async migrate(statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      await this.#pg.exec(statement);
    }
  }

  async healthCheck(): Promise<boolean> {
    const result = await this.#pg.query<{ ok: number }>("select 1 as ok");
    return result.rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.#pg.close();
  }
}
