import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OwnedGitError, runOwnedGit } from "../dist/owned/owned-git.js";
import { spawnParentGuardedProcess } from "../dist/owned/parent-guard.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= until) throw new Error("Actual process observation timed out"); await pause(10); }
}
function absent(pid, group = false) {
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "artoo-parent-guard-real-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, "command.mjs"), ready = join(root, "ready.json");
  const options = { gitExecutable: process.execPath, readTimeoutMs: 5000, materializeTimeoutMs: 10_000,
    terminationTimeoutMs: 5000, maxOutputBytes: 64 * 1024, guardParent: true,
    environment: { PATH: process.env.PATH } };
  const run = (signal) => runOwnedGit({ cwd: root, args: [script], kind: "materialize", signal }, options);
  return { root, script, ready, options, run };
}
function closed(receipt) {
  assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(receipt.childExitObserved, true); assert.equal(receipt.childCloseObserved, true); assert.equal(receipt.groupState, "absent");
  assert.equal(receipt.parent_guard.cleanupConfirmed, true); assert.equal(receipt.parent_guard.exitObserved, true);
  assert.equal(receipt.parent_guard.closeObserved, true); assert.equal(receipt.parent_guard.groupAbsentObserved, true);
  assert.notEqual(receipt.pid, receipt.parent_guard.pid);
  assert(absent(receipt.pid, true)); assert(absent(receipt.parent_guard.pid, true));
}

test("guarded command receipts observe the real command exit and a separately closed guardian", { skip: !supported, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  for (const status of [0, 7]) {
    writeFileSync(f.script, `console.log(JSON.stringify({pid:process.pid,parent:process.ppid}));console.error('real stderr');process.exit(${status});`);
    const result = await f.run();
    const observed = JSON.parse(result.stdout.toString());
    assert.equal(result.status, status); assert.equal(result.receipt.childStatus, status);
    assert.equal(observed.pid, result.receipt.pid); assert.equal(observed.parent, result.receipt.parent_guard.pid);
    assert.equal(result.stderr.toString().trim(), "real stderr"); closed(result.receipt);
    assert.equal(result.receipt.parent_guard.disarmRequested, true);
  }
});

test("the opt-in leaves the ordinary owned-command execution contract unchanged", { skip: !supported, timeout: 15_000 }, async (t) => {
  const f = fixture(t); writeFileSync(f.script, "console.log(process.pid)");
  const result = await runOwnedGit({ cwd: f.root, args: [f.script], kind: "materialize" }, { ...f.options, guardParent: false });
  assert.equal(Number(result.stdout.toString()), result.receipt.pid); assert.equal(result.receipt.cleanupConfirmed, true);
  assert.equal(result.receipt.parent_guard, undefined); assert(absent(result.receipt.pid, true));
});

