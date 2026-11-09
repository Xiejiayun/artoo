// Source only: no execution or native qualification is implied. Requires an
// explicitly scheduled window and a separately bound, protected native bundle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareWindowsProcessInstallation } from "../dist/windows-process-installation.js";
import { assertWindowsProcessBackend, assertWindowsProcessTargetControlCapability, isWindowsOwnedClosureReceipt,
  isWindowsOwnedTargetControlReceipt, startWindowsOwnedProcess } from "../dist/owned/windows-owned-process.js";

if (process.platform !== "win32" || process.arch !== "x64" || process.env.ARTOO_WINDOWS_TARGET_CONTROL_NATIVE_WINDOW !== "1") {
  throw new Error("An explicitly scheduled native Windows x64 target-control window is required; skipping does not qualify this fixture");
}
const bundleArgument = process.env.ARTOO_WINDOWS_PROCESS_BUNDLE;
const manifestSha256 = process.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256;
const evidenceArgument = process.env.ARTOO_WINDOWS_TARGET_CONTROL_EVIDENCE_ROOT;
const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
if (![bundleArgument, evidenceArgument, systemRoot].every(value => typeof value === "string" && isAbsolute(value))
  || !/^sha256:[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("Exact bundle, separately bound manifest digest, fresh evidence root and SystemRoot are required");
const directory = realpathSync.native(bundleArgument), node = realpathSync.native(process.execPath);
const worker = realpathSync.native(fileURLToPath(new URL("./windows-target-control-worker.mjs", import.meta.url)));
const evidenceRoot = join(realpathSync.native(dirname(evidenceArgument)), basename(evidenceArgument));
const contains = (root, path) => { const tail = relative(root, path); return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep)); };
assert.equal(contains(directory, evidenceRoot) || contains(evidenceRoot, directory), false, "Evidence must not overlap the protected helper installation");
mkdirSync(evidenceRoot); // New directory only. Never remove evidence, even on failure.
const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const controlCapability = "artoo.windows-target-control.v1";
function pin(path) {
  assert.equal(realpathSync.native(path).toLowerCase(), path.toLowerCase());
  const before = lstatSync(path); assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false); assert.equal(before.nlink, 1);
  const bytes = readFileSync(path), after = lstatSync(path);
  for (const field of ["dev", "ino", "size", "mtimeMs", "ctimeMs"]) assert.equal(after[field], before[field], "Fixture input changed during read");
  return { path, size: bytes.length, sha256: digest(bytes), device: after.dev, inode: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
}
const pins = [node, fileURLToPath(import.meta.url), worker, fileURLToPath(new URL("../dist/owned/windows-owned-process.js", import.meta.url)),
  fileURLToPath(new URL("../dist/windows-process-installation.js", import.meta.url)), join(directory, "manifest.json")].map(path => pin(realpathSync.native(path)));
assert.equal(pins.at(-1).sha256, manifestSha256);
function assertPins() { for (const original of pins) assert.deepEqual(pin(original.path), original, "Bound fixture input changed"); }
const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
assert.ok(manifest.capabilities.includes(controlCapability));
const helperExecutable = join(directory, manifest.executable);
const modes = ["ordered-final", "budget-final", "post-final-cancel", "idle-cancel", "idle-timeout", "blocked-cancel", "root-exit-reader"];
const rawModes = ["raw-wrong-sequence", "raw-replayed-id", "raw-replayed-sequence", "raw-after-final", "raw-missing-final",
  "raw-nonboolean-final", "raw-duplicate-final", "raw-extra-field", "raw-over-message", "raw-noncanonical-base64", "raw-message-513"];
writeFileSync(join(evidenceRoot, "inputs.json"), JSON.stringify({ version: 1, modes, rawModes, directory, manifestSha256, pins,
  scope: "controlled real Windows target control and original Job closure; no provider, service-quiescence or product qualification",
  compatibilityRequiredSeparately: "Run existing windows-verified-node-real and windows-target-input-real fixtures on this exact new bundle" }, null, 2) + "\n", { flag: "wx" });
