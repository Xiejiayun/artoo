// Native integration: real node verification -> private installed CLI -> nested
// Job browser -> sealed v3 storage measurements. No model, skips or publication.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import test from "node:test";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { isWindowsOwnedClosureReceipt, startWindowsOwnedProcess } from "../dist/owned/windows-owned-process.js";

if (process.platform !== "win32" || process.arch !== "x64" || process.env.ARTOO_WINDOWS_BROWSER_VERIFICATION_NATIVE_WINDOW !== "1") {
  throw new Error("An explicit native win-x64 verification fixture window is required; skipping is not qualification");
}
function physicalInput(name, directory) {
  const value = process.env[name]; assert.ok(value && isAbsolute(value), name + " must be an explicit absolute path");
  const stat = lstatSync(value); assert.equal(stat.isSymbolicLink(), false); assert.equal(directory ? stat.isDirectory() : stat.isFile(), true);
  return realpathSync.native(value);
}
const installationDirectory = physicalInput("ARTOO_WINDOWS_PROCESS_BUNDLE", true), browser = physicalInput("ARTOO_TEST_CHROMIUM", false);
const manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
assert.ok(manifestSha256); assert.match(manifestSha256, /^sha256:[a-f0-9]{64}$/);
const base = realpathSync.native(tmpdir()), systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
assert.ok(systemRoot && isAbsolute(systemRoot));
const worker = fileURLToPath(new URL("./browser-job-verification-worker.mjs", import.meta.url));
const sha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const within = (child, parent) => { const suffix = relative(parent, child); return suffix === "" || suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix); };

test("real native private descriptor and Job browser produce sealed storage evidence and reject missing/mismatched authority", { timeout: 330000 }, async () => {
  // Two separate roots are intentional. Private control/TEMP/evidence are never
  // included in the installation's complete list of agent writable workspaces.
  const root = realpathSync.native(mkdtempSync(join(base, "artoo-job-verification-records-")));
  const workspace = realpathSync.native(mkdtempSync(join(base, "artoo-job-verification-workspace-")));
  assert.equal(within(root, workspace) || within(workspace, root), false);
  const temporary = join(root, "temporary"); mkdirSync(temporary);
  const installation = { directory: installationDirectory, manifestSha256, writableWorkspaceRoots: [workspace] };
  const input = { version: 1, root, workspace, browser, ...installation }, inputFile = join(root, "input.json");
  writeFileSync(inputFile, JSON.stringify(input, null, 2), { flag: "wx" });
  const before = sha(readFileSync(inputFile));
  let run, streams, receipt, passed = false, failure;
  const stdout = [], stderr = [];
  try {
    const backend = prepareWindowsProcessInstallation(installation);
    run = startWindowsOwnedProcess(backend, { executable: process.execPath, args: [worker, inputFile], cwd: root,
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), TEMP: temporary, TMP: temporary,
        ARTOO_WINDOWS_BROWSER_VERIFICATION_NATIVE_WINDOW: "1" }, timeoutMs: 300000, cleanupTimeoutMs: 5000,
      normalExitPolicy: "require-empty", normalExitGraceMs: 250, maxOutputBytes: 1024 * 1024 });
    run.stdout.on("data", data => stdout.push(Buffer.from(data))); run.stderr.on("data", data => stderr.push(Buffer.from(data)));
    streams = Promise.all([finished(run.stdout, { cleanup: true }), finished(run.stderr, { cleanup: true })]); void streams.catch(() => {});
    const { pid } = await run.started; receipt = await run.closed; await streams;
    assert.equal(isWindowsOwnedClosureReceipt(receipt), true, "The outer original receipt is authority for the whole native subtree");
    assert.equal(isWindowsOwnedClosureReceipt(JSON.parse(JSON.stringify(receipt))), false, "Serialized evidence cannot replace original authority");
    assert.equal(receipt.rootPid, pid); assert.ok(receipt.rootCreationTime); assert.equal(receipt.rootExitCode, 0, Buffer.concat(stderr).toString("utf8"));
    for (const flag of ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "jobEmptyObserved", "stdoutEof", "stderrEof",
      "helperSpawnObserved", "helperExitObserved", "helperCloseObserved", "cleanupConfirmed"]) assert.equal(receipt[flag], true, flag);
    assert.equal(receipt.helperExitCode, 0); assert.equal(receipt.helperSignal, null); assert.equal(receipt.failureCode, null); assert.equal(receipt.nativeError, null);
    assert.equal(receipt.terminationReason, null); assert.equal(receipt.nativeTerminationReason, null);
    const result = JSON.parse(readFileSync(join(root, "integration-result.json"), "utf8"));
    assert.equal(result.worker_pid, pid); assert.equal(result.success, true); assert.equal(result.node_receipt.outcome, "passed");
    assert.equal(result.node_receipt.checks[0].exit_code, 0); assert.equal(result.node_receipt.checks[0].observation.version, 3);
    assert.equal(result.sealed_measurement.seed_apply_count, 1); assert.equal(result.sealed_measurement.failed_write_hits, 1);
    assert.equal(result.sealed_measurement.source_unchanged, true); assert.equal(result.sealed_measurement.private_context_removed, true);
    assert.equal(result.negative_cases.length, 10); assert.ok(result.negative_cases.every(item => item.passed && item.cli_exit_code === 1
      && item.temporary_empty && item.original_receipt_authenticated && item.serialized_copy_rejected));
    assert.deepEqual(readdirSync(temporary), [], "Successful node invocation must leave its private TEMP empty");
    assert.equal(sha(readFileSync(inputFile)), before); passed = true;
  } catch (error) { failure = error; throw error; }
  finally {
    if (run && !receipt) {
      run.cancel(); try { receipt = await run.closed; await streams; } catch (error) { failure ??= error; }
    }
    writeFileSync(join(root, "outer-result.json"), JSON.stringify({ version: 1, passed, root, workspace, retained: true,
      source_input_sha256: before, original_receipt_authenticated: receipt ? isWindowsOwnedClosureReceipt(receipt) : false,
      // This JSON projection is evidence only. Cleanup above uses the original in-memory object.
      receipt, error: failure instanceof Error ? failure.message : failure, temporary_entries: readdirSync(temporary) }, null, 2), { flag: "wx" });
    writeFileSync(join(root, "worker.stdout.log"), Buffer.concat(stdout), { flag: "wx" });
    writeFileSync(join(root, "worker.stderr.log"), Buffer.concat(stderr), { flag: "wx" });
    process.stdout.write(JSON.stringify({ fixture: "native-node-cli-job-browser-sealed-storage", passed, retained: true, root, workspace }) + String.fromCharCode(10));
  }
});
