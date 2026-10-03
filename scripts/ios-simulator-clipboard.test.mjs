import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createSimulatorClipboard } from "./ios-simulator-clipboard.mjs";

const UDID = "1A2B3C4D-1111-2222-3333-112233445566";
const OTHER = "1A2B3C4D-1111-2222-3333-665544332211";
function fixture() {
  let clipboard = Buffer.alloc(0);
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, ...options });
    assert.equal(command, "/usr/bin/xcrun"); assert.deepEqual(args.slice(0, 1), ["simctl"]);
    assert.equal(args[2], UDID); assert.equal(args.length, 3);
    assert.equal(options.timeout, 10_000); assert.equal(options.maxBuffer, 16_384);
    if (args[1] === "pbcopy") { clipboard = Buffer.from(options.input); return { status: 0, stdout: Buffer.alloc(0) }; }
    assert.equal(args[1], "pbpaste"); return { status: 0, stdout: Buffer.from(clipboard) };
  };
  return { observer: createSimulatorClipboard({ simulatorUDID: UDID, execute }), calls,
    setClipboard: (bytes) => { clipboard = Buffer.from(bytes); }, getClipboard: () => Buffer.from(clipboard) };
}
function request(observer, action, body, { method = "POST", raw } = {}) {
  return new Promise((resolve) => {
    const stream = new PassThrough(); stream.url = `/clipboard/${action}`; stream.method = method;
    const handled = observer.handle(stream, (status, response) => resolve({ handled: true, status, body: response }));
    if (!handled) resolve({ handled: false });
    stream.end(raw ?? JSON.stringify(body));
  });
}
async function seed(observer) {
  const response = await request(observer, "seed", { simulator_udid: UDID });
  assert.equal(response.status, 200); return response.body;
}

test("fixed simulator commands seed unique bytes, observe exact Unicode/whitespace, clear, and retain hashes only", async () => {
  const f = fixture(), probe = await seed(f.observer);
  const sentinel = Buffer.from(probe.sentinel_utf8_base64, "base64");
  assert.deepEqual(f.calls[0].input, sentinel); assert.equal(probe.simulator_udid, UDID);
  const copied = Buffer.from(" /tmp/任务 e\u0301/🌳\n\t ", "utf8");
  assert.notDeepEqual(copied, sentinel); f.setClipboard(copied);
  const read = await request(f.observer, "read", { simulator_udid: UDID, probe_id: probe.probe_id });
  assert.equal(read.status, 200); assert.deepEqual(Buffer.from(read.body.utf8_base64, "base64"), copied);
  const cleared = await request(f.observer, "clear", { simulator_udid: UDID, probe_id: probe.probe_id });
  assert.equal(cleared.status, 200); assert.equal(cleared.body.cleared, true); assert.equal(f.getClipboard().length, 0);
  assert.deepEqual(f.calls.map((call) => call.args[1]), ["pbcopy", "pbpaste", "pbpaste", "pbcopy", "pbpaste"]);
  const evidence = f.observer.evidence(); assert.deepEqual(evidence.map((item) => item.action), ["seed", "read", "clear"]);
  assert.ok(evidence.every((item) => item.origin === "request"));
  assert.equal(evidence[1].sha256, createHash("sha256").update(copied).digest("hex")); assert.equal(evidence[1].byte_length, copied.length);
  assert.equal(JSON.stringify(evidence).includes(copied.toString("utf8")), false);
  assert.equal(JSON.stringify(evidence).includes(sentinel.toString("utf8")), false);
  evidence.length = 0; assert.equal(f.observer.evidence().length, 3);
  await f.observer.close(); await f.observer.close(); assert.equal(f.calls.length, 5);
});