const failure = error => ({ name: error instanceof Error ? error.name : "Unknown", ...(typeof error?.code === "string" ? { code: error.code } : {}) });
function message(sequence, final) {
  const value = { sequence, final, padding: "" };
  value.padding = "x".repeat(4096 - Buffer.byteLength(JSON.stringify(value) + "\n"));
  const bytes = Buffer.from(JSON.stringify(value) + "\n"); assert.equal(bytes.length, 4096); return bytes;
}
function prepare() {
  // Mandatory real installation/ACL audit, without replacement callbacks.
  const backend = prepareWindowsProcessInstallation({ directory, manifestSha256, writableWorkspaceRoots: [evidenceRoot] });
  assertWindowsProcessTargetControlCapability(backend); return backend;
}
function targetEnv() {
  return { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"), ARTOO_WINDOWS_TARGET_CONTROL_NATIVE_WINDOW: "1" };
}
function observer() {
  const events = [], stdout = [], stderr = [], notifications = new EventEmitter();
  let buffer = "", parseFailure, closed = false, outputBytes = 0;
  return { events, stdout, stderr,
    feed(stream, input) {
      const data = Buffer.from(input); (stream === "stdout" ? stdout : stderr).push(data); outputBytes += data.length;
      try {
        assert.ok(outputBytes <= 1024 * 1024);
        if (stream === "stdout") {
          buffer += data.toString("utf8"); let end;
          while ((end = buffer.indexOf("\n")) !== -1) {
            assert.ok(Buffer.byteLength(buffer.slice(0, end)) <= 65536);
            const event = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            assert.equal(event.version, 1); assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);
            assert.ok(["stream", "held-after-final", "idle", "blocked", "root-exit-reader", "held-reader"].includes(event.mode));
            assert.ok(["ready", "message", "input-eof", "root-leaving-reader"].includes(event.kind)); events.push(event);
          }
          assert.ok(Buffer.byteLength(buffer) <= 65536);
        }
      } catch (error) { parseFailure ??= error; }
      notifications.emit("change");
    },
    end() { closed = true; notifications.emit("change"); },
    assertParsed() { if (parseFailure) throw parseFailure; assert.equal(buffer, ""); },
    async wait(predicate, deadline) {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Original fixture event deadline elapsed")), Math.max(1, deadline - performance.now()));
        function finish(error, value) { clearTimeout(timer); notifications.off("change", check); error ? reject(error) : resolve(value); }
        function check() {
          if (parseFailure) return finish(parseFailure);
          const value = events.find(predicate); if (value) return finish(undefined, value);
          if (closed) finish(new Error("Original owner closed before the required target observation"));
        }
        notifications.on("change", check); check();
      });
    },
  };
}
function assertClosure(receipt, started) {
  assert.equal(isWindowsOwnedClosureReceipt(receipt), true); assert.equal(isWindowsOwnedClosureReceipt({ ...receipt }), false);
  assert.equal(receipt.rootPid, started.pid); assert.equal(receipt.rootCreationTime, started.creationTime);
  for (const key of ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "stdoutEof", "stderrEof", "jobEmptyObserved",
    "helperSpawnObserved", "helperExitObserved", "helperCloseObserved", "cleanupConfirmed"]) assert.equal(receipt[key], true, "Missing original closure fact: " + key);
  assert.equal(receipt.helperExitCode, 0); assert.equal(receipt.helperSignal, null); assert.equal(receipt.failureCode, null); assert.equal(receipt.nativeError, null);
}
function assertAck(ack, sequence, bytes, final) {
  assert.equal(isWindowsOwnedTargetControlReceipt(ack), true); assert.equal(isWindowsOwnedTargetControlReceipt({ ...ack }), false);
  assert.equal(ack.version, 1); assert.equal(ack.sequence, sequence); assert.equal(ack.bytesWritten, bytes.length);
  assert.equal(ack.sha256, digest(bytes)); assert.equal(ack.final, final); assert.equal(ack.inputClosed, final);
}
let nativeWindowUsable = true;
function caseEvidence(name, body) {
  test("real Windows target control: " + name, { timeout: 90000, concurrency: false }, async context => {
    const root = join(evidenceRoot, name); mkdirSync(root);
    const state = { root, output: observer(), acks: [], requested: [], rawFrames: [], forcedCleanup: false };
    let passed = false, primaryFailure, cleanupFailure, sourceFailure;
    try { assert.equal(nativeWindowUsable, true, "A previous original owner closure remains unconfirmed"); assertPins(); await body(state, context); passed = true; }
    catch (error) { primaryFailure = failure(error); if (error?.receipt) state.receipt = error.receipt; throw error; }
    finally {
      if (state.run && !state.receipt) {
        state.run.cancel();
        try { state.receipt = await state.run.closed; } catch (error) { cleanupFailure = failure(error); if (error?.receipt) state.receipt = error.receipt; }
      }
      if (state.raw && !state.raw.closed) { state.raw.cancel(); try { await state.raw.close; } catch (error) { cleanupFailure = failure(error); } }
      if (state.streams) try { await state.streams; } catch (error) { cleanupFailure ??= failure(error); }
      try { assertPins(); } catch (error) { sourceFailure = failure(error); }
      const confirmed = state.run ? !!state.receipt && isWindowsOwnedClosureReceipt(state.receipt) && state.receipt.cleanupConfirmed
        : state.raw?.closureConfirmed === true;
      if ((state.run || state.raw) && !confirmed) nativeWindowUsable = false;
      const finalPassed = passed && confirmed && !state.forcedCleanup && !cleanupFailure && !sourceFailure;
      writeFileSync(join(root, "stdout.log"), Buffer.concat(state.output.stdout), { flag: "wx" });
      writeFileSync(join(root, "stderr.log"), Buffer.concat(state.output.stderr), { flag: "wx" });
      writeFileSync(join(root, "result.json"), JSON.stringify({ version: 1, mode: name, passed: finalPassed, started: state.started,
        acks: state.acks, requested: state.requested, cancelledPending: state.cancelledPending,
        memberObservation: state.memberObservation, receipt: state.receipt,
        raw: state.raw?.evidence(), rawFrames: state.rawFrames, events: state.output.events, primaryFailure, cleanupFailure, sourceFailure,
        cleanupConfirmedByOriginalOwner: confirmed, forcedCleanup: state.forcedCleanup, retained: true }, null, 2) + "\n", { flag: "wx" });
      process.stdout.write(JSON.stringify({ event: "windows_target_control_case", mode: name, passed: finalPassed, evidence: root, cleanupConfirmed: confirmed }) + "\n");
      if (!primaryFailure && !finalPassed) throw new Error("Target-control postflight failed; retained evidence is required");
    }
  });
}

