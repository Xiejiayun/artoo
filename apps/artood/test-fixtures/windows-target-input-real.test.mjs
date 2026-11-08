// Source only: this fixture has not been executed. It requires the scheduled
// exact native bundle; it is not live-provider or product-publication evidence.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { isWindowsOwnedClosureReceipt, isWindowsOwnedTargetInputReceipt, startWindowsOwnedProcess } from "../dist/owned/windows-owned-process.js";

if (process.platform !== "win32" || process.arch !== "x64" || process.env.ARTOO_WINDOWS_TARGET_INPUT_NATIVE_WINDOW !== "1") {
  throw new Error("An explicitly scheduled native Windows x64 target-input window is required; skipping does not qualify this fixture");
}
const bundleArgument = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE;
const manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
const evidenceArgument = process.env.ARTOO_WINDOWS_TARGET_INPUT_EVIDENCE_ROOT;
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (![bundleArgument, evidenceArgument, systemRoot].every(value => typeof value === "string" && isAbsolute(value))
  || !/^sha256:[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("Exact bundle, separately bound manifest digest, fresh evidence root and SystemRoot are required");
const directory = realpathSync.native(bundleArgument), node = realpathSync.native(process.execPath);
const worker = fileURLToPath(new URL("./windows-target-input-worker.mjs", import.meta.url));
const evidenceParent = realpathSync.native(dirname(evidenceArgument));
const evidenceRoot = join(evidenceParent, basename(evidenceArgument));
const contains = (root, path) => { const tail = relative(root, path); return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep)); };
assert.equal(contains(directory, evidenceRoot) || contains(evidenceRoot, directory), false, "Evidence must not overlap the protected helper installation");
mkdirSync(evidenceRoot); // Exclusive fresh directory. Every case and failure is retained.
const modes = ["legacy-null", "idle-initialize", "message-4096", "post-ack-cancel", "idle-cancel", "idle-timeout", "root-exit-reader"];
const targetInput = Object.freeze({ version: 1, mode: "single-message-eof", maximumBytes: 4096 });
const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function pin(path) {
  assert.equal(realpathSync.native(path).toLowerCase(), path.toLowerCase(), "Fixture input must be its physical path");
  const before = lstatSync(path); assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false); assert.equal(before.nlink, 1);
  const bytes = readFileSync(path), after = lstatSync(path);
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(after[field], before[field], "Fixture input changed during read: " + path);
  return { path, size: bytes.length, sha256: digest(bytes), device: after.dev, inode: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
}
const pins = [node, fileURLToPath(import.meta.url), worker, fileURLToPath(new URL("../dist/owned/windows-owned-process.js", import.meta.url)),
  fileURLToPath(new URL("../dist/windows-process-installation.js", import.meta.url)), join(directory, "manifest.json")].map(path => pin(realpathSync.native(path)));
assert.equal(pins.at(-1).sha256, manifestSha256, "Manifest differs from the independent local binding");
function assertPins() { for (const original of pins) assert.deepEqual(pin(original.path), original, "Bound fixture input changed"); }
writeFileSync(join(evidenceRoot, "inputs.json"), JSON.stringify({ version: 1, modes, directory, manifestSha256, pins,
  scope: "controlled real Windows target input, original Job closure; no provider/product qualification" }, null, 2) + "\n", { flag: "wx" });
