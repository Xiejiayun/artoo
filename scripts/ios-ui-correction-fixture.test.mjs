import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createCorrectionControl, readCorrectionArtifact } from "./ios-ui-correction-fixture.mjs";

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
  const control = await createCorrectionControl({ scenario, errors, ...options });
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
    assert.equal((await request("/checkpoints/initial", { method: "POST", token, body: "{}" })).status, 401);
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
    assert.equal((await request("/checkpoints/initial", { method: "POST", body })).status, 400);
  }
  assert.deepEqual(calls, []);
  assert.equal((await request("/checkpoints/failed", { method: "POST", body: "{}" })).status, 409);
  assert.equal((await request("/checkpoints/initial", { method: "POST", body: " {}\n" })).status, 200);
  assert.equal((await request("/checkpoints/initial", { method: "POST", body: "{}" })).status, 409);
  assert.deepEqual(calls, ["initial"]);
});

test("concurrent checkpoint submissions execute serially and a queued name cannot be submitted twice", async (t) => {
  const firstEntered = deferred(), releaseFirst = deferred(), executed = [];
  let active = 0, maximum = 0;
  const { request } = await controlFor(t, { async waitForCheckpoint(name) {
    active++; maximum = Math.max(maximum, active); executed.push(name);
    if (name === "initial") { firstEntered.resolve(); await releaseFirst.promise; }
    active--;
    return { name, observation: {} };
  }, async close() { releaseFirst.resolve(); } });
  const first = request("/checkpoints/initial", { method: "POST", body: "{}" });
  await firstEntered.promise;
  const second = request("/checkpoints/changes_requested", { method: "POST", body: "{}" });
  const duplicate = request("/checkpoints/changes_requested", { method: "POST", body: "{}" });
  assert.equal((await Promise.race([second, duplicate])).status, 409);
  assert.deepEqual(executed, ["initial"], "The already-reserved second boundary must wait for the first observer");
  releaseFirst.resolve();
  assert.equal((await first).status, 200);
  assert.deepEqual((await Promise.all([second, duplicate])).map((value) => value.status).sort(), [200, 409]);
  assert.deepEqual(executed, ["initial", "changes_requested"]);
  assert.equal(maximum, 1);
});

test("wire failures stay generic while the parent retains the exact original error", async (t) => {
  const original = new Error("Private fixture diagnostic with task/context details");
  const { request, errors } = await controlFor(t, {
    async observe() { throw original; },
    async waitForCheckpoint() { throw original; },
  });
  assert.deepEqual(await request("/observations"), { status: 500, body: { error: "Correction observation failed" } });
  assert.deepEqual(await request("/checkpoints/initial", { method: "POST", body: "{}" }),
    { status: 500, body: { error: "Correction checkpoint failed" } });
  assert.deepEqual(errors, [original, original]);
  assert.equal((await request("/checkpoints/initial", { method: "POST", body: "{}" })).status, 409);
});

test("close aborts a pending checkpoint before waiting on its queue and is idempotent", { timeout: 3000 }, async (t) => {
  const entered = deferred(), waiting = deferred(), aborted = new Error("Owned observer closed");
  let closeCount = 0;
  const { control, request, errors } = await controlFor(t, {
    async waitForCheckpoint() { entered.resolve(); return waiting.promise; },
    async close() { closeCount++; waiting.reject(aborted); },
  });
  const pending = request("/checkpoints/initial", { method: "POST", body: "{}" }).catch((error) => ({ disconnected: true, error }));
  await entered.promise;
  await control.close();
  await control.close();
  await pending;
  assert.equal(closeCount, 1);
  assert.deepEqual(errors, [aborted]);
});

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("artifact download uses real authenticated HTTP and preserves the original bytes", async (t) => {
  const bytes = Buffer.from("diff --git a/test b/test\n+实际产物\n"), requests = [];
  const origin = await localServer(t, (req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/octet-stream" }); res.end(bytes);
  });
  const artifact = { id: "artifact_exact", uri: "/api/v1/artifacts/artifact_exact/content" };
  assert.deepEqual(await readCorrectionArtifact({ origin, peerToken: "owned-peer-credential", artifact }), bytes);
  assert.deepEqual(requests, [{ path: artifact.uri, authorization: "Bearer owned-peer-credential" }]);
  for (const uri of ["https://example.invalid/private", "//example.invalid/private", `${origin}${artifact.uri}`, `${artifact.uri}?extra=1`, `${artifact.uri}#fragment`, "/api/v1/artifacts/another/content"]) {
    await assert.rejects(readCorrectionArtifact({ origin, peerToken: "owned-peer-credential", artifact: { ...artifact, uri } }));
  }
  assert.equal(requests.length, 1, "Invalid artifact identity/URI must fail before any network request");
});

test("an authenticated artifact read cannot follow a redirect or treat a denied response as artifact bytes", async (t) => {
  let redirectedRequests = 0;
  const elsewhere = await localServer(t, (_req, res) => { redirectedRequests++; res.end("Must not be fetched"); });
  const origin = await localServer(t, (req, res) => {
    if (req.url.includes("redirect")) { res.writeHead(302, { Location: `${elsewhere}/artifact` }); res.end(); }
    else { res.writeHead(401); res.end("Denied"); }
  });
  for (const id of ["artifact_redirect", "artifact_denied"]) {
    await assert.rejects(readCorrectionArtifact({ origin, peerToken: "owned-peer-credential",
      artifact: { id, uri: `/api/v1/artifacts/${id}/content` } }));
  }
  assert.equal(redirectedRequests, 0);
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
