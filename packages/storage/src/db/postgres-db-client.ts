import pg, { type PoolClient, type PoolConfig, type QueryResult } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import type { DbClient, DrizzleDb } from "./db-client.js";
import { applyMigrationJournal } from "./migration-journal.js";

export interface PostgresDbClientOptions {
  connectionString: string;
  /** Optional PEM CA certificate; certificate and hostname verification stay enabled. */
  sslCa?: string;
  /** Only for an explicitly selected local test database, never a remote host. */
  allowInsecureLocalhost?: boolean;
  connectionTimeoutMillis?: number;
  queryTimeoutMillis?: number;
  /** Called once after a live session is lost. The server must stop its workers and exit. */
  onFatal?: (error: Error) => void;
}

// Database-scoped, session-owned lock. All Artoo servers for this database use
// the same key, independent of their hostname, organization or container revision.
const LOCK_NAMESPACE = 0x4152544f;
const LOCK_RESOURCE = 0x53455256;
const SESSION_LOST = "PostgreSQL session lost; this server is fenced and must restart before using the database";

/**
 * One server, one physical PostgreSQL session. Pool checkout serializes ordinary
 * queries with complete Drizzle transactions; the same session holds the writer
 * lock. This deliberately does not implement transparent connection recovery.
 */
export class PostgresDbClient implements DbClient {
  readonly db: DrizzleDb;
  readonly #pool: pg.Pool;
  readonly #onFatal: PostgresDbClientOptions["onFatal"];
  readonly #unavailable: Promise<never>;
  readonly #checkouts = new Set<(error?: Error | boolean) => void>();
  #rejectUnavailable!: (error: Error) => void;
  #physicalClient: PoolClient | undefined;
  #backendPid: number | undefined;
  #state: "starting" | "ready" | "failed" | "closing" | "closed" = "starting";
  #failure: Error | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(config: PoolConfig, onFatal: PostgresDbClientOptions["onFatal"]) {
    this.#pool = new pg.Pool(config);
    this.#onFatal = onFatal;
    this.#unavailable = new Promise<never>((_resolve, reject) => { this.#rejectUnavailable = reject; });
    // A fatal event can arrive while no checkout is waiting.
    void this.#unavailable.catch(() => undefined);