test("stale sentinel is returned unchanged, never accepted as a Copy result; probes cannot overlap or be reused", async () => {
  const f = fixture(), first = await seed(f.observer);
  assert.equal((await request(f.observer, "seed", { simulator_udid: UDID })).status, 409);
  const stale = await request(f.observer, "read", { simulator_udid: UDID, probe_id: first.probe_id });
  assert.equal(stale.body.utf8_base64, first.sentinel_utf8_base64);
  assert.equal(Object.hasOwn(stale.body, "passed"), false);
  await request(f.observer, "clear", { simulator_udid: UDID, probe_id: first.probe_id });
  assert.equal((await request(f.observer, "read", { simulator_udid: UDID, probe_id: first.probe_id })).status, 409);
  const second = await seed(f.observer);
  assert.notEqual(second.probe_id, first.probe_id); assert.notEqual(second.sentinel_utf8_base64, first.sentinel_utf8_base64);
  assert.equal((await request(f.observer, "clear", { simulator_udid: UDID, probe_id: first.probe_id })).status, 409);
  await f.observer.close(); assert.equal(f.getClipboard().length, 0);
  assert.equal(f.observer.evidence().at(-1).origin, "cleanup");
});

test("unknown methods, devices, fields, invalid JSON/UTF-8 and oversized bodies never execute a command", async () => {
  const f = fixture();
  assert.equal((await request(f.observer, "unknown", {})).handled, false);
  assert.equal((await request(f.observer, "seed", { simulator_udid: UDID }, { method: "GET" })).status, 405);
  for (const body of [{ simulator_udid: OTHER }, { simulator_udid: "booted" }, {}, [], null,
    { simulator_udid: UDID, expected: "/expected/path" }, { simulator_udid: UDID, command: "pbpaste" },
    { simulator_udid: UDID, probe_id: OTHER }]) assert.equal((await request(f.observer, "seed", body)).status, 400);
  for (const raw of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(1025, 0x20)])
    assert.equal((await request(f.observer, "seed", null, { raw })).status, 400);
  assert.equal(f.calls.length, 0); await f.observer.close();
  assert.throws(() => createSimulatorClipboard({ simulatorUDID: "booted" }), /exact simulator UDID/);
});

test("wrong/missing probe is rejected and operation order is serialized", async () => {
  const f = fixture();
  assert.equal((await request(f.observer, "read", { simulator_udid: UDID, probe_id: OTHER })).status, 409);
  const first = request(f.observer, "seed", { simulator_udid: UDID });
  const duplicate = request(f.observer, "seed", { simulator_udid: UDID });
  assert.equal((await first).status, 200); assert.equal((await duplicate).status, 409);
  assert.equal((await request(f.observer, "read", { simulator_udid: UDID })).status, 400);
  assert.equal((await request(f.observer, "clear", { simulator_udid: UDID, probe_id: OTHER })).status, 409);
  assert.equal(f.calls.length, 2); await f.observer.close();
  assert.equal((await request(f.observer, "seed", { simulator_udid: UDID })).status, 503);
});

test("nonzero, rejected, invalid UTF-8 and oversized command output fail closed without exposing output", async () => {
  const failures = [
    () => ({ status: 1, stdout: Buffer.from("private command output") }),
    () => { throw new Error("private command output"); },
    () => ({ status: 0, stdout: Buffer.from([0xff]) }),
    () => ({ status: 0, stdout: Buffer.alloc(16_385, 0x61) }),
    () => ({ status: 0, stdout: "untyped string output" }),
  ];
  for (const failure of failures) {
    let count = 0;
    const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async () => ++count === 1 ? failure() : { status: 0, stdout: Buffer.alloc(0) } });
    const response = await request(observer, "seed", { simulator_udid: UDID });
    assert.equal(response.status, 500); assert.equal(JSON.stringify(response).includes("private command output"), false);
    assert.equal(observer.evidence().length, 1); assert.equal(observer.evidence()[0].action, "error");
    await observer.close(); assert.equal(count, 3);
  }
});

test("seed verification rejects stale bytes and preserves cleanup ownership", async () => {
  const calls = [];
  const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async (_, args) => {
    calls.push(args); return { status: 0, stdout: calls.length === 2 ? Buffer.from("old clipboard") : Buffer.alloc(0) };
  } });
  assert.equal((await request(observer, "seed", { simulator_udid: UDID })).status, 500);
  assert.equal(observer.evidence()[0].action, "error"); await observer.close(); assert.deepEqual(calls.map((args) => args[1]), ["pbcopy", "pbpaste", "pbcopy", "pbpaste"]);
});

