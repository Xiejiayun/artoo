// Fixture-only observation of the original native guardian. This never launches,
// signals, substitutes a receipt, or grants execution/recovery authority.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const MODULE_HASH = "f8f9018b8aa2b9814bd9c3a21101cc907c9f4e4e5505c8c30debc7a616685f7f";
const PROGRAM_HASH = "a45015d32b2fb1442c2df0e1f1e04eb421f80823371158b7ecd85f7dcad0ec65";
const PROGRAM_BYTES = 3199;
const ownershipKey = Symbol.for("artoo.fixture.owned-verifier-spawn-observer");
const hash = value => createHash("sha256").update(value).digest("hex");
const identity = stat => [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const sameArgs = (left, right) => Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
const sameDescriptor = (left, right) => left === undefined ? right === undefined : right !== undefined
  && Reflect.ownKeys(left).length === Reflect.ownKeys(right).length && Reflect.ownKeys(left).every(key => Object.hasOwn(right, key) && Object.is(left[key], right[key]));
function binding(object, name) {
  const chain = [];
  for (let current = object; current !== null; current = Object.getPrototypeOf(current)) chain.push([current, Object.getOwnPropertyDescriptor(current, name)]);
  return chain;
}
const sameBinding = (left, right) => !!right && left.length === right.length
  && left.every(([object, descriptor], index) => object === right[index][0] && sameDescriptor(descriptor, right[index][1]));
function plain(stat, mode) {
  assert.ok(stat.isFile() && stat.nlink === 1n && (stat.mode & 0o022n) === 0n,
    "observer input must be a protected single-link plain file");
  if (mode !== undefined) assert.equal(stat.mode & 0o777n, BigInt(mode), "protected context mode changed");
  assert.ok(stat.size > 0n && stat.size <= 65_536n, "observer input exceeds its fixed size bound");
}
function sourcePin(path) {
  assert.equal(realpathSync.native(path), path, "guardian module path must be canonical");
  const before = lstatSync(path, { bigint: true }); plain(before);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd, { bigint: true }); plain(opened);
    assert.equal(identity(opened), identity(before), "guardian source changed before open");
    const bytes = readFileSync(fd);
    assert.equal(identity(fstatSync(fd, { bigint: true })), identity(before));
    assert.equal(identity(lstatSync(path, { bigint: true })), identity(before));
    assert.equal(hash(bytes), MODULE_HASH, "guardian module is not the reviewed version");
    const source = bytes.toString("utf8").replace(/\r\n/g, "\n");
    assert.ok(!source.includes("\r"));
    assert.equal((source.match(/\bString\.raw\b/g) ?? []).length, 1, "unexpected raw literal in guardian module");
    const match = /\bconst PARENT_GUARD = String\.raw\s*`([^`]*)`;/u.exec(source);
    assert.ok(match && !match[1].includes("${"), "guardian program must be one uninterpolated raw literal");
    assert.equal(Buffer.byteLength(match[1]), PROGRAM_BYTES);
    assert.equal(hash(match[1]), PROGRAM_HASH, "inline guardian program is not the reviewed version");
    return { identity: identity(before), program: match[1] };
  } finally { closeSync(fd); }
}
async function protectedJson(path, mode, missingAllowed = false) {
  assert.ok(isAbsolute(path) && resolve(path) === path, "observation file path must be absolute");
  let before;
  try { before = await lstat(path, { bigint: true }); }
  catch (error) { if (missingAllowed && error.code === "ENOENT" && error.path === path) return; throw error; }
  plain(before, mode);
  assert.equal(before.uid, BigInt(process.getuid()), "fixture context/marker must be owned by this process user");
  assert.equal(await realpath(path), path, "observation file path changed");
  const parent = await lstat(dirname(path), { bigint: true });
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === BigInt(process.getuid()) && (parent.mode & 0o077n) === 0n,
    "observation directory must remain private");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat({ bigint: true }); plain(opened, mode);
    assert.equal(identity(opened), identity(before), "observation file changed before open");
    const bytes = await file.readFile();
    assert.ok(bytes.length <= 65_536);
    assert.equal(identity(await file.stat({ bigint: true })), identity(before), "observation file changed while reading");
    assert.equal(identity(await lstat(path, { bigint: true })), identity(before), "observation file was replaced");
    assert.equal(await realpath(path), path);
    assert.equal(identity(await lstat(dirname(path), { bigint: true })), identity(parent), "observation directory changed while reading");
    return { value: JSON.parse(bytes.toString("utf8")), identity: identity(before), sha256: hash(bytes) };
  } finally { await file.close(); }
}

export function observeOwnedVerifierSpawn({ executable, args, cwd, requestId, validateContext }) {
  assert.ok(process.platform === "linux" || process.platform === "darwin");
  assert.ok(isAbsolute(executable) && realpathSync.native(executable) === executable);
  assert.ok(isAbsolute(cwd) && resolve(cwd) === cwd && Array.isArray(args) && args.every(value => typeof value === "string"));
  assert.match(requestId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
  assert.equal(typeof validateContext, "function");
  assert.equal(globalThis[ownershipKey], undefined, "native observer requires exclusive serial fixture ownership");
  const sourcePath = fileURLToPath(new URL("../dist/owned/parent-guard.js", import.meta.url));
  const pinned = sourcePin(sourcePath), expectedArgs = [...args], owner = {};
  const spawnDescriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn"), nativeSpawn = childProcess.spawn;
  let installedSpawnBinding;
  assert.ok(spawnDescriptor && typeof nativeSpawn === "function" && spawnDescriptor.configurable);
  const installedAt = performance.now(), records = [];
  let selected, matchingLaunches = 0, cancellation = false, disposed = false, failure, originalPending, pendingStatus;
  let context, contextIdentity, contextHash, contextValidated = false, markerObservedAt, preparationWaited = false;
  let rejectFailure, resolveSpawn, resolveContext;
  const failed = new Promise((_, reject) => { rejectFailure = reject; });
  const spawned = new Promise(resolve => { resolveSpawn = resolve; });
  const contextReady = new Promise(resolve => { resolveContext = resolve; });
  // Failures may arrive before the fixture reaches its first await.
  failed.catch(() => {});
  function fail(error) {
    if (!failure) { failure = error instanceof Error ? error : new Error("Native verifier observation failed"); rejectFailure(failure); }
  }
  function safely(body) { try { body(); } catch (error) { fail(error); } }
  function check() { if (failure) throw failure; assert.ok(!disposed, "native observer was disposed"); }
  function bindPending(pending) {
    assert.ok(pending && typeof pending.then === "function");
    if (originalPending) assert.equal(pending, originalPending, "observation must use the original finalizer promise");
    else {
      originalPending = pending;
      pending.then(() => {
        pendingStatus = "fulfilled";
        if (!cancellation) fail(new Error("Finalizer ended before cancellation of the observed live verifier"));
      }, error => {
        pendingStatus = "rejected";
        if (!cancellation) fail(error);
      });
    }
  }
  function listen(record, event, body) {
    const listener = (...values) => safely(() => body(...values));
    record.child.on(event, listener); record.listeners.push([event, listener]);
  }
  function observeMessage(record, value) {
    if (value?.kind === "ready") { record.ready++; if (record === selected) assert.equal(record.ready, 1, "duplicate guardian ready"); return; }
    if (record !== selected) return;
    assert.ok(value && typeof value === "object", "invalid guardian IPC message");
    if (value.kind === "spawn") {
      assert.equal(record.targetSpawnCount++, 0, "duplicate target spawn");
      assert.ok(Number.isSafeInteger(value.pid) && value.pid > 1 && value.pid !== record.child.pid);
      record.targetPid = value.pid; record.spawnAt = performance.now(); resolveSpawn();
    } else if (value.kind === "exit" || value.kind === "close") {
      assert.ok(record.targetPid, "target ended without an observed spawn");
      assert.ok(value.code === null || Number.isInteger(value.code));
      assert.ok(value.signal === null || typeof value.signal === "string");
      const field = value.kind === "exit" ? "targetExit" : "targetClose";
      assert.equal(record[field], undefined, "duplicate target terminal event");
      record[field] = { code: value.code, signal: value.signal, at: performance.now() };
      assert.ok(cancellation, "target ended before the requested live cancellation");
    } else { throw new Error("Unexpected target guardian IPC message"); }
  }
  function observeLaunch(record, value) {
    if (value?.kind !== "launch" || value.executable !== executable || !sameArgs(value.args, expectedArgs)) return;
    matchingLaunches++;
    assert.equal(matchingLaunches, 1, "duplicate matching verifier launch");
    assert.equal(value.cwd, cwd, "matching verifier launch has another workspace");
    assert.ok(record.child instanceof childProcess.ChildProcess);
    assert.equal(record.executable, process.execPath, "unexpected guardian executable");
    assert.ok(sameArgs(record.args, ["-e", pinned.program]), "unexpected inline guardian program");
    assert.equal(record.options?.cwd, cwd);
    assert.equal(record.options?.detached, true); assert.equal(record.options?.shell, false);
    assert.ok(sameArgs(record.options?.stdio, ["ignore", "pipe", "pipe", "ipc"]));
    assert.equal(record.ready, 1); assert.equal(record.guardianSpawnCount, 1);
    assert.ok(!record.guardianExit && !record.guardianClose && !record.guardianError);
    assert.equal(realpathSync.native(cwd), cwd);
    selected = record;
    const contextPath = value.env?.ARTOO_VERIFICATION_CONTEXT_FILE;
    assert.equal(typeof contextPath, "string");
    const suffix = relative(cwd, contextPath);
    assert.ok(suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix), "context must be outside the verifier workspace");
    void protectedJson(contextPath, 0o400).then(async observed => {
      assert.equal(observed.value?.request_id, requestId);
      context = structuredClone(observed.value); contextIdentity = observed.identity; contextHash = observed.sha256;
      await validateContext(structuredClone(context));
      contextValidated = true; resolveContext();
    }).catch(fail);
  }
  function instrument(child, call) {
    // Every actual native IPC child is passed through unchanged. Only a launch
    // matching this one verifier command is selected and retained in evidence.
    if (typeof child.send !== "function") return;
    const options = call[2];
    const record = { child, executable: call[0], args: Array.isArray(call[1]) ? [...call[1]] : call[1],
      options: { cwd: options?.cwd, detached: options?.detached, shell: options?.shell,
        stdio: Array.isArray(options?.stdio) ? [...options.stdio] : options?.stdio },
      ready: 0, guardianSpawnCount: 0, targetSpawnCount: 0, listeners: [] };
    records.push(record);
    record.sendDescriptor = Object.getOwnPropertyDescriptor(child, "send"); record.nativeSend = child.send;
    record.removeListener = child.removeListener;
    record.sendWrapper = function (...sendArgs) {
      // Validation cannot block or alter the real send, its callback or its return value.
      let result;
      try { result = Reflect.apply(record.nativeSend, this, sendArgs); }
      catch (error) { if (record === selected) fail(error); throw error; }
      safely(() => observeLaunch(record, sendArgs[0]));
      return result;
    };
    Object.defineProperty(child, "send", { ...(record.sendDescriptor ?? { configurable: true, enumerable: true, writable: true }), value: record.sendWrapper });
    record.installedSendBinding = binding(child, "send");
    listen(record, "spawn", () => { record.guardianSpawnCount++; });
    listen(record, "message", value => observeMessage(record, value));
    listen(record, "error", error => { record.guardianError = error; if (record === selected) fail(error); });
    for (const event of ["exit", "close"]) listen(record, event, (code, signal) => {
      const field = event === "exit" ? "guardianExit" : "guardianClose";
      assert.equal(record[field], undefined, "duplicate native guardian terminal event");
      record[field] = { code, signal, at: performance.now() };
      if (record === selected) assert.ok(cancellation, "guardian ended before live cancellation");
    });
  }
  function spawnWrapper(...call) {
    let child;
    try { child = Reflect.apply(nativeSpawn, this, call); }
    catch (error) { fail(error); throw error; }
    safely(() => {
      if (call[0] === executable && sameArgs(call[1], expectedArgs)) throw new Error("Verifier was directly spawned without the pinned guardian");
      instrument(child, call);
    });
    return child;
  }
  globalThis[ownershipKey] = owner;
  try {
    Object.defineProperty(childProcess, "spawn", { ...spawnDescriptor, value: spawnWrapper });
    installedSpawnBinding = binding(childProcess, "spawn"); syncBuiltinESMExports();
  } catch (error) {
    const errors = [error];
    try {
      assert.ok(sameBinding(binding(childProcess, "spawn"), installedSpawnBinding), "spawn binding changed during observer installation");
      Object.defineProperty(childProcess, "spawn", spawnDescriptor); syncBuiltinESMExports();
    } catch (cleanup) { errors.push(cleanup); }
    if (globalThis[ownershipKey] === owner) delete globalThis[ownershipKey];
    throw errors.length === 1 ? error : new AggregateError(errors, "Native observer installation failed");
  }
  async function raceUntil(operation, deadline, label) {
    let timer;
    // An already expired deadline must not leave the concurrently started poll
    // rejection unobserved, even when it finishes before Promise.race is installed.
    operation.catch(() => {});
    try {
      check(); const remaining = deadline - performance.now(); assert.ok(remaining > 0, `${label} deadline elapsed`);
      await Promise.race([failed, operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), remaining); })]);
      check(); assert.ok(performance.now() < deadline, `${label} exceeded its deadline`);
    } finally { clearTimeout(timer); }
  }
  return {
    async waitForSpawn(pending, milliseconds = 120_000) {
      assert.equal(preparationWaited, false, "preparation clock cannot restart"); preparationWaited = true;
      assert.equal(milliseconds, 120_000, "fixture preparation has one fixed bound"); bindPending(pending);
      await raceUntil(spawned, installedAt + milliseconds, "Actual verifier preparation/spawn");
      assert.ok(!pendingStatus && !cancellation && selected?.targetPid);
      await raceUntil(contextReady, Math.min(installedAt + milliseconds, selected.spawnAt + 15_000), "Actual verifier context validation");
      assert.ok(!pendingStatus && !cancellation && contextValidated && selected?.targetPid);
    },
    async waitForReadyMarker(marker, pending) {
      bindPending(pending); check(); assert.ok(selected?.targetPid && contextValidated && !markerObservedAt && !cancellation);
      const deadline = selected.spawnAt + 15_000;
      let stopped = false, pollTimer, wake;
      const poll = async () => {
        while (!stopped) {
          check(); assert.ok(performance.now() < deadline, "Verifier did not publish its ready marker within 15 seconds of actual spawn");
          const observed = await protectedJson(marker, undefined, true);
          if (stopped) return;
          if (observed) {
            assert.deepEqual(Object.keys(observed.value).sort(), ["cwd", "envelope", "pid"]);
            assert.equal(observed.value.pid, selected.targetPid); assert.equal(observed.value.cwd, cwd);
            assert.deepEqual(observed.value.envelope, context);
            await assert.rejects(lstat(`${marker}.pending`), error => error.code === "ENOENT");
            process.kill(selected.targetPid, 0); // Read-only actual liveness, never a termination target.
            assert.ok(!selected.targetExit && !selected.targetClose && !pendingStatus && !cancellation);
            assert.ok(performance.now() < deadline, "Ready observation exceeded its original 15-second deadline");
            markerObservedAt = performance.now(); return;
          }
          await new Promise(resolvePoll => { wake = resolvePoll; pollTimer = setTimeout(resolvePoll, Math.min(10, Math.max(0, deadline - performance.now()))); });
        }
      };
      try { await raceUntil(poll(), deadline, "Actual verifier ready marker"); }
      finally { stopped = true; clearTimeout(pollTimer); wake?.(); }
    },
    beginCancellation() { cancellation = true; },
    assertClosed() {
      check(); assert.ok(cancellation && markerObservedAt && contextValidated && selected && pendingStatus === "fulfilled");
      assert.equal(matchingLaunches, 1); assert.equal(selected.targetSpawnCount, 1); assert.equal(selected.guardianSpawnCount, 1);
      assert.ok(selected.targetExit && selected.targetClose && selected.guardianExit && selected.guardianClose);
      assert.equal(selected.guardianExit.code, 0); assert.equal(selected.guardianClose.code, 0);
      assert.equal(selected.guardianExit.signal, null); assert.equal(selected.guardianClose.signal, null);
      for (const pid of [selected.targetPid, selected.child.pid]) {
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        for (const value of [pid, -pid]) assert.throws(() => process.kill(value, 0), error => error.code === "ESRCH", "observed process and group must actually be absent");
      }
      assert.deepEqual(sourcePin(sourcePath), pinned, "reviewed guardian source changed during the fixture");
    },
    dispose() {
      assert.equal(disposed, false, "observer must be disposed once"); disposed = true;
      const errors = [];
      for (const record of records) {
        try {
          assert.ok(sameBinding(binding(record.child, "send"), record.installedSendBinding), "guardian send descriptor/prototype changed; replacement preserved");
          if (record.sendDescriptor) Object.defineProperty(record.child, "send", record.sendDescriptor);
          else delete record.child.send;
        } catch (error) { errors.push(error); }
        for (const [event, listener] of record.listeners) {
          try { Reflect.apply(record.removeListener, record.child, [event, listener]); } catch (error) { errors.push(error); }
        }
      }
      try {
        assert.ok(sameBinding(binding(childProcess, "spawn"), installedSpawnBinding), "global spawn descriptor/prototype changed; replacement preserved");
        Object.defineProperty(childProcess, "spawn", spawnDescriptor); syncBuiltinESMExports();
      }
      catch (error) { errors.push(error); }
      if (globalThis[ownershipKey] === owner) delete globalThis[ownershipKey];
      else errors.push(new Error("Exclusive observer ownership changed"));
      if (errors.length) throw new AggregateError(errors, "Native observer restoration failed");
    },
    snapshot() {
      return { request_id: requestId, guardian_module_sha256: MODULE_HASH, guardian_program_sha256: PROGRAM_HASH,
        matching_launches: matchingLaunches, target_pid: selected?.targetPid ?? null, guardian_pid: selected?.child.pid ?? null,
        preparation_elapsed_ms: selected?.spawnAt === undefined ? null : selected.spawnAt - installedAt,
        spawn_monotonic_ms: selected?.spawnAt ?? null, ready_monotonic_ms: markerObservedAt ?? null,
        ready_elapsed_ms: markerObservedAt === undefined ? null : markerObservedAt - selected.spawnAt,
        context_sha256: contextHash ?? null, context_identity: contextIdentity ?? null,
        context_validated: contextValidated, pending_status: pendingStatus ?? "pending", cancellation_started: cancellation,
        ...(failure ? { observation_failure: failure.message } : {}) };
    },
  };
}
