import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
