import assert from "node:assert/strict";

const owners = new WeakSet();
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value);

/** Test-only, exact pre-handler failure. Authentication is independently read
 * from the production session endpoint using this request's credential. No
 * token/body is retained, no successful mutation is rewritten as a failure,
 * and the server's WebSocket upgrade listeners are never changed. */
export function installMentionsReadFault(server, { origin, readIdentity } = {}) {
  const base = new URL(origin), address = server.address();
  assert.ok(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    && !base.username && !base.password && base.pathname === "/" && !base.search && !base.hash
    && address && typeof address !== "string" && Number(base.port) === address.port,
  "Mention fault requires its own listening loopback server");
  assert.ok(!owners.has(server), "A mention fault already owns this server");
  const original = server.rawListeners("request");
  assert.equal(original.length, 1, "The fixture must wrap exactly one production HTTP dispatcher");
  owners.add(server);
  let target, injected = false, stopped = false;
  const attempts = [], pending = new Set(), errors = [];
  const authenticate = readIdentity ?? (async (request) => {
    const headers = {};
    for (const name of ["authorization", "cookie"]) if (typeof request.headers[name] === "string") headers[name] = request.headers[name];
    if (!Object.keys(headers).length) return null;
    const response = await fetch(new URL("/auth/session", base), { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) { await response.body?.cancel(); return null; }
    const value = await response.json();
    return { user_id: value.user?.id, device_id: value.device_id };
  });
  const forward = (request, response) => Reflect.apply(original[0], server, [request, response]);
  const reply = (request, response, status, message) => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    const requestOrigin = request.headers.origin;
    if (requestOrigin === "null" || requestOrigin === base.origin) {
      headers["Access-Control-Allow-Origin"] = requestOrigin;
      headers["Access-Control-Allow-Credentials"] = "true";
      headers.Vary = "Origin";
    }
    request.resume();
    response.writeHead(status, headers);
    response.end(JSON.stringify({ error: { code: "fixture_read_unavailable", message } }));
  };
  const dispatch = async (request, response, notificationId) => {
    let identity;
    try { identity = await authenticate(request); }
    catch {
      errors.push("Could not independently authenticate a candidate read request");
      reply(request, response, 502, "Fixture identity observation failed"); return;
    }
    if (stopped || identity?.user_id !== target.userId || identity?.device_id !== target.deviceId) {
      forward(request, response); return;
    }
    const fail = notificationId === target.notificationId && !injected;
    if (fail) injected = true;
    const entry = { sequence: attempts.length + 1, method: request.method,
      path: request.url.split("?")[0], notification_id: notificationId,
      user_id: identity.user_id, device_id: identity.device_id,
      status: null, injected: fail, forwarded: !fail, response_finished: false };
    attempts.push(entry);
    response.once("finish", () => { entry.status = response.statusCode; entry.response_finished = true; });
    if (fail) reply(request, response, 503, "Temporary read confirmation failure; use the visible Retry action.");
    else forward(request, response);
  };
  function wrapper(request, response) {
    const path = request.url?.split("?")[0];
    const notificationId = target?.paths.get(path);
    if (stopped || request.method !== "POST" || !notificationId) { forward(request, response); return; }
    const operation = dispatch(request, response, notificationId).catch(() => {
      errors.push("Mention read dispatch failed");
      if (!response.headersSent) reply(request, response, 502, "Fixture read dispatch failed");
      else response.destroy();
    });
    pending.add(operation); void operation.finally(() => pending.delete(operation));
  }
  server.removeListener("request", original[0]); server.on("request", wrapper);
  return Object.freeze({
    arm({ notificationId, notificationIds, userId, deviceId }) {
      assert.ok(!stopped && !target, "Mention fault can only be armed once");
      assert.ok(id(notificationId) && id(userId) && id(deviceId));
      assert.ok(Array.isArray(notificationIds) && notificationIds.length === 3
        && new Set(notificationIds).size === 3 && notificationIds.every(id) && notificationIds.includes(notificationId));
      target = { notificationId, userId, deviceId,
        paths: new Map(notificationIds.map((value) => [`/api/v1/notifications/${value}/read`, value])) };
    },
    observe() { return { read_attempts: attempts.map((entry) => ({ ...entry })), observation_errors: [...errors] }; },
    async close() {
      if (!stopped) {
        stopped = true; server.removeListener("request", wrapper); server.prependListener("request", original[0]); owners.delete(server);
      }
      await Promise.allSettled([...pending]);
      assert.ok(server.rawListeners("request").includes(original[0]), "Original HTTP dispatcher was not restored");
    },
  });
}
