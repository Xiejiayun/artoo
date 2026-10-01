import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { installMentionsReadFault } from "./mentions-read-fault.mjs";

async function fixture(t) {
  const handled = [], identities = [];
  const handler = (req, res) => {
    req.resume();
    if (req.url === "/auth/session") {
      identities.push(req.headers.authorization);
      if (!req.headers.authorization?.startsWith("Bearer ")) { res.writeHead(401); res.end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ user: { id: req.headers.authorization === "Bearer other-user" ? "other_user" : "recipient" },
        device_id: req.headers.authorization === "Bearer other-device" ? "other_device" : "device" })); return;
    }
    handled.push({ method: req.method, path: req.url, key: req.headers["idempotency-key"] });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ received: true }));
  };
  const server = createServer(handler), upgrade = () => {};
  server.on("upgrade", upgrade);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fault = installMentionsReadFault(server, { origin });
  t.after(async () => { await fault.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  const post = (notification = "first", authorization = "Bearer owned", extra = {}) => fetch(`${origin}/api/v1/notifications/${notification}/read`, {
    method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json", "Idempotency-Key": "original-command", ...extra }, body: "{}" });
  const arm = () => fault.arm({ notificationId: "first", notificationIds: ["first", "second", "sentinel"], userId: "recipient", deviceId: "device" });
  return { server, origin, fault, handled, identities, handler, upgrade, post, arm };
}

test("the real session endpoint binds exactly one pre-handler failure, then forwards the original request", async (t) => {
  const f = await fixture(t); f.arm();
  const failed = await f.post("first", "Bearer owned", { Origin: "null" });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get("access-control-allow-origin"), "null");
  await failed.json(); assert.equal(f.handled.length, 0, "A fabricated failure must never follow a successful mutation");
  const retried = await f.post(); assert.equal(retried.status, 200); assert.deepEqual(await retried.json(), { received: true });
  assert.deepEqual(f.handled, [{ method: "POST", path: "/api/v1/notifications/first/read", key: "original-command" }]);
  assert.deepEqual(f.identities, ["Bearer owned", "Bearer owned"]);
  const evidence = f.fault.observe();
  assert.deepEqual(evidence.read_attempts.map(({ status, injected, forwarded, response_finished }) => ({ status, injected, forwarded, response_finished })), [
    { status: 503, injected: true, forwarded: false, response_finished: true },
    { status: 200, injected: false, forwarded: true, response_finished: true },
  ]);
  assert.ok(evidence.read_attempts.every((entry) => entry.device_id === "device" && entry.user_id === "recipient"));
  assert.ok(!JSON.stringify(evidence).includes("Bearer")); assert.deepEqual(evidence.observation_errors, []);
});

test("wrong user/device, unrelated routes, GET and OPTIONS retain production behavior", async (t) => {
  const f = await fixture(t); f.arm();
  for (const authorization of ["Bearer other-user", "Bearer other-device"]) { const r = await f.post("first", authorization); assert.equal(r.status, 200); await r.json(); }
  for (const method of ["GET", "OPTIONS"]) { const r = await fetch(`${f.origin}/api/v1/notifications/first/read`, { method }); assert.equal(r.status, 200); await r.json(); }
  const other = await f.post("unrelated"); assert.equal(other.status, 200); await other.json();
  assert.equal(f.fault.observe().read_attempts.length, 0);
  const failed = await f.post(); assert.equal(failed.status, 503); await failed.json();
  assert.equal(f.fault.observe().read_attempts.length, 1);
});

test("concurrent duplicate requests cannot consume the injected failure more than once", async (t) => {
  const f = await fixture(t); f.arm();
  const responses = await Promise.all([f.post(), f.post()]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 503]);
  await Promise.all(responses.map((r) => r.json()));
  assert.equal(f.handled.length, 1); assert.equal(f.fault.observe().read_attempts.filter((a) => a.injected).length, 1);
});

test("the second target and sentinel are observed but never faulted", async (t) => {
  const f = await fixture(t); f.arm();
  for (const name of ["second", "sentinel"]) { const r = await f.post(name); assert.equal(r.status, 200); await r.json(); }
  assert.deepEqual(f.fault.observe().read_attempts.map((a) => [a.notification_id, a.injected]), [["second", false], ["sentinel", false]]);
});

test("restoration leaves the original HTTP and WebSocket listeners intact", async (t) => {
  const f = await fixture(t);
  assert.throws(() => installMentionsReadFault(f.server, { origin: f.origin }), /already owns/);
  f.arm(); await f.fault.close(); await f.fault.close();
  assert.deepEqual(f.server.rawListeners("request"), [f.handler]); assert.deepEqual(f.server.listeners("upgrade"), [f.upgrade]);
  const result = await f.post(); assert.equal(result.status, 200); await result.json();
  assert.equal(f.fault.observe().read_attempts.length, 0); assert.throws(f.arm, /only be armed once/);
});

test("invalid destination scope cannot arm or consume a fault", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.fault.arm({ notificationId: "first", notificationIds: ["first", "first", "sentinel"], userId: "recipient", deviceId: "device" }));
  assert.throws(() => f.fault.arm({ notificationId: "first", notificationIds: ["first", "second", "sentinel"], userId: "recipient", deviceId: "../escape" }));
  f.arm(); assert.throws(f.arm, /only be armed once/);
});

test("an independent identity failure is a fixture error, never the intended 503 or a forwarded mutation", async (t) => {
  const f = await fixture(t); await f.fault.close();
  const fault = installMentionsReadFault(f.server, { origin: f.origin, readIdentity: async () => { throw new Error("private credential diagnostic"); } });
  t.after(() => fault.close());
  fault.arm({ notificationId: "first", notificationIds: ["first", "second", "sentinel"], userId: "recipient", deviceId: "device" });
  const result = await f.post(); assert.equal(result.status, 502); await result.json();
  assert.equal(f.handled.length, 0); assert.equal(fault.observe().read_attempts.length, 0);
  assert.equal(fault.observe().observation_errors.length, 1); assert.ok(!JSON.stringify(fault.observe()).includes("private"));
  await fault.close();
});
