import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { inspect } from "node:util";
import test from "node:test";
import { observeMemberClaim } from "./ios-ui-member-claim-observer.mjs";

const expectedName = "Exact native member phone";
const expectedUser = "member-user";
const expectedDevice = "native-phone";
const controlSecret = "PRIVATE_NATIVE_CONTROL_FOR_OBSERVER_TEST";
const nodeSecret = "PRIVATE_NODE_MUST_NEVER_BE_RETAINED";
const claim = (patch = {}) => ({ device: { id: expectedDevice, display_name: expectedName, enrolled_by_user_id: expectedUser, platform: "ios", computer_id: null, ...patch }, control_token: controlSecret, node_token: nodeSecret });

async function harness(t) {
  const state = { claim: claim(), claimStatus: 201, claimBody: null, claimMode: "split", sessionStatus: 200, sessionBody: null, sessionRequests: [], writeCallbacks: 0, endCallbacks: 0 };
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/auth/session") {
      state.sessionRequests.push({ method: request.method, authorization: request.headers.authorization });
      const finish = () => {
        response.writeHead(state.sessionStatus, { "Content-Type": "application/json", ...(state.redirect ? { Location: "/redirected-session" } : {}) });
        response.end(state.sessionBody ?? JSON.stringify({ user: { id: expectedUser, role: "member" }, device_id: expectedDevice }));
      };
      if (state.pauseSession) { state.finishSession = finish; state.sessionStarted?.(); } else finish();
      return;
    }
    const bytes = state.claimBody ?? JSON.stringify(state.claim);
    response.writeHead(state.claimStatus, { "Content-Type": "application/json", "X-Original-Header": "unchanged" });
    if (state.claimMode === "typed-view") {
      const contents = Buffer.from(bytes);
      state.backing = Buffer.concat([Buffer.from("prefix"), contents, Buffer.from("suffix")]);
      const view = new Uint8Array(state.backing.buffer, state.backing.byteOffset + 6, contents.length);
      response.end(view, () => { state.endCallbacks += 1; });
      return;
    }
    if (["callback-only", "undefined-callback", "null-callback"].includes(state.claimMode)) {
      state.writeReturn = response.write(bytes);
      const done = () => { state.endCallbacks += 1; };
      state.endReturn = state.claimMode === "callback-only" ? response.end(done)
        : state.claimMode === "undefined-callback" ? response.end(undefined, done) : response.end(null, done);
      state.endReturnedResponse = state.endReturn === response;
      state.endReturn = undefined;
      return;
    }
    const split = Math.floor(bytes.length / 2);
    response.write(bytes.slice(0, split), "utf8", () => { state.writeCallbacks += 1; });
    if (state.claimMode === "paused") { state.finishClaim = () => response.end(Buffer.from(bytes.slice(split))); return; }
    if (state.claimMode === "abort") { response.destroy(); return; }
    response.end(Buffer.from(bytes.slice(split)), () => { state.endCallbacks += 1; });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const observer = observeMemberClaim(server, { origin, displayName: expectedName, memberUserId: expectedUser });
  t.after(async () => {
    observer.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const issue = async (path = "/api/v1/devices/claim", method = "POST") => {
    const response = await fetch(`${origin}${path}`, { method });
    const body = await response.text();
    return { body, status: response.status, header: response.headers.get("x-original-header") };
  };
  return { state, server, origin, observer, issue };
}

test("raw response observation preserves bytes, status, headers and write/end callbacks", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.issue(), { body: JSON.stringify(claim()), status: 201, header: "unchanged" });
  assert.equal(h.state.writeCallbacks, 1); assert.equal(h.state.endCallbacks, 1);
  const active = await h.observer.verifyActive(expectedDevice);
  assert.deepEqual(active, { device_id: expectedDevice, member_user_id: expectedUser, status: 200 });
  h.state.sessionStatus = 401;
  h.state.sessionBody = JSON.stringify({ error: { message: controlSecret } });
  const revoked = await h.observer.verifyRevoked(expectedDevice);
  assert.deepEqual(revoked, { device_id: expectedDevice, status: 401 });
  assert.equal(h.state.sessionRequests.length, 2);
  assert.ok(h.state.sessionRequests.every((request) => request.method === "GET" && request.authorization === `Bearer ${controlSecret}`));
  for (const publicValue of [JSON.stringify(h.observer), inspect(h.observer), JSON.stringify({ active, revoked })]) {
    assert.equal(publicValue.includes(controlSecret), false); assert.equal(publicValue.includes(nodeSecret), false);
  }
  await assert.rejects(h.observer.verifyRevoked(expectedDevice), /No matching native member credential/);
});