test("read rejects malformed or unbounded clipboard bytes and clear must observe an empty clipboard", async () => {
  const f = fixture(), probe = await seed(f.observer);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.alloc(16_385, 0x61)]) {
    f.setClipboard(bytes);
    assert.equal((await request(f.observer, "read", { simulator_udid: UDID, probe_id: probe.probe_id })).status, 500);
  }
  await f.observer.close(); assert.equal(f.observer.evidence().filter((item) => item.action === "error").length, 2);
  let clipboard = Buffer.alloc(0), ignoredClear = false;
  const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async (_, args, options) => {
    if (args[1] === "pbcopy") {
      if (options.input.length === 0 && !ignoredClear) ignoredClear = true;
      else clipboard = Buffer.from(options.input);
      return { status: 0, stdout: Buffer.alloc(0) };
    }
    return { status: 0, stdout: clipboard };
  } });
  const pending = await seed(observer);
  assert.equal((await request(observer, "clear", { simulator_udid: UDID, probe_id: pending.probe_id })).status, 500);
  assert.equal(observer.evidence().some((item) => item.action === "clear"), false);
  await observer.close(); assert.equal(clipboard.length, 0); assert.equal(observer.evidence().at(-1).origin, "cleanup");
});

test("a reaped command timeout is classified and close clears its active probe exactly once", async () => {
  let calls = 0;
  const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async (_, __, options) => {
    assert.equal(options.timeout, 10_000);
    if (++calls === 1) throw Object.assign(new Error("mock child killed and closed"), { code: "ETIMEDOUT", killed: true, signal: "SIGKILL" });
    return { status: 0, stdout: Buffer.alloc(0) };
  } });
  const response = await request(observer, "seed", { simulator_udid: UDID });
  assert.equal(response.status, 504); assert.equal(calls, 1);
  const diagnostic = observer.evidence()[0].command;
  assert.equal(diagnostic.action, "pbcopy"); assert.equal(diagnostic.timeout_ms, 10_000);
  assert.equal(diagnostic.exit_code, null); assert.equal(diagnostic.signal, "SIGKILL");
  assert.ok(Number.isInteger(diagnostic.elapsed_ms) && diagnostic.elapsed_ms >= 0);
  await Promise.all([observer.close(), observer.close()]); assert.equal(calls, 3);
});

test("seed read timeout identifies pbpaste without retry or raw output and retains cleanup ownership", async () => {
  const calls = []; let clipboard = Buffer.alloc(0);
  const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async (_, args, options) => {
    calls.push(args[1]); assert.equal(options.timeout, 10_000);
    if (calls.length === 2) throw Object.assign(new Error("PRIVATE command message"), {
      code: "ETIMEDOUT", killed: true, signal: "SIGKILL", stdout: "PRIVATE stdout", stderr: "PRIVATE stderr", argv: ["PRIVATE argv"], token: "PRIVATE credential",
    });
    if (args[1] === "pbcopy") clipboard = Buffer.from(options.input);
    return { status: 0, stdout: args[1] === "pbpaste" ? clipboard : Buffer.alloc(0) };
  } });
  const response = await request(observer, "seed", { simulator_udid: UDID });
  assert.deepEqual(response, { handled: true, status: 504, body: { error: "Simulator clipboard command failed" } });
  assert.deepEqual(calls, ["pbcopy", "pbpaste"]);
  const error = observer.evidence()[0]; assert.equal(error.operation, "seed"); assert.equal(error.command.action, "pbpaste");
  assert.deepEqual(Object.keys(error.command).sort(), ["action", "elapsed_ms", "exit_code", "signal", "timeout_ms"]);
  assert.equal(error.command.timeout_ms, 10_000); assert.equal(error.command.exit_code, null); assert.equal(error.command.signal, "SIGKILL");
  assert.ok(Number.isInteger(error.command.elapsed_ms) && error.command.elapsed_ms >= 0);
  assert.equal(JSON.stringify([response, observer.evidence()]).includes("PRIVATE"), false);
  await observer.close(); assert.deepEqual(calls, ["pbcopy", "pbpaste", "pbcopy", "pbpaste"]);
  const cleared = observer.evidence().at(-1); assert.equal(cleared.action, "clear"); assert.equal(cleared.origin, "cleanup");
  assert.equal(cleared.probe_id, error.probe_id); assert.equal(Object.hasOwn(cleared, "command"), false);
});

