import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationDataBroker, type ApplicationDataInvocation } from "./application-data-broker.js";
import { ApplicationDataError, parseApplicationDataSchema, type ApplicationDataScope } from "./application-data-contract.js";

const schema = { version: 1, tables: [{ name: "inventory", columns: [
  { name: "name", type: "text", nullable: false, max_bytes: 128 },
  { name: "quantity", type: "integer", nullable: false, min: 0, max: 10_000 },
  { name: "active", type: "boolean", nullable: false },
  { name: "note", type: "text", nullable: true, max_bytes: 128 },
] }] };
const initialScope: ApplicationDataScope = { product_id: "product-inventory", data_generation: "data-original",
  service_generation: 1, artifact_digest: `sha256:${"a".repeat(64)}` };
const scopes = new Set<ApplicationDataBroker>(), directories = new Set<string>();
afterEach(context => {
  // Only test-created stores are removed, and only after all original connections close.
  const originalBrokers = [...scopes], originalDirectories = [...directories], failures: unknown[] = [];
  scopes.clear(); directories.clear();
  for (const broker of originalBrokers) { try { broker.close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Original broker closure unknown; test stores retained");
  // Every body in this suite is synchronous; this is not a general async timeout drain.
  if (context.task.result?.state !== "pass" || context.signal.aborted) return;
  for (const directory of originalDirectories) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^artoo-application-data-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture(clock?: () => number, schemaValue: unknown = schema) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-application-data-")); directories.add(directory);
  const databasePath = join(directory, "product.sqlite"), schemaJson = JSON.stringify(schemaValue);
  const options = { databasePath, schemaJson, scope: initialScope };
  const broker = track(new ApplicationDataBroker({ ...options, mode: "create" }, clock));
  return { broker, databasePath, schemaJson,
    reopen: (scope: ApplicationDataScope = initialScope, now?: () => number) => track(new ApplicationDataBroker({ ...options, scope, mode: "open" }, now)) };
}
function track(broker: ApplicationDataBroker) { scopes.add(broker); return broker; }
function grant(broker: ApplicationDataBroker, json: string, access: "read" | "write" = "write", lifetime = 30_000, signal?: AbortSignal) {
  return broker.grantInvocation({ scope: broker.getScope(), request_digest: broker.describeRequest(json).request_digest,
    access, lifetime_ms: lifetime, signal });
}
function call(broker: ApplicationDataBroker, request: unknown) {
  const json = JSON.stringify(request);
  return broker.execute(grant(broker, json), json);
}
const query = (extra: object = {}) => ({ version: 1, kind: "read", query: { kind: "query", table: "inventory",
  columns: ["id", "revision", "name", "quantity", "active", "note"], limit: 100, ...extra } });
const insert = (id = "item-1", quantity = 1) => ({ kind: "insert", table: "inventory", id,
  values: { name: `Item ${id}`, quantity, active: true, note: null } });
const cas = (id = "item-1", expected = 1, quantity = 0) => ({ kind: "compare-and-set", table: "inventory", id,
  expected_revision: expected, values: { quantity } });
const transaction = (key: string, ...operations: unknown[]) => ({ version: 1, kind: "transaction", idempotency_key: key, operations });
function error(code: ApplicationDataError["code"]) { return new ApplicationDataError(code); }

describe("application data broker (real SQLite, internal component only)", () => {
  it("rejects unsafe or ambiguous schema definitions before creating a database", () => {
    const table = schema.tables[0]!;
    for (const invalid of [
      { ...schema, version: 2 }, { ...schema, sql: "CREATE TABLE anything (value)" },
      { ...schema, tables: [table, table] },
      { ...schema, tables: [{ ...table, columns: [...table.columns, table.columns[0]] }] },
      { ...schema, tables: [{ ...table, name: "sqlite_schema" , columns: [{ name: "id", type: "text", nullable: false, max_bytes: 10 }] }] },
      { ...schema, tables: [{ ...table, columns: [{ name: "value", type: "integer", nullable: false, min: 2, max: 1 }] }] },
      { ...schema, tables: [{ ...table, columns: [{ name: "value", type: "text", nullable: false, max_bytes: 4_097 }] }] },
    ]) expect(() => parseApplicationDataSchema(JSON.stringify(invalid))).toThrow(error("invalid-schema"));
  });

  it("persists typed rows and idempotent results across actual connection closure and reopen", () => {
    const f = fixture();
    const request = transaction("create-original", insert());
    const committed = call(f.broker, request);
    expect(committed).toMatchObject({ replayed: false, result: { kind: "committed", operations: [{ kind: "inserted", id: "item-1", revision: 1 }] } });
    f.broker.close();
    const reopened = f.reopen();
    expect(call(reopened, request)).toEqual({ ...committed, replayed: true });
    expect(call(reopened, query())).toMatchObject({ replayed: false, result: { kind: "read", rows: [
      { id: "item-1", revision: 1, name: "Item item-1", quantity: 1, active: true, note: null },
    ] } });
    expect(() => call(reopened, transaction("create-original", insert("item-other")))).toThrow(error("idempotency-conflict"));
  });

  it("shares the persisted generation fence across two connections, including reads", () => {
    const f = fixture(), second = f.reopen();
    const original = transaction("create-original", insert());
    const saved = call(f.broker, original);
    const readJson = JSON.stringify(query()), writeJson = JSON.stringify(transaction("stale", cas()));
    const readPermit = grant(f.broker, readJson, "read"), writePermit = grant(f.broker, writeJson);
    const newScope = second.rotateService({ service_generation: 2, artifact_digest: `sha256:${"b".repeat(64)}` });
    expect(() => f.broker.execute(readPermit, readJson)).toThrow(error("scope-mismatch"));
    expect(() => f.broker.execute(writePermit, writeJson)).toThrow(error("scope-mismatch"));
    expect(() => grant(f.broker, readJson)).toThrow(error("scope-mismatch"));
    expect(call(second, original)).toEqual({ ...saved, replayed: true });
    expect(call(second, query())).toMatchObject({ result: { scope: newScope, rows: [{ quantity: 1, revision: 1 }] } });
    second.close();
    const reopened = f.reopen(newScope);
    expect(call(reopened, original)).toEqual({ ...saved, replayed: true });
    expect(() => f.reopen()).toThrow(error("scope-mismatch"));
  });

  it("does not reset idempotency when the same broker rotates to a new artifact", () => {
    const { broker } = fixture();
    call(broker, transaction("seed", insert()));
    const outgoing = transaction("outgoing-one", cas());
    const previous = call(broker, outgoing);
    const json = JSON.stringify(outgoing), oldPermit = grant(broker, json);
    broker.rotateService({ service_generation: 2, artifact_digest: `sha256:${"c".repeat(64)}` });
    expect(() => broker.execute(oldPermit, json)).toThrow(error("scope-mismatch"));
    expect(call(broker, outgoing)).toEqual({ ...previous, replayed: true });
    expect(call(broker, query())).toMatchObject({ result: { rows: [{ quantity: 0, revision: 2 }] } });
    expect(() => broker.rotateService({ service_generation: 4, artifact_digest: `sha256:${"d".repeat(64)}` })).toThrow(error("scope-mismatch"));
    expect(() => broker.rotateService({ service_generation: 3, artifact_digest: `sha256:${"d".repeat(64)}`, data_generation: "replacement" } as never)).toThrow(error("scope-mismatch"));
  });

  it("allows only one of two same-revision contenders on separate SQLite connections", () => {
    // This case checks two-connection serialization, not simultaneous worker execution.
    const f = fixture(), second = f.reopen();
    call(f.broker, transaction("seed", insert()));
    expect(call(f.broker, transaction("withdraw-a", cas())).result.kind).toBe("committed");
    expect(call(second, transaction("withdraw-b", cas())).result).toMatchObject({ kind: "conflict", operation_index: 0 });
    expect(call(f.broker, query())).toMatchObject({ result: { rows: [{ quantity: 0, revision: 2 }] } });
  });

  it("rolls back the complete batch on conflict and durably replays that conflict", () => {
    const { broker } = fixture();
    call(broker, transaction("seed", insert()));
    const conflicting = transaction("batch", insert("new"), cas("item-1", 9));
    const result = call(broker, conflicting);
    expect(result).toMatchObject({ replayed: false, result: { kind: "conflict", operation_index: 1 } });
    expect(call(broker, query({ id: "new" }))).toMatchObject({ result: { rows: [] } });
    expect(call(broker, transaction("create-new", insert("new"))).result.kind).toBe("committed");
    expect(call(broker, conflicting)).toEqual({ ...result, replayed: true });
    expect(call(broker, query({ id: "new" }))).toMatchObject({ result: { rows: [{ revision: 1 }] } });
  });

  it("keeps deletion tombstones so a stale CAS cannot target a recreated identity", () => {
    const { broker } = fixture();
    call(broker, transaction("seed", insert()));
    expect(call(broker, transaction("delete", { kind: "delete", table: "inventory", id: "item-1", expected_revision: 1 }))).toMatchObject({ result: { operations: [{ kind: "deleted", revision: 2 }] } });
    expect(call(broker, query())).toMatchObject({ result: { rows: [] } });
    expect(call(broker, transaction("recreate", insert())).result.kind).toBe("conflict");
    expect(call(broker, transaction("stale", cas())).result.kind).toBe("conflict");
  });

  it("requires the original local permit and exact request, including for a saved result", () => {
    const f = fixture(), other = f.reopen();
    const json = JSON.stringify(transaction("create", insert())), permit = grant(f.broker, json);
    f.broker.execute(permit, json);
    expect(() => f.broker.execute(JSON.parse(JSON.stringify(permit)) as ApplicationDataInvocation, json)).toThrow(error("unauthorized"));
    expect(() => other.execute(permit, json)).toThrow(error("unauthorized"));
    expect(() => f.broker.execute(permit, JSON.stringify(transaction("changed", insert("other"))))).toThrow(error("unauthorized"));
    expect(() => f.broker.execute(grant(f.broker, json, "read"), json)).toThrow(error("unauthorized"));
    const alteredScope = { ...f.broker.getScope(), artifact_digest: `sha256:${"e".repeat(64)}` };
    expect(() => f.broker.grantInvocation({ scope: alteredScope, request_digest: f.broker.describeRequest(json).request_digest, access: "write", lifetime_ms: 100 })).toThrow(error("scope-mismatch"));
  });

  it("checks revocation, abort and monotonic expiry before idempotent replay", () => {
    let clock = 0;
    const { broker } = fixture(() => clock), json = JSON.stringify(transaction("create", insert()));
    const revoked = grant(broker, json);
    broker.execute(revoked, json); broker.revoke(revoked);
    expect(() => broker.execute(revoked, json)).toThrow(error("revoked"));
    const expired = grant(broker, json, "write", 10); clock = 10;
    expect(() => broker.execute(expired, json)).toThrow(error("expired"));
    const controller = new AbortController(), aborted = grant(broker, json, "write", 100, controller.signal);
    controller.abort();
    expect(() => broker.execute(aborted, json)).toThrow(error("aborted"));
    const live = grant(broker, json); clock = 9;
    expect(() => broker.execute(live, json)).toThrow(error("unauthorized"));
  });

  it("checks expiry immediately before COMMIT and leaves neither business writes nor an idempotency result", () => {
    let checks = 0, expired = false;
    const { broker } = fixture(() => {
      checks++;
      if (checks === 6) expired = true; // grant, dispatch, budget, transaction, operation, commit
      return expired ? 50_000 : 0;
    });
    const request = transaction("expire-at-commit", insert()), json = JSON.stringify(request);
    const permit = grant(broker, json);
    expect(() => broker.execute(permit, json)).toThrow(error("expired"));
    expect(call(broker, query())).toMatchObject({ result: { rows: [] } });
    const retry = call(broker, request);
    expect(retry).toMatchObject({ replayed: false, result: { kind: "committed" } });
  });

  it("does not derive write permission from a health route or an existing result", () => {
    const { broker } = fixture();
    const json = JSON.stringify(transaction("health-attempt", insert()));
    const readonly = grant(broker, json, "read");
    expect(() => broker.execute(readonly, json)).toThrow(error("unauthorized"));
    expect(call(broker, query())).toMatchObject({ result: { rows: [] } });
    const readJson = JSON.stringify(query());
    expect(broker.execute(grant(broker, readJson, "read"), readJson).result.kind).toBe("read");
  });

  it("treats SQL-looking strings as data and rejects non-AST escape hatches", () => {
    const { broker } = fixture();
    const item = insert(); item.values.name = "'; DROP TABLE app_inventory; --";
    call(broker, transaction("quoted", item));
    expect(call(broker, query())).toMatchObject({ result: { rows: [{ name: item.values.name }] } });
    const rejected: unknown[] = [
      { version: 1, kind: "sql", sql: "SELECT * FROM sqlite_schema" },
      transaction("raw", { kind: "query", table: "inventory", columns: ["id"], limit: 1, where: "1=1" }),
      transaction("hidden", { ...insert(), table: "artoo_app_metadata" }),
      transaction("negative", cas("item-1", 1, -1)),
      transaction("noninteger", cas("item-1", 1, 0.5)),
      transaction("metadata", { ...cas(), values: { revision: 999 } }),
      transaction("unknown", { ...insert("other"), values: { name: "only one field" } }),
      query({ id: "item-1", after: "item-0" }), query({ limit: 101 }), query({ columns: ["name", "name"] }),
      query({ columns: ["deleted"] }),
    ];
    for (const request of rejected) expect(() => broker.describeRequest(JSON.stringify(request))).toThrow(error("invalid-request"));
    expect(() => broker.describeRequest("{".repeat(65_537))).toThrow(error("invalid-request"));
  });

  it("enforces UTF-8 bytes, not just string length, before writing", () => {
    const { broker } = fixture();
    const item = insert(); item.values.name = "中".repeat(43);
    expect(() => call(broker, transaction("oversized", item))).toThrow(error("invalid-request"));
    expect(call(broker, query())).toMatchObject({ result: { rows: [] } });
  });

  it("binds the semantic AST while ignoring harmless JSON property order", () => {
    const { broker } = fixture();
    const first = JSON.stringify(query({ limit: 1 }));
    const reordered = JSON.stringify({ query: { columns: ["id", "revision", "name", "quantity", "active", "note"], table: "inventory", limit: 1, kind: "query" }, kind: "read", version: 1 });
    expect(broker.describeRequest(first)).toEqual(broker.describeRequest(reordered));
    expect(broker.execute(grant(broker, first, "read"), reordered).result.kind).toBe("read");
  });

  it("rejects an oversized reply before committing and remains usable for a bounded query", () => {
    const largeSchema = structuredClone(schema); largeSchema.tables[0]!.columns[0]!.max_bytes = 4_096;
    const { broker } = fixture(undefined, largeSchema);
    for (let batch = 0; batch < 6; batch++) {
      const operations = Array.from({ length: 11 }, (_, i) => {
        const item = insert(`large-${String(batch * 11 + i).padStart(3, "0")}`); item.values.name = "x".repeat(4_096); return item;
      });
      call(broker, transaction(`seed-${batch}`, ...operations));
    }
    expect(() => call(broker, query())).toThrow(error("limit"));
    expect(call(broker, query({ limit: 1 }))).toMatchObject({ result: { rows: [{ revision: 1 }] } });
  });

  it("rejects schema changes on reopen, with no silent migration or data reset", () => {
    const f = fixture(); call(f.broker, transaction("seed", insert())); f.broker.close();
    const changed = structuredClone(schema); changed.tables[0]!.columns[1]!.min = -1;
    expect(() => new ApplicationDataBroker({ databasePath: f.databasePath, mode: "open", schemaJson: JSON.stringify(changed), scope: initialScope })).toThrow(error("storage-unavailable"));
    expect(call(f.reopen(), query())).toMatchObject({ result: { rows: [{ quantity: 1 }] } });
  });

  it("detects unexpected SQL objects and schema mutation after open", () => {
    const f = fixture();
    const outside = new DatabaseSync(f.databasePath);
    try { outside.exec("CREATE TABLE unexpected (value TEXT)"); } finally { outside.close(); }
    expect(() => call(f.broker, query())).toThrow(error("storage-unavailable"));
    f.broker.close();
    expect(() => f.reopen()).toThrow(error("storage-unavailable"));
  });

  it("will not overwrite an existing store or create a missing store in open mode", () => {
    const f = fixture();
    expect(() => new ApplicationDataBroker({ databasePath: f.databasePath, mode: "create", schemaJson: f.schemaJson, scope: initialScope })).toThrow(error("storage-unavailable"));
    expect(() => new ApplicationDataBroker({ databasePath: `${f.databasePath}.missing`, mode: "open", schemaJson: f.schemaJson, scope: initialScope })).toThrow(error("storage-unavailable"));
    f.broker.close();
    expect(() => call(f.broker, query())).toThrow(error("closed"));
  });
});
