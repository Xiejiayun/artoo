import { createHash } from "node:crypto";
import pg, { type ClientConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DbClient, DrizzleDb } from "../../../packages/storage/dist/index.js";

export interface TransactionReceipt {
  xid: string;
  backendPid: number;
  isolation: string;
  state: "active" | "committed" | "aborted";
  databaseErrorCode?: string;
}

/** Test adapter only. One physical backend owns every statement in a transaction.
 * The harness issues one route at a time; concurrent/nested transactions on this
 * adapter fail rather than silently sharing the client's protocol queue. */
export class PgHarnessDbClient implements DbClient {
  readonly db: DrizzleDb;
  readonly transactions: TransactionReceipt[] = [];
  #busy = false;

  private constructor(readonly connection: pg.Client, readonly backendPid: number) {
    this.db = drizzle(connection) as unknown as DrizzleDb;
  }

  static async create(config: ClientConfig): Promise<PgHarnessDbClient> {
    const connection = new pg.Client(config);
    await connection.connect();
    try {
      const row = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!;
      return new PgHarnessDbClient(connection, row.pid);
    } catch (error) {
      await connection.end();
      throw error;
    }
  }

  async transaction<T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("Harness adapter forbids overlapping or nested transactions");
    this.#busy = true;
    let receipt: TransactionReceipt | undefined;
    try {
      await this.connection.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const row = (await this.connection.query<{ xid: string; pid: number; isolation: string }>(
        "SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation",
      )).rows[0]!;
      if (row.pid !== this.backendPid || row.isolation !== "read committed") throw new Error("Transaction backend/isolation drift");
      receipt = { xid: row.xid, backendPid: row.pid, isolation: row.isolation, state: "active" };
      this.transactions.push(receipt);
      const result = await fn(this.db);
      await this.connection.query("COMMIT");
      receipt.state = "committed";
      return result;
    } catch (error) {
      await this.connection.query("ROLLBACK");
      if (receipt) {
        receipt.state = "aborted";
        const nested = error as { code?: string; cause?: { code?: string } };
        const code = nested.cause?.code ?? nested.code;
        if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) receipt.databaseErrorCode = code;
      }
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  /** Applies the candidate's unchanged ordered SQL to a fresh owned database.
   * It deliberately refuses an existing public schema; no adoption path. */
  async migrate(statements: readonly string[]): Promise<void> {
    await this.transaction(async () => {
      const tables = await this.connection.query("SELECT 1 FROM information_schema.tables WHERE table_schema='public' LIMIT 1");
      if (tables.rowCount !== 0) throw new Error("Harness migration requires an empty owned database");
      await this.connection.query("CREATE SCHEMA artoo_harness_meta; CREATE TABLE artoo_harness_meta.migrations(position integer PRIMARY KEY, sha256 text NOT NULL)");
      for (const [position, statement] of statements.entries()) {
        await this.connection.query(statement);
        await this.connection.query("INSERT INTO artoo_harness_meta.migrations VALUES ($1, $2)", [
          position, createHash("sha256").update(statement.replace(/\r\n/g, "\n").trim()).digest("hex"),
        ]);
      }
    });
  }

  async healthCheck(): Promise<boolean> {
    return (await this.connection.query<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok === 1;
  }

  async close(): Promise<void> { await this.connection.end(); }
}
