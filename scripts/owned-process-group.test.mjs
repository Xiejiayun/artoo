import assert from "node:assert/strict";
import childProcess, { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";

const posix = process.platform !== "win32";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function groupExists(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await pause(10); }
  assert.fail(message);
}
function ownedGroup(t, script) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-owned-group-unit-")), receipt = join(directory, "ready.json");
  const child = spawn(process.execPath, ["--eval", script, receipt], { detached: true, stdio: "ignore", env: {} });
  const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
  t.after(async () => {
    const cleanup = await closeOwnedProcessGroup(child.pid, { termTimeoutMs: 100, killTimeoutMs: 5000, pollIntervalMs: 10 });
    assert.equal(cleanup.closed, true, JSON.stringify(cleanup));
    await exited; rmSync(directory, { recursive: true, force: true });
  });
  return { child, receipt, exited };
}

// Controlled platform/process/clock observations exercise the query budget on Windows too.
// No real process is spawned or signalled by these fixtures; genuine POSIX cases remain below.
function queryFixture(t, observations, platform = "darwin") {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const calls = [], targets = []; let now = 0;
  t.after(() => {
    t.mock.restoreAll(); Object.defineProperty(process, "platform", platformDescriptor); syncBuiltinESMExports();
  });
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  t.mock.method(performance, "now", () => now);
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "/bin/ps"); assert.deepEqual(args, ["-o", "pgid=", "-p", String(process.pid)]);
    assert.equal(options.encoding, "utf8"); assert.equal(options.maxBuffer, 4096);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.ok(options.timeout >= 1 && options.timeout <= 1000);
    const observation = observations[calls.length]; assert.ok(observation, "Unexpected additional self-group query");
    calls.push(options.timeout); now += observation.elapsedMs ?? 0;
    return observation.result;
  });
  t.mock.method(process, "kill", (pid, signal) => {
    targets.push({ pid, signal });
    assert.equal(pid, -2147483647); assert.equal(signal, 0, "The controlled target is already gone; no signal is permitted");
    throw Object.assign(new Error("Controlled absent target group"), { code: "ESRCH" });
  });
  syncBuiltinESMExports();
  return { calls, targets };
}
const queryTimeout = { status: null, stdout: "", error: { code: "ETIMEDOUT" } };
const querySuccess = { status: 0, stdout: "42\n" };

test("a transient self-group timeout can recover within the added query budget", async (t) => {
  const fixture = queryFixture(t, [{ result: queryTimeout, elapsedMs: 2991 }, { result: querySuccess, elapsedMs: 10 }]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, true); assert.equal(result.alreadyGone, true);
  assert.equal(result.termSent, false); assert.equal(result.killSent, false);
  assert.deepEqual(fixture.calls, [1000, 1000]); assert.deepEqual(fixture.targets, [{ pid: -2147483647, signal: 0 }]);
  assert.deepEqual(result.selfGroupQuery, { budgetMs: 5000, maxAttempts: 2, attempts: 2, timeouts: 1, elapsedMs: 3001, budgetExhausted: false });
});

test("persistent self-group timeouts stop after two attempts without probing or signalling", async (t) => {
  const fixture = queryFixture(t, [{ result: queryTimeout, elapsedMs: 1000 }, { result: queryTimeout, elapsedMs: 1000 }]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, false); assert.equal(result.error.stage, "self-group"); assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.selfGroupQuery.attempts, 2); assert.equal(result.selfGroupQuery.timeouts, 2);
  assert.equal(result.selfGroupQuery.budgetExhausted, false); assert.deepEqual(fixture.calls, [1000, 1000]);
  assert.deepEqual(fixture.targets, []); assert.equal(result.termSent, false); assert.equal(result.killSent, false);
});

test("a retry query timeout cannot exceed its remaining acceptance budget", async (t) => {
  const fixture = queryFixture(t, [{ result: queryTimeout, elapsedMs: 4900 }, { result: querySuccess, elapsedMs: 50 }]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, true); assert.equal(result.selfGroupQuery.elapsedMs, 4950);
  assert.deepEqual(fixture.calls, [1000, 100]); assert.deepEqual(fixture.targets, [{ pid: -2147483647, signal: 0 }]);
});