test("only the exact member phone's successful POST claim can be retained", async (t) => {
  const h = await harness(t);
  for (const patch of [{ display_name: "Someone else's phone" }, { enrolled_by_user_id: "owner" }, { platform: "macos" }, { computer_id: "computer" }]) {
    h.state.claim = claim(patch);
    await h.issue();
    await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
  }
  h.state.claim = claim();
  for (const [path, method] of [["/api/v1/devices/claim", "GET"], ["/unrelated", "POST"]]) {
    await h.issue(path, method);
    await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
  }
  h.state.claimStatus = 400;
  await h.issue();
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
  assert.equal(h.state.sessionRequests.length, 0);
  h.state.claimStatus = 201;
  await h.issue();
  await h.observer.verifyActive(expectedDevice);
});

test("continued HTTP 200 after owner revocation fails and erases the captured credential", async (t) => {
  const h = await harness(t);
  await h.issue(); await h.observer.verifyActive(expectedDevice);
  await assert.rejects(h.observer.verifyRevoked(expectedDevice), (error) => {
    assert.match(error.message, /HTTP 401.*HTTP 200/);
    assert.equal(inspect(error).includes(controlSecret), false);
    return true;
  });
  const attempts = h.state.sessionRequests.length;
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
  assert.equal(h.state.sessionRequests.length, attempts, "The captured credential must not survive a failed revocation check");
});

test("active proof rejects another device or administrator identity without leaking response data", async (t) => {
  for (const identity of [
    { user: { id: expectedUser, role: "owner", token: controlSecret }, device_id: expectedDevice },
    { user: { id: expectedUser, role: "member", token: controlSecret }, device_id: "another-device" },
  ]) {
    const h = await harness(t);
    await h.issue();
    h.state.sessionBody = JSON.stringify(identity);
    await assert.rejects(h.observer.verifyActive(expectedDevice), (error) => {
      assert.match(error.message, /same member and device/);
      assert.equal(inspect(error).includes(controlSecret), false);
      return true;
    });
    await assert.rejects(h.observer.verifyRevoked(expectedDevice), /No matching native member credential/);
  }
});

