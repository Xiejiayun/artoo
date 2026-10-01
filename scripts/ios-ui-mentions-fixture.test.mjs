import assert from "node:assert/strict";
import test from "node:test";
import { closeNativeMentionsResources, createNativeMentionsFixture } from "./ios-ui-mentions-fixture.mjs";

async function setup(t, scenario) {
  const fixture = await createNativeMentionsFixture({ scenario });
  t.after(() => fixture.close());
  const request = (path, { method = "GET", body, authorization = `Bearer ${fixture.fields.fixture_control_token}` } = {}) => fetch(
    `${fixture.fields.fixture_control_url}${path}`, { method, headers: { ...(authorization ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body, signal: AbortSignal.timeout(5000) });
  return { fixture, request };
}

test("control rejects absent or wrong credentials and unknown operations before invoking the scenario", async (t) => {
  let publishes = 0, observations = 0;
  const { request } = await setup(t, { publish: async () => { publishes += 1; }, observe: async () => { observations += 1; } });
  for (const authorization of [null, "Bearer wrong"]) {
    assert.equal((await request("/publish", { method: "POST", body: "{}", authorization })).status, 401);
    assert.equal((await request("/observations", { authorization })).status, 401);
  }
  for (const [path, method] of [["/publish", "GET"], ["/observations", "POST"], ["/notifications/n/read", "POST"], ["/observations?device=other", "GET"]]) {
    assert.equal((await request(path, { method, ...(method === "POST" ? { body: "{}" } : {}) })).status, 404);
  }
  assert.equal(publishes, 0); assert.equal(observations, 0);
});

test("concurrent and repeated publication requests share one awaited real scenario result", async (t) => {
  let release, started, calls = 0;
  const arrived = new Promise((done) => { started = done; });
  const pending = new Promise((done) => { release = done; });
  const publication = { project_b: { id: "project_b" }, first: { notification_id: "first", message_id: "message" } };
  const { request } = await setup(t, { publish: async (input) => {
    calls += 1; assert.deepEqual(input, {}); started(); return pending;
  }, observe: async () => ({ unread_count: 3 }) });
  const first = request("/publish", { method: "POST", body: "{}" });
  await arrived;
  const second = request("/publish", { method: "POST", body: "{}" });
  release(publication);
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), publication);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const repeated = await request("/publish", { method: "POST", body: "{}" });
  assert.deepEqual(await repeated.json(), publication); assert.equal(calls, 1);
});

test("observations remain live read-only calls and publication cannot accept a caller device or command", async (t) => {
  let reads = 0, writes = 0;
  const { request } = await setup(t, { publish: async () => { writes += 1; return {}; }, observe: async () => ({ unread_count: ++reads, attempts: [] }) });
  assert.deepEqual(await (await request("/observations")).json(), { unread_count: 1, attempts: [] });
  assert.deepEqual(await (await request("/observations")).json(), { unread_count: 2, attempts: [] });
  for (const body of ["", "not-json", "null", "[]", '{"deviceId":"foreign"}', '{"read":true}']) {
    assert.equal((await request("/publish", { method: "POST", body })).status, 400);
  }
  assert.equal((await request("/publish", { method: "POST", body: " ".repeat(4097) })).status, 413);
  assert.equal(writes, 0); assert.equal(reads, 2);
});

test("failed scenario calls preserve sanitized failure status without retrying partial publication", async (t) => {
  let calls = 0;
  const { request } = await setup(t, { publish: async () => { calls += 1; throw new Error("PRIVATE_FIXTURE_SECRET"); },
    observe: async () => { throw new Error("PRIVATE_FIXTURE_SECRET"); } });
  for (let i = 0; i < 2; i += 1) {
    const response = await request("/publish", { method: "POST", body: "{}" });
    assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: "Mentions publication failed" });
  }
  const response = await request("/observations");
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "Mentions observation unavailable" });
  assert.equal(calls, 1);
});

test("close waits for owned operations and does not close the enclosing shared scenario", async (t) => {
  let release, started, scenarioClosed = false;
  const arrived = new Promise((done) => { started = done; });
  const pending = new Promise((done) => { release = done; });
  const { fixture, request } = await setup(t, { publish: async () => { started(); return pending; }, observe: async () => ({}),
    close: async () => { scenarioClosed = true; } });
  const inFlight = request("/publish", { method: "POST", body: "{}" }).catch(() => null);
  await arrived;
  let completed = false;
  const closing = fixture.close().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false);
  release({ first: { notification_id: "first" } });
  await closing; await inFlight;
  assert.equal(scenarioClosed, false);
  await assert.rejects(() => request("/observations"));
    await fixture.close();
});

test("parent cleanup aborts the scenario before waiting for control publication, then closes browser and server", async () => {
  const order = [];
  let release;
  const pending = new Promise((done) => { release = done; });
  const closing = closeNativeMentionsResources({ scenario: async () => { order.push("scenario-start"); await pending; order.push("scenario-stopped"); },
    fixture: async () => { order.push("fixture"); }, browser: async () => { order.push("browser"); }, server: async () => { order.push("server"); } });
  await Promise.resolve();
  assert.deepEqual(order, ["scenario-start"]);
  release();
  const result = await closing;
  assert.equal(result.closed, true);
  assert.deepEqual(order, ["scenario-start", "scenario-stopped", "fixture", "browser", "server"]);
});

test("a stuck or rejected cleanup remains failed while later resource cleanup and report finalization can proceed", async () => {
  const order = [];
  const result = await closeNativeMentionsResources({ scenario: async () => { throw new Error("PRIVATE_CLEANUP_SECRET"); },
    fixture: () => new Promise(() => {}), browser: async () => { order.push("browser"); }, server: async () => { order.push("server"); },
    timeouts: { scenario: 25, fixture: 25, browser: 25, server: 25 } });
  assert.equal(result.closed, false);
  assert.deepEqual(result.steps.scenario, { closed: false, error: "Cleanup rejected" });
  assert.deepEqual(result.steps.fixture, { closed: false, error: "Cleanup timed out" });
  assert.deepEqual(order, ["browser", "server"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_CLEANUP_SECRET"), false);
});