    this.#pool.on("connect", (client: PoolClient) => {
      if (this.#physicalClient !== undefined || this.#state !== "starting") {
        this.#fence();
        // Never let a replacement session execute a queued statement without
        // the original lock, even if Pool creates it during an error race.
        void client.end().catch(() => this.#fence());
        return;
      }
      this.#physicalClient = client;
      client.on("error", () => this.#fence());
      client.on("end", () => this.#fence());
    });
    this.#pool.on("error", () => this.#fence());
    this.#pool.on("remove", () => this.#fence());

    const connect = this.#pool.connect.bind(this.#pool);
    const checkout = async (): Promise<PoolClient> => {
      this.#assertAvailable();
      const pending = connect();
      let claimed = false;
      try {
        const client = await Promise.race([pending, this.#unavailable]);
        claimed = true;
        try { this.#assertAvailable(); }
        catch (error) { client.release(true); throw error; }
        return this.#scopeClient(client);
      } catch (error) {
        // A fenced waiter must reject promptly, while still releasing any
        // physical checkout which completes after it stopped waiting.
        if (!claimed) void pending.then((client) => client.release(true), () => undefined);
        throw error;
      }
    };
    // Keep an actual pg.Pool: Drizzle detects it to pin transactions. Both its
    // callback query path and Drizzle's promise checkout path use this guard.
    this.#pool.connect = ((callback?: (error: Error | undefined, client?: PoolClient, release?: (error?: Error | boolean) => void) => void) => {
      if (callback === undefined) return checkout();
      void checkout().then(
        (client) => callback(undefined, client, client.release),
        (error: Error) => callback(error),
      );
    }) as pg.Pool["connect"];
    this.db = drizzle(this.#pool) as unknown as DrizzleDb;
  }

  static async create(options: PostgresDbClientOptions): Promise<PostgresDbClient> {
    const adapter = new PostgresDbClient(connectionConfig(options), options.onFatal);
    try {
      const connection = await adapter.#pool.connect();
      try {
        const result = await connection.query<{ acquired: boolean; pid: number }>(
          "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired, pg_backend_pid() AS pid",
          [LOCK_NAMESPACE, LOCK_RESOURCE],
        );
        if (result.rows[0]?.acquired !== true) {
          throw new Error("Another Artoo server owns this PostgreSQL database; stop it before starting this server");
        }
        adapter.#backendPid = result.rows[0].pid;
        adapter.#assertAvailable();
        adapter.#state = "ready";
      } finally { connection.release(); }
      return adapter;
    } catch (error) {
      await adapter.close();
      if (error instanceof Error && error.message.startsWith("Another Artoo server")) throw error;
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      // pg connection failures can include supplied connection parameters. Do
      // not expose the URL/password via the server's startup error handler.
      throw new Error(`PostgreSQL connection failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ""}; check host, credentials, verified TLS, and session-pooler configuration`);
    }
  }

  async transaction<T>(fn: (tx: DrizzleDb) => Promise<T>): Promise<T> {
    this.#assertAvailable();
    return this.db.transaction(fn);
  }

  async migrate(statements: readonly string[]): Promise<void> {
    const connection = await this.#pool.connect();
    try {
      await connection.query("BEGIN");
      // Supabase may grant public-schema access to its Data API roles by
      // default. Check effective privileges before any migration creates data.
      const exposed = await connection.query<{ rolname: string }>(
        "SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') AND has_schema_privilege(oid, 'public', 'USAGE')",
      );
      if (exposed.rows.length > 0) {
        throw new Error("PostgreSQL public schema is accessible to Supabase Data API roles; run the documented deployment security prerequisite before migrating");
      }
      await applyMigrationJournal({
        execute: (statement) => connection.query(statement),
        query: (statement, parameters) => connection.query<Record<string, unknown>>(statement, parameters),
      }, statements);
      await connection.query("COMMIT");
    } catch (error) {
      try { await connection.query("ROLLBACK"); }
      catch { this.#fence(); }
      throw error;
    } finally { connection.release(); }
  }

  async healthCheck(): Promise<boolean> {
    if (this.#state !== "ready") return false;
    const result = await this.#pool.query<{ pid: number; owned: boolean }>(
      `SELECT pg_backend_pid() AS pid, EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
          AND classid = $1::oid AND objid = $2::oid AND objsubid = 2 AND granted
      ) AS owned`, [LOCK_NAMESPACE, LOCK_RESOURCE],
    );
    if (result.rows[0]?.pid !== this.#backendPid || result.rows[0]?.owned !== true) {
      this.#fence();
      return false;
    }
    return true;
  }

  close(): Promise<void> {
    return this.#closePromise ??= (async () => {
      this.#state = "closing";
      this.#rejectUnavailable(new Error("PostgreSQL database is closed"));
      // Drizzle's BEGIN can fail before its transaction finally/release block.
      // A broken or abandoned checkout must not leave pool.end() hanging.
      for (const release of this.#checkouts) release(true);
      await this.#pool.end();
      this.#state = "closed";
    })();
  }

  #assertAvailable(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#state === "closing" || this.#state === "closed") throw new Error("PostgreSQL database is closed");
  }

  #fence(): void {
    if (this.#state === "failed" || this.#state === "closing" || this.#state === "closed") return;
    const notify = this.#state === "ready";
    this.#state = "failed";
    this.#failure = new Error(SESSION_LOST);
    this.#rejectUnavailable(this.#failure);
    for (const release of this.#checkouts) release(true);
    // Releasing the advisory lock also makes every outstanding query on the
    // sole session fail. No separate business pool can keep writing afterward.
    if (this.#physicalClient !== undefined) void this.#physicalClient.end().catch(() => this.#fence());
    if (notify) this.#onFatal?.(this.#failure);
  }

  #scopeClient(client: PoolClient): PoolClient {
    let active = true;
    const releasePhysical = client.release.bind(client);
    const assertScope = (): void => {
      this.#assertAvailable();
      if (!active) throw new Error("PostgreSQL transaction/checkout has already been released");
    };
    const release = (error?: Error | boolean): void => {
      if (!active) return;
      active = false;
      this.#checkouts.delete(release);
      // Pool.query normally destroys its checkout on *any* SQL error. A
      // PostgreSQL ERROR response (e.g. unique violation) leaves an autocommit
      // session usable; destroying it would unnecessarily lose our owner lock.
      // Unknown/client/FATAL errors still invalidate the entire server session.
      const discard = error != null && error !== false && !isRecoverableQueryError(error);
      if (discard) this.#fence();
      releasePhysical(discard ? error : undefined);
    };
    this.#checkouts.add(release);
    const query = (...args: unknown[]): unknown => {
      assertScope();
      const last = args.at(-1);
      const statement = typeof args[0] === "string" ? args[0]
        : args[0] !== null && typeof args[0] === "object" && "text" in args[0] ? args[0].text : undefined;
      const startsTransaction = typeof statement === "string" && /^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(statement);
      const complete = (error: unknown): void => {
        // Drizzle does not enter its release finally block until BEGIN succeeds.
        // Fence even a nonfatal BEGIN error so the server cannot remain ready
        // with its sole checkout abandoned and every later query stuck behind it.
        if (isConnectionFailure(error) || error != null && startsTransaction) this.#fence();
      };
      if (typeof last === "function") {
        const callback = last as (error: unknown, result?: QueryResult) => void;
        args[args.length - 1] = (error: unknown, result: QueryResult): void => {
          complete(error);
          try { assertScope(); } catch (failure) { callback(failure); return; }
          callback(error, result);
        };
        return Reflect.apply(client.query, client, args);
      }
      const result = Reflect.apply(client.query, client, args) as Promise<QueryResult>;
      return result.then((value) => { assertScope(); return value; }, (error: unknown) => { complete(error); throw error; });
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === "query") return query;
        if (property === "release") return release;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

function connectionConfig(options: PostgresDbClientOptions): PoolConfig {
  let url: URL;
  try { url = new URL(options.connectionString); }
  catch { throw new Error("Invalid PostgreSQL connection URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) throw new Error("Invalid PostgreSQL connection URL");
  if (!/^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\])$/.test(url.hostname)) throw new Error("PostgreSQL requires a TCP hostname or IP address");
  if (url.port === "6543") throw new Error("Transaction pooler port 6543 is unsupported; use a direct PostgreSQL connection or session pooler on port 5432");
  // An absent URL port must not fall through to an unrelated PGPORT variable.
  if (!url.port) url.port = "5432";
  const mode = url.searchParams.get("sslmode");
  if (mode !== null && !["require", "verify-full"].includes(mode)) throw new Error("PostgreSQL requires verified TLS; weaker sslmode settings are unsupported");
  url.searchParams.delete("sslmode");
  if ([...url.searchParams.keys()].some((key) => /^(ssl|uselibpqcompat)/i.test(key))) {
    throw new Error("Configure PostgreSQL TLS with sslCa instead of URL SSL overrides");
  }
  if ([...url.searchParams.keys()].length > 0) {
    // pg-connection-string lets URL query fields override host, port and query
    // timeouts. Do not let them bypass the endpoint or deadline checks above.
    throw new Error("PostgreSQL URL query parameters other than sslmode are unsupported");
  }
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (options.allowInsecureLocalhost === true && !local) throw new Error("Disabling PostgreSQL TLS is allowed only for a local test database");
  const connectionTimeoutMillis = boundedTimeout(options.connectionTimeoutMillis, 10000);
  const queryTimeoutMillis = boundedTimeout(options.queryTimeoutMillis, 30000);
  return {
    connectionString: url.toString(),
    ssl: options.allowInsecureLocalhost === true ? false : { rejectUnauthorized: true, ...(options.sslCa === undefined ? {} : { ca: options.sslCa }) },
    max: 1, idleTimeoutMillis: 0, maxLifetimeSeconds: 0,
    connectionTimeoutMillis, statement_timeout: queryTimeoutMillis, query_timeout: queryTimeoutMillis + 1000,
    keepAlive: true, keepAliveInitialDelayMillis: 10000, application_name: "artoo-server",
  };
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 300000) throw new Error("PostgreSQL timeout must be an integer between 100 and 300000 milliseconds");
  return value;
}

function isConnectionFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string; severity?: string };
  return typeof value.code === "string" && (/^08/.test(value.code) || ["57P01", "57P02", "57P03", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(value.code))
    || value.message === "Query read timeout" || value.severity === "FATAL" || value.severity === "PANIC";
}

function isRecoverableQueryError(error: unknown): boolean {
  return error instanceof pg.DatabaseError && error.severity === "ERROR" && !isConnectionFailure(error);
}
