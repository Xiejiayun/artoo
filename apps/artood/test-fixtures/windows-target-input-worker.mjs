// Controlled target for the real Windows helper fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.env.ARTOO_WINDOWS_TARGET_INPUT_NATIVE_WINDOW !== "1") {
  throw new Error("An explicitly scheduled native Windows target-input fixture window is required");
}
const [mode] = process.argv.slice(2);
if (!["legacy-null", "idle-initialize", "message-4096", "post-ack-cancel", "idle-cancel", "idle-timeout", "root-exit-reader", "held-reader"].includes(mode)) {
  throw new Error("Unknown fixed target-input fixture mode");
}
const digest = bytes => "sha256:" + createHash("sha256").update(bytes).digest("hex");
async function report(kind, facts = {}) {
  await new Promise((resolve, reject) => process.stdout.write(JSON.stringify({ version: 1, mode, pid: process.pid, kind, ...facts }) + "\n",
    error => error ? reject(error) : resolve()));
}

let eof = false, observedBytes = 0;
const chunks = [];
if (mode !== "held-reader") {
  process.stdin.on("data", chunk => {
    observedBytes += chunk.length;
    assert.ok(observedBytes <= 4096, "Target input exceeded the fixed native bridge bound");
    chunks.push(Buffer.from(chunk));
  });
  process.stdin.on("end", () => { eof = true; });
  process.stdin.on("error", error => { throw error; });
  process.stdin.resume();
}
// held-reader only retains the inherited handle and admits its exact PID over
// IPC. Like the control fixture, it never accesses/resumes process.stdin; active
// consumption is not part of this descendant's lingering-reader obligation.
await report("ready");

if (mode === "legacy-null") {
  if (!eof) await once(process.stdin, "end");
  assert.equal(observedBytes, 0); await report("legacy-eof", { eof: true, bytes: 0 });
} else if (mode === "idle-initialize") {
  // Reading is deliberately active during initialization. An early parent close
  // would deliver EOF before the target voluntarily releases its own read end.
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(eof, false, "Target received EOF before its natural initialization exit");
  assert.equal(observedBytes, 0);
  const eofBeforeOwnReadClose = eof;
  const closed = once(process.stdin, "close"); process.stdin.destroy(); await closed;
  await report("initialized", { eofBeforeOwnReadClose, bytes: observedBytes, ownReadClosed: true });
  // No process.exit(): the target ends through normal Node event-loop completion.
} else if (mode === "message-4096" || mode === "post-ack-cancel") {
  if (!eof) await once(process.stdin, "end");
  const bytes = Buffer.concat(chunks);
  if (mode === "message-4096") {
    assert.equal(bytes.length, 4096); assert.ok(bytes.every(value => value === 0x41));
  } else assert.equal(bytes.toString("utf8"), '{"kind":"shutdown"}\n');
  await report("input-eof", { eof: true, bytes: bytes.length, sha256: digest(bytes) });
  if (mode === "post-ack-cancel") {
    // Keep the real target alive after target EOF. The controller must still be
    // able to observe its original Job and cancel through helper control stdin.
    setInterval(() => {}, 1000);
  }
} else if (mode === "root-exit-reader") {
  // The actual child inherits this target's input reader and its original Job.
  // It also inherits output handles; require-empty must reject the lingering
  // child, not mistake the root's ordinary zero exit for complete shutdown.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "held-reader"], {
    // Detach from Node's own child-lifetime Job, not from the native owner's
    // non-breakaway Job. The descendant must survive this Node root's exit.
    cwd: process.cwd(), shell: false, windowsHide: true, detached: true, env: process.env,
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Original fixture descendant did not become ready")), 5000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once("error", fail);
    child.once("exit", code => fail(new Error("Fixture descendant exited before admission: " + code)));
    child.once("message", value => { clearTimeout(timer); resolve(value); });
  });
  assert.deepEqual(ready, { kind: "reader-ready", pid: child.pid });
  child.disconnect(); child.unref();
  const closed = once(process.stdin, "close"); process.stdin.destroy(); await closed;
  await report("root-leaving-reader", { descendantPid: child.pid, bytes: observedBytes, eofBeforeRootExit: eof });
} else {
  if (mode === "held-reader") {
    assert.equal(typeof process.send, "function");
    await new Promise((resolve, reject) => process.send({ kind: "reader-ready", pid: process.pid }, error => error ? reject(error) : resolve()));
  }
  // These are deliberate negative cases. Only the original helper's timeout,
  // cancellation, or lingering-Job failure is allowed to stop the target.
  setInterval(() => {}, 1000);
}
