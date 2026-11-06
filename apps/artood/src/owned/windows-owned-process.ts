// Node-owned Windows Job Object process control. Production callers qualify the
// local installation before creating this opaque backend.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, type Readable } from "node:stream";
import { windowsProcessDiagnostic, withWindowsProcessDiagnostic, type WindowsProcessDiagnosticV1 } from "./windows-process-diagnostic.js";

declare const backendBrand: unique symbol;
export interface PreparedWindowsProcessBackend { readonly [backendBrand]: true }
export interface WindowsProcessBundleBinding {
  readonly directory: string;
  readonly manifestSha256: string;
  /** Mandatory local ACL/reparse/qualification check; never accepted from a remote payload. */
  readonly assertLocalInstallation: () => void;
}
interface BackendState extends WindowsProcessBundleBinding {
  readonly executable: string;
  readonly helperSystemRoot: string;
  readonly files: readonly { readonly path: string; readonly size: number; readonly sha256: string }[];
}
const backends = new WeakMap<object, BackendState>();
const receipts = new WeakSet<object>();
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const within = (root: string, value: string) => {
  const tail = relative(root, value); return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
};
function safeRelative(value: string): void {
  if (!value || isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Windows bundle member");
}
function validateBundle(state: BackendState): void {
  if (process.platform !== "win32") throw new Error("Windows process backend requires Windows");
  try {
    const qualification = state.assertLocalInstallation() as unknown;
    if (qualification && (typeof qualification === "object" || typeof qualification === "function")
      && typeof (qualification as { then?: unknown }).then === "function") {
      // The disallowed asynchronous check is an explicit admission failure, never an awaited bypass.
      // Observe a possible rejection so it cannot become a separate unhandled rejection after failing.
      void Promise.resolve(qualification).catch(() => undefined);
      throw new Error("Local installation qualification must finish synchronously");
    }
  } catch { throw new Error("Windows process bundle lacks synchronous local installation qualification"); }
  if (realpathSync.native(state.directory).toLowerCase() !== state.directory.toLowerCase()) throw new Error("Windows process bundle path changed");
  const manifestPath = join(state.directory, "manifest.json"), manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
    || sha(readFileSync(manifestPath)) !== state.manifestSha256) throw new Error("Windows process bundle manifest changed");
  const actual: string[] = [];
  const visit = (directory: string) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Windows process bundle directory");
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), child = lstatSync(path);
      if (child.isSymbolicLink() || !within(state.directory, realpathSync.native(path))) throw new Error("Linked Windows process bundle member");
      if (child.isDirectory()) visit(path);
      else if (child.isFile() && child.nlink === 1) {
        const member = relative(state.directory, path).split(sep).join("/");
        if (member !== "manifest.json") actual.push(member);
      }
      else throw new Error("Invalid Windows process bundle member");
    }
  };
  visit(state.directory);
  const expected = state.files.map(file => file.path).sort(); actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Windows process bundle membership changed");
  for (const file of state.files) {
    const path = join(state.directory, file.path), before = lstatSync(path), bytes = readFileSync(path), after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.size !== file.size || before.mtimeMs !== after.mtimeMs || sha(bytes) !== file.sha256) throw new Error("Windows process bundle bytes changed");
  }
}
export function prepareWindowsProcessBackend(binding: WindowsProcessBundleBinding): PreparedWindowsProcessBackend {
  if (typeof binding.assertLocalInstallation !== "function" || !isAbsolute(binding.directory)
    || !/^sha256:[a-f0-9]{64}$/.test(binding.manifestSha256)) throw new Error("Invalid Windows process bundle binding");
  const directory = resolve(binding.directory);
  const configuredSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!configuredSystemRoot || !isAbsolute(configuredSystemRoot)) throw new Error("Node environment lacks a trusted Windows system root");
  const helperSystemRoot = realpathSync.native(configuredSystemRoot);
  const bytes = readFileSync(join(directory, "manifest.json"));
  if (sha(bytes) !== binding.manifestSha256) throw new Error("Windows process bundle manifest differs from local binding");
  const manifest = JSON.parse(bytes.toString("utf8")) as { version: unknown; protocol: unknown; runtime: unknown; executable: string;
    files: { path: string; size: number; sha256: string }[] };
  if (manifest.version !== 1 || manifest.protocol !== "artoo.windows-job-process.v1" || manifest.runtime !== "win-x64"
    || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Unsupported Windows process manifest");
  safeRelative(manifest.executable);
  const files = manifest.files.map(file => { safeRelative(file.path);
    if (file.path.toLowerCase() === "manifest.json" || !Number.isSafeInteger(file.size) || file.size < 0 || !/^sha256:[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid bundle file");
    return Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 }); });
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length || !files.some(file => file.path === manifest.executable)
    || !manifest.executable.toLowerCase().endsWith(".exe")) throw new Error("Invalid Windows process entrypoint");
  const state = Object.freeze({ directory, manifestSha256: binding.manifestSha256, files: Object.freeze(files),
    executable: join(directory, manifest.executable), helperSystemRoot, assertLocalInstallation: binding.assertLocalInstallation });
  validateBundle(state);
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; backends.set(backend, state); return backend;
}
export function assertWindowsProcessBackend(backend: PreparedWindowsProcessBackend): void {
  const state = backends.get(backend);
  if (!state) throw new Error("Windows process backend was not locally prepared");
  validateBundle(state);
}
export interface WindowsOwnedStart {
  readonly executable: string; readonly args: readonly string[]; readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>; readonly timeoutMs: number; readonly maxOutputBytes: number;
  readonly cleanupTimeoutMs: number; readonly normalExitPolicy: "terminate-descendants" | "require-empty";
  readonly normalExitGraceMs: number; readonly signal?: AbortSignal;
}
interface NativeClosure {
  rootCreated: boolean; rootStarted: boolean; rootPid: number | null; rootCreationTime: string | null;
  atomicJobMember: boolean; rootWaitObserved: boolean; rootExitCode: number | null;
  stdoutEof: boolean; stderrEof: boolean; stdoutCreated: boolean; stderrCreated: boolean;
  jobCreated: boolean; jobEmptyObserved: boolean; noTargetCreated: boolean;
  terminationReason: string | null; failureCode: string | null; nativeError: number | null;
  outputBytesObserved: number; outputBytesCaptured: number; cleanupConfirmed: boolean;
}
export interface WindowsOwnedClosureReceipt {
  readonly version: 1; readonly token: string; readonly elapsedMs: number;
  readonly rootCreated: boolean; readonly rootStarted: boolean; readonly rootPid: number | null;
  readonly rootCreationTime: string | null; readonly atomicJobMember: boolean;
  readonly rootWaitObserved: boolean; readonly rootExitCode: number | null;
  readonly stdoutEof: boolean; readonly stderrEof: boolean; readonly jobEmptyObserved: boolean;
  readonly noTargetCreated: boolean; readonly terminationReason: string | null;
  readonly nativeTerminationReason: string | null; readonly failureCode: string | null;
  readonly nativeError: number | null; readonly outputBytesObserved: number; readonly outputBytesCaptured: number;
  readonly helperSpawnObserved: boolean; readonly helperExitObserved: boolean; readonly helperCloseObserved: boolean;
  readonly helperExitCode: number | null; readonly helperSignal: NodeJS.Signals | null;
  readonly cleanupConfirmed: boolean;
}
export class WindowsOwnedCleanupError extends Error {
  override readonly name = "WindowsOwnedCleanupError";
  readonly diagnostic: WindowsProcessDiagnosticV1;
  constructor(readonly receipt: WindowsOwnedClosureReceipt) {
    const diagnostic = windowsProcessDiagnostic(receipt);
    super(withWindowsProcessDiagnostic("Windows process closure remains unconfirmed; execution remains owned", diagnostic));
    this.diagnostic = diagnostic;
  }
}
export class WindowsOwnedStartupError extends Error {
  override readonly name = "WindowsOwnedStartupError";
  readonly diagnostic: WindowsProcessDiagnosticV1;
  constructor(receipt: WindowsOwnedClosureReceipt) {
    const diagnostic = windowsProcessDiagnostic(receipt);
    super(withWindowsProcessDiagnostic("Windows target did not start", diagnostic));
    this.diagnostic = diagnostic;
  }
}
export function isWindowsOwnedClosureReceipt(value: unknown): value is WindowsOwnedClosureReceipt {
  return typeof value === "object" && value !== null && receipts.has(value);
}
export interface WindowsOwnedProcess extends EventEmitter {
  readonly stdout: Readable; readonly stderr: Readable;
  readonly pid: number | undefined; readonly exitCode: number | null; readonly signalCode: null;
  readonly started: Promise<{ readonly pid: number }>;
  readonly closed: Promise<WindowsOwnedClosureReceipt>;
  cancel(): void;
}
function normalizeEnvironment(source: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const entries = new Map<string, { key: string; value: string }>();
  // Windows treats keys case-insensitively. The caller's final insertion wins, exactly once.
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) throw new Error("Invalid Windows process environment");
    entries.set(key.toUpperCase(), { key, value });
  }
  if (!entries.get("SYSTEMROOT")?.value) throw new Error("Windows process environment requires explicit SystemRoot");
  return Object.fromEntries([...entries.values()].sort((a, b) => a.key.toUpperCase().localeCompare(b.key.toUpperCase())).map(({ key, value }) => [key, value]));
}
function nativeClosure(value: unknown): NativeClosure {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid closure");
  const v = value as Record<string, unknown>;
  const booleans = ["rootCreated", "rootStarted", "atomicJobMember", "rootWaitObserved", "stdoutEof", "stderrEof", "stdoutCreated", "stderrCreated", "jobCreated", "jobEmptyObserved", "noTargetCreated", "cleanupConfirmed"];
  for (const key of booleans) if (typeof v[key] !== "boolean") throw new Error("Invalid closure flag");
  for (const key of ["rootPid", "rootExitCode", "nativeError"]) if (v[key] !== null && (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0 || (v[key] as number) > 0xffffffff)) throw new Error("Invalid process fact");
  for (const key of ["outputBytesObserved", "outputBytesCaptured"]) if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0) throw new Error("Invalid output count");
  for (const key of ["terminationReason", "failureCode"]) if (v[key] !== null && (typeof v[key] !== "string" || !/^[a-z_]{1,64}$/.test(v[key] as string))) throw new Error("Invalid reason");
  if (v.rootCreationTime !== null && (typeof v.rootCreationTime !== "string" || !/^\d{1,20}$/.test(v.rootCreationTime))) throw new Error("Invalid process identity");
  return v as unknown as NativeClosure;
}
export function startWindowsOwnedProcess(backend: PreparedWindowsProcessBackend, input: WindowsOwnedStart): WindowsOwnedProcess {
  const begun = performance.now(), state = backends.get(backend);
  if (!state) throw new Error("Windows process backend was not locally prepared");
  input.signal?.throwIfAborted();
  const args = [...input.args], env = normalizeEnvironment(input.env), signal = input.signal;
  const { executable, cwd, timeoutMs, maxOutputBytes, cleanupTimeoutMs, normalExitPolicy, normalExitGraceMs } = input;
  if (!isAbsolute(executable) || !executable.toLowerCase().endsWith(".exe") || !isAbsolute(cwd)
    || [executable, cwd, ...args].some(value => typeof value !== "string" || value.includes("\0"))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 43_200_000
    || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60_000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 67_108_864
    || !Number.isInteger(normalExitGraceMs) || normalExitGraceMs < 0 || normalExitGraceMs > cleanupTimeoutMs
    || !["terminate-descendants", "require-empty"].includes(normalExitPolicy)) throw new Error("Invalid Windows owned process input");
  validateBundle(state); signal?.throwIfAborted();
  const deadline = begun + timeoutMs;
  if (performance.now() >= deadline) throw new Error("Windows process deadline elapsed before helper launch");
  const token = randomUUID(), stdout = new PassThrough(), stderr = new PassThrough(), emitter = new EventEmitter();
  if (Buffer.byteLength(JSON.stringify({ version: 1, kind: "launch", token, executable, args, cwd, env,
    timeoutMs, maxOutputBytes, cleanupTimeoutMs, normalExitPolicy, normalExitGraceMs })) >= 1024 * 1024) throw new Error("Windows process launch frame exceeds its fixed bound");
  let resolveStarted!: (value: { pid: number }) => void, rejectStarted!: (error: Error) => void;
  let resolveClosed!: (value: WindowsOwnedClosureReceipt) => void, rejectClosed!: (error: Error) => void;
  const started = new Promise<{ pid: number }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const closed = new Promise<WindowsOwnedClosureReceipt>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void started.catch(() => {}); void closed.catch(() => {});
  let child: ChildProcessWithoutNullStreams;
  let helperSpawn = false, helperExit = false, helperClose = false, helperStatus: number | null = null, helperSignal: NodeJS.Signals | null = null;
  let ready = false, dispatched = false, admittedToCaller = false, rootStarted = false;
  let seenRootExit: number | null = null, seenPid: number | null = null, seenCreationTime: string | null = null;
  let sequence = 0, bytes = 0, helperDiagnosticBytes = 0, frameBuffer = "", final: NativeClosure | undefined;
  let stdoutEof = false, stderrEof = false, fatal: string | null = null, requestedStop: string | null = null, settled = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const root = state.helperSystemRoot;
  // No DOTNET_STARTUP_HOOKS, profiler, provider or arbitrary target environment enters the helper.
  child = spawn(state.executable, ["--stdio-v1"], { cwd: state.directory, shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") } });
  function receipt(): WindowsOwnedClosureReceipt {
    const complete = !!final && final.cleanupConfirmed && !fatal && helperSpawn && helperExit && helperClose && helperStatus === 0 && helperSignal === null;
    return Object.freeze({ version: 1, token, elapsedMs: performance.now() - begun,
      rootCreated: final?.rootCreated ?? seenPid !== null, rootStarted: final?.rootStarted ?? rootStarted,
      rootPid: final?.rootPid ?? seenPid, rootCreationTime: final?.rootCreationTime ?? null, atomicJobMember: final?.atomicJobMember ?? false,
      rootWaitObserved: final?.rootWaitObserved ?? seenRootExit !== null, rootExitCode: final?.rootExitCode ?? seenRootExit,
      stdoutEof: final?.stdoutEof ?? stdoutEof, stderrEof: final?.stderrEof ?? stderrEof, jobEmptyObserved: final?.jobEmptyObserved ?? false,
      noTargetCreated: final?.noTargetCreated ?? false, terminationReason: requestedStop ?? final?.terminationReason ?? fatal,
      nativeTerminationReason: final?.terminationReason ?? null, failureCode: fatal ?? final?.failureCode ?? null, nativeError: final?.nativeError ?? null,
      outputBytesObserved: final?.outputBytesObserved ?? bytes, outputBytesCaptured: final?.outputBytesCaptured ?? bytes,
      helperSpawnObserved: helperSpawn, helperExitObserved: helperExit, helperCloseObserved: helperClose,
      helperExitCode: helperStatus, helperSignal, cleanupConfirmed: complete });
  }
  function settle(): void {
    if (settled) return; settled = true;
    clearTimeout(operationTimer); clearTimeout(startupTimer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", onAbort);
    stdout.end(); stderr.end();
    const value = receipt(); receipts.add(value);
    if (!rootStarted) rejectStarted(new WindowsOwnedStartupError(value));
    if (value.cleanupConfirmed) { resolveClosed(value); emitter.emit("close", value.rootExitCode, null); }
    else rejectClosed(new WindowsOwnedCleanupError(value));
  }
  function stop(reason: string, protocolFailure = false): void {
    if (settled) return;
    requestedStop ??= reason; if (protocolFailure) fatal ??= reason;
    if (dispatched && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify({ version: 1, kind: "cancel", token })}\n`, () => {});
    child.stdin.end();
    // One fixed deadline. Repeated cancel/output cannot renew it.
    cleanupTimer ??= setTimeout(() => { fatal ??= "cleanup_deadline"; child.kill(); settle(); }, cleanupTimeoutMs + 2500);
  }
  const onAbort = () => stop("cancelled");
  const operationTimer = setTimeout(() => stop("timeout"), Math.max(1, deadline - performance.now()));
  const startupTimer = setTimeout(() => stop("timeout"), Math.max(1, Math.min(10000, deadline - performance.now())));
  function frame(line: string): void {
    const value = JSON.parse(line) as { version?: unknown; token?: unknown; kind?: unknown; sequence?: unknown; payload?: unknown };
    if (value.version !== 1 || value.sequence !== sequence++ || typeof value.kind !== "string" || !value.payload || typeof value.payload !== "object" || final) throw new Error("Invalid frame");
    const payload = value.payload as Record<string, unknown>;
    if (value.kind === "ready") {
      if (ready || value.token !== null || payload.protocol !== "artoo.windows-job-process.v1" || payload.atomicJobList !== true) throw new Error("Invalid ready");
      ready = true;
      if (!admittedToCaller) { stop("launch_abandoned"); return; }
      if (requestedStop) { child.stdin.end(); return; }
      if (performance.now() >= deadline) { stop("timeout"); return; }
      dispatched = true;
      child.stdin.write(`${JSON.stringify({ version: 1, kind: "launch", token, executable, args, cwd, env,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), cleanupTimeoutMs, maxOutputBytes, normalExitPolicy, normalExitGraceMs })}\n`,
        error => { if (error) stop("control_write", true); });
      return;
    }
    const neverDispatched = ready && !dispatched && value.kind === "complete" && value.token === null;
    if (!neverDispatched && (!dispatched || value.token !== token)) throw new Error("Unbound control frame");
    if (value.kind === "created") {
      if (seenPid !== null || seenRootExit !== null || !Number.isSafeInteger(payload.pid) || (payload.pid as number) < 1 || payload.jobMember !== true
        || typeof payload.creationTime !== "string" || !/^\d{1,20}$/.test(payload.creationTime)) throw new Error("Invalid creation");
      seenPid = payload.pid as number; seenCreationTime = payload.creationTime;
    } else if (value.kind === "started") {
      if (rootStarted || seenRootExit !== null || seenPid === null || payload.pid !== seenPid) throw new Error("Invalid start");
      rootStarted = true; clearTimeout(startupTimer); resolveStarted(Object.freeze({ pid: seenPid })); emitter.emit("spawn");
    } else if (value.kind === "root_exit") {
      if (seenRootExit !== null || !Number.isSafeInteger(payload.code) || (payload.code as number) < 0 || (payload.code as number) > 0xffffffff) throw new Error("Invalid exit");
      seenRootExit = payload.code as number; emitter.emit("exit", seenRootExit, null);
    } else if (value.kind === "output") {
      if (!["stdout", "stderr"].includes(payload.stream as string) || typeof payload.data !== "string" || payload.data.length > 24000
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.data)) throw new Error("Invalid output");
      if (payload.stream === "stdout" ? stdoutEof : stderrEof) throw new Error("Output after EOF");
      const data = Buffer.from(payload.data, "base64"); bytes += data.length;
      if (bytes > maxOutputBytes) throw new Error("Output overflow");
      (payload.stream === "stdout" ? stdout : stderr).write(data);
    } else if (value.kind === "pipe_eof") {
      if (payload.stream === "stdout" && !stdoutEof) { stdoutEof = true; stdout.end(); }
      else if (payload.stream === "stderr" && !stderrEof) { stderrEof = true; stderr.end(); }
      else throw new Error("Invalid EOF");
    } else if (value.kind === "complete") {
      const result = nativeClosure(payload);
      if (neverDispatched && (!result.noTargetCreated || result.rootCreated || result.rootStarted || result.jobCreated
        || result.stdoutCreated || result.stderrCreated)) throw new Error("Unexpected work before dispatch");
      if (result.rootStarted !== rootStarted || (seenPid !== null && result.rootPid !== seenPid)
        || result.rootExitCode !== seenRootExit || result.stdoutEof !== stdoutEof || result.stderrEof !== stderrEof
        || result.outputBytesCaptured !== bytes || result.outputBytesObserved < bytes
        || (result.rootStarted && (!result.rootCreated || !result.atomicJobMember))
        || (result.rootCreated && (result.rootPid === null || result.rootPid < 1 || !result.jobCreated || !result.stdoutCreated || !result.stderrCreated))
        || (result.noTargetCreated && (result.rootPid !== null || result.rootWaitObserved || result.rootExitCode !== null
          || result.rootStarted || result.atomicJobMember || result.rootCreationTime !== null))
        || (result.rootWaitObserved && !result.rootCreated) || (result.rootExitCode !== null && !result.rootWaitObserved)
        || (result.rootCreationTime !== null && !result.rootCreated)
        || (seenPid !== null && (!result.atomicJobMember || result.rootCreationTime !== seenCreationTime))
        || (result.stdoutEof && !result.stdoutCreated) || (result.stderrEof && !result.stderrCreated)
        || (result.jobEmptyObserved && !result.jobCreated)
        || (result.rootCreated === result.noTargetCreated)
        || (result.cleanupConfirmed && (!(result.noTargetCreated || result.rootWaitObserved)
          || (result.stdoutCreated && !result.stdoutEof) || (result.stderrCreated && !result.stderrEof)
          || (result.jobCreated && !result.jobEmptyObserved)))) throw new Error("Inconsistent closure");
      final = result; clearTimeout(startupTimer); child.stdin.end();
    } else throw new Error("Unknown frame");
  }
  child.once("spawn", () => { helperSpawn = true; });
  child.once("error", () => stop("helper_error", true));
  child.once("exit", (code, osSignal) => { helperExit = true; helperStatus = code; helperSignal = osSignal; });
  child.once("close", (code, osSignal) => {
    helperClose = true; helperStatus ??= code; helperSignal ??= osSignal;
    if (frameBuffer.length || !final) fatal ??= "missing_complete";
    settle();
  });
  child.stdin.on("error", () => { if (!final) stop("control_write", true); });
  child.stdout.on("error", () => stop("control_read", true));
  child.stderr.on("error", () => stop("helper_diagnostic_pipe", true));
  child.stderr.on("data", (data: Buffer) => { helperDiagnosticBytes += data.length; if (helperDiagnosticBytes > 65536) stop("helper_diagnostic_limit", true); });
  child.stdout.on("data", (data: Buffer) => {
    if (settled || fatal) return;
    frameBuffer += data.toString("utf8");
    try {
      let end: number;
      while ((end = frameBuffer.indexOf("\n")) >= 0) {
        const line = frameBuffer.slice(0, end); frameBuffer = frameBuffer.slice(end + 1);
        if (Buffer.byteLength(line) > 65536) throw new Error("Frame too large"); frame(line);
      }
      if (Buffer.byteLength(frameBuffer) > 65536) throw new Error("Frame too large");
    } catch { stop("control_protocol", true); }
  });
  const result = Object.assign(emitter, { stdout, stderr, started, closed, cancel: () => stop("cancelled") });
  Object.defineProperties(result, { pid: { get: () => seenPid ?? undefined }, exitCode: { get: () => seenRootExit }, signalCode: { get: () => null } });
  try { signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); }
  catch { stop("launch_abandoned"); throw new Error("Windows process cancellation observer could not be installed; target was not dispatched"); }
  admittedToCaller = true;
  // defineProperties installs these readonly native-observation getters above;
  // TypeScript cannot infer their addition to EventEmitter's structural type.
  return result as unknown as WindowsOwnedProcess;
}
