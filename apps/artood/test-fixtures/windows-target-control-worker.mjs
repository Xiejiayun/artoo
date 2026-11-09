// Source preparation only. A controlled target for real Win32 transport tests;
// its messages are fixture observations, never publication or quiescence proof.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.env.ARTOO_WINDOWS_TARGET_CONTROL_NATIVE_WINDOW !== "1") {
  throw new Error("An explicitly scheduled native target-control window is required");
}
const [mode] = process.argv.slice(2);
assert.ok(["stream", "held-after-final", "idle", "blocked", "root-exit-reader", "held-reader"].includes(mode));
const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
let reporting = Promise.resolve();
function report(kind, facts = {}) {
  reporting = reporting.then(() => new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify({ version: 1, mode, pid: process.pid, kind, ...facts }) + "\n",
      error => error ? reject(error) : resolve());
  }));
  return reporting;
}

if (mode === "blocked" || mode === "held-reader") {
  // Deliberately never access/resume process.stdin: the original reader stays
  // open, but no user-space read can release a blocked native WriteFile.
  await report("ready");
  if (mode === "held-reader") {
    assert.equal(typeof process.send, "function");
    await new Promise((resolve, reject) => process.send({ kind: "reader-ready", pid: process.pid }, error => error ? reject(error) : resolve()));
  }
  setInterval(() => {}, 1000);
} else {
  let bytes = 0, count = 0, eof = false, final = false, buffer = Buffer.alloc(0);
  const chunks = [];
  let resolveInput, rejectInput;
  const inputClosed = new Promise((resolve, reject) => { resolveInput = resolve; rejectInput = reject; });
  void inputClosed.catch(() => {});
  process.stdin.on("data", chunk => {
    try {
      assert.ok(mode === "stream" || mode === "held-after-final", "Idle target received unexpected bytes");
      bytes += chunk.length; assert.ok(bytes <= 2 * 1024 * 1024);
      chunks.push(Buffer.from(chunk)); buffer = Buffer.concat([buffer, chunk]);
      let end;
      while ((end = buffer.indexOf(10)) !== -1) {
        assert.ok(!final && end < 4096 && count < 512);
        const line = buffer.subarray(0, end + 1), value = JSON.parse(line.toString("utf8"));
        buffer = buffer.subarray(end + 1);
        assert.deepEqual(Object.keys(value).sort(), ["final", "padding", "sequence"]);
        assert.equal(value.sequence, count++); assert.equal(typeof value.final, "boolean");
        assert.equal(typeof value.padding, "string"); final = value.final;
        void report("message", { sequence: value.sequence, final, eof: false, bytes: line.length, sha256: digest(line) });
      }
      assert.ok(buffer.length < 4096);
    } catch (error) { rejectInput(error); process.stdin.destroy(error); }
  });
  process.stdin.on("error", rejectInput);
  process.stdin.on("end", () => {
    eof = true;
    try {
      assert.ok(mode === "stream" || mode === "held-after-final", "Idle target received unexpected EOF");
      assert.equal(buffer.length, 0); assert.equal(final, true);
      resolveInput();
    } catch (error) { rejectInput(error); }
  });
  process.stdin.resume(); await report("ready");
  if (mode === "root-exit-reader") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "held-reader"], {
      cwd: process.cwd(), shell: false, windowsHide: true, detached: true, env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Original fixture descendant did not become ready")), 5000);
      function fail(error) { clearTimeout(timer); reject(error); }
      child.once("error", fail); child.once("exit", () => fail(new Error("Fixture descendant exited before admission")));
      child.once("message", value => { clearTimeout(timer); resolve(value); });
    });
    assert.deepEqual(ready, { kind: "reader-ready", pid: child.pid });
    child.disconnect(); child.unref();
    const closed = once(process.stdin, "close"); process.stdin.destroy(); await closed;
    assert.equal(eof, false); assert.equal(bytes, 0);
    await report("root-leaving-reader", { descendantPid: child.pid, bytes, eof });
    // Natural root exit leaves the descendant in the original non-breakaway Job.
  } else if (mode === "idle") setInterval(() => {}, 1000);
  else {
    await inputClosed;
    await report("input-eof", { eof, messages: count, bytes, sha256: digest(Buffer.concat(chunks)) });
    if (mode === "held-after-final") setInterval(() => {}, 1000);
  }
}
