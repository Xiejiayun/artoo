// Requires a fresh @artoo/artood build. Real SQLite connections on simultaneous workers;
// this is not generated-product, native isolation, or service-lifetime acceptance.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { ApplicationDataBroker } from "../dist/application-data-broker.js";

const schemaJson = JSON.stringify({ version: 1, tables: [{ name: "inventory", columns: [
  { name: "quantity", type: "integer", nullable: false, min: 0, max: 100 },
] }] });
const scope = { product_id: "inventory-contention", data_generation: "data-original", service_generation: 1,
  artifact_digest: `sha256:${"a".repeat(64)}` };
function execute(broker, request) {
  const json = JSON.stringify(request);
  const permit = broker.grantInvocation({ scope: broker.getScope(), request_digest: broker.describeRequest(json).request_digest,
    access: "write", lifetime_ms: 10_000 });
  return broker.execute(permit, json);
}
function mutation(key, operation) { return { version: 1, kind: "transaction", idempotency_key: key, operations: [operation] }; }

if (!isMainThread) {
  let broker;
  try {
    broker = new ApplicationDataBroker({ databasePath: workerData.databasePath, mode: "open", schemaJson, scope });
    const barrier = new Int32Array(workerData.barrier);
    parentPort.postMessage({ kind: "ready" });
    const waited = Atomics.wait(barrier, 0, 0, 10_000);
    assert.notEqual(waited, "timed-out");
    const result = execute(broker, mutation(workerData.key, { kind: "compare-and-set", table: "inventory", id: "last-item",
      expected_revision: 1, values: { quantity: 0 } }));
    broker.close(); broker = undefined;
    parentPort.postMessage({ kind: "result", result });
  } catch (error) {
    // Keep diagnostic category; no raw database values, paths or query text in replies.
    parentPort.postMessage({ kind: "failed", code: typeof error?.code === "string" ? error.code : "unexpected-worker-failure" });
    process.exitCode = 1;
  } finally {
    if (broker) broker.close();
    parentPort.close();
  }
} else {
  async function bounded(promise, milliseconds = 15_000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Original application-data worker deadline exceeded")), milliseconds);
    })]); } finally { clearTimeout(timer); }
  }
  function contender(databasePath, barrier, key, script = new URL(import.meta.url)) {
    const worker = new Worker(script, { workerData: { databasePath, barrier, key } });
    let ready, result, exited, exitCode, failure;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    const resultPromise = new Promise(resolve => { result = resolve; });
    const exitPromise = new Promise(resolve => { exited = resolve; });
    worker.on("message", message => {
      if (message.kind === "ready") ready(message);
      else if (message.kind === "result") result(message);
      else if (message.kind === "failed") { failure = message; ready(message); result(message); }
    });
    worker.on("error", error => { failure = { kind: "worker-error", message: error.message }; ready(failure); result(failure); });
    worker.on("exit", code => {
      exitCode = code;
      const missing = failure ?? { kind: "exited-without-required-message", code };
      ready(missing); result(missing); exited(code);
    });
    return { worker, ready: readyPromise, result: resultPromise, exited: exitPromise,
      async close() {
        if (exitCode === undefined) await bounded(worker.terminate(), 5_000);
        await bounded(exitPromise, 5_000);
      } };
  }
  function startContenders(workers, databasePath, barrier, create = contender) {
    // Register the original handle before attempting another possibly throwing constructor.
    workers.push(create(databasePath, barrier, "withdraw-a"));
    workers.push(create(databasePath, barrier, "withdraw-b"));
  }
  async function withCleanup(body, cleanup, signal) {
    let failed;
    try { await body(); } catch (error) { failed = { error }; }
    try { await cleanup(!!failed || signal?.aborted === true); }
    catch (error) {
      if (failed) throw new AggregateError([failed.error, error], "Application-data test and original cleanup both failed");
      throw error;
    }
    if (failed) throw failed.error;
  }
  async function closeAndRemove(directory, broker, workers, barrier, retain = false, signal) {
    Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0, 2);
    const closure = await Promise.allSettled(workers.map(async worker => worker.close()));
    const failures = closure.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    try { if (broker) broker.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Original worker or broker closure unknown; test store retained");
    // The test may cross its deadline while original Worker closure is awaited.
    if (retain || signal?.aborted) return;
    // Only this fixture's direct temporary children may be recursively removed.
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(basename(directory), /^artoo-application-data-(?:contention|construction|retention)-/u);
    rmSync(directory, { recursive: true, force: true });
  }

  test("simultaneous independent SQLite workers commit one withdrawal and preserve replay after service restart", { timeout: 40_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), "artoo-application-data-contention-"));
    const databasePath = join(directory, "product.sqlite"), barrier = new SharedArrayBuffer(4);
    const workers = [];
    let broker;
    await withCleanup(async () => {
      broker = new ApplicationDataBroker({ databasePath, mode: "create", schemaJson, scope });
      execute(broker, mutation("seed", { kind: "insert", table: "inventory", id: "last-item", values: { quantity: 1 } }));
      startContenders(workers, databasePath, barrier);
      const ready = await bounded(Promise.all(workers.map(worker => worker.ready)));
      assert.deepEqual(ready.map(message => message.kind), ["ready", "ready"]);
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      const messages = await bounded(Promise.all(workers.map(worker => worker.result)));
      assert.deepEqual(messages.map(message => message.kind), ["result", "result"]);
      assert.deepEqual(messages.map(message => message.result.result.kind).sort(), ["committed", "conflict"]);
      assert.deepEqual(await bounded(Promise.all(workers.map(worker => worker.exited))), [0, 0]);
      const read = { version: 1, kind: "read", query: { kind: "query", table: "inventory", columns: ["id", "revision", "quantity"], id: "last-item", limit: 1 } };
      assert.deepEqual(execute(broker, read).result.rows.map(row => ({ ...row })), [{ id: "last-item", revision: 2, quantity: 0 }]);
      const successor = broker.rotateService({ service_generation: 2, artifact_digest: `sha256:${"b".repeat(64)}` });
      broker.close(); broker = new ApplicationDataBroker({ databasePath, mode: "open", schemaJson, scope: successor });
      for (const [index, key] of ["withdraw-a", "withdraw-b"].entries()) {
        const replay = execute(broker, mutation(key, { kind: "compare-and-set", table: "inventory", id: "last-item", expected_revision: 1, values: { quantity: 0 } }));
        assert.deepEqual(replay, { ...messages[index].result, replayed: true });
      }
      assert.equal(execute(broker, read).result.rows[0].revision, 2);
      broker.close(); broker = undefined;
    }, async retain => {
      // Wait the actual original workers before deleting their database, including on failure.
      await closeAndRemove(directory, broker, workers, barrier, retain, context.signal);
    }, context.signal);
  });

  for (const closure of ["confirmed", "unknown"]) {
    test(`second Worker construction failure retains the first original handle (${closure} closure)`, { timeout: 30_000 }, async context => {
      const directory = mkdtempSync(join(tmpdir(), "artoo-application-data-construction-"));
      const databasePath = join(directory, "product.sqlite"), barrier = new SharedArrayBuffer(4);
      const workers = [], originals = [];
      let broker;
      let exitObserved = false;
      await withCleanup(async () => {
        broker = new ApplicationDataBroker({ databasePath, mode: "create", schemaJson, scope });
        execute(broker, mutation("seed", { kind: "insert", table: "inventory", id: "last-item", values: { quantity: 1 } }));
        assert.throws(() => startContenders(workers, databasePath, barrier, (file, shared, key) => {
          // This is an actual synchronous Worker constructor rejection, not a rejected task.
          const worker = contender(file, shared, key, originals.length ? "invalid-worker-script" : new URL(import.meta.url));
          originals.push(worker); // Test rescue retains originals even if registration regresses.
          worker.worker.once("exit", () => { exitObserved = true; });
          return worker;
        }), { code: "ERR_WORKER_PATH" });
        assert.equal(workers.length, 1);
        assert.equal(workers[0], originals[0]);
        assert.equal((await bounded(originals[0].ready)).kind, "ready");
        assert.equal(exitObserved, false); // The original Worker is still held by its start barrier.
        assert.equal(existsSync(directory), true);
        const closeOriginal = originals[0].close;
        // A controlled unknown-closure report must never authorize deletion. The rescue
        // below separately waits the genuine original handle before removing test data.
        workers[0] = { ...originals[0], async close() {
          if (closure === "unknown") throw new Error("Injected closure uncertainty");
          await closeOriginal();
          assert.equal(exitObserved, true);
          assert.equal(existsSync(directory), true);
        } };
        // Keep the sample until every assertion passes; the outer cleanup owns deletion.
        const cleanup = closeAndRemove(directory, broker, workers, barrier, true, context.signal);
        assert.equal(existsSync(directory), true);
        if (closure === "unknown") {
          await assert.rejects(cleanup, /Original worker or broker closure unknown; test store retained/u);
          assert.equal(existsSync(directory), true);
        } else {
          await cleanup;
          assert.equal(exitObserved, true);
          assert.equal(existsSync(directory), true);
        }
      }, async retain => {
        // This rescue uses the real, unmodified handles even when the fault was injected.
        await closeAndRemove(directory, broker, originals, barrier, retain, context.signal);
      }, context.signal);
      assert.equal(existsSync(directory), false);
    });
  }

  for (const cleanupFails of [false, true]) {
    test(`failed body retains its store after original Worker exit and broker closure (cleanup failure: ${cleanupFails})`, { timeout: 30_000 }, async context => {
      const directory = mkdtempSync(join(tmpdir(), "artoo-application-data-retention-"));
      const databasePath = join(directory, "product.sqlite"), barrier = new SharedArrayBuffer(4), originals = [];
      let broker, exitObserved = false;
      await withCleanup(async () => {
        broker = new ApplicationDataBroker({ databasePath, mode: "create", schemaJson, scope });
        execute(broker, mutation("seed", { kind: "insert", table: "inventory", id: "last-item", values: { quantity: 1 } }));
        const worker = contender(databasePath, barrier, "withdraw"); originals.push(worker);
        worker.worker.once("exit", () => { exitObserved = true; });
        assert.equal((await bounded(worker.ready)).kind, "ready");
        const bodyFailure = new Error("Injected body failure"), cleanupFailure = new Error("Injected cleanup failure");
        const closeOriginal = worker.close;
        const workers = [{ ...worker, async close() { await closeOriginal(); if (cleanupFails) throw cleanupFailure; } }];
        await assert.rejects(withCleanup(async () => { throw bodyFailure; }, retain => {
          assert.equal(retain, true); return closeAndRemove(directory, broker, workers, barrier, retain);
        }), error => {
          if (!cleanupFails) return error === bodyFailure;
          assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], bodyFailure);
          assert.ok(error.errors[1] instanceof AggregateError); assert.deepEqual(error.errors[1].errors, [cleanupFailure]);
          return true;
        });
        assert.equal(exitObserved, true);
        assert.throws(() => broker.getScope(), { code: "closed" });
        assert.equal(existsSync(directory), true);
      }, retain => closeAndRemove(directory, broker, originals, barrier, retain, context.signal), context.signal);
    });
  }

  test("a deadline observed during original Worker closure retains the store", { timeout: 30_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), "artoo-application-data-retention-"));
    const databasePath = join(directory, "product.sqlite"), barrier = new SharedArrayBuffer(4), originals = [];
    let broker;
    await withCleanup(async () => {
      broker = new ApplicationDataBroker({ databasePath, mode: "create", schemaJson, scope });
      execute(broker, mutation("seed", { kind: "insert", table: "inventory", id: "last-item", values: { quantity: 1 } }));
      const worker = contender(databasePath, barrier, "withdraw"); originals.push(worker);
      assert.equal((await bounded(worker.ready)).kind, "ready");
      const controller = new AbortController();
      const closing = { ...worker, async close() { await worker.close(); controller.abort(); } };
      await closeAndRemove(directory, broker, [closing], barrier, false, controller.signal);
      assert.equal(controller.signal.aborted, true);
      assert.throws(() => broker.getScope(), { code: "closed" });
      assert.equal(existsSync(directory), true);
    }, retain => closeAndRemove(directory, broker, originals, barrier, retain, context.signal), context.signal);
  });
}
