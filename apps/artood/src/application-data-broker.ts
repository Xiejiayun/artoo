import { closeSync, openSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  APPLICATION_DATA_LIMITS as limits, ApplicationDataError, ApplicationDataScopeSchema,
  applicationDataDigest, applicationDataTable, canonicalApplicationDataJson,
  parseApplicationDataRequest, parseApplicationDataSchema,
  type ApplicationDataColumn, type ApplicationDataOperation, type ApplicationDataScalar,
  type ApplicationDataSchema, type ApplicationDataScope,
} from "./application-data-contract.js";

/**
 * Trusted synchronous storage core, not a process or OS isolation boundary. Integration must
 * keep it in a separately owned broker process, protect its directory, and keep every control
 * method below off the application's channel. This module is not wired to node capabilities,
 * generated code, HTTP, migrations, backup, or publication.
 */
export interface ApplicationDataBrokerOptions {
  databasePath: string;
  mode: "create" | "open";
  schemaJson: string;
  scope: ApplicationDataScope;
}
declare const invocationBrand: unique symbol;
export interface ApplicationDataInvocation { readonly [invocationBrand]: true }
export interface ApplicationDataGrant {
  scope: ApplicationDataScope;
  request_digest: string;
  access: "read" | "write";
  lifetime_ms: number;
  signal?: AbortSignal;
}
type Row = Record<string, ApplicationDataScalar>;
type OperationResult = { kind: "rows"; rows: Row[] } | { kind: "inserted" | "updated" | "deleted"; id: string; revision: number };
export type ApplicationDataResult = { kind: "read"; rows: Row[]; scope: ApplicationDataScope }
  | { kind: "committed"; operations: OperationResult[]; scope: ApplicationDataScope }
  | { kind: "conflict"; operation_index: number; scope: ApplicationDataScope };
export interface ApplicationDataReply {
  version: 1;
  request_digest: string;
  replayed: boolean;
  result: ApplicationDataResult;
}
interface GrantState {
  scope: ApplicationDataScope; requestDigest: string; access: "read" | "write";
  expires: number; revoked: boolean; signal?: AbortSignal;
}
interface Metadata {
  format_version: number; product_id: string; data_generation: string; schema_digest: string;
  service_generation: number; artifact_digest: string;
}
interface LedgerRow { request_digest: string; result_json: string; result_digest: string }
type SqlRow = Record<string, SQLOutputValue>;
const metaName = "artoo_app_metadata", ledgerName = "artoo_app_requests", countsName = "artoo_app_counts";
const metadataSql = `CREATE TABLE ${metaName} (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format_version INTEGER NOT NULL CHECK(format_version=1), product_id TEXT NOT NULL, data_generation TEXT NOT NULL, schema_digest TEXT NOT NULL, service_generation INTEGER NOT NULL CHECK(service_generation>=1 AND service_generation<=9007199254740990), artifact_digest TEXT NOT NULL, ledger_count INTEGER NOT NULL CHECK(ledger_count>=0 AND ledger_count<=${limits.ledgerEntries})) STRICT`;
const ledgerSql = `CREATE TABLE ${ledgerName} (operation_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB))<=${limits.replyBytes}), result_digest TEXT NOT NULL) STRICT, WITHOUT ROWID`;
const countsSql = `CREATE TABLE ${countsName} (table_name TEXT PRIMARY KEY, row_count INTEGER NOT NULL CHECK(row_count>=0 AND row_count<=${limits.rowsPerTable})) STRICT, WITHOUT ROWID`;

const resultScalar = z.union([z.string().max(limits.textBytes), z.number().int().safe(), z.boolean(), z.null()]);
const resultRows = z.array(z.record(z.string().max(40), resultScalar)).max(limits.rowsPerQuery);
const operationResult = z.union([
  z.object({ kind: z.literal("rows"), rows: resultRows }).strict(),
  z.object({ kind: z.enum(["inserted", "updated", "deleted"]),
    id: z.string().max(128), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
]);
const savedResult = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), operations: z.array(operationResult).min(1).max(limits.operations), scope: ApplicationDataScopeSchema }).strict(),
  z.object({ kind: z.literal("conflict"), operation_index: z.number().int().min(0).max(limits.operations - 1), scope: ApplicationDataScopeSchema }).strict(),
]);

