import assert from "node:assert/strict";
import { test } from "node:test";

import { createRetentionControl, verifyRetentionHistory } from "./ios-ui-retention-fixture.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function controlFor(t, overrides = {}, options = {}) {
  const calls = [], errors = [];
  const scenario = {
    async observe() { calls.push("observe"); return { snapshot: null, live_pids: [] }; },
    async waitForCheckpoint(name) { calls.push(name); return { name, observation: {} }; },
    async close() { calls.push("close"); },
    ...overrides,
  };
  const control = await createRetentionControl({ scenario, errors, ...options });
  t.after(() => control.close());
  const request = async (path, { method = "GET", token = control.token, body } = {}) => {
    const response = await fetch(`${control.url}${path}`, { method, headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    }, ...(body === undefined ? {} : { body }) });
    return { status: response.status, body: await response.json() };
  };
  return { control, request, calls, errors };
}

test("control requires its actual loopback credential and exposes only observation/checkpoint routes", async (t) => {
  const { request, calls } = await controlFor(t);
  for (const token of [null, "wrong-token"]) {
    assert.equal((await request("/observations", { token })).status, 401);
    assert.equal((await request("/checkpoints/completed", { method: "POST", token, body: "{}" })).status, 401);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request("/tasks", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await request("/node/stop", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await request("/checkpoints/unknown", { method: "POST", body: "{}" })).status, 404);
  assert.equal((await request("/observations?mutate=true")).status, 404);
  assert.deepEqual(await request("/observations"), { status: 200, body: { snapshot: null, live_pids: [] } });
  assert.deepEqual(calls, ["observe"]);
});

test("checkpoint accepts only an empty JSON object and rejects future or repeated boundaries", async (t) => {
  const { request, calls } = await controlFor(t);
  for (const body of ["", "null", "[]", '{"task_id":"forged"}', "{invalid", " ".repeat(1025) + "{}"]) {
    assert.equal((await request("/checkpoints/completed", { method: "POST", body })).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request("/checkpoints/relaunched", { method: "POST", body: "{}" })).status, 409);
  assert.equal((await request("/checkpoints/completed", { method: "POST", body: " {}\n" })).status, 200);
  assert.equal((await request("/checkpoints/completed", { method: "POST", body: "{}" })).status, 409);
  assert.deepEqual(calls, ["completed"]);
});

test("concurrent checkpoint submissions execute serially and a queued name cannot be submitted twice", async (t) => {
  const firstEntered = deferred(), releaseFirst = deferred(), executed = [];
  let active = 0, maximum = 0;
  const { request } = await controlFor(t, { async waitForCheckpoint(name) {
    active++; maximum = Math.max(maximum, active); executed.push(name);
    if (name === "completed") { firstEntered.resolve(); await releaseFirst.promise; }
    active--;
    return { name, observation: {} };
  }, async close() { releaseFirst.resolve(); } });
  const first = request("/checkpoints/completed", { method: "POST", body: "{}" });
  await firstEntered.promise;
  const second = request("/checkpoints/relaunched", { method: "POST", body: "{}" });
  const duplicate = request("/checkpoints/relaunched", { method: "POST", body: "{}" });
  assert.equal((await Promise.race([second, duplicate])).status, 409);
  assert.deepEqual(executed, ["completed"], "The already-reserved second boundary must wait for the first observer");
  releaseFirst.resolve();
  assert.equal((await first).status, 200);
  assert.deepEqual((await Promise.all([second, duplicate])).map((value) => value.status).sort(), [200, 409]);
  assert.deepEqual(executed, ["completed", "relaunched"]);
  assert.equal(maximum, 1);
});

test("wire failures stay generic while the parent retains the exact original error", async (t) => {
  const original = new Error("Private fixture diagnostic with task/context details");
  const { request, errors } = await controlFor(t, {
    async observe() { throw original; },
    async waitForCheckpoint() { throw original; },
  });
  assert.deepEqual(await request("/observations"), { status: 500, body: { error: "Retention observation failed" } });
  assert.deepEqual(await request("/checkpoints/completed", { method: "POST", body: "{}" }),
    { status: 500, body: { error: "Retention checkpoint failed" } });
  assert.deepEqual(errors, [original, original]);
  assert.equal((await request("/checkpoints/completed", { method: "POST", body: "{}" })).status, 409);
});

test("close aborts a pending checkpoint before waiting on its queue and is idempotent", { timeout: 3000 }, async (t) => {
  const entered = deferred(), waiting = deferred(), aborted = new Error("Owned observer closed");
  let closeCount = 0;
  const { control, request, errors } = await controlFor(t, {
    async waitForCheckpoint() { entered.resolve(); return waiting.promise; },
    async close() { closeCount++; waiting.reject(aborted); },
  });
  const pending = request("/checkpoints/completed", { method: "POST", body: "{}" }).catch((error) => ({ disconnected: true, error }));
  await entered.promise;
  await control.close();
  await control.close();
  await pending;
  assert.equal(closeCount, 1);
  assert.deepEqual(errors, [aborted]);
});


test("cold recovery rejects changed durable identities or file bytes but allows a newer observation time", () => {
  const original = { snapshot: { task: { id: "task_a", status: "review" }, runs: [{ id: "run_a" }], approvals: [{ id: "approval_a" }], reviews: [], artifacts: [] },
    run_reads: [{ id: "run_a" }], receipts: [{ run_id: "run_a", pid: 123 }], launches: [{ run_id: "run_a" }],
    contexts: [{ sha256: "original" }], workspace: { root: "/owned/work", files: { "ignored.bin": "original" } }, base: { head: "original" }, live_pids: [], observed_at: "before" };
  const later = structuredClone(original); later.observed_at = "after"; later.snapshot.version_cursor = 42;
  assert.equal(verifyRetentionHistory(original, later), true);
  for (const mutate of [
    (value) => value.snapshot.artifacts.push({ id: "unexpected" }),
    (value) => value.snapshot.runs.push({ id: "duplicate" }),
    (value) => { value.snapshot.runs[0].id = "wrong"; },
    (value) => { value.workspace.files["ignored.bin"] = "changed"; },
    (value) => value.live_pids.push(999),
  ]) { const changed = structuredClone(later); mutate(changed); assert.throws(() => verifyRetentionHistory(original, changed)); }
});


test("clipboard observer routing is inside the existing private loopback authentication boundary", async (t) => {
  const calls = [];
  const clipboard = {
    handle(req, reply) {
      if (req.url !== "/clipboard/read") return false;
      calls.push("read"); req.resume(); reply(200, { observed: true }); return true;
    },
    async close() { calls.push("closed"); },
    evidence() { return [{ infrastructure_only: true }]; },
  };
  const { control, request } = await controlFor(t, {}, { clipboard });
  for (const token of [null, "wrong-token"]) {
    assert.equal((await request("/clipboard/read", { method: "POST", token, body: "{}" })).status, 401);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request("/clipboard/read", { method: "POST", body: "{}" })).status, 200);
  assert.deepEqual(calls, ["read"]);
  assert.deepEqual(control.clipboardEvidence(), [{ infrastructure_only: true }]);
  await control.close(); assert.deepEqual(calls, ["read", "closed"]);
});
