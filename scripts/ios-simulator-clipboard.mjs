import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_BODY = 1024, MAX_BYTES = 16_384, COMMAND_TIMEOUT = 10_000;
class ClipboardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function executeClipboard(command, args, { input, timeout, maxBuffer }) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "buffer", shell: false, timeout, maxBuffer, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) {
        const failure = new ClipboardError(error.killed ? 504 : 500, "Simulator clipboard command failed");
        failure.exitCode = Number.isInteger(error.code) ? error.code : null; failure.signal = error.signal;
        reject(failure); return;
      }
      resolve({ status: 0, stdout });
    });
    // A failed/terminated simctl can close stdin early; the callback remains
    // the authoritative command failure and must not expose command output.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener("data", data); request.removeListener("end", end);
      request.removeListener("error", fail); request.removeListener("aborted", aborted);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const fail = () => done(new ClipboardError(400, "Clipboard request body failed"));
    const aborted = () => fail();
    const data = (chunk) => {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > MAX_BODY) { done(new ClipboardError(400, "Clipboard request body is too large")); return; }
      chunks.push(bytes);
    };
    const end = () => {
      const bytes = Buffer.concat(chunks);
      try {
        if (!isUtf8(bytes)) throw new Error();
        const value = JSON.parse(bytes.toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        done(null, value);
      } catch { done(new ClipboardError(400, "Clipboard request requires a JSON object")); }
    };
    const timer = setTimeout(() => done(new ClipboardError(408, "Clipboard request body timed out")), 1000);
    request.on("data", data); request.once("end", end); request.once("error", fail); request.once("aborted", aborted);
  });
}

/** Test-only observer for one parent-selected simulator. The caller MUST check
 * its existing loopback address, bearer token and closing state before handle.
 * No route accepts expected clipboard contents, a command, or another device.
 * execute is a command-mock seam and must settle only after command termination,
 * honoring the supplied timeout. Production uses execFile's post-close callback,
 * fixed simctl argv and SIGKILL timeout, never a shell or an early Promise.race.
 */
export function createSimulatorClipboard({ simulatorUDID, execute = executeClipboard }) {
  assert.ok(typeof simulatorUDID === "string" && UUID.test(simulatorUDID), "Clipboard observer requires one exact simulator UDID");
  let active, operation = Promise.resolve(), closing = false, closePromise;
  const records = [];
  const record = (action, probeId, bytes, origin = "request") => records.push({ action, origin, simulator_udid: simulatorUDID, probe_id: probeId,
    observed_at: new Date().toISOString(), byte_length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const recordError = (error, action, origin = "request") => records.push({ action: "error", operation: action, origin,
    simulator_udid: simulatorUDID, probe_id: active?.id ?? null, observed_at: new Date().toISOString(), status: error.status ?? 500,
    ...(error.command ? { command: error.command } : {}) });
  async function command(action, input = Buffer.alloc(0)) {
    const started = performance.now(); let result;
    try {
      result = await execute("/usr/bin/xcrun", ["simctl", action, simulatorUDID], {
        input, timeout: COMMAND_TIMEOUT, maxBuffer: MAX_BYTES,
      });
      if (result?.status !== 0 || result.signal || !Buffer.isBuffer(result.stdout)) throw new ClipboardError(500, "Simulator clipboard command failed");
      if (result.stdout.length > MAX_BYTES || !isUtf8(result.stdout)) throw new ClipboardError(500, "Simulator clipboard output is not bounded UTF-8");
      return result.stdout;
    } catch (error) {
      const failure = error instanceof ClipboardError ? error : new ClipboardError(error?.code === "ETIMEDOUT" || error?.killed ? 504 : 500, "Simulator clipboard command failed");
      const exitCode = result?.status ?? error?.exitCode ?? error?.code, signal = result?.signal ?? error?.signal;
      failure.command = { action, timeout_ms: COMMAND_TIMEOUT, elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === "string" && Object.hasOwn(osConstants.signals, signal) ? signal : null };
      throw failure;
    }
  }
  async function clearActive(origin = "request") {
    if (!active) return;
    const probe = active;
    await command("pbcopy");
    const actual = await command("pbpaste");
    if (actual.length !== 0) throw new ClipboardError(500, "Simulator clipboard clear verification failed");
    record("clear", probe.id, actual, origin); active = undefined;
  }
  function handle(request, reply) {
    const match = /^\/clipboard\/(seed|read|clear)$/.exec(request.url ?? "");
    if (!match) return false;
    if (request.method !== "POST") { request.resume(); reply(405, { error: "Clipboard operations require POST" }); return true; }
    if (closing) { request.resume(); reply(503, { error: "Clipboard observer closing" }); return true; }
    const action = match[1];
    // Start consuming immediately; queue only bounded parsed data, never leave
    // a body rejection unhandled while an earlier command is still running.
    const body = readBody(request).then((value) => ({ value }), (error) => ({ error }));
    operation = operation.catch(() => {}).then(async () => {
      const parsed = await body;
      if (parsed.error) throw parsed.error;
      if (closing) throw new ClipboardError(503, "Clipboard observer closing");
      const expectedKeys = action === "seed" ? ["simulator_udid"] : ["probe_id", "simulator_udid"];
      const value = parsed.value;
      if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
        || value.simulator_udid !== simulatorUDID) throw new ClipboardError(400, "Clipboard request must match the bound simulator and exact schema");
      if (action === "seed") {
        if (active) throw new ClipboardError(409, "An active clipboard probe must be cleared first");
        const probe = { id: randomUUID(), sentinel: Buffer.from(`Artoo native Copy probe ${randomUUID()}`, "utf8") };
        active = probe; // Keep cleanup ownership even if seeding/verification fails.
        await command("pbcopy", probe.sentinel);
        if (closing) throw new ClipboardError(503, "Clipboard observer closing");
        const actual = await command("pbpaste");
        if (!actual.equals(probe.sentinel)) throw new ClipboardError(500, "Simulator clipboard sentinel verification failed");
        record("seed", probe.id, actual);
        return { simulator_udid: simulatorUDID, probe_id: probe.id, sentinel_utf8_base64: actual.toString("base64") };
      }
      if (typeof value.probe_id !== "string" || !UUID.test(value.probe_id) || !active || value.probe_id !== active.id)
        throw new ClipboardError(409, "Clipboard probe is not active");
      const probeId = active.id;
      if (action === "clear") {
        await clearActive(); return { simulator_udid: simulatorUDID, probe_id: probeId, cleared: true };
      }
      const actual = await command("pbpaste");
      record("read", probeId, actual);
      return { simulator_udid: simulatorUDID, probe_id: probeId, utf8_base64: actual.toString("base64") };
    }).catch((error) => { recordError(error, action); throw error; });
    void operation.then((value) => reply(200, value), (error) => reply(error.status ?? 500, {
      error: error instanceof ClipboardError ? error.message : "Clipboard operation failed",
    }));
    return true;
  }
  const close = () => closePromise ??= (async () => {
    closing = true;
    await operation.catch(() => {});
    try { await clearActive("cleanup"); }
    catch (error) { recordError(error, "close", "cleanup"); throw error; }
  })();
  return { handle, close, evidence: () => structuredClone(records) };
}