for (const [label, observation] of [
  ["timeout exhausts the budget", { result: queryTimeout, elapsedMs: 5000 }],
  ["valid result reaches the deadline", { result: querySuccess, elapsedMs: 5000 }],
  ["valid result exceeds the deadline", { result: querySuccess, elapsedMs: 5001 }],
  ["remaining budget is less than one millisecond", { result: queryTimeout, elapsedMs: 4999.5 }],
]) test(`self-group ${label} cannot authorize target operations`, async (t) => {
  const fixture = queryFixture(t, [observation]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, false); assert.equal(result.error.stage, "self-group"); assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.selfGroupQuery.budgetExhausted, true); assert.equal(result.selfGroupQuery.elapsedMs, observation.elapsedMs);
  assert.deepEqual(fixture.calls, [1000]); assert.deepEqual(fixture.targets, []);
  assert.equal(result.termSent, false); assert.equal(result.killSent, false);
});

for (const [label, response, code] of [
  ["non-timeout error", { status: null, stdout: "", error: { code: "EIO" } }, "EIO"],
  ["nonzero status", { status: 1, stdout: "42\n" }, "SELF_PGID_UNAVAILABLE"],
  ["empty result", { status: 0, stdout: "" }, "SELF_PGID_UNAVAILABLE"],
  ["multiple process groups", { status: 0, stdout: "42\n43\n" }, "SELF_PGID_UNAVAILABLE"],
  ["unsafe process group", { status: 0, stdout: "9007199254740992\n" }, "SELF_PGID_UNAVAILABLE"],
]) test(`a self-group ${label} fails without retry or target operations`, async (t) => {
  const fixture = queryFixture(t, [{ result: response }]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, false); assert.equal(result.error.stage, "self-group"); assert.equal(result.error.code, code);
  assert.deepEqual(fixture.calls, [1000]); assert.deepEqual(fixture.targets, []);
});

test("a successful retry identifying the caller's own group still refuses all target operations", async (t) => {
  const fixture = queryFixture(t, [{ result: queryTimeout, elapsedMs: 1000 }, { result: { status: 0, stdout: "2147483647\n" } }]);
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, false); assert.equal(result.error.code, "SELF_PROCESS_GROUP");
  assert.deepEqual(fixture.calls, [1000, 1000]); assert.deepEqual(fixture.targets, []);
});

test("Windows remains unsupported before any self-group query or target operation", async (t) => {
  const fixture = queryFixture(t, [], "win32");
  const result = await closeOwnedProcessGroup(2147483647);
  assert.equal(result.closed, false); assert.equal(result.error.code, "UNSUPPORTED_PLATFORM");
  assert.deepEqual(fixture.calls, []); assert.deepEqual(fixture.targets, []);
});

test("normal detached group closes on TERM without escalation", { skip: !posix }, async (t) => {
  const fixture = ownedGroup(t, `require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`);
  await waitFor(() => existsSync(fixture.receipt), "The owned child must become ready");
  assert.equal(groupExists(fixture.child.pid), true);
  const result = await closeOwnedProcessGroup(fixture.child.pid);
  assert.equal(result.closed, true, JSON.stringify(result)); assert.equal(result.termSent, true);
  assert.equal(result.forced, false); assert.equal(result.killSent, false); assert.equal(result.alreadyGone, false);
  assert.equal(groupExists(fixture.child.pid), false);
  assert.equal((await fixture.exited).signal, "SIGTERM");
});

test("an exited leader cannot hide its live TERM-resistant grandchild group", { skip: !posix }, async (t) => {
  const grandchild = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:process.pid})); setInterval(()=>{},1000);`;
  const leader = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['--eval',${JSON.stringify(grandchild)},process.argv[1]],{stdio:'ignore',env:{}}); child.unref();`;
  const fixture = ownedGroup(t, leader);
  assert.equal((await fixture.exited).code, 0, "The process leader must actually exit before cleanup starts");
  await waitFor(() => existsSync(fixture.receipt), "The orphaned grandchild must publish readiness");
  const descendant = JSON.parse(readFileSync(fixture.receipt, "utf8"));
  assert.notEqual(descendant.pid, fixture.child.pid); assert.equal(fixture.child.exitCode, 0);
  assert.equal(groupExists(fixture.child.pid), true, "The kernel must still observe the group after its leader exits");
  const result = await closeOwnedProcessGroup(fixture.child.pid, { termTimeoutMs: 100, killTimeoutMs: 5000, pollIntervalMs: 10 });
  assert.equal(result.closed, true, JSON.stringify(result)); assert.equal(result.termSent, true);
  assert.equal(result.forced, true); assert.equal(result.killSent, true);
  assert.ok(result.elapsedMs >= 100, "Escalation must wait through the configured TERM grace period");
  assert.equal(groupExists(fixture.child.pid), false);
  assert.throws(() => process.kill(descendant.pid, 0), { code: "ESRCH" });
});

