// Fixed native nested-Job regression, not model/product or multi-computer acceptance.
// Build the composed candidate first. Run only in an explicitly opened native window.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import test from "node:test";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { isWindowsOwnedClosureReceipt, startWindowsOwnedProcess } from "../dist/owned/windows-owned-process.js";

if (process.platform !== "win32" || process.env.ARTOO_WINDOWS_BROWSER_JOB_NATIVE_WINDOW !== "1") throw new Error("Explicit native Windows browser Job fixture window is required; skipping cannot qualify this test");
const bundle = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE, manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
const browser = process.env.ARTOO_TEST_CHROMIUM;
if (!bundle || !isAbsolute(bundle) || !browser || !isAbsolute(browser) || !/^sha256:[a-f0-9]{64}$/.test(manifestSha256 ?? "")) {
  throw new Error("Exact installed helper directory, separately bound manifest SHA-256 and Chrome executable are required");
}
const directory = realpathSync.native(bundle), executablePath = realpathSync.native(browser);
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Local Windows SystemRoot is required");
const worker = fileURLToPath(new URL("./owned-browser-windows-job-worker.mjs", import.meta.url));
const temporaryBase = realpathSync.native(tmpdir()), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertClosure(receipt, startedPid) {
  assert.equal(isWindowsOwnedClosureReceipt(receipt), true, "Only the original in-process receipt is authority");
  assert.equal(receipt.rootPid, startedPid); assert.equal(receipt.rootCreated, true); assert.equal(receipt.rootStarted, true);
  assert.equal(receipt.atomicJobMember, true); assert.equal(receipt.rootWaitObserved, true); assert.ok(receipt.rootCreationTime);
  assert.equal(receipt.jobEmptyObserved, true); assert.equal(receipt.stdoutEof, true); assert.equal(receipt.stderrEof, true);
  assert.equal(receipt.helperSpawnObserved, true); assert.equal(receipt.helperExitObserved, true); assert.equal(receipt.helperCloseObserved, true);
  assert.equal(receipt.helperExitCode, 0); assert.equal(receipt.helperSignal, null); assert.equal(receipt.cleanupConfirmed, true);
  assert.equal(receipt.failureCode, null); assert.equal(receipt.nativeError, null);
}
function assertProfile(root, value) {
  assert.equal(typeof value, "string"); const allowed = realpathSync.native(join(root, "temporary"));
  assert.equal(lstatSync(value).isSymbolicLink(), false);
  const tail = relative(allowed, realpathSync.native(value));
  assert.ok(tail && tail !== ".." && !tail.startsWith(".." + sep) && !isAbsolute(tail));
}
for (const mode of ["normal", "abort", "outer-cancel"]) {
  test("real nested browser Job: " + mode, { timeout: 120000 }, async () => {
    const root = mkdtempSync(join(temporaryBase, "artoo-browser-nested-job-"));
    mkdirSync(join(root, "workspace")); mkdirSync(join(root, "temporary"));
    let run, streams, originalReceipt, passed = false;
    const stdout = [], stderr = [];
    try {
      const backend = prepareWindowsProcessInstallation({ directory, manifestSha256, writableWorkspaceRoots: [root] });
      run = startWindowsOwnedProcess(backend, { executable: process.execPath, args: [worker, root, mode, executablePath, directory, manifestSha256],
        cwd: root, env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"),
          TEMP: join(root, "temporary"), TMP: join(root, "temporary"), ARTOO_WINDOWS_BROWSER_JOB_NATIVE_WINDOW: "1" },
        timeoutMs: 90000, maxOutputBytes: 1024 * 1024, cleanupTimeoutMs: 5000, normalExitPolicy: "require-empty", normalExitGraceMs: 250 });
      run.stdout.on("data", data => stdout.push(Buffer.from(data))); run.stderr.on("data", data => stderr.push(Buffer.from(data)));
      streams = Promise.all([finished(run.stdout, { cleanup: true }), finished(run.stderr, { cleanup: true })]); void streams.catch(() => {});
      const { pid: startedPid } = await run.started;
      let earlyClosed = false; void run.closed.then(() => { earlyClosed = true; }, () => { earlyClosed = true; });
      let facts;
      if (mode === "outer-cancel") {
        const deadline = Date.now() + 60000, ready = join(root, "ready.json");
        while (!existsSync(ready) && !earlyClosed && Date.now() < deadline) await pause(20);
        assert.equal(existsSync(ready), true, "Nested browser must render before outer Job cancellation");
        facts = JSON.parse(readFileSync(ready, "utf8")); assert.equal(facts.real_renderer, true); assertProfile(root, facts.profile);
        run.cancel();
      }
      originalReceipt = await run.closed; await streams; assertClosure(originalReceipt, startedPid);
      if (mode === "outer-cancel") {
        assert.equal(originalReceipt.terminationReason, "cancelled"); assert.equal(originalReceipt.nativeTerminationReason, "cancelled");
        assert.equal(existsSync(facts.profile), true, "Killed worker cannot falsely remove its browser profile");
      } else {
        assert.equal(originalReceipt.rootExitCode, 0, Buffer.concat(stderr).toString("utf8"));
        assert.equal(originalReceipt.terminationReason, null); assert.equal(originalReceipt.nativeTerminationReason, null);
        facts = JSON.parse(readFileSync(join(root, "facts.json"), "utf8"));
        assert.equal(facts.worker_pid, startedPid); assert.equal(facts.nested_job, true); assert.equal(facts.real_renderer, true);
        if (mode === "normal") { assert.equal(facts.close_passed, true); assert.equal(facts.profile_removed, true); assert.equal(facts.repeated_close_same_promise, true); }
        else { assert.equal(facts.external_abort_rejected, true); assert.equal(facts.profile_retained, true); assertProfile(root, facts.profile); }
      }
      assert.notEqual(facts.browser_pid, startedPid);
      // Serialized receipt below is evidence only, never reused as process authority.
      process.stdout.write(JSON.stringify({ event: "native_browser_nested_job", mode, facts, outer_receipt: originalReceipt }) + String.fromCharCode(10));
      passed = true;
    } finally {
      if (run && !originalReceipt) {
        run.cancel();
        try { originalReceipt = await run.closed; await streams; } catch { /* Failed cleanup retains the exact fixture root below. */ }
      }
      if (passed && originalReceipt && isWindowsOwnedClosureReceipt(originalReceipt) && originalReceipt.cleanupConfirmed) {
        const physical = realpathSync.native(root);
        assert.equal(dirname(physical), temporaryBase); assert.equal(lstatSync(root).isSymbolicLink(), false);
        assert.ok(physical.startsWith(join(temporaryBase, "artoo-browser-nested-job-")));
        // The genuine outer Job has already observed every nested descendant gone.
        rmSync(physical, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } else process.stderr.write(JSON.stringify({ event: "native_browser_nested_job_retained", mode, root }) + String.fromCharCode(10));
    }
  });
}
