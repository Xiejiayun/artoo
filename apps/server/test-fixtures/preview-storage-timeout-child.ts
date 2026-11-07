import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { access, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, type TestContext } from "vitest";
import { finishStorageCase, storageCase, type PreviewStorageScope } from "../src/test-fixtures/preview-storage-scope.js";

const evidence = process.env.ARTOO_STORAGE_HARNESS_EVIDENCE;
if (!evidence) throw new Error("Harness evidence directory is required");
const trace = join(evidence, "trace.jsonl");
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function record(name: string, event: string, data: object = {}) {
  appendFileSync(trace, JSON.stringify({ name, event, at: performance.now(), pid: process.pid, ...data }) + "\n");
}
const exists = (path: string) => access(path).then(() => true, error => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
  throw error;
});
type State = { context: TestContext; root?: string; closes: number; afterEachStarted: ReturnType<typeof deferred>;
  releaseLateBody: ReturnType<typeof deferred>; bodyFinished: ReturnType<typeof deferred> };
const states = new Map<string, State>();

function tracked(name: string, body: (scope: PreviewStorageScope, state: State) => Promise<void>) {
  return (context: TestContext) => {
    const state: State = { context, closes: 0, afterEachStarted: deferred(), releaseLateBody: deferred(), bodyFinished: deferred() };
    states.set(name, state);
    record(name, "body-started");
    const work = storageCase(scope => body(scope, state))(context);
    work.then(() => { record(name, "body-settled", { outcome: "fulfilled" }); state.bodyFinished.resolve(); }, error => {
      record(name, "body-settled", { outcome: "rejected", message: error instanceof Error ? error.message : String(error) });
      state.bodyFinished.resolve();
    });
    return work;
  };
}
async function resource(name: string, scope: PreviewStorageScope, state: State, failClose = false) {
  state.root = await scope.temporary();
  record(name, "root-created", { root: state.root });
  const handle = await open(join(state.root, "open-file.txt"), "wx");
  return scope.own({ async close() {
    state.closes++;
    record(name, "close-started", { calls: state.closes });
    await handle.close();
    record(name, "native-close-confirmed");
    if (failClose) throw new Error("controlled close confirmation failure");
    record(name, "close-done");
  } });
}

afterEach(async context => {
  const name = context.task.name;
  const state = states.get(name);
  if (!state) return; // The final sentinel owns no storageCase.
  const same = state.context === context;
  record(name, "context-identity", { same });
  assert.equal(same, true, "Test body and afterEach must receive the identical TestContext object");
  record(name, "afterEach-started", { aborted: context.signal.aborted });
  state.afterEachStarted.resolve();
  try {
    await finishStorageCase(context);
    record(name, "afterEach-completed", { rootExists: state.root === undefined ? null : await exists(state.root) });
  } catch (error) {
    record(name, "afterEach-failed", { message: error instanceof Error ? error.message : String(error),
      rootExists: state.root === undefined ? null : await exists(state.root) });
    throw error;
  } finally {
    if (name === "drain expiry retains after late completion") state.releaseLateBody.resolve();
  }
}, 30_000);

it("timeout drains original write and close", tracked("timeout drains original write and close", async (scope, state) => {
  const owned = await resource("timeout drains original write and close", scope, state);
  try {
    await state.afterEachStarted.promise;
    await writeFile(join(state.root!, "late-write.txt"), "write after the real Vitest timeout");
    record("timeout drains original write and close", "write-done");
    scope.checkpoint();
  } finally { await scope.close(owned); }
}), 200);

it("ordinary assertion preserves failure and cleans", tracked("ordinary assertion preserves failure and cleans", async (scope, state) => {
  const owned = await resource("ordinary assertion preserves failure and cleans", scope, state);
  try { expect("actual", "ordinary storage assertion").toBe("expected"); }
  finally { await scope.close(owned); }
}));

it("failed close confirmation retains", tracked("failed close confirmation retains", async (scope, state) => {
  const owned = await resource("failed close confirmation retains", scope, state, true);
  try { await writeFile(join(state.root!, "data.txt"), "controlled close rejection fixture"); }
  finally { await scope.close(owned); }
}));

it("drain expiry retains after late completion", tracked("drain expiry retains after late completion", async (scope, state) => {
  const owned = await resource("drain expiry retains after late completion", scope, state);
  try {
    await state.releaseLateBody.promise;
    await writeFile(join(state.root!, "late-write.txt"), "write after drain expiry");
    record("drain expiry retains after late completion", "write-done");
  } finally { await scope.close(owned); }
}), 200);

it("late completion sentinel", async () => {
  const state = states.get("drain expiry retains after late completion")!;
  await state.bodyFinished.promise;
  expect(state.closes).toBe(1);
  expect(await exists(state.root!)).toBe(true);
  expect(await readFile(join(state.root!, "late-write.txt"), "utf8")).toBe("write after drain expiry");
  record("late completion sentinel", "retention-confirmed", { root: state.root, closes: state.closes });
});

it("unexpected rejected operation preserves assertion and retains", tracked("unexpected rejected operation preserves assertion and retains", async (scope, state) => {
  const name = "unexpected rejected operation preserves assertion and retains";
  state.root = await scope.temporary();
  record(name, "root-created", { root: state.root });
  const operation = (async () => {
    const handle = await open(join(state.root!, "hidden-resource.txt"), "wx");
    state.closes++;
    record(name, "close-started", { calls: state.closes });
    await handle.close();
    record(name, "native-close-confirmed");
    // Controlled hidden cleanup rejection; the real file handle is already shut.
    throw new Error("controlled hidden close confirmation failure");
  })();
  await scope.expectedRejection(operation, promise => expect(promise, "original expected rejection assertion")
    .rejects.toThrow("expected rejection before acquisition"));
}));

it("expected rejected operation permits cleanup", tracked("expected rejected operation permits cleanup", async (scope, state) => {
  const name = "expected rejected operation permits cleanup";
  state.root = await scope.temporary();
  record(name, "root-created", { root: state.root });
  await scope.expectedRejection(Promise.reject(new Error("expected rejection before acquisition")),
    operation => expect(operation).rejects.toThrow("expected rejection before acquisition"));
}));
