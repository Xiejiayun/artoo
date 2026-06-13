import type { PgDatabase } from "drizzle-orm/pg-core";

/**
 * Drizzle query handle exposed by a {@link DbClient}. It is intentionally
 * schema-less at the port boundary so storage does not depend on packages/db's
 * schema (dependency points db -> storage). Callers pass tables explicitly to
 * `.select().from(table)` etc.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDb = PgDatabase<any, Record<string, never>, Record<string, never>>;

/**
 * The single database port. PGlite backs it for dev/test; a Postgres adapter
 * implements the same interface for production. drizzle is the dialect layer,
 * so the PGlite<->Postgres swap is a one-line driver change behind this port.
 */
export interface DbClient {
  /** Schema-less drizzle query interface. */
  readonly db: DrizzleDb;
  /** Run `fn` atomically; the transaction rolls back if `fn` throws. */
  transaction<T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T>;
  /** Apply ordered DDL/migration statements (must be Postgres-compatible). */
  migrate(statements: readonly string[]): Promise<void>;
  /** True when the connection answers a trivial query. */
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