test("guarded command cancellation and timeout close both actual process groups", { skip: !supported, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  for (const cancel of [true, false]) {
    if (existsSync(f.ready)) rmSync(f.ready);
    writeFileSync(f.script, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
    const controller = new AbortController(); f.options.materializeTimeoutMs = cancel ? 10_000 : 1500;
    const pending = f.run(controller.signal).then((value) => ({ value }), (error) => ({ error }));
    await waitFor(() => existsSync(f.ready)); if (cancel) controller.abort();
    const result = await pending; assert(result.error instanceof OwnedGitError);
    assert.equal(result.error.code, cancel ? "aborted" : "timeout"); closed(result.error.receipt);
    assert(result.error.receipt.signals.some((entry) => entry.signal === "SIGKILL"));
  }
});

test("a failed guarded command spawn cannot masquerade as an actual exit", { skip: !supported, timeout: 15_000 }, async (t) => {
  const f = fixture(t);
  await assert.rejects(runOwnedGit({ cwd: f.root, args: [], kind: "read" }, { ...f.options, gitExecutable: join(f.root, "missing-executable") }), (error) => {
    assert(error instanceof OwnedGitError); assert.equal(error.code, "spawn_failed"); assert.equal(error.receipt.spawned, false);
    assert.equal(error.receipt.childExitObserved, false); assert.equal(error.receipt.childCloseObserved, true);
    assert.equal(error.receipt.cleanupConfirmed, true); assert.equal(error.receipt.parent_guard.cleanupConfirmed, true); return true;
  });
});

test("guarded output limits retain bounded bytes and close both actual process groups", { skip: !supported, timeout: 15_000 }, async (t) => {
  const f = fixture(t); f.options.maxOutputBytes = 1024;
  writeFileSync(f.script, "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)");
  await assert.rejects(f.run(), (error) => {
    assert(error instanceof OwnedGitError); assert.equal(error.code, "output_limit");
    assert.equal(error.stdout.length + error.stderr.length, 1024); assert.equal(error.receipt.outputTruncated, true); closed(error.receipt); return true;
  });
});

test("guarded burst output drains paused command pipes during cleanup", { skip: !supported, timeout: 30_000 }, async (t) => {
  for (const stream of ["stdout", "stderr"]) await t.test(stream, async (t) => {
    const f = fixture(t); f.options.maxOutputBytes = 1024 * 1024;
    writeFileSync(f.script, `process.${stream}.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)`);
    await assert.rejects(f.run(), (error) => {
      assert(error instanceof OwnedGitError);
      t.after(async () => {
        // A failing regression must also reap its observed process groups.
        for (const pid of [error.receipt.pid, error.receipt.parent_guard?.pid]) {
          if (pid && !absent(pid, true)) {
            try { process.kill(-pid, "SIGKILL"); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
            await waitFor(() => absent(pid, true));
          }
        }
      });
      assert.equal(error.code, "output_limit");
      assert.equal(error.stdout.length + error.stderr.length, f.options.maxOutputBytes);
      assert.equal(error.receipt.outputTruncated, true); closed(error.receipt); return true;
    });
  });
});

test("closing a backpressured guardian pipe still observes actual command closure", { skip: !supported, timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.script, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:process.pid,guardian:process.ppid}));process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`);
  const child = spawnParentGuardedProcess(process.execPath, [f.script], f.root, { PATH: process.env.PATH });
  let observed = 0, exited = false, didClose = false;
  const errors = [];
  child.on("error", (error) => { errors.push(error); }); child.on("exit", () => { exited = true; }); child.on("close", () => { didClose = true; });
  child.stdout.on("data", (chunk) => { observed += chunk.length; if (observed >= 1024 * 1024) child.stdout.pause(); });
  child.stderr.resume();
  t.after(async () => {
    child.stdout.destroy(); child.stderr.destroy();
    const receipt = await child.closeGuard(exited && didClose && absent(child.pid, true));
    for (const pid of [child.pid, receipt.pid]) {
      if (pid && !absent(pid, true)) {
        try { process.kill(-pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await waitFor(() => absent(pid, true));
      }
    }
  });
  await waitFor(() => observed >= 1024 * 1024);
  // Keep the receiver paused long enough for the actual OS pipe to backpressure
  // the relay. Closing it must discard queued command output, not strand close.
  await pause(100); child.stdout.destroy();
  await waitFor(() => exited && didClose, 3000);
  assert(absent(child.pid, true));
  const receipt = await child.closeGuard(true);
  assert.equal(receipt.cleanupConfirmed, true); assert.equal(receipt.exitObserved, true);
  assert.equal(receipt.closeObserved, true); assert.equal(receipt.groupAbsentObserved, true);
  assert(absent(receipt.pid, true)); assert.deepEqual(errors, []);
});

test("losing the guardian never fabricates missing command exit observations or leaves the owner promise pending", { skip: !supported, timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  writeFileSync(f.script, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:process.pid,guardian:process.ppid}));setInterval(()=>{},1000);`);
  const pending = f.run().then((value) => ({ value }), (error) => ({ error }));
  await waitFor(() => existsSync(f.ready)); const ids = JSON.parse(readFileSync(f.ready, "utf8")); process.kill(ids.guardian, "SIGKILL");
  const result = await pending; assert(result.error instanceof OwnedGitError); assert.equal(result.error.code, "cleanup_uncertain");
  assert.equal(result.error.receipt.cleanupConfirmed, false); assert.equal(result.error.receipt.childExitObserved, false);
  assert.equal(result.error.receipt.childCloseObserved, false); assert.equal(result.error.receipt.parent_guard.signal, "SIGKILL");
  assert(absent(ids.guardian, true)); await waitFor(() => absent(ids.pid, true));
});

test("a real daemon SIGKILL causes guardian EOF cleanup of the verifier and its same-group descendant", { skip: !supported, timeout: 30_000 }, async (t) => {
  const f = fixture(t), descendantReady = join(f.root, "descendant.json"), receiptPath = join(f.root, "receipt.json");
  const descendant = join(f.root, "descendant.mjs"), daemon = join(f.root, "daemon.mjs");
  writeFileSync(descendant, `import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(descendantReady)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`);
  writeFileSync(f.script, `import{spawn}from'node:child_process';import{existsSync,readFileSync,writeFileSync}from'node:fs';
    process.on('SIGTERM',()=>{});spawn(process.execPath,[${JSON.stringify(descendant)}],{stdio:'inherit'});
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(descendantReady)})){clearInterval(timer);writeFileSync(${JSON.stringify(f.ready)},JSON.stringify({pid:process.pid,guardian:process.ppid,descendant:JSON.parse(readFileSync(${JSON.stringify(descendantReady)},'utf8')).pid}));}},10);setInterval(()=>{},1000);`);
  writeFileSync(daemon, `import{runOwnedGit}from ${JSON.stringify(new URL("../dist/owned/owned-git.js", import.meta.url).href)};import{writeFileSync}from'node:fs';
    const result=await runOwnedGit({cwd:${JSON.stringify(f.root)},args:[${JSON.stringify(f.script)}],kind:'materialize'},${JSON.stringify({ ...f.options, materializeTimeoutMs: 60_000 })});writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify(result.receipt));`);
  const owner = spawn(process.execPath, [daemon], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "", ownerClosed = false; owner.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const done = new Promise((resolve) => owner.once("close", (code, signal) => { ownerClosed = true; resolve({ code, signal }); }));
  let ids;
  t.after(async () => {
    if (!ownerClosed) owner.kill("SIGKILL"); await done;
    // Test cleanup is restricted to this fixture's still-observed command group.
    if (ids && !absent(ids.pid, true)) { try { process.kill(-ids.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  });
  await waitFor(() => existsSync(f.ready) || ownerClosed);
  assert.equal(ownerClosed, false, errors); ids = JSON.parse(readFileSync(f.ready, "utf8"));
  assert(!absent(ids.pid)); assert(!absent(ids.guardian)); assert(!absent(ids.descendant));
  owner.kill("SIGKILL"); assert.deepEqual(await done, { code: null, signal: "SIGKILL" });
  await waitFor(() => absent(ids.pid, true) && absent(ids.guardian, true) && absent(ids.descendant));
  assert.equal(existsSync(receiptPath), false, "A killed daemon cannot issue a successful completion receipt");
});