test("malformed or oversized claim JSON cannot leak raw token bytes through parsing errors", async (t) => {
  const h = await harness(t);
  for (const body of [`{"control_token":"${controlSecret}",broken`, JSON.stringify({ ...claim(), padding: "x".repeat(70_000) })]) {
    h.state.claimBody = body;
    assert.equal((await h.issue()).body, body, "Observer limits must not truncate the product's response");
    await assert.rejects(h.observer.verifyActive(expectedDevice), (error) => {
      assert.equal(inspect(error).includes(controlSecret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("malformed session JSON is reported without the response or a sensitive cause", async (t) => {
  const h = await harness(t);
  await h.issue();
  h.state.sessionBody = `invalid session body ${controlSecret}`;
  await assert.rejects(h.observer.verifyActive(expectedDevice), (error) => {
    assert.equal(inspect(error).includes(controlSecret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("duplicate matching claims cannot replace the token whose identity is being checked", async (t) => {
  const h = await harness(t);
  await h.issue();
  h.state.claim = { ...claim({ id: "another-phone" }), control_token: "PRIVATE_REPLACEMENT" };
  await h.issue();
  await assert.rejects(h.observer.verifyActive(expectedDevice), /ambiguous/);
  assert.equal(h.state.sessionRequests.length, 0);
});

test("stop removes the raw observer and prevents later claims or verifications", async (t) => {
  const h = await harness(t);
  await h.issue();
  h.observer.stop();
  assert.equal(h.server.listenerCount("request"), 1, "The production HTTP listener must remain unchanged");
  await h.issue();
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
  assert.equal(h.state.sessionRequests.length, 0);
});

test("end overloads preserve callbacks/return values and do not duplicate captured bytes", async (t) => {
  for (const mode of ["callback-only", "undefined-callback", "null-callback"]) {
    const h = await harness(t); h.state.claimMode = mode;
    assert.equal((await h.issue()).body, JSON.stringify(claim()));
    assert.equal(typeof h.state.writeReturn, "boolean");
    assert.equal(h.state.endReturnedResponse, true); assert.equal(h.state.endCallbacks, 1);
    await h.observer.verifyActive(expectedDevice);
  }
});

test("wiping observer copies never changes the product's Uint8Array backing buffer", async (t) => {
  const h = await harness(t); h.state.claimMode = "typed-view";
  assert.equal((await h.issue()).body, JSON.stringify(claim()));
  await h.observer.verifyActive(expectedDevice);
  h.state.sessionStatus = 401;
  await h.observer.verifyRevoked(expectedDevice);
  assert.equal(h.state.backing.toString(), `prefix${JSON.stringify(claim())}suffix`);
});

test("stop releases an unfinished response without truncating its later bytes", async (t) => {
  const h = await harness(t); h.state.claimMode = "paused";
  const response = await fetch(`${h.origin}/api/v1/devices/claim`, { method: "POST" });
  h.observer.stop(); h.state.finishClaim();
  assert.equal(await response.text(), JSON.stringify(claim()));
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
});

test("a response closed before finish is discarded", async (t) => {
  const h = await harness(t); h.state.claimMode = "abort";
  await assert.rejects(h.issue());
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
});

test("stop during an active-session probe cannot return a successful proof", async (t) => {
  const h = await harness(t); await h.issue(); h.state.pauseSession = true;
  const started = new Promise((resolve) => { h.state.sessionStarted = resolve; });
  const proving = h.observer.verifyActive(expectedDevice);
  await started;
  h.observer.stop(); h.state.finishSession();
  await assert.rejects(proving, /No matching native member credential/);
});

test("a duplicate claim during the revoked-session probe cannot turn ambiguity into success", async (t) => {
  const h = await harness(t); await h.issue(); await h.observer.verifyActive(expectedDevice);
  h.state.pauseSession = true; h.state.sessionStatus = 401;
  const started = new Promise((resolve) => { h.state.sessionStarted = resolve; });
  const proving = h.observer.verifyRevoked(expectedDevice);
  await started;
  h.state.claim = { ...claim({ id: "duplicate-phone" }), control_token: "PRIVATE_REPLACEMENT" };
  await h.issue(); h.state.finishSession();
  await assert.rejects(proving, /ambiguous/);
});

test("a 401 cannot be accepted without the same credential's earlier active proof", async (t) => {
  const h = await harness(t); await h.issue(); h.state.sessionStatus = 401;
  await assert.rejects(h.observer.verifyRevoked(expectedDevice), /successful active-session check/);
  assert.equal(h.state.sessionRequests.length, 0);
  await assert.rejects(h.observer.verifyActive(expectedDevice), /No matching native member credential/);
});

test("session probes reject redirects without exposing their response or following them", async (t) => {
  const h = await harness(t); await h.issue();
  h.state.sessionStatus = 302; h.state.redirect = true; h.state.sessionBody = controlSecret;
  await assert.rejects(h.observer.verifyActive(expectedDevice), (error) => {
    assert.equal(inspect(error).includes(controlSecret), false); assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(h.state.sessionRequests.length, 1);
});

test("observation cannot send a captured credential to another origin or server port", async (t) => {
  const h = await harness(t);
  for (const origin of ["https://external.example", "http://127.0.0.1:1", `${h.origin}/not-an-origin`, `${h.origin}?token=private`]) {
    assert.throws(() => observeMemberClaim(h.server, { origin, displayName: expectedName, memberUserId: expectedUser }), /local fixture origin/);
  }
});

test("a product write exception is rethrown unchanged and restores original methods", () => {
  const server = new EventEmitter(); server.address = () => ({ port: 12345 });
  const observer = observeMemberClaim(server, { origin: "http://127.0.0.1:12345", displayName: expectedName, memberUserId: expectedUser });
  const response = new EventEmitter();
  const originalError = new Error("product write failure");
  const write = function () { throw originalError; };
  const end = function () { return this; };
  response.write = write; response.end = end;
  server.emit("request", { method: "POST", url: "/api/v1/devices/claim" }, response);
  assert.throws(() => response.write("chunk"), (error) => error === originalError);
  assert.equal(response.write, write); assert.equal(response.end, end);
  assert.equal(response.listenerCount("error"), 0);
  observer.stop();
});