for (const mode of modes) caseEvidence(mode, async (state, context) => {
  const backend = prepare(), targetMode = mode === "post-final-cancel" ? "held-after-final"
    : mode === "root-exit-reader" ? mode : mode === "blocked-cancel" ? "blocked" : mode.startsWith("idle-") ? "idle" : "stream";
  const timeoutMs = mode === "idle-timeout" ? 10000 : 30000, deadline = performance.now() + timeoutMs;
  const run = state.run = startWindowsOwnedProcess(backend, { executable: node, args: [worker, targetMode], cwd: state.root,
    env: targetEnv(), timeoutMs, cleanupTimeoutMs: 5000, maxOutputBytes: 1024 * 1024,
    normalExitPolicy: "require-empty", normalExitGraceMs: 500, signal: context.signal, targetControl: { version: 1 } });
  run.stdout.on("data", data => state.output.feed("stdout", data)); run.stderr.on("data", data => state.output.feed("stderr", data));
  void run.closed.then(() => state.output.end(), () => state.output.end());
  state.streams = Promise.all([finished(run.stdout, { cleanup: true }), finished(run.stderr, { cleanup: true })]); void state.streams.catch(() => {});
  const started = state.started = await run.started; assert.ok(started.creationTime); assert.equal(run.endInput, undefined);
  await state.output.wait(event => event.kind === "ready" && event.pid === started.pid, deadline);
  async function write(sequence, final) {
    const bytes = message(sequence, final), original = Buffer.from(bytes); state.requested.push({ sequence, bytes: bytes.length, final, sha256: digest(bytes) });
    const writing = run.writeControl(bytes, { final }); bytes.fill(0x7f);
    const ack = await writing; assertAck(ack, sequence, original, final); state.acks.push(ack); return original;
  }
  if (["ordered-final", "budget-final", "post-final-cancel"].includes(mode)) {
    const count = mode === "budget-final" ? 512 : 3, sent = [];
    for (let sequence = 0; sequence < count; sequence++) {
      const bytes = await write(sequence, sequence === count - 1); sent.push(bytes);
      // The next write is impossible until the actual native ACK; the target's
      // independently parsed observation also proves no EOF after nonfinal input.
      const observed = await state.output.wait(event => event.kind === "message" && event.pid === started.pid && event.sequence === sequence, deadline);
      assert.equal(observed.sha256, digest(bytes)); assert.equal(observed.eof, false);
    }
    const eof = await state.output.wait(event => event.kind === "input-eof" && event.pid === started.pid, deadline);
    assert.equal(eof.messages, count); assert.equal(eof.bytes, count * 4096); assert.equal(eof.sha256, digest(Buffer.concat(sent))); assert.equal(eof.eof, true);
    await assert.rejects(run.writeControl(Buffer.from("again"), { final: false }));
    if (mode === "post-final-cancel") {
      state.memberObservation = await run.observeMembers([{ pid: started.pid, creationTime: started.creationTime }]);
      assert.deepEqual(state.memberObservation.members, [{ pid: started.pid, creationTime: started.creationTime, status: "observed", jobMember: true }]); run.cancel();
    }
  } else if (mode === "idle-cancel") run.cancel();
  else if (mode === "blocked-cancel") {
    let observedPending = false;
    for (let sequence = 0; sequence < 64; sequence++) {
      const bytes = message(sequence, false); state.requested.push({ sequence, bytes: bytes.length, final: false, sha256: digest(bytes) });
      let completed = false, timer;
      const writing = run.writeControl(bytes, { final: false }); void writing.catch(() => {});
      const waiting = new Promise(resolve => { timer = setTimeout(() => resolve({ pending: true }), 150); });
      const result = await Promise.race([writing.then(ack => { completed = true; return { ack }; }), waiting]); clearTimeout(timer);
      if (result.ack) { assertAck(result.ack, sequence, bytes, false); state.acks.push(result.ack); continue; }
      assert.equal(completed, false); observedPending = true;
      assert.equal(state.cancelledPending, undefined);
      state.cancelledPending = { ...state.requested.at(-1), observedPending: true, promiseRejected: false };
      run.cancel(); await assert.rejects(writing, /Original target control was cancelled before acknowledgement/);
      assert.equal(completed, false); state.cancelledPending.promiseRejected = true; break;
    }
    assert.equal(observedPending, true, "A nonreading original pipe never produced a pending WriteFile");
  }
  state.receipt = await run.closed; await state.streams; state.output.assertParsed(); assertClosure(state.receipt, started);
  const fact = state.receipt.targetControl; assert.equal(fact.version, 1); assert.equal(fact.pipeCreated, true); assert.equal(fact.inputClosed, true);
  assert.equal(fact.messagesRequested, state.requested.length);
  const acknowledgedBytes = state.acks.reduce((sum, ack) => sum + ack.bytesWritten, 0);
  if (mode === "blocked-cancel") {
    const pending = state.cancelledPending;
    assert.ok(pending); assert.equal(pending.observedPending, true); assert.equal(pending.promiseRejected, true);
    assert.equal(state.requested.length, state.acks.length + 1); assert.equal(pending.sequence, state.acks.length);
    assert.deepEqual(state.requested.at(-1), { sequence: pending.sequence, bytes: pending.bytes, final: false, sha256: pending.sha256 });
    // The original owner validates a late native ACK against this one admitted
    // request while keeping its already-cancelled promise rejected. Its terminal
    // ledger therefore need not equal the count of resolved promise receipts.
    assert.ok(fact.messagesAcknowledged === state.acks.length || fact.messagesAcknowledged === state.acks.length + 1);
    pending.lateAcknowledged = fact.messagesAcknowledged === state.acks.length + 1;
    if (pending.lateAcknowledged) assert.equal(fact.bytesWritten, acknowledgedBytes + pending.bytes);
    else assert.ok(fact.bytesWritten >= acknowledgedBytes && fact.bytesWritten <= acknowledgedBytes + pending.bytes);
  } else {
    assert.equal(fact.messagesAcknowledged, state.acks.length);
    assert.ok(fact.bytesWritten >= acknowledgedBytes && fact.bytesWritten <= state.requested.length * 4096);
  }
  const last = state.acks.at(-1);
  assert.deepEqual(fact.finalAcknowledgement, last?.final ? { requestId: last.requestId, sequence: last.sequence, bytesWritten: last.bytesWritten,
    sha256: last.sha256, final: true, inputClosed: true } : null);
  for (const ack of state.acks) assert.equal(ack.token, state.receipt.token);
  if (["ordered-final", "budget-final"].includes(mode)) {
    assert.equal(state.receipt.rootExitCode, 0); assert.equal(state.receipt.terminationReason, null); assert.equal(state.receipt.nativeTerminationReason, null);
    assert.equal(fact.bytesWritten, acknowledgedBytes);
  } else if (mode === "root-exit-reader") {
    const leaving = state.output.events.find(event => event.kind === "root-leaving-reader" && event.pid === started.pid);
    assert.ok(leaving && Number.isSafeInteger(leaving.descendantPid) && leaving.descendantPid !== started.pid);
    assert.equal(leaving.eof, false); assert.equal(leaving.bytes, 0);
    assert.ok(state.output.events.some(event => event.kind === "ready" && event.mode === "held-reader" && event.pid === leaving.descendantPid));
    assert.equal(state.receipt.rootExitCode, 0); assert.equal(state.receipt.terminationReason, "control_target_exited");
    assert.equal(state.receipt.nativeTerminationReason, "control_target_exited");
  } else if (mode === "idle-timeout") {
    assert.equal(state.receipt.terminationReason, "timeout"); assert.ok(["timeout", "cancelled"].includes(state.receipt.nativeTerminationReason));
  } else {
    assert.equal(state.receipt.terminationReason, "cancelled"); assert.equal(state.receipt.nativeTerminationReason, "cancelled");
  }
});