function failure(error) { return { name: error instanceof Error ? error.name : "Unknown", message: error instanceof Error ? error.message : String(error) }; }
function assertClosure(receipt, started) {
  assert.equal(isWindowsOwnedClosureReceipt(receipt), true, "Serialized copies cannot replace the original owner receipt");
  assert.equal(receipt.rootPid, started.pid); assert.equal(receipt.rootCreationTime, started.creationTime);
  for (const key of ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "stdoutEof", "stderrEof", "jobEmptyObserved",
    "helperSpawnObserved", "helperExitObserved", "helperCloseObserved", "cleanupConfirmed"]) assert.equal(receipt[key], true, "Missing original closure fact: " + key);
  assert.equal(receipt.helperExitCode, 0); assert.equal(receipt.helperSignal, null);
  assert.equal(receipt.failureCode, null); assert.equal(receipt.nativeError, null);
}
function observe(run) {
  const events = [], stdout = [], stderr = [], notifications = new EventEmitter();
  let buffer = "", parseFailure, ownerClosed = false;
  run.stdout.on("data", data => {
    stdout.push(Buffer.from(data)); buffer += data.toString("utf8");
    try {
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        assert.ok(Buffer.byteLength(line) <= 65536); const event = JSON.parse(line);
        assert.equal(event.version, 1); assert.ok(modes.includes(event.mode) || event.mode === "held-reader");
        assert.equal(typeof event.kind, "string"); assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);
        events.push(event);
      }
      assert.ok(Buffer.byteLength(buffer) <= 65536); notifications.emit("change");
    } catch (error) { parseFailure ??= error; run.cancel(); notifications.emit("change"); }
  });
  run.stderr.on("data", data => stderr.push(Buffer.from(data)));
  run.stdout.on("end", () => { if (buffer) parseFailure ??= new Error("Partial target fixture output"); notifications.emit("change"); });
  void run.closed.then(() => { ownerClosed = true; notifications.emit("change"); }, () => { ownerClosed = true; notifications.emit("change"); });
  return { events, stdout, stderr,
    assertParsed() { if (parseFailure) throw parseFailure; assert.equal(buffer, ""); },
    async wait(kind, pid, timeoutMs = 10000) {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Missing real target event: " + kind)), timeoutMs);
        function finish(error, value) { clearTimeout(timer); notifications.off("change", check); error ? reject(error) : resolve(value); }
        function check() {
          if (parseFailure) return finish(parseFailure);
          const value = events.find(event => event.kind === kind && event.pid === pid);
          if (value) return finish(undefined, value);
          if (ownerClosed) finish(new Error("Original owner closed before target event: " + kind));
        }
        notifications.on("change", check); check();
      });
    },
  };
}

