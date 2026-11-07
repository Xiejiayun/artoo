import assert from "node:assert/strict";
import { test } from "node:test";
import { changeWorkflowNode, workflowNodeFailureResponse } from "./ios-ui-workflows-fixture.mjs";

// Failure-injection fixtures, not a live node or native UI acceptance run.
function fixture(start = false, overrides = {}) {
  const calls = [], failures = [], transitions = [];
  const daemon = { status: start ? "online" : "offline", connected: start, runtimes: [{ runtime: "executor" }], last_heartbeat_at: "fixture" };
  return { calls, failures, daemon, options: { start, transitions, runtimeNames: ["executor"],
    node: { start: async () => calls.push("start"), stop: async () => calls.push("stop") },
    readDaemon: async () => { calls.push("read"); return daemon; },
    until: async (read, message, timeout) => { calls.push(["until", message, timeout]); assert.equal(await read(), true); },
    reportFailure: value => failures.push(value), ...overrides } };
}
for (const start of [false, true]) test(`successful ${start ? "start" : "stop"} keeps the existing observation and deadline`, async () => {
  const f = fixture(start);
  assert.deepEqual(await changeWorkflowNode(f.options), { daemon: f.daemon });
  assert.deepEqual(f.calls, [start ? "start" : "stop", ["until", `Authenticated fixture node did not become ${start ? "online" : "offline"}`, 60000], "read", "read"]);
  assert.deepEqual(f.failures, []);
  assert.equal(f.options.transitions.length, 1);
  assert.equal(f.options.transitions[0].action, start ? "start" : "stop");
});

for (const phase of ["node_start", "node_stop", "presence_read", "presence_check", "presence_wait", "final_presence_read", "record_transition"]) {
  test(`failure at ${phase} is attributed without exporting its private cause`, async () => {
    const secret = "private-token/secret-workspace?token=credential", original = new TypeError(secret);
    const f = fixture(phase === "node_start");
    if (phase === "node_start" || phase === "node_stop") f.options.node[phase === "node_start" ? "start" : "stop"] = async () => { throw original; };
    if (phase === "presence_read") f.options.readDaemon = async () => { throw original; };
    if (phase === "presence_check") f.options.readDaemon = async () => ({ get status() { throw original; } });
    if (phase === "presence_wait") f.options.until = async read => { await read(); throw original; };
    if (phase === "final_presence_read" || phase === "record_transition") {
      let reads = 0;
      f.options.readDaemon = async () => {
        if (++reads === 1) return f.daemon;
        if (phase === "final_presence_read") throw original;
        return { get status() { throw original; } };
      };
    }
    await assert.rejects(changeWorkflowNode(f.options), error => {
      assert.equal(error.cause, original);
      assert.equal(error.diagnostic.phase, phase);
      assert.equal(error.diagnostic.kind, "type_error");
      assert.equal(error.diagnostic.code, "unknown");
      const body = workflowNodeFailureResponse(error);
      assert.deepEqual(body, { error: "Fixture node transition failed", diagnostic: f.failures[0] });
      assert.ok(!JSON.stringify(body).includes(secret));
      assert.ok(!error.message.includes(secret));
      assert.equal(Object.hasOwn(body, "stack"), false);
      return true;
    });
    assert.equal(f.failures.length, 1);
    assert.equal(f.options.transitions.length, 0);
  });
}

test("known upstream status and fixed presence timeout survive without raw error strings", async () => {
  for (const [message, code, status] of [["GET /api/v1/daemons failed (500)", "daemon_http_error", 500],
    ["Authenticated fixture node did not become offline", "presence_timeout", undefined],
    ["GET /api/v1/daemons?token=private failed (500)", "unknown", undefined]]) {
    const f = fixture(false, { readDaemon: async () => { throw new Error(message); } });
    await assert.rejects(changeWorkflowNode(f.options), error => {
      assert.equal(error.diagnostic.code, code); assert.equal(error.diagnostic.upstream_status, status); return true;
    });
  }
});

test("transport causes use an allowlist and accessor fields are not invoked", async () => {
  let getterCalls = 0;
  const opaque = Object.create(null);
  for (const key of ["name", "message", "code", "cause"]) Object.defineProperty(opaque, key, { get() { getterCalls++; throw Error("private"); } });
  for (const [original, expected] of [[new TypeError("private", { cause: Object.assign(new Error("private"), { code: "ECONNRESET" }) }), "ECONNRESET"],
    [Object.assign(new Error("private"), { code: "SECRET" }), "unknown"], [opaque, "unknown"]]) {
    const f = fixture(false, { node: { stop: async () => { throw original; } } });
    await assert.rejects(changeWorkflowNode(f.options), error => { assert.equal(error.diagnostic.code, expected); return true; });
  }
  assert.equal(getterCalls, 0);
  assert.deepEqual(workflowNodeFailureResponse({ message: "private", diagnostic: { secret: "private" } }), { error: "Fixture node transition failed" });
});
