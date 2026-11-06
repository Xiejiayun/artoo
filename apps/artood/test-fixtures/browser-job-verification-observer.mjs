// Read-only observation of the actual native helper transport. Frames are evidence,
// never replacement responses or serialized process authority. No browser APIs are patched.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, relative, sep } from "node:path";

const sha = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const outside = (path, root) => { const tail = relative(root, path); return isAbsolute(tail) || tail === ".." || tail.startsWith(".." + sep); };
export function observeActualVerificationCli(expected) {
  const descriptor = Object.getOwnPropertyDescriptor(childProcess, "spawn"), originalSpawn = childProcess.spawn;
  assert.ok(descriptor);
  const children = [], events = []; let failure, envelope, contextPath, ordinal = 0, disposed = false;
  const safe = body => { try { body(); } catch (error) { failure ??= error; } };
  const event = (kind, facts = {}) => {
    assert.ok(events.length < 4096, "Fixed native observer event budget exceeded"); events.push({ ordinal: ++ordinal, kind, ...facts });
  };
  function observeLaunch(child, value) {
    assert.equal(value.kind, "launch"); assert.equal(value.executable, process.execPath);
    assert.deepEqual(value.args, [expected.cli, expected.config]); assert.equal(value.cwd, expected.workspace);
    assert.equal(envelope, undefined, "Exactly one real verification CLI invocation is expected");
    const file = value.env?.ARTOO_VERIFICATION_CONTEXT_FILE, digest = value.env?.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
    assert.ok(typeof file === "string" && isAbsolute(file) && outside(file, expected.workspace));
    assert.equal(realpathSync.native(file), file); const stat = lstatSync(file);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
    assert.ok(stat.size > 0 && stat.size <= 1024 * 1024);
    const bytes = readFileSync(file); assert.equal(sha(bytes), digest, "The exact private envelope digest must enter only the local command environment");
    const valueEnvelope = JSON.parse(bytes.toString("utf8"));
    assert.equal(valueEnvelope.version, 1); assert.equal(valueEnvelope.request_id, expected.requestId);
    assert.equal(valueEnvelope.profile_digest, expected.profileDigest); assert.equal(valueEnvelope.subject_digest, expected.subjectDigest);
    assert.deepEqual(valueEnvelope.windows_browser_process, { version: 1, request_id: expected.requestId, command_id: "browser",
      profile_digest: expected.profileDigest, subject_digest: expected.subjectDigest, workspace_root: expected.workspace, installation: expected.installation });
    assert.deepEqual(valueEnvelope.static_web_capabilities.options.windows_browser_process, { version: 1 });
    assert.equal(valueEnvelope.static_web_capabilities.binding.command_id, "browser");
    const publicPack = JSON.stringify(valueEnvelope.context);
    assert.equal(publicPack.includes("windows_browser_process"), false); assert.equal(publicPack.includes(expected.installation.directory), false);
    envelope = valueEnvelope; contextPath = file; child.token = value.token;
    event("private-command-bound", { context_file: file, envelope_sha256: digest, request_id: expected.requestId,
      profile_digest: expected.profileDigest, subject_digest: expected.subjectDigest, command_id: "browser" });
  }
  function instrument(child, executable, args, options) {
    const record = { executable, args, windows_hide: options?.windowsHide, pid: null, spawned: false,
      exit: null, close: null, stdout_eof: false, stderr_eof: false, root_created: null, root_started: null, root_exit: null, complete: null };
    /** @type {Array<[import("node:events").EventEmitter, string, (...args: any[]) => void]>} */
    const listeners = [];
    const internal = { child, record, buffer: "", nextSequence: 0, token: undefined, listeners,
      writeDescriptor: Object.getOwnPropertyDescriptor(child.stdin, "write"), nativeWrite: child.stdin.write };
    children.push(internal);
    assert.equal(executable, expected.helperExecutable); assert.deepEqual(args, ["--stdio-v1"]); assert.equal(options?.windowsHide, true);
    const listen = (target, name, listener) => { target.on(name, listener); internal.listeners.push([target, name, listener]); };
    listen(child, "spawn", () => safe(() => { record.pid = child.pid; record.spawned = true; event("helper-spawn", { pid: child.pid }); }));
    listen(child, "error", error => safe(() => { record.error = error.message; event("helper-error", { error: error.message }); }));
    for (const name of ["exit", "close"]) listen(child, name, (code, signal) => safe(() => {
      record[name] = { code, signal }; event("helper-" + name, { pid: child.pid, code, signal });
    }));
    for (const name of ["stdout", "stderr"]) listen(child[name], "end", () => safe(() => { record[name + "_eof"] = true; event("helper-pipe-eof", { stream: name }); }));
    listen(child.stdout, "data", data => safe(() => {
      internal.buffer += data.toString("utf8"); let end;
      while ((end = internal.buffer.indexOf("\n")) >= 0) {
        const line = internal.buffer.slice(0, end); internal.buffer = internal.buffer.slice(end + 1);
        assert.ok(Buffer.byteLength(line) <= 65536); const frame = JSON.parse(line);
        assert.equal(frame.version, 1); assert.equal(frame.sequence, internal.nextSequence++);
        if (frame.kind === "ready") { assert.equal(frame.token, null); continue; }
        assert.equal(frame.token, internal.token, "Observe only control frames bound to the actual launch");
        if (frame.kind === "created") record.root_created = frame.payload;
        if (frame.kind === "started") record.root_started = frame.payload;
        if (frame.kind === "root_exit") record.root_exit = frame.payload;
        if (frame.kind === "complete") record.complete = frame.payload;
        if (["created", "started", "root_exit", "pipe_eof", "complete"].includes(frame.kind)) event("native-" + frame.kind, { payload: frame.payload });
      }
      assert.ok(Buffer.byteLength(internal.buffer) <= 65536);
    }));
    internal.writeWrapper = function (...writeArgs) {
      const returned = Reflect.apply(internal.nativeWrite, this, writeArgs);
      safe(() => {
        const data = writeArgs[0]; if (typeof data !== "string" && !Buffer.isBuffer(data)) return;
        assert.ok(Buffer.byteLength(data) <= 1024 * 1024); const command = JSON.parse(data.toString());
        if (command.kind === "launch") observeLaunch(internal, command);
      });
      return returned;
    };
    Object.defineProperty(child.stdin, "write", { configurable: true, enumerable: false, writable: true, value: internal.writeWrapper });
  }
  /** @this {unknown} */
  function observedSpawn(...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    safe(() => instrument(child, args[0], args[1], args[2])); return child;
  }
  Object.defineProperty(childProcess, "spawn", { ...descriptor, value: observedSpawn }); syncBuiltinESMExports();
  return {
    assertNoDispatch() { if (failure) throw failure; assert.equal(children.length, 0); assert.equal(envelope, undefined); },
    assertClosed() {
      if (failure) throw failure; assert.equal(children.length, 1); assert.ok(envelope);
      const { record, buffer } = children[0]; assert.equal(buffer, ""); assert.equal(record.spawned, true);
      assert.deepEqual(record.exit, { code: 0, signal: null }); assert.deepEqual(record.close, record.exit);
      assert.equal(record.stdout_eof, true); assert.equal(record.stderr_eof, true); assert.equal(record.error, undefined);
      assert.equal(record.root_created.pid, record.root_started.pid); assert.equal(record.root_created.jobMember, true);
      assert.deepEqual(record.root_exit, { code: 0 }); const result = record.complete;
      assert.equal(result.rootPid, record.root_started.pid); assert.equal(result.rootCreationTime, record.root_created.creationTime);
      for (const field of ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "stdoutEof", "stderrEof", "jobEmptyObserved", "cleanupConfirmed"]) assert.equal(result[field], true, field);
      assert.equal(result.rootExitCode, 0); assert.equal(result.failureCode, null); assert.equal(result.terminationReason, null);
    },
    snapshot() { return { claim: "read-only actual helper frames and OS stream events, not process authority", events,
      children: children.map(item => item.record), context_path: contextPath, context_directory: contextPath ? dirname(contextPath) : undefined,
      ...(failure ? { observation_error: failure.message } : {}) }; },
    envelope() { assert.ok(envelope); return structuredClone(envelope); },
    dispose() {
      assert.equal(disposed, false); disposed = true; const failures = [];
      for (const item of children) {
        try {
          assert.equal(item.child.stdin.write, item.writeWrapper);
          if (item.writeDescriptor) Object.defineProperty(item.child.stdin, "write", item.writeDescriptor); else delete item.child.stdin.write;
        } catch (error) { failures.push(error); }
        for (const [target, name, listener] of item.listeners) target.off(name, listener);
      }
      try { assert.equal(childProcess.spawn, observedSpawn); Object.defineProperty(childProcess, "spawn", descriptor); syncBuiltinESMExports(); }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Native observer restoration failed");
    },
  };
}