test("a group that already ended is confirmed gone without sending signals", { skip: !posix }, async (t) => {
  const fixture = ownedGroup(t, "process.exit(0)");
  await fixture.exited;
  const result = await closeOwnedProcessGroup(fixture.child.pid);
  assert.equal(result.closed, true, JSON.stringify(result)); assert.equal(result.alreadyGone, true);
  assert.equal(result.termSent, false); assert.equal(result.killSent, false); assert.equal(result.forced, false);
});

test("persistent probe uncertainty after TERM fails without a false closed result or KILL escalation", { skip: !posix }, async (t) => {
  const fixture = ownedGroup(t, `require('node:fs').writeFileSync(process.argv[1], '{}'); setInterval(()=>{},1000);`);
  await waitFor(() => existsSync(fixture.receipt), "The owned child must become ready");
  const originalKill = process.kill; let termSent = false, killAttempted = false;
  process.kill = (pid, signal) => {
    if (pid === -fixture.child.pid && signal === 0 && termSent) throw Object.assign(new Error("Synthetic persistent uncertainty"), { code: "EPERM" });
    if (pid === -fixture.child.pid && signal === "SIGKILL") killAttempted = true;
    const result = originalKill(pid, signal);
    if (pid === -fixture.child.pid && signal === "SIGTERM") termSent = true;
    return result;
  };
  try {
    const result = await closeOwnedProcessGroup(fixture.child.pid, { termTimeoutMs: 50, pollIntervalMs: 10 });
    assert.equal(result.closed, false); assert.equal(result.error.code, "EPERM");
    assert.equal(result.error.stage, "term-wait"); assert.equal(result.termSent, true);
    assert.equal(result.killSent, false); assert.equal(killAttempted, false);
    assert.deepEqual(result.probeErrors, [{ stage: "term-wait", code: "EPERM" }]);
  } finally { process.kill = originalKill; }
});

test("other target probe errors fail before signalling the owned group", { skip: !posix }, async (t) => {
  const fixture = ownedGroup(t, `require('node:fs').writeFileSync(process.argv[1], '{}'); setInterval(()=>{},1000);`);
  await waitFor(() => existsSync(fixture.receipt), "The owned child must become ready");
  const originalKill = process.kill; let signalled = false;
  process.kill = (pid, signal) => {
    if (pid === -fixture.child.pid && signal === 0) throw Object.assign(new Error("Synthetic probe failure"), { code: "EIO" });
    if (pid === -fixture.child.pid) signalled = true;
    return originalKill(pid, signal);
  };
  try {
    const result = await closeOwnedProcessGroup(fixture.child.pid);
    assert.equal(result.closed, false); assert.equal(result.error.code, "EIO");
    assert.equal(result.error.stage, "initial-probe"); assert.equal(signalled, false);
  } finally { process.kill = originalKill; }
});

test("zero, negative, unsafe or current-process identities never become a closed-group claim", async () => {
  for (const pgid of [undefined, null, "123", 0, 1, -1, -process.pid, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, process.pid]) {
    const result = await closeOwnedProcessGroup(pgid);
    assert.equal(result.closed, false); assert.equal(result.error.code, "INVALID_PGID");
    assert.equal(result.termSent, false); assert.equal(result.killSent, false);
  }
});

test("the caller's actual process group is rejected even when its ID differs from its PID", { skip: !posix }, async () => {
  const own = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 1000 });
  assert.equal(own.status, 0);
  const pgid = Number(own.stdout.trim()); assert.ok(Number.isSafeInteger(pgid) && pgid > 0);
  const result = await closeOwnedProcessGroup(pgid);
  assert.equal(result.closed, false); assert.ok(["SELF_PROCESS_GROUP", "INVALID_PGID"].includes(result.error.code));
  assert.equal(result.termSent, false); assert.equal(result.killSent, false);
});

test("unbounded or invalid grace periods fail before probing or signalling a target", { skip: !posix }, async () => {
  for (const options of [{ termTimeoutMs: 5001 }, { killTimeoutMs: 5001 }, { termTimeoutMs: -1 }, { killTimeoutMs: Infinity }, { pollIntervalMs: 0 }, { pollIntervalMs: 1001 }]) {
    // This positive sentinel is never probed because option validation precedes
    // the self-group query and target operations.
    const result = await closeOwnedProcessGroup(2147483647, options);
    assert.equal(result.closed, false); assert.equal(result.error.code, "INVALID_TIMEOUT");
    assert.equal(result.termSent, false); assert.equal(result.killSent, false);
  }
});
