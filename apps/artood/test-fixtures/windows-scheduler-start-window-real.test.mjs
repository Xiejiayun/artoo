// Native helper gate regression. This is controlled process evidence, not provider/product acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  prepareWindowsProcessBackend,
  assertWindowsSchedulerStartBackend,
  startWindowsOwnedProcess,
} from "../dist/owned/windows-owned-process.js";
import { windowsQpcMs } from "../dist/owned/windows-launch-window.js";

if (process.platform !== "win32")
  throw new Error("Native Windows is required; skipping does not qualify this integration");
const directory = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE,
  manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
if (!directory || !isAbsolute(directory) || !/^sha256:[a-f0-9]{64}$/.test(manifestSha256 ?? ""))
  throw new Error("Set the exact rebuilt helper directory and pinned manifest digest");
const root = realpathSync.native(directory),
  manifestPath = join(root, "manifest.json");
const sha = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const backend = prepareWindowsProcessBackend({
  directory: root,
  manifestSha256,
  assertLocalInstallation() {
    // Controlled fixture pin only, never production installation qualification.
    assert.equal(realpathSync.native(directory), root);
    assert.equal(lstatSync(directory).isSymbolicLink(), false);
    assert.equal(sha(readFileSync(manifestPath)), manifestSha256);
  },
});
assertWindowsSchedulerStartBackend(backend);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const helperExecutable = join(root, manifest.executable);

test("native QPC gate rejects an expired absolute deadline without creating a target", { timeout: 20000 }, async () => {
  const workspace = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-launch-window-")),
    marker = join(workspace, "must-not-exist");
  let provedClosed = false,
    launched = false,
    final;
  const helper = spawn(helperExecutable, ["--stdio-v1"], {
    cwd: root,
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = createInterface({ input: helper.stdout });
  let stderrBytes = 0,
    protocolError;
  helper.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 65536) helper.stdin.end();
  });
  const timeout = setTimeout(() => {
    helper.stdin.end();
    helper.kill();
  }, 12000);
  frames.on("line", (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.kind === "ready") {
        assert.ok(frame.payload.capabilities.includes("artoo.windows-launch-window.v1"));
        assert.ok(Math.abs(frame.payload.launchClock.tick_ms - windowsQpcMs()) < 5000);
        assert.equal(launched, false);
        launched = true;
        helper.stdin.write(
          JSON.stringify({
            version: 1,
            kind: "launch",
            token: randomUUID(),
            executable: process.execPath,
            args: ["-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", marker],
            cwd: workspace,
            env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
            timeoutMs: 5000,
            cleanupTimeoutMs: 5000,
            maxOutputBytes: 65536,
            normalExitPolicy: "require-empty",
            normalExitGraceMs: 250,
            launchWindow: { version: 1, clock: "windows-qpc-ms.v1", deadline_ms: windowsQpcMs() - 1 },
          }) + "\n",
        );
      } else if (frame.kind === "created" || frame.kind === "started")
        throw new Error("Expired native window created a target");
      else if (frame.kind === "complete") {
        assert.equal(final, undefined);
        final = frame.payload;
      }
    } catch (error) {
      protocolError = error;
      helper.stdin.end();
    }
  });
  try {
    const result = await new Promise((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.ifError(protocolError);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(launched, true);
    assert.equal(final?.failureCode, "launch_window_expired");
    assert.equal(final?.noTargetCreated, true);
    assert.equal(final?.rootCreated, false);
    assert.equal(final?.rootStarted, false);
    assert.equal(final?.cleanupConfirmed, true);
    provedClosed = true;
    assert.equal(existsSync(marker), false);
  } finally {
    clearTimeout(timeout);
    frames.close();
    if (provedClosed) rmSync(workspace, { recursive: true });
  }
});

test("original native Job can observe its exact target then confirms full closure", { timeout: 20000 }, async () => {
  const workspace = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-launch-job-"));
  let provedClosed = false,
    run;
  try {
    run = startWindowsOwnedProcess(backend, {
      executable: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: workspace,
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot },
      timeoutMs: 10000,
      maxOutputBytes: 65536,
      cleanupTimeoutMs: 5000,
      normalExitPolicy: "require-empty",
      normalExitGraceMs: 250,
      launchWindow: { version: 1, clock: "windows-qpc-ms.v1", deadline_ms: windowsQpcMs() + 5000 },
    });
    const target = await run.started;
    assert.ok(target.creationTime);
    assert.ok(run.observeMembers);
    const facts = await run.observeMembers([{ pid: target.pid, creationTime: target.creationTime }]);
    assert.deepEqual(facts.members, [
      { pid: target.pid, creationTime: target.creationTime, status: "observed", jobMember: true },
    ]);
    run.cancel();
    const receipt = await run.closed;
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.rootWaitObserved, true);
    assert.equal(receipt.jobEmptyObserved, true);
    assert.equal(receipt.helperCloseObserved, true);
    provedClosed = true;
  } finally {
    if (run && !provedClosed) {
      run.cancel();
      try {
        provedClosed = (await run.closed).cleanupConfirmed;
      } catch {}
    }
    if (provedClosed) rmSync(workspace, { recursive: true });
  }
});