// Deliberate malformed native wire tests cannot use the production API, which
// rejects these inputs before writing them. This original-child observer never
// creates, deserializes or substitutes a branded production closure receipt.
function rawOwner(state, backend, signal) {
  assertWindowsProcessBackend(backend);
  const token = randomUUID(), changed = new EventEmitter(), startedAt = performance.now(), timeoutMs = 30000;
  const child = spawn(helperExecutable, ["--stdio-v1"], { cwd: directory, shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32") } });
  let spawnSeen = false, exitSeen = false, closeSeen = false, exitCode, closeCode, exitSignal, closeSignal;
  let stdoutEnd = false, stderrEnd = false, buffer = "", bytes = 0, sequence = 0, parseFailure, cancelling = false, resolveClose, rejectClose;
  const close = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; }); void close.catch(() => {});
  function send(frame) { assert.equal(closeSeen, false); child.stdin.write((typeof frame === "string" ? frame : JSON.stringify(frame)) + "\n"); }
  function cancel() {
    if (cancelling || closeSeen) return; cancelling = true;
    if (!child.stdin.destroyed && !child.stdin.writableEnded) { send({ version: 1, kind: "cancel", token }); child.stdin.end(); }
  }
  const deadlineTimer = setTimeout(cancel, timeoutMs);
  const forcedTimer = setTimeout(() => {
    state.forcedCleanup = true;
    try { child.kill(); } catch (error) { parseFailure ??= error; }
  }, timeoutMs + 7500);
  const closureTimer = setTimeout(() => {
    state.forcedCleanup = true; parseFailure ??= new Error("Original helper closure remains unconfirmed");
    rejectClose(parseFailure); changed.emit("change");
  }, timeoutMs + 10000);
  const onAbort = () => { state.forcedCleanup = true; cancel(); }; signal.addEventListener("abort", onAbort, { once: true });
  child.once("spawn", () => { spawnSeen = true; });
  child.once("error", error => { parseFailure ??= error; cancel(); changed.emit("change"); });
  child.stdin.on("error", error => { if (!closeSeen && !state.rawFrames.some(frame => frame.kind === "complete")) parseFailure ??= error; });
  child.stdout.on("data", input => {
    try {
      bytes += input.length; assert.ok(bytes <= 2 * 1024 * 1024); buffer += input.toString("utf8"); let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        assert.ok(Buffer.byteLength(buffer.slice(0, end)) <= 65536);
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        assert.equal(frame.version, 1); assert.equal(frame.sequence, sequence++); assert.equal(frame.token, frame.kind === "ready" ? null : token);
        assert.ok(frame.payload && typeof frame.payload === "object" && !Array.isArray(frame.payload));
        assert.ok(state.rawFrames.length < 4096); state.rawFrames.push(frame);
        if (frame.kind === "output") {
          assert.ok(["stdout", "stderr"].includes(frame.payload.stream));
          state.output.feed(frame.payload.stream, Buffer.from(frame.payload.data, "base64"));
        }
      }
      assert.ok(Buffer.byteLength(buffer) <= 65536);
    } catch (error) { parseFailure ??= error; cancel(); }
    changed.emit("change");
  });
  const diagnostics = [];
  child.stderr.on("data", data => { diagnostics.push(Buffer.from(data)); if (diagnostics.reduce((sum, item) => sum + item.length, 0) > 65536) { parseFailure ??= new Error("Helper diagnostic limit"); cancel(); } });
  child.stdout.on("error", error => { parseFailure ??= error; cancel(); }); child.stderr.on("error", error => { parseFailure ??= error; cancel(); });
  child.stdout.once("end", () => { stdoutEnd = true; }); child.stderr.once("end", () => { stderrEnd = true; });
  child.once("exit", (code, osSignal) => { exitSeen = true; exitCode = code; exitSignal = osSignal; changed.emit("change"); });
  child.once("close", (code, osSignal) => {
    closeSeen = true; closeCode = code; closeSignal = osSignal; clearTimeout(deadlineTimer); clearTimeout(forcedTimer); clearTimeout(closureTimer);
    signal.removeEventListener("abort", onAbort); state.output.end(); changed.emit("change"); resolveClose();
  });
  return {
    token, close, cancel, send, deadline: startedAt + timeoutMs, get closed() { return closeSeen; }, closureConfirmed: false,
    async wait(predicate) {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Original native frame deadline elapsed")), Math.max(1, startedAt + timeoutMs - performance.now()));
        function finish(error, value) { clearTimeout(timer); changed.off("change", check); error ? reject(error) : resolve(value); }
        function check() {
          if (parseFailure) return finish(parseFailure);
          const frame = state.rawFrames.find(predicate); if (frame) return finish(undefined, frame);
          if (closeSeen) finish(new Error("Original helper closed before its required native frame"));
        }
        changed.on("change", check); check();
      });
    },
    evidence() { return { token, spawnSeen, exitSeen, closeSeen, exitCode, closeCode, exitSignal, closeSignal, stdoutEnd, stderrEnd,
      partialControlFrame: buffer.length !== 0, parseFailure: parseFailure ? failure(parseFailure) : undefined, helperDiagnosticsBytes: diagnostics.reduce((sum, item) => sum + item.length, 0) }; },
    assertClosed() {
      if (parseFailure) throw parseFailure;
      for (const flag of [spawnSeen, exitSeen, closeSeen, stdoutEnd, stderrEnd]) assert.equal(flag, true);
      assert.equal(exitCode, 0); assert.equal(closeCode, 0); assert.equal(exitSignal, null); assert.equal(closeSignal, null); assert.equal(buffer, "");
      assert.equal(state.forcedCleanup, false); state.output.assertParsed();
      const complete = state.rawFrames.filter(frame => frame.kind === "complete"); assert.equal(complete.length, 1);
      const fact = complete[0].payload, created = state.rawFrames.find(frame => frame.kind === "created").payload;
      const exited = state.rawFrames.filter(frame => frame.kind === "root_exit"); assert.equal(exited.length, 1);
      assert.equal(fact.rootPid, created.pid); assert.equal(fact.rootCreationTime, created.creationTime); assert.equal(fact.rootExitCode, exited[0].payload.code);
      for (const key of ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "stdoutEof", "stderrEof", "stdoutCreated", "stderrCreated", "jobCreated", "jobEmptyObserved", "cleanupConfirmed"]) assert.equal(fact[key], true);
      for (const stream of ["stdout", "stderr"]) assert.equal(state.rawFrames.filter(frame => frame.kind === "pipe_eof" && frame.payload.stream === stream).length, 1);
      assert.equal(fact.noTargetCreated, false); assert.equal(fact.failureCode, null); assert.equal(fact.nativeError, null);
      assert.equal(fact.terminationReason, "control_protocol"); this.closureConfirmed = true; return fact;
    },
  };
}