function quote(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,47}$/u.test(identifier)) throw new ApplicationDataError("invalid-schema");
  return `"${identifier}"`;
}
const tableSqlName = (name: string) => quote(`app_${name}`);
const columnSqlName = (name: string) => quote(name === "id" || name === "revision" ? name : `value_${name}`);
function columnDefinition(column: ApplicationDataColumn): string {
  const identifier = columnSqlName(column.name);
  const constraint = column.type === "text" ? `length(CAST(${identifier} AS BLOB))<=${column.max_bytes}`
    : column.type === "boolean" ? `${identifier} IN (0,1)` : `${identifier}>=${column.min} AND ${identifier}<=${column.max}`;
  return `${identifier} ${column.type === "text" ? "TEXT" : "INTEGER"}${column.nullable ? "" : " NOT NULL"} CHECK(${constraint})`;
}
function applicationTableSql(table: ApplicationDataSchema["tables"][number]): string {
  return `CREATE TABLE ${tableSqlName(table.name)} (id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB)) BETWEEN 1 AND 128), revision INTEGER NOT NULL CHECK(revision>=1 AND revision<=9007199254740991), deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), ${table.columns.map(columnDefinition).join(", ")}) STRICT, WITHOUT ROWID`;
}
function sqlValue(value: ApplicationDataScalar): SQLInputValue { return typeof value === "boolean" ? Number(value) : value; }
function scope(input: unknown): ApplicationDataScope {
  const result = ApplicationDataScopeSchema.safeParse(input);
  if (!result.success) throw new ApplicationDataError("scope-mismatch");
  return Object.freeze(result.data);
}
function sameScope(left: ApplicationDataScope, right: ApplicationDataScope): boolean {
  return left.product_id === right.product_id && left.data_generation === right.data_generation
    && left.service_generation === right.service_generation && left.artifact_digest === right.artifact_digest;
}
function unavailable(error: unknown): ApplicationDataError {
  // SQL and filesystem errors may contain paths or data. Keep them out of the application reply.
  return error instanceof ApplicationDataError ? error : new ApplicationDataError("storage-unavailable");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class ApplicationDataBroker {
  private readonly database: DatabaseSync;
  private readonly schema: ApplicationDataSchema;
  private readonly schemaDigest: string;
  private readonly permits = new WeakMap<ApplicationDataInvocation, GrantState>();
  private readonly schemaVersion: number;
  private current: ApplicationDataScope;
  private closed = false;
  private failed = false;
  private transactionOpen = false;
  private lastClock = 0;

  /** The optional clock is a trusted host test seam; application data cannot configure it. */
  constructor(options: ApplicationDataBrokerOptions, private readonly clock: () => number = () => performance.now()) {
    this.schema = parseApplicationDataSchema(options.schemaJson);
    this.schemaDigest = applicationDataDigest(this.schema);
    this.current = scope(options.scope);
    if (typeof options.databasePath !== "string" || !isAbsolute(options.databasePath) || options.databasePath.includes("\0")
      || (options.mode !== "create" && options.mode !== "open")) throw new ApplicationDataError("storage-unavailable");
    let database: DatabaseSync | undefined;
    try {
      // Exclusive creation never adopts an existing product. Failed files remain for diagnosis.
      if (options.mode === "create") closeSync(openSync(options.databasePath, "wx", 0o600));
      else closeSync(openSync(options.databasePath, "r+")); // DatabaseSync must not create on reopen.
      database = new DatabaseSync(options.databasePath, { enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false, allowExtension: false, timeout: 25 });
      this.database = database;
      database.exec("PRAGMA trusted_schema=OFF; PRAGMA recursive_triggers=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=25; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048");
      if (options.mode === "create") database.exec("PRAGMA page_size=4096");
      if (database.prepare("PRAGMA page_size").get()?.page_size !== 4096
        || database.prepare("PRAGMA max_page_count=65536").get()?.max_page_count !== 65536)
        throw new ApplicationDataError("storage-unavailable");
      const journal = database.prepare(options.mode === "create" ? "PRAGMA journal_mode=DELETE" : "PRAGMA journal_mode").get();
      if (journal?.journal_mode !== "delete") throw new ApplicationDataError("storage-unavailable");
      if (options.mode === "create") this.initialize();
      this.checkSchema();
      const version = this.database.prepare("PRAGMA schema_version").get()?.schema_version;
      if (typeof version !== "number") throw new ApplicationDataError("storage-unavailable");
      this.schemaVersion = version;
      this.transaction(() => { this.assertLease(); this.checkCounts(); });
    } catch (error) {
      if (database) {
        try { database.close(); } catch { /* No successful close is reported when construction fails. */ }
      }
      throw unavailable(error);
    }
  }

  getScope(): ApplicationDataScope { this.assertAvailable(); return this.current; }
  describeRequest(json: string): { request_digest: string; requires_write: boolean } {
    this.assertAvailable();
    const request = parseApplicationDataRequest(json, this.schema);
    return Object.freeze({ request_digest: request.digest, requires_write: request.requiresWrite });
  }

  /** Host control API. Never expose this, rotateService, or revoke on the application channel. */
  grantInvocation(input: ApplicationDataGrant): ApplicationDataInvocation {
    this.assertAvailable();
    const grantedScope = scope(input.scope);
    if (!sameScope(grantedScope, this.current)) throw new ApplicationDataError("scope-mismatch");
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.request_digest) || !["read", "write"].includes(input.access)
      || !Number.isSafeInteger(input.lifetime_ms) || input.lifetime_ms < 1 || input.lifetime_ms > limits.permitMilliseconds)
      throw new ApplicationDataError("unauthorized");
    this.assertLease();
    const now = this.now();
    const permit = Object.freeze({}) as ApplicationDataInvocation;
    this.permits.set(permit, { scope: grantedScope, requestDigest: input.request_digest, access: input.access,
      expires: now + input.lifetime_ms, revoked: false, signal: input.signal });
    return permit;
  }
  revoke(permit: ApplicationDataInvocation): void {
    const value = this.permits.get(permit);
    if (!value) throw new ApplicationDataError("unauthorized");
    value.revoked = true;
  }

  execute(permit: ApplicationDataInvocation, json: string): ApplicationDataReply {
    this.assertAvailable();
    const parsed = parseApplicationDataRequest(json, this.schema);
    const grant = this.checkPermit(permit, parsed.digest, parsed.requiresWrite);
    const deadline = Math.min(grant.expires, this.now() + limits.executionMilliseconds);
    return this.transaction(() => {
      this.assertLease();
      this.checkPermit(permit, parsed.digest, parsed.requiresWrite, deadline);
      const request = parsed.request;
      let result: ApplicationDataResult;
      let replayed = false;
      if (request.kind === "read") {
        result = { kind: "read", rows: this.query(request.query), scope: this.current };
      } else {
        const previous = this.database.prepare(`SELECT request_digest, result_json, result_digest FROM ${ledgerName} WHERE operation_key=?`).get(request.idempotency_key) as unknown as LedgerRow | undefined;
        if (previous) {
          if (previous.request_digest !== parsed.digest) throw new ApplicationDataError("idempotency-conflict");
          result = this.readSavedResult(previous);
          replayed = true;
        } else {
          const count = this.database.prepare(`SELECT ledger_count FROM ${metaName} WHERE singleton=1`).get()?.ledger_count;
          if (typeof count !== "number" || count >= limits.ledgerEntries) throw new ApplicationDataError("limit");
          this.database.exec("SAVEPOINT application_work");
          const operations: OperationResult[] = [];
          let conflict: number | undefined;
          for (const [index, item] of request.operations.entries()) {
            this.checkPermit(permit, parsed.digest, true, deadline);
            const value = this.operation(item);
            if (value === undefined) { conflict = index; break; }
            operations.push(value);
          }
          if (conflict !== undefined) {
            // A conflict is a durable idempotent result, while every business write in this
            // batch is rolled back. Tombstones prevent revision ABA after deletion.
            this.database.exec("ROLLBACK TO application_work");
            result = { kind: "conflict", operation_index: conflict, scope: this.current };
          } else result = { kind: "committed", operations, scope: this.current };
          this.database.exec("RELEASE application_work");
          const saved = canonicalApplicationDataJson(result);
          this.assertReplySize({ version: 1, request_digest: parsed.digest, replayed: false, result });
          this.database.prepare(`INSERT INTO ${ledgerName} (operation_key, request_digest, result_json, result_digest) VALUES (?, ?, ?, ?)`).run(
            request.idempotency_key, parsed.digest, saved, applicationDataDigest(result));
          this.database.prepare(`UPDATE ${metaName} SET ledger_count=ledger_count+1 WHERE singleton=1`).run();
        }
      }
      const reply: ApplicationDataReply = { version: 1, request_digest: parsed.digest, replayed, result };
      this.assertReplySize(reply);
      // The write reservation serializes other generations. Both the persisted lease and
      // this invocation are checked again inside the same transaction, before COMMIT.
      this.assertLease();
      this.checkPermit(permit, parsed.digest, parsed.requiresWrite, deadline);
      return freeze(reply);
    });
  }

  /** Same-schema, same-data service restart only; data-generation changes are unsupported. */
  rotateService(next: { service_generation: number; artifact_digest: string }): ApplicationDataScope {
    this.assertAvailable();
    const parsed = ApplicationDataScopeSchema.pick({ service_generation: true, artifact_digest: true }).strict().safeParse(next);
    if (!parsed.success) throw new ApplicationDataError("scope-mismatch");
    const target = scope({ ...this.current, ...parsed.data });
    if (target.service_generation !== this.current.service_generation + 1) throw new ApplicationDataError("scope-mismatch");
    this.transaction(() => {
      this.assertLease();
      const changed = this.database.prepare(`UPDATE ${metaName} SET service_generation=?, artifact_digest=? WHERE singleton=1 AND product_id=? AND data_generation=? AND service_generation=? AND artifact_digest=?`).run(
        target.service_generation, target.artifact_digest, this.current.product_id, this.current.data_generation,
        this.current.service_generation, this.current.artifact_digest);
      if (Number(changed.changes) !== 1) throw new ApplicationDataError("scope-mismatch");
    });
    this.current = target;
    return this.current;
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionOpen) throw new ApplicationDataError("storage-unavailable");
    try { this.database.close(); this.closed = true; }
    catch { this.failed = true; throw new ApplicationDataError("storage-unavailable"); }
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isFinite(value) || value < this.lastClock) throw new ApplicationDataError("unauthorized");
    this.lastClock = value;
    return value;
  }
  private assertAvailable(): void {
    if (this.closed) throw new ApplicationDataError("closed");
    if (this.failed || this.transactionOpen) throw new ApplicationDataError("storage-unavailable");
  }
  private checkPermit(permit: ApplicationDataInvocation, digest: string, write: boolean, deadline?: number): GrantState {
    const grant = this.permits.get(permit);
    if (!grant || grant.requestDigest !== digest || (write && grant.access !== "write")) throw new ApplicationDataError("unauthorized");
    if (grant.revoked) throw new ApplicationDataError("revoked");
    if (grant.signal?.aborted) throw new ApplicationDataError("aborted");
    if (!sameScope(grant.scope, this.current)) throw new ApplicationDataError("scope-mismatch");
    const now = this.now();
    if (now >= grant.expires || (deadline !== undefined && now >= deadline)) throw new ApplicationDataError("expired");
    return grant;
  }
  private assertLease(): void {
    const metadata = this.database.prepare(`SELECT format_version, product_id, data_generation, schema_digest, service_generation, artifact_digest FROM ${metaName} WHERE singleton=1`).get() as unknown as Metadata | undefined;
    if (!metadata || metadata.format_version !== 1 || metadata.schema_digest !== this.schemaDigest || !sameScope(metadata, this.current)) throw new ApplicationDataError("scope-mismatch");
    if (this.schemaVersion !== undefined && this.database.prepare("PRAGMA schema_version").get()?.schema_version !== this.schemaVersion)
      throw new ApplicationDataError("storage-unavailable");
  }
  private transaction<T>(work: () => T): T {
    this.assertAvailable();
    let began = false;
    try {
      this.database.exec("BEGIN IMMEDIATE"); began = true; this.transactionOpen = true;
      const result = work();
      this.database.exec("COMMIT"); began = false;
      return result;
    } catch (error) {
      if (began) {
        try { this.database.exec("ROLLBACK"); }
        catch { this.failed = true; }
      }
      throw unavailable(error);
    } finally { this.transactionOpen = false; }
  }
  private initialize(): void {
    this.transaction(() => {
      this.database.exec(metadataSql); this.database.exec(ledgerSql); this.database.exec(countsSql);
      this.database.prepare(`INSERT INTO ${metaName} (singleton, format_version, product_id, data_generation, schema_digest, service_generation, artifact_digest, ledger_count) VALUES (1, 1, ?, ?, ?, ?, ?, 0)`).run(
        this.current.product_id, this.current.data_generation, this.schemaDigest, this.current.service_generation, this.current.artifact_digest);
      for (const table of this.schema.tables) {
        this.database.exec(applicationTableSql(table));
        this.database.prepare(`INSERT INTO ${countsName} (table_name, row_count) VALUES (?, 0)`).run(table.name);
      }
    });
  }
  private checkSchema(): void {
    const expected = new Map<string, string>([[metaName, metadataSql], [ledgerName, ledgerSql], [countsName, countsSql],
      ...this.schema.tables.map(table => [`app_${table.name}`, applicationTableSql(table)] as [string, string])]);
    const actual = this.database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema").all();
    if (actual.length !== expected.size || actual.some(row => row.type !== "table" || row.tbl_name !== row.name || row.sql !== expected.get(String(row.name))))
      throw new ApplicationDataError("storage-unavailable");
  }
  private checkCounts(): void {
    if (this.database.prepare(`SELECT count(*) AS total FROM ${metaName}`).get()?.total !== 1
      || this.database.prepare(`SELECT count(*) AS total FROM ${countsName}`).get()?.total !== this.schema.tables.length)
      throw new ApplicationDataError("storage-unavailable");
    const count = this.database.prepare(`SELECT count(*) AS total FROM ${ledgerName}`).get()?.total;
    if (count !== this.database.prepare(`SELECT ledger_count FROM ${metaName} WHERE singleton=1`).get()?.ledger_count)
      throw new ApplicationDataError("storage-unavailable");
    for (const table of this.schema.tables) {
      if (this.database.prepare(`SELECT count(*) AS total FROM ${tableSqlName(table.name)}`).get()?.total
        !== this.database.prepare(`SELECT row_count FROM ${countsName} WHERE table_name=?`).get(table.name)?.row_count)
        throw new ApplicationDataError("storage-unavailable");
    }
  }
  private readSavedResult(row: LedgerRow): ApplicationDataResult {
    if (typeof row.result_json !== "string" || Buffer.byteLength(row.result_json, "utf8") > limits.replyBytes)
      throw new ApplicationDataError("storage-unavailable");
    let parsed: unknown;
    try { parsed = JSON.parse(row.result_json); } catch { throw new ApplicationDataError("storage-unavailable"); }
    const checked = savedResult.safeParse(parsed);
    if (!checked.success || applicationDataDigest(checked.data) !== row.result_digest
      || checked.data.scope.product_id !== this.current.product_id || checked.data.scope.data_generation !== this.current.data_generation
      || checked.data.scope.service_generation > this.current.service_generation) throw new ApplicationDataError("storage-unavailable");
    return checked.data;
  }
  private assertReplySize(reply: ApplicationDataReply): void {
    if (Buffer.byteLength(canonicalApplicationDataJson(reply), "utf8") > limits.replyBytes) throw new ApplicationDataError("limit");
  }
  private query(item: Extract<ApplicationDataOperation, { kind: "query" }>): Row[] {
    const table = applicationDataTable(this.schema, item.table);
    const where = item.id !== undefined ? "id=?" : item.after !== undefined ? "id>?" : "1=1";
    const parameters: SQLInputValue[] = item.id !== undefined ? [item.id] : item.after !== undefined ? [item.after] : [];
    parameters.push(item.limit);
    const statement = this.database.prepare(`SELECT ${item.columns.map(columnSqlName).join(", ")} FROM ${tableSqlName(table.name)} WHERE deleted=0 AND ${where} ORDER BY id LIMIT ?`);
    const rows: Row[] = [];
    let bytes = 0;
    for (const raw of statement.iterate(...parameters)) {
      const result: Row = Object.create(null) as Row;
      for (const selected of item.columns) {
        const field = table.columns.find(column => column.name === selected);
        const value = (raw as SqlRow)[selected === "id" || selected === "revision" ? selected : `value_${selected}`];
        if (value === null && field?.nullable) result[selected] = null;
        else if (selected === "id" && typeof value === "string") result[selected] = value;
        else if (selected === "revision" && typeof value === "number" && Number.isSafeInteger(value)) result[selected] = value;
        else if (field?.type === "text" && typeof value === "string" && Buffer.byteLength(value, "utf8") <= field.max_bytes) result[selected] = value;
        else if (field?.type === "integer" && typeof value === "number" && Number.isSafeInteger(value) && value >= field.min && value <= field.max) result[selected] = value;
        else if (field?.type === "boolean" && (value === 0 || value === 1)) result[selected] = value === 1;
        else throw new ApplicationDataError("storage-unavailable");
      }
      bytes += Buffer.byteLength(canonicalApplicationDataJson(result), "utf8");
      if (bytes > limits.replyBytes) throw new ApplicationDataError("limit");
      rows.push(result);
    }
    return rows;
  }
  private operation(item: ApplicationDataOperation): OperationResult | undefined {
    if (item.kind === "query") return { kind: "rows", rows: this.query(item) };
    const table = tableSqlName(item.table);
    if (item.kind === "insert") {
      const exists = this.database.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(item.id);
      if (exists) return undefined;
      const count = this.database.prepare(`SELECT row_count FROM ${countsName} WHERE table_name=?`).get(item.table)?.row_count;
      if (typeof count !== "number" || count >= limits.rowsPerTable) throw new ApplicationDataError("limit");
      const names = Object.keys(item.values).sort();
      this.database.prepare(`INSERT INTO ${table} (id, revision, deleted, ${names.map(columnSqlName).join(", ")}) VALUES (?, 1, 0, ${names.map(() => "?").join(", ")})`).run(item.id, ...names.map(name => sqlValue(item.values[name]!)));
      this.database.prepare(`UPDATE ${countsName} SET row_count=row_count+1 WHERE table_name=?`).run(item.table);
      return { kind: "inserted", id: item.id, revision: 1 };
    }
    const assignments = item.kind === "delete" ? "deleted=1"
      : Object.keys(item.values).sort().map(name => `${columnSqlName(name)}=?`).join(", ");
    const parameters: SQLInputValue[] = item.kind === "delete" ? [] : Object.keys(item.values).sort().map(name => sqlValue(item.values[name]!));
    parameters.push(item.id, item.expected_revision);
    const changed = this.database.prepare(`UPDATE ${table} SET ${assignments}, revision=revision+1 WHERE id=? AND revision=? AND deleted=0`).run(...parameters);
    if (Number(changed.changes) !== 1) return undefined;
    return { kind: item.kind === "delete" ? "deleted" : "updated", id: item.id, revision: item.expected_revision + 1 };
  }
}