for (const mode of modes) {
  test("real Windows target input: " + mode, { timeout: 90000, concurrency: false }, async context => {
    const root = join(evidenceRoot, mode); mkdirSync(root);
    let run, output, streams, started, receipt, ack, memberObservation;
    let passed = false, primaryFailure, cleanupFailure, sourceFailure;
    try {
      assertPins();
      // The real installation audit remains mandatory. This fixture supplies no
      // alternate qualification callback and never edits ACLs or the bundle.
      const backend = prepareWindowsProcessInstallation({ directory, manifestSha256, writableWorkspaceRoots: [evidenceRoot] });
      run = startWindowsOwnedProcess(backend, { executable: node, args: [worker, mode], cwd: root,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), ARTOO_WINDOWS_TARGET_INPUT_NATIVE_WINDOW: "1" },
        timeoutMs: 30000, cleanupTimeoutMs: 5000, maxOutputBytes: 1024 * 1024,
        normalExitPolicy: "require-empty", normalExitGraceMs: 500, signal: context.signal,
        ...(mode === "legacy-null" ? {} : { targetInput }) });
      output = observe(run);
      streams = Promise.all([finished(run.stdout, { cleanup: true }), finished(run.stderr, { cleanup: true })]); void streams.catch(() => {});
      started = await run.started; assert.ok(started.creationTime); await output.wait("ready", started.pid);
      if (mode === "legacy-null") assert.equal(run.endInput, undefined);
      else assert.equal(typeof run.endInput, "function");
      if (mode === "message-4096" || mode === "post-ack-cancel") {
        const bytes = mode === "message-4096" ? Buffer.alloc(4096, 0x41) : Buffer.from('{"kind":"shutdown"}\n');
        const expected = Buffer.from(bytes), writing = run.endInput(bytes); bytes.fill(0x42);
        ack = await writing;
        assert.equal(isWindowsOwnedTargetInputReceipt(ack), true); assert.equal(isWindowsOwnedTargetInputReceipt({ ...ack }), false);
        assert.equal(ack.bytesWritten, expected.length); assert.equal(ack.sha256, digest(expected)); assert.equal(ack.inputClosed, true);
        const fact = await output.wait("input-eof", started.pid);
        assert.equal(fact.bytes, expected.length); assert.equal(fact.sha256, digest(expected)); assert.equal(fact.eof, true);
        if (mode === "post-ack-cancel") {
          // A new original-Job observation must traverse control stdin after the
          // target's EOF. An ACK alone cannot demonstrate that control stayed open.
          assert.equal(typeof run.observeMembers, "function");
          memberObservation = await run.observeMembers([{ pid: started.pid, creationTime: started.creationTime }]);
          assert.deepEqual(memberObservation.members, [{ pid: started.pid, creationTime: started.creationTime, status: "observed", jobMember: true }]);
          run.cancel();
        }
      } else if (mode === "idle-cancel") run.cancel();
      // idle-timeout intentionally sends neither input nor cancel here. Its
      // original operation deadline must terminate the Job; it cannot pass as a
      // normal root exit or extend the deadline while waiting for target input.
      receipt = await run.closed; await streams; output.assertParsed(); assertClosure(receipt, started);
      if (mode === "legacy-null") {
        assert.equal(receipt.targetInput, undefined);
        assert.deepEqual(output.events.find(event => event.kind === "legacy-eof"), { version: 1, mode, pid: started.pid, kind: "legacy-eof", eof: true, bytes: 0 });
      } else {
        assert.deepEqual(receipt.targetInput, { version: 1, pipeCreated: true, writeRequested: !!ack, requestId: ack?.requestId ?? null,
          bytesWritten: ack?.bytesWritten ?? 0, inputClosed: true });
        if (ack) assert.equal(ack.token, receipt.token);
      }
      if (mode === "idle-cancel" || mode === "post-ack-cancel") {
        assert.equal(receipt.terminationReason, "cancelled"); assert.equal(receipt.nativeTerminationReason, "cancelled");
      } else if (mode === "idle-timeout") {
        assert.equal(receipt.terminationReason, "timeout");
        assert.ok(["timeout", "cancelled"].includes(receipt.nativeTerminationReason), "The original node/native deadline may win first, never normal completion");
      } else if (mode === "root-exit-reader") {
        const fact = output.events.find(event => event.kind === "root-leaving-reader" && event.pid === started.pid);
        assert.ok(fact && Number.isSafeInteger(fact.descendantPid) && fact.descendantPid !== started.pid);
        assert.equal(fact.eofBeforeRootExit, false); assert.equal(fact.bytes, 0);
        assert.ok(output.events.some(event => event.mode === "held-reader" && event.pid === fact.descendantPid && event.kind === "ready"));
        assert.equal(receipt.rootExitCode, 0); assert.equal(receipt.terminationReason, "lingering_processes");
        assert.equal(receipt.nativeTerminationReason, "lingering_processes");
      } else {
        assert.equal(receipt.rootExitCode, 0); assert.equal(receipt.terminationReason, null); assert.equal(receipt.nativeTerminationReason, null);
        if (mode === "idle-initialize") {
          const fact = output.events.find(event => event.kind === "initialized" && event.pid === started.pid);
          assert.ok(fact); assert.equal(fact.eofBeforeOwnReadClose, false); assert.equal(fact.bytes, 0); assert.equal(fact.ownReadClosed, true);
        }
      }
      passed = true;
    } catch (error) { primaryFailure = failure(error); if (error?.receipt) receipt = error.receipt; throw error; }
    finally {
      if (run && !receipt) {
        run.cancel();
        try { receipt = await run.closed; } catch (error) { cleanupFailure = failure(error); if (error?.receipt) receipt = error.receipt; }
      }
      if (streams) try { await streams; } catch (error) { cleanupFailure ??= failure(error); }
      try { assertPins(); } catch (error) { sourceFailure = failure(error); }
      const confirmed = !!receipt && isWindowsOwnedClosureReceipt(receipt) && receipt.cleanupConfirmed;
      const finalPassed = passed && confirmed && !cleanupFailure && !sourceFailure;
      writeFileSync(join(root, "stdout.log"), Buffer.concat(output?.stdout ?? []), { flag: "wx" });
      writeFileSync(join(root, "stderr.log"), Buffer.concat(output?.stderr ?? []), { flag: "wx" });
      writeFileSync(join(root, "result.json"), JSON.stringify({ version: 1, mode, passed: finalPassed, started, ack, memberObservation,
        receipt, events: output?.events ?? [], primaryFailure, cleanupFailure, sourceFailure,
        cleanupConfirmedByOriginalOwner: confirmed, retained: true }, null, 2) + "\n", { flag: "wx" });
      process.stdout.write(JSON.stringify({ event: "windows_target_input_case", mode, passed: finalPassed, evidence: root, cleanupConfirmed: confirmed }) + "\n");
      if (!primaryFailure && !finalPassed) throw new Error("Target-input fixture postflight failed; preserve evidence at " + root);
    }
  });
}
