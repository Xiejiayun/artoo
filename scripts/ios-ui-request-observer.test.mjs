import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { observeNativeFixtureRequest } from "./ios-ui-request-observer.mjs";

async function localServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("successful and HTTP error responses retain their caller-owned behavior", async (t) => {
  const origin = await localServer(t, (_request, response) => {
    response.writeHead(503);
    response.end("original response");
  });
  const failures = [],
    signal = new AbortController().signal;
  const response = await observeNativeFixtureRequest(() => fetch(origin, { signal }), {
    method: "GET",
    path: "/api/v1/tasks",
    signal,
    failures,
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "original response");
  assert.deepEqual(failures, []);
});

test("a real socket failure retains its original error and safe transport cause", async (t) => {
  const origin = await localServer(t, (request) => request.socket.destroy());
  const failures = [],
    signal = new AbortController().signal;
  let original;
  await assert.rejects(
    observeNativeFixtureRequest(
      async () => {
        try {
          return await fetch(origin, { signal });
        } catch (error) {
          original = error;
          throw error;
        }
      },
      { method: "GET", path: "/api/v1/tasks?private=test-secret", signal, failures },
    ),
    (error) => error === original,
  );
  assert.ok(original instanceof TypeError);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].route, "/api/v1/tasks");
  assert.equal(failures[0].aborted, false);
  assert.equal(failures[0].transport.cause.code, "UND_ERR_SOCKET");
  assert.ok(failures[0].elapsed_ms >= 0);
  assert.ok(!JSON.stringify(failures).includes("test-secret"));
});

test("abort is propagated unchanged and is explicitly distinguished from a transport failure", async (t) => {
  const origin = await localServer(t, (_request, response) => response.end("unused"));
  const controller = new AbortController(),
    reason = new Error("private abort reason"),
    failures = [];
  controller.abort(reason);
  await assert.rejects(
    observeNativeFixtureRequest(() => fetch(origin, { signal: controller.signal }), {
      method: "GET",
      path: "/api/v1/tasks",
      signal: controller.signal,
      failures,
    }),
    (error) => error === reason,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].aborted, true);
  assert.ok(!JSON.stringify(failures).includes("private abort reason"));
});

test("nested causes omit secrets, ignore getters and bound cyclic or aggregate diagnostics", async () => {
  const privateCause = new Error("private message");
  privateCause.code = "ECONNREFUSED";
  let getterCalls = 0;
  Object.defineProperty(privateCause, "cause", {
    get() {
      getterCalls++;
      throw new Error("private getter");
    },
  });
  const cycle = new Error("private cyclic message");
  cycle.cause = cycle;
  const original = new TypeError("private root", {
    cause: new AggregateError([privateCause, cycle, new Error("private"), new Error("private"), new Error("private")]),
  });
  original.code = "PRIVATE_SECRET_CODE";
  const failures = [],
    signal = new AbortController().signal;
  await assert.rejects(
    observeNativeFixtureRequest(() => Promise.reject(original), {
      method: "GET",
      path: "/api/v1/tasks",
      signal,
      failures,
    }),
    (error) => error === original,
  );
  assert.equal(getterCalls, 0);
  assert.equal(failures[0].transport.code, null);
  assert.equal(failures[0].transport.cause.errors[0].code, "ECONNREFUSED");
  assert.deepEqual(failures[0].transport.cause.errors[1].cause, { truncated: true });
  assert.equal(failures[0].transport.cause.omitted_errors, 1);
  assert.ok(!JSON.stringify(failures).includes("private"));
  assert.ok(!JSON.stringify(failures).includes("PRIVATE_SECRET"));
});