test("command error receipts retain only numeric exit codes and known signals", async () => {
  const cases = [
    [() => ({ status: 17, stdout: Buffer.from("PRIVATE output") }), 17, null],
    [() => { throw Object.assign(new Error("PRIVATE message"), { code: 9, signal: "SIGTERM" }); }, 9, "SIGTERM"],
    [() => { throw Object.assign(new Error("PRIVATE message"), { code: "PRIVATE code", signal: "PRIVATE signal" }); }, null, null],
  ];
  for (const [fail, exitCode, signal] of cases) {
    let calls = 0;
    const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async () => ++calls === 1 ? fail() : { status: 0, stdout: Buffer.alloc(0) } });
    assert.equal((await request(observer, "seed", { simulator_udid: UDID })).status, 500); assert.equal(calls, 1);
    const error = observer.evidence()[0]; assert.equal(error.command.action, "pbcopy");
    assert.equal(error.command.exit_code, exitCode); assert.equal(error.command.signal, signal);
    assert.equal(JSON.stringify(error).includes("PRIVATE"), false);
    await observer.close(); assert.equal(calls, 3);
  }
});

test("close waits for the current command, rejects queued work, and labels incomplete cleanup separately", async () => {
  let release, started;
  const calls = [], entered = new Promise((resolve) => { started = resolve; });
  const observer = createSimulatorClipboard({ simulatorUDID: UDID, execute: async (_, args, options) => {
    calls.push({ args, input: options.input });
    if (calls.length === 1) { started(); await new Promise((resolve) => { release = resolve; }); }
    return { status: 0, stdout: Buffer.alloc(0) };
  } });
  const seeding = request(observer, "seed", { simulator_udid: UDID }); await entered;
  const queued = request(observer, "read", { simulator_udid: UDID, probe_id: OTHER });
  const closing = observer.close(); assert.equal(calls.length, 1); release();
  assert.equal((await seeding).status, 503); assert.equal((await queued).status, 503); await closing;
  assert.deepEqual(calls.map((call) => call.args[1]), ["pbcopy", "pbcopy", "pbpaste"]); assert.equal(calls[1].input.length, 0);
  const evidence = observer.evidence(); assert.equal(evidence.length, 3); assert.equal(evidence.at(-1).action, "clear");
  assert.equal(evidence.at(-1).origin, "cleanup"); assert.equal(evidence.filter((item) => item.action === "error").length, 2);
});

test("an unfinished body times out without starting a clipboard command", async () => {
  const f = fixture(), stream = new PassThrough(); stream.url = "/clipboard/seed"; stream.method = "POST";
  const response = new Promise((resolve) => f.observer.handle(stream, (status, body) => resolve({ status, body })));
  stream.write("{"); assert.equal((await response).status, 408); stream.end();
  assert.equal(f.calls.length, 0); await f.observer.close();
});

test("integration must authenticate before routing: denied requests never reach the observer", async () => {
  const f = fixture();
  const server = createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== "Bearer fixture-test-token") { req.resume(); reply(401, { error: "Denied" }); return; }
    if (!f.observer.handle(req, reply)) { req.resume(); reply(404, {}); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const action of ["seed", "read", "clear"]) {
      const response = await fetch(`${origin}/clipboard/${action}`, { method: "POST", body: JSON.stringify({ simulator_udid: UDID }) });
      assert.equal(response.status, 401);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.observer.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