for (const mode of rawModes) caseEvidence(mode, async (state, context) => {
  const raw = state.raw = rawOwner(state, prepare(), context.signal), ready = await raw.wait(frame => frame.kind === "ready");
  assert.equal(ready.payload.protocol, "artoo.windows-job-process.v1"); assert.equal(ready.payload.atomicJobList, true); assert.ok(ready.payload.capabilities.includes(controlCapability));
  raw.send({ version: 1, kind: "launch", token: raw.token, executable: node, args: [worker, "held-after-final"], cwd: state.root, env: targetEnv(),
    timeoutMs: 30000, cleanupTimeoutMs: 5000, maxOutputBytes: 1024 * 1024, normalExitPolicy: "require-empty", normalExitGraceMs: 500, targetControl: { version: 1 } });
  const started = await raw.wait(frame => frame.kind === "started"); state.started = started.payload;
  await state.output.wait(event => event.kind === "ready" && event.pid === state.started.pid, raw.deadline);
  let original;
  async function valid(sequence, final) {
    const bytes = message(sequence, final), request = { version: 1, kind: "target_control", token: raw.token, requestId: randomUUID(), sequence, final, dataBase64: bytes.toString("base64") };
    raw.send(request); state.requested.push({ sequence, bytes: bytes.length, final, sha256: digest(bytes), requestId: request.requestId });
    const ack = (await raw.wait(frame => frame.kind === "target_control_written" && frame.payload.sequence === sequence)).payload;
    assert.deepEqual(ack, { requestId: request.requestId, sequence, bytesWritten: bytes.length, sha256: digest(bytes), final, inputClosed: final });
    state.acks.push(ack);
    const observed = await state.output.wait(event => event.kind === "message" && event.pid === state.started.pid && event.sequence === sequence, raw.deadline);
    assert.equal(observed.sha256, digest(bytes)); assert.equal(observed.eof, false);
    if (final) await state.output.wait(event => event.kind === "input-eof" && event.pid === state.started.pid, raw.deadline);
    return request;
  }
  if (["raw-replayed-id", "raw-replayed-sequence", "raw-after-final"].includes(mode)) original = await valid(0, mode === "raw-after-final");
  if (mode === "raw-message-513") for (let sequence = 0; sequence < 512; sequence++) await valid(sequence, false);
  const sequence = state.acks.length, frame = { version: 1, kind: "target_control", token: raw.token, requestId: randomUUID(),
    sequence, final: false, dataBase64: message(sequence, false).toString("base64") };
  if (mode === "raw-wrong-sequence") frame.sequence = 1;
  else if (mode === "raw-replayed-id") frame.requestId = original.requestId;
  else if (mode === "raw-replayed-sequence") frame.sequence = 0;
  else if (mode === "raw-missing-final") delete frame.final;
  else if (mode === "raw-nonboolean-final") frame.final = "false";
  else if (mode === "raw-extra-field") frame.extra = true;
  else if (mode === "raw-over-message") frame.dataBase64 = Buffer.alloc(4097).toString("base64");
  else if (mode === "raw-noncanonical-base64") frame.dataBase64 = Buffer.from("x").toString("base64") + "\r";
  if (mode === "raw-duplicate-final") raw.send(JSON.stringify(frame).replace('"final":false', '"final":false,"final":true'));
  else raw.send(frame);
  await raw.close;
  const complete = raw.assertClosed(), fact = complete.targetControl;
  assert.equal(fact.version, 1); assert.equal(fact.pipeCreated, true); assert.equal(fact.inputClosed, true);
  assert.equal(fact.messagesRequested, state.acks.length); assert.equal(fact.messagesAcknowledged, state.acks.length);
  assert.equal(fact.bytesWritten, state.acks.length * 4096);
  assert.deepEqual(fact.finalAcknowledgement, mode === "raw-after-final" ? state.acks[0] : null);
  assert.equal(state.rawFrames.filter(frame => frame.kind === "target_control_written").length, state.acks.length, "Invalid input must never mint an ACK");
});
