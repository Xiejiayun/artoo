import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, type TestContext } from "vitest";
import { settledServerFixture } from "../src/test-fixtures/settled-server-fixture.js";

const output = process.env.ARTOO_SETTLED_FIXTURE_OUTPUT;
if (!output) throw new Error("Run this fixture through its parent harness");
const trace = join(output, "trace.jsonl");
const emit = (name: string, event: string, details: object = {}) => appendFileSync(trace,
  JSON.stringify({ name, event, at: performance.now(), pid: process.pid, ...details }) + "\n");
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
type State = { root?: string; db?: PGlite; context?: TestContext; gate: ReturnType<typeof deferred>; identity: object };
const records = new Map<string, State>();
const create = (): State => ({ gate: deferred(), identity: {} });
function observe(event: string, context: TestContext, details: Record<string, unknown>) {
  emit(context.task.name, event, details);
  if (event === "drain-started") records.get(context.task.name)?.gate.resolve();
}

describe("body ownership", () => {
  const scope = settledServerFixture(create, { observe });
  const it = scope.it;
  scope.beforeEach(async (state, context) => {
    state.context = context; records.set(context.task.name, state);
    state.root = await scope.temporary("artoo-settled-body-");
    const db = state.db = await scope.acquire(PGlite.create());
    scope.own({ async close() { emit(context.task.name, "database-close-started"); await db.close(); emit(context.task.name, "database-closed"); } });
  });
  scope.afterEach((state, context) => {
    assert.equal(context, state.context); assert.equal(scope.context(), context);
    emit(context.task.name, "cleanup-context-same");
  });
  it("body timeout drains original database query", async context => {
    const state = scope.current(), db = state.db!;
    assert.equal(state.context, context); assert.equal(scope.context(), context);
    await state.gate.promise; // Released by the real timeout's afterEach, not a fake timer.
    assert.equal(context.signal.aborted, true); assert.equal(db.closed, false);
    const rows = await db.query<{ value: number }>("select 17 as value");
    expect(rows.rows[0]!.value).toBe(17);
    await writeFile(join(state.root!, "late-query.json"), JSON.stringify(rows.rows));
    emit(context.task.name, "late-query-confirmed", { root: state.root, closed: db.closed });
  }, 100);
  it("ordinary assertion remains failed after safe close", async () => {
    expect("actual", "original fixture assertion").toBe("expected");
  });
  const identities = new Set<object>();
  it.each(["first", "second"])("native parameter case %s", async name => {
    const state = scope.current(), context = scope.context();
    assert.equal(context, state.context); assert.equal(context.task.name, "native parameter case " + name);
    assert.equal(identities.has(state.identity), false); identities.add(state.identity);
    emit(context.task.name, "parameter-context-confirmed", { value: name });
    expect((await state.db!.query<{ value: number }>("select 23 as value")).rows[0]!.value).toBe(23);
  });
  it("native explicit timeout is preserved", async context => {
    expect(context.task.timeout).toBe(120000);
    assert.equal(scope.context(), context); emit(context.task.name, "explicit-timeout-confirmed", { timeout: context.task.timeout });
  }, 120000);
});

describe("setup ownership", () => {
  const scope = settledServerFixture(create, { observe });
  const it = scope.it;
  scope.beforeEach(async (state, context) => {
    state.context = context; records.set(context.task.name, state);
    state.root = await scope.temporary("artoo-settled-setup-");
    await state.gate.promise; // The original setup continues only after its actual hook timeout.
    assert.equal(context.signal.aborted, true);
    const db = state.db = await scope.acquire(PGlite.create());
    // Simulates onResourceAcquired: registration is allowed after cancellation and before a server is exposed.
    scope.own({ async close() { emit(context.task.name, "database-close-started"); await db.close(); emit(context.task.name, "database-closed"); } });
    assert.equal(db.closed, false); expect((await db.query<{ value: number }>("select 31 as value")).rows[0]!.value).toBe(31);
    emit(context.task.name, "late-setup-query-confirmed", { root: state.root });
  }, 100);
  scope.afterEach((state, context) => { assert.equal(context, state.context); emit(context.task.name, "cleanup-context-same"); });
  it("setup timeout drains late acquisition", () => { emit("setup timeout drains late acquisition", "unexpected-body-entered"); });
});

describe("expired ownership", () => {
  const lateClosed = deferred();
  const scope = settledServerFixture(create, { drainMs: 40, observe(event, context, details) {
    emit(context.task.name, event, details);
    if (event === "retained") records.get(context.task.name)?.gate.resolve();
    if (event === "close-confirmed") lateClosed.resolve();
  } });
  const it = scope.it;
  scope.beforeEach(async (state, context) => {
    state.context = context; records.set(context.task.name, state);
    state.root = await scope.temporary("artoo-settled-expired-");
    scope.own({ async close() { emit(context.task.name, "late-owned-close"); } });
  });
  scope.afterEach(() => { emit("drain expiry retains late resource", "unexpected-global-cleanup"); });
  it("drain expiry retains late resource", async () => {
    const state = scope.current();
    await state.gate.promise;
    assert.equal(state.context!.signal.aborted, true);
    await writeFile(join(state.root!, "retained.txt"), "original timed-out case");
    emit(state.context!.task.name, "late-body-root-retained", { root: state.root, exists: existsSync(state.root!) });
  }, 100);
  it("next body is refused after uncertain closure", () => { emit("next body is refused after uncertain closure", "unexpected-body-entered"); });
  // The case remains failed/retained. Keep the worker alive until its original continuation actually closes.
  afterAll(async () => { await lateClosed.promise; });
});
