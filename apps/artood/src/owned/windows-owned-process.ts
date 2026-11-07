// Node-owned Windows Job Object process control. Production callers qualify the
// local installation before creating this opaque backend.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { markWindowsNativeFailure, windowsNativeFailureDetail, windowsProcessDiagnostic, withWindowsProcessDiagnostic, type WindowsNativeFailureCode,
  type WindowsProcessDiagnosticV1 } from "./windows-process-diagnostic.js";
import { consumeWindowsGuardianSlot, type PreparedWindowsGuardianSlot } from "./windows-runtime-guardian.js";

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
  readonly guardian: boolean;
  readonly supervisor: boolean;
  readonly memberObservation: boolean;
}
const backends = new WeakMap<object, BackendState>();
const receipts = new WeakSet<object>();
// A fixed installation audit may itself need a registered native collector.
// Only the current synchronous audit can reenter; every entry still verifies
// the original manifest, inventory and bytes. No state survives the call.
const qualifying = new WeakSet<BackendState>();
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const within = (root: string, value: string) => {
  const tail = relative(root, value); return tail === "" || (!isAbsolute(tail) && tail !== ".." && !tail.startsWith(`..${sep}`));
};
function safeRelative(value: string): void {
  if (!value || isAbsolute(value) || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Windows bundle member");
}
function validateBundle(state: BackendState): void {
  if (process.platform !== "win32") throw new Error("Windows process backend requires Windows");
  if (!qualifying.has(state)) { try {
    qualifying.add(state);
    const qualification = state.assertLocalInstallation() as unknown;
    if (qualification && (typeof qualification === "object" || typeof qualification === "function")
      && typeof (qualification as { then?: unknown }).then === "function") {
      // The disallowed asynchronous check is an explicit admission failure, never an awaited bypass.
      // Observe a possible rejection so it cannot become a separate unhandled rejection after failing.
      void Promise.resolve(qualification).catch(() => undefined);
      throw new Error("Local installation qualification must finish synchronously");
    }
  } catch (cause) { throw markWindowsNativeFailure(new Error("Windows process bundle lacks synchronous local installation qualification", { cause }),
    "native_qualification_failed"); }
  finally { qualifying.delete(state); } }
  try { validateBundleFiles(state); }
  catch (cause) { throw markWindowsNativeFailure(cause instanceof Error ? cause : new Error("Windows process bundle file qualification failed", { cause }),
    "native_qualification_failed"); }
}
function validateBundleFiles(state: BackendState): void {
  if (process.platform !== "win32") throw new Error("Windows process backend requires Windows");
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
    files: { path: string; size: number; sha256: string }[]; capabilities?: unknown };
  if (manifest.version !== 1 || manifest.protocol !== "artoo.windows-job-process.v1" || manifest.runtime !== "win-x64"
    || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error("Unsupported Windows process manifest");
  safeRelative(manifest.executable);
  const files = manifest.files.map(file => { safeRelative(file.path);
    if (file.path.toLowerCase() === "manifest.json" || !Number.isSafeInteger(file.size) || file.size < 0 || !/^sha256:[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid bundle file");
    return Object.freeze({ path: file.path, size: file.size, sha256: file.sha256 }); });
  if (new Set(files.map(file => file.path.toLowerCase())).size !== files.length || !files.some(file => file.path === manifest.executable)
    || !manifest.executable.toLowerCase().endsWith(".exe")) throw new Error("Invalid Windows process entrypoint");
  if (manifest.capabilities !== undefined && (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 16
    || manifest.capabilities.some(value => typeof value !== "string") || new Set(manifest.capabilities).size !== manifest.capabilities.length)) throw new Error("Invalid Windows process capabilities");
  const state = Object.freeze({ directory, manifestSha256: binding.manifestSha256, files: Object.freeze(files),
    executable: join(directory, manifest.executable), helperSystemRoot, assertLocalInstallation: binding.assertLocalInstallation,
    guardian: Array.isArray(manifest.capabilities) && manifest.capabilities.includes("artoo.windows-runtime-guardian.v1"),
    supervisor: Array.isArray(manifest.capabilities) && manifest.capabilities.includes("artoo.windows-daemon-supervisor.v1"),
    memberObservation: Array.isArray(manifest.capabilities) && manifest.capabilities.includes("artoo.windows-job-member-observation.v1") });
  validateBundle(state);
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; backends.set(backend, state); return backend;
}
export function assertWindowsProcessBackend(backend: PreparedWindowsProcessBackend): void {
  const state = backends.get(backend);
  if (!state) throw new Error("Windows process backend was not locally prepared");
  validateBundle(state);
}
/** Fixed guardian control only. This does not admit a target or replace a full
 * installation audit when preparing an operation that can execute one. */
export function assertWindowsProcessBackendImage(backend: PreparedWindowsProcessBackend): void {
  const state = backends.get(backend);
  if (!state) throw new Error("Windows process backend was not locally prepared");
  validateBundleFiles(state);
}
export interface WindowsOwnedStart {
  readonly executable: string; readonly args: readonly string[]; readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>; readonly timeoutMs: number; readonly maxOutputBytes: number;
  readonly cleanupTimeoutMs: number; readonly normalExitPolicy: "terminate-descendants" | "require-empty";
  readonly normalExitGraceMs: number; readonly signal?: AbortSignal;
  /** Original single-use native reservation. Never accepted from a remote launch payload. */
  readonly guardianSlot?: PreparedWindowsGuardianSlot;
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
  readonly started: Promise<{ readonly pid: number; readonly creationTime?: string }>;
  readonly hostIdentity?: WindowsJobMemberIdentity;
  readonly closed: Promise<WindowsOwnedClosureReceipt>;
  cancel(): void;
  /** Read-only facts from this owner's original Job HANDLE; never execution/recovery authority. */
  observeMembers?(members: readonly WindowsJobMemberIdentity[], timeoutMs?: number): Promise<WindowsJobMemberObservation>;
}
export interface WindowsJobMemberIdentity { readonly pid: number; readonly creationTime: string }
export interface WindowsJobMemberObservation {
  readonly version: 1; readonly token: string; readonly requestId: string; readonly observedElapsedMs: number;
  readonly members: readonly (WindowsJobMemberIdentity & ({ readonly status: "observed"; readonly jobMember: boolean }
    | { readonly status: "unavailable"; readonly reason: string }))[];
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
  // Capture validated capability booleans for the later control-frame callback.
  const { guardian: installedGuardian, memberObservation: installedMemberObservation } = state;
  const guardian = consumeWindowsGuardianSlot(backend, input.guardianSlot, cwd);
  const deadline = begun + timeoutMs;
  if (performance.now() >= deadline) throw new Error("Windows process deadline elapsed before helper launch");
  const token = randomUUID(), stdout = new PassThrough(), stderr = new PassThrough(), emitter = new EventEmitter();
  if (Buffer.byteLength(JSON.stringify({ version: 1, kind: "launch", token, executable, args, cwd, env,
    timeoutMs, maxOutputBytes, cleanupTimeoutMs, normalExitPolicy, normalExitGraceMs })) >= 1024 * 1024) throw new Error("Windows process launch frame exceeds its fixed bound");
  let resolveStarted!: (value: { pid: number; creationTime?: string }) => void, rejectStarted!: (error: Error) => void;
  let resolveClosed!: (value: WindowsOwnedClosureReceipt) => void, rejectClosed!: (error: Error) => void;
  const started = new Promise<{ pid: number; creationTime?: string }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  const closed = new Promise<WindowsOwnedClosureReceipt>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  void started.catch(() => {}); void closed.catch(() => {});
  let child: ChildProcessWithoutNullStreams;
  let helperSpawn = false, helperExit = false, helperClose = false, helperStatus: number | null = null, helperSignal: NodeJS.Signals | null = null;
  let ready = false, dispatched = false, admittedToCaller = false, rootStarted = false;
  let seenRootExit: number | null = null, seenPid: number | null = null, seenCreationTime: string | null = null;
  let sequence = 0, bytes = 0, helperDiagnosticBytes = 0, frameBuffer = "", final: NativeClosure | undefined;
  let stdoutEof = false, stderrEof = false, fatal: string | null = null, requestedStop: string | null = null, settled = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let memberCapability = false, observationCount = 0;
  let hostIdentity: WindowsJobMemberIdentity | undefined;
  const pendingObservations = new Map<string, { members: readonly WindowsJobMemberIdentity[]; timer: ReturnType<typeof setTimeout>;
    resolve: (value: WindowsJobMemberObservation) => void; reject: (error: Error) => void }>();
  function rejectObservations(): void {
    for (const pending of pendingObservations.values()) { clearTimeout(pending.timer); pending.reject(new Error("Original Job owner closed before its member observation")); }
    pendingObservations.clear();
  }
  const root = state.helperSystemRoot;
  // No DOTNET_STARTUP_HOOKS, profiler, provider or arbitrary target environment enters the helper.
  // Only an original consumed Guardian slot may outlive this daemon's private libuv Job.
  // Detached does not request breakaway from the enclosing native Supervisor/owner Job.
  child = spawn(state.executable, ["--stdio-v1"], { cwd: state.directory, shell: false, windowsHide: true,
    detached: guardian !== undefined, stdio: ["pipe", "pipe", "pipe"], env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") } });
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
    rejectObservations();
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
      if (payload.hostIdentity !== undefined) {
        const identity = payload.hostIdentity as { pid?: unknown; creationTime?: unknown };
        if (!identity || identity.pid !== child.pid || typeof identity.creationTime !== "string" || !/^\d{1,20}$/.test(identity.creationTime))
          throw new Error("Invalid native host identity");
        hostIdentity = Object.freeze({ pid: identity.pid as number, creationTime: identity.creationTime });
      }
      if (guardian && (!installedGuardian || !Array.isArray(payload.capabilities) || !payload.capabilities.includes("artoo.windows-runtime-guardian.v1"))) throw new Error("Guardian host capability missing");
      memberCapability = installedMemberObservation && Array.isArray(payload.capabilities) && payload.capabilities.includes("artoo.windows-job-member-observation.v1");
      ready = true;
      if (!admittedToCaller) { stop("launch_abandoned"); return; }
      if (requestedStop) { child.stdin.end(); return; }
      if (performance.now() >= deadline) { stop("timeout"); return; }
      dispatched = true;
      child.stdin.write(`${JSON.stringify({ version: 1, kind: "launch", token, executable, args, cwd, env,
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), cleanupTimeoutMs, maxOutputBytes, normalExitPolicy, normalExitGraceMs,
        ...(guardian ? { guardian } : {}) })}\n`,
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
      if (payload.creationTime !== undefined && payload.creationTime !== seenCreationTime) throw new Error("Native root identity changed before start");
      rootStarted = true; clearTimeout(startupTimer); resolveStarted(Object.freeze({ pid: seenPid, ...(payload.creationTime !== undefined ? { creationTime: seenCreationTime! } : {}) })); emitter.emit("spawn");
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
    } else if (value.kind === "job_members") {
      const pending = typeof payload.requestId === "string" && pendingObservations.get(payload.requestId);
      if (!memberCapability || !pending || !Array.isArray(payload.members) || payload.members.length !== pending.members.length
        || typeof payload.observedElapsedMs !== "number" || !Number.isFinite(payload.observedElapsedMs) || payload.observedElapsedMs < 0)
        throw new Error("Unbound original Job member observation");
      const members = payload.members.map((item: unknown, index: number) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid member fact");
        const fact = item as Record<string, unknown>, expected = pending.members[index]!;
        if (fact.pid !== expected.pid || fact.creationTime !== expected.creationTime || Object.keys(fact).length !== 4)
          throw new Error("Original Job member identity changed");
        if (fact.status === "observed" && typeof fact.jobMember === "boolean") return Object.freeze({ ...expected, status: "observed" as const, jobMember: fact.jobMember });
        if (fact.status === "unavailable" && typeof fact.reason === "string" && /^[a-z_]{1,64}$/.test(fact.reason))
          return Object.freeze({ ...expected, status: "unavailable" as const, reason: fact.reason });
        throw new Error("Invalid original Job member result");
      });
      clearTimeout(pending.timer); pendingObservations.delete(payload.requestId as string);
      pending.resolve(Object.freeze({ version: 1, token, requestId: payload.requestId as string,
        observedElapsedMs: payload.observedElapsedMs, members: Object.freeze(members) }));
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
  async function observeMembers(inputMembers: readonly WindowsJobMemberIdentity[], observationTimeoutMs = 5000): Promise<WindowsJobMemberObservation> {
    if (!memberCapability || !rootStarted || settled || final || requestedStop || seenRootExit !== null)
      throw new Error("Original live Job owner does not support member observation");
    if (!Array.isArray(inputMembers) || inputMembers.length < 1 || inputMembers.length > 128
      || inputMembers.some(item => !item || !Number.isSafeInteger(item.pid) || item.pid < 1 || item.pid > 0xffffffff
        || typeof item.creationTime !== "string" || !/^\d{1,20}$/.test(item.creationTime))
      || new Set(inputMembers.map(item => item.pid)).size !== inputMembers.length || pendingObservations.size >= 16 || observationCount >= 256
      || !Number.isInteger(observationTimeoutMs) || observationTimeoutMs < 1 || observationTimeoutMs > 5000)
      throw new Error("Invalid bounded original Job member observation");
    const members = Object.freeze(inputMembers.map(item => Object.freeze({ pid: item.pid, creationTime: item.creationTime }))), requestId = randomUUID();
    const line = `${JSON.stringify({ version: 1, kind: "observe_members", token, requestId, members })}\n`;
    if (Buffer.byteLength(line) > 16384) throw new Error("Original Job member request exceeds its fixed bound");
    observationCount++;
    return await new Promise<WindowsJobMemberObservation>((resolve, reject) => {
      // A late response still consumes its exact request slot; timeout never renews the owner deadline.
      const timer = setTimeout(() => reject(new Error("Original Job member observation deadline elapsed")), Math.max(1, Math.min(observationTimeoutMs, deadline - performance.now())));
      pendingObservations.set(requestId, { members, timer, resolve, reject });
      child.stdin.write(line, error => { if (error) { clearTimeout(timer); pendingObservations.delete(requestId); reject(new Error("Original Job member observation input failed")); } });
    });
  }
  const result = Object.assign(emitter, { stdout, stderr, started, closed, cancel: () => stop("cancelled"),
    ...(installedMemberObservation ? { observeMembers } : {}) });
  Object.defineProperties(result, { pid: { get: () => seenPid ?? undefined }, hostIdentity: { get: () => hostIdentity }, exitCode: { get: () => seenRootExit }, signalCode: { get: () => null } });
  try { signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) onAbort(); }
  catch { stop("launch_abandoned"); throw new Error("Windows process cancellation observer could not be installed; target was not dispatched"); }
  admittedToCaller = true;
  // defineProperties installs these readonly native-observation getters above;
  // TypeScript cannot infer their addition to EventEmitter's structural type.
  return result as unknown as WindowsOwnedProcess;
}

/** Private native transport, not a recovery permit. The fixed freshly rechecked bundle is
 * the only executable, and control/tickets never enter target argv or environment. */
export async function invokeWindowsGuardianNative(backend: PreparedWindowsProcessBackend,
  mode: "bootstrap" | "command" | "supervisor", input: unknown): Promise<unknown> {
  const state = backends.get(backend);
  if (!state) throw new Error("Windows guardian requires an original prepared backend");
  validateBundleFiles(state);
  if (!state.guardian) throw new Error("Installed Windows process bundle does not advertise guardian v1");
  if (mode === "supervisor" && !state.supervisor) throw new Error("Installed Windows process bundle does not advertise daemon supervisor v1");
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text) > 65536 || !["bootstrap", "command", "supervisor"].includes(mode)) throw new Error("Invalid Windows guardian control");
  if (mode === "supervisor" && text !== JSON.stringify({ version: 1, kind: "qualify" })) throw new Error("Supervisor qualification accepts only its fixed local request");
  return await new Promise((resolve, reject) => {
    const root = state.helperSystemRoot;
    const child = spawn(state.executable, [mode === "bootstrap" ? "--guardian-v1" : mode === "supervisor" ? "--daemon-supervisor-qualify-v1" : "--guardian-client-v1"], {
      cwd: state.directory, shell: false, windowsHide: true, detached: mode === "bootstrap", stdio: ["pipe", "pipe", "pipe"],
      env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") },
    });
    let output = "", diagnosticBytes = 0, spawned = false, ended = false, diagnosticEnded = false, exited = false, done = false;
    const decoder = new StringDecoder("utf8");
    let result: unknown, resultSeen = false, status: number | null = null, signal: NodeJS.Signals | null = null;
    const finish = (error?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      if (error) {
        // A bootstrap may already own a fence. Stop only this exact spawned helper;
        // the retained owner.lock is deliberately never removed or adopted.
        child.kill(); child.stdin.destroy(); reject(error); return;
      }
      if (mode === "bootstrap") { child.stdin.end(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("Windows guardian handshake timed out; ownership remains fenced")), 10000);
    child.once("spawn", () => { spawned = true; });
    child.once("error", () => finish(new Error("Windows guardian helper failed to spawn")));
    child.once("exit", (code, osSignal) => { exited = true; status = code; signal = osSignal; });
    child.once("close", () => {
      if (done) return;
      if (mode === "bootstrap" || !spawned || !exited || !ended || mode === "supervisor" && !diagnosticEnded || status !== 0 || signal !== null || !resultSeen || output.length)
        finish(new Error("Windows guardian command lacks actual successful helper closure"));
      else finish();
    });
    child.stdin.on("error", () => { if (!done) finish(new Error("Windows guardian input failed")); });
    child.stdout.on("error", () => { if (!done) finish(new Error("Windows guardian output failed")); });
    child.stderr.on("error", () => { if (!done) finish(new Error("Windows guardian diagnostic pipe failed")); });
    child.stderr.on("data", (data: Buffer) => { diagnosticBytes += data.length; if (diagnosticBytes > 65536) finish(new Error("Windows guardian diagnostic bound exceeded")); });
    child.stdout.once("end", () => { output += decoder.end(); ended = true; });
    child.stderr.once("end", () => { diagnosticEnded = true; });
    child.stdout.on("data", (data: Buffer) => {
      if (done) return;
      output += decoder.write(data);
      try {
        if (Buffer.byteLength(output) > 65536) throw new Error("Windows guardian response bound exceeded");
        const end = output.indexOf("\n"); if (end < 0) return;
        if (resultSeen) throw new Error("Windows guardian returned multiple results");
        const frame = JSON.parse(output.slice(0, end)) as { version?: unknown; kind?: unknown; payload?: unknown };
        output = output.slice(end + 1);
        if (frame.version !== 1 || frame.kind !== (mode === "bootstrap" ? "guardian_ready" : mode === "supervisor" ? "supervisor_qualified" : "guardian_result") || output.length)
          throw new Error("Windows guardian response protocol changed");
        result = frame.payload; resultSeen = true;
        if (mode === "bootstrap") {
          const endpoint = (result as { endpoint?: { guardianPid?: unknown } })?.endpoint;
          if (!spawned || exited || endpoint?.guardianPid !== child.pid) throw new Error("Windows guardian bootstrap identity changed");
          finish();
        }
      } catch (error) { finish(error instanceof Error ? error : new Error("Windows guardian response invalid")); }
    });
    child.stdin.end(`${text}\n`);
  });
}

function synchronousNativeFailure(child: { error?: NodeJS.ErrnoException; pid: number; status: number | null;
  signal: NodeJS.Signals | null }, protocolFailure: boolean): WindowsNativeFailureCode {
  if (child.error?.code === "ETIMEDOUT") return "native_timeout";
  if (child.error?.code === "ENOBUFS") return "native_protocol_failed";
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return "native_spawn_failed";
  if (Number.isInteger(child.status) && child.status !== 0) return "native_nonzero_exit";
  if (child.error || child.signal !== null || child.status !== 0) return "native_closure_unconfirmed";
  return protocolFailure ? "native_protocol_failed" : "native_closure_unconfirmed";
}
/** Synchronous fixed control relay. A successful response is still descriptive;
 * only the guardian module can bind it to an original epoch or one-use slot. */
export function invokeWindowsGuardianNativeSync(backend: PreparedWindowsProcessBackend,
  mode: "command", input: unknown): unknown {
  const state = backends.get(backend);
  if (!state || !state.guardian || mode !== "command") throw new Error("Original guardian-capable backend required");
  try { validateBundleFiles(state); }
  catch (cause) { throw markWindowsNativeFailure(cause instanceof Error ? cause : new Error("Windows process bundle file qualification failed", { cause }),
    "native_qualification_failed"); }
  const text = JSON.stringify(input);
  if (typeof text !== "string" || Buffer.byteLength(text) > 65536) throw new Error("Invalid Windows guardian control");
  const root = state.helperSystemRoot;
  const child = (() => {
    try { return spawnSync(state.executable, ["--guardian-client-v1"], {
      cwd: state.directory, shell: false, windowsHide: true, input: `${text}\n`,
      timeout: 10000, maxBuffer: 131072,
      env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") },
    }); } catch (cause) {
      throw markWindowsNativeFailure(new Error("Windows guardian control helper could not be spawned", { cause }), "native_spawn_failed",
        windowsNativeFailureDetail("guardian_client_sync", null, undefined));
    }
  })();
  if (child.error || !Number.isSafeInteger(child.pid) || child.pid < 1 || child.status !== 0 || child.signal !== null
    || !Buffer.isBuffer(child.stdout) || !Buffer.isBuffer(child.stderr) || child.stdout.length > 65536 || child.stderr.length > 65536) {
    throw markWindowsNativeFailure(new Error("Windows guardian command lacks successful synchronous process and pipe closure"),
      synchronousNativeFailure(child, true), windowsNativeFailureDetail("guardian_client_sync", child.status, child.stderr));
  }
  try {
    const output = child.stdout.toString("utf8");
    if (!output.endsWith("\n") || output.indexOf("\n") !== output.length - 1) throw new Error("Windows guardian response framing changed");
    const frame = JSON.parse(output) as { version?: unknown; kind?: unknown; payload?: unknown };
    if (frame.version !== 1 || frame.kind !== "guardian_result" || !Object.hasOwn(frame, "payload")) throw new Error("Invalid Windows guardian response");
    return frame.payload;
  } catch (cause) {
    throw markWindowsNativeFailure(cause instanceof Error ? cause : new Error("Windows guardian response framing or protocol changed", { cause }),
      "native_protocol_failed", windowsNativeFailureDetail("guardian_client_sync", child.status, child.stderr));
  }
}

/** Internal fixed collector boundary. Callers supply only the protected collector
 * program and local input; an original observer slot is consumed before spawn.
 * spawnSync waits for the exact helper and its captured pipes. The native host
 * separately proves the target HANDLE, Job zero, target EOF and guardian ACK. */
export function startWindowsGuardianObserverSync(backend: PreparedWindowsProcessBackend,
  input: WindowsOwnedStart & { readonly guardianSlot: PreparedWindowsGuardianSlot; readonly inputBytes?: Uint8Array }):
  { readonly stdout: Buffer; readonly stderr: Buffer; readonly receipt: WindowsOwnedClosureReceipt } {
  const begun = performance.now(), state = backends.get(backend);
  if (!state?.guardian) throw new Error("Original guardian-capable backend required");
  input.signal?.throwIfAborted();
  const args = [...input.args], env = normalizeEnvironment(input.env);
  const { executable, cwd, timeoutMs, maxOutputBytes, cleanupTimeoutMs, normalExitPolicy, normalExitGraceMs } = input;
  if (!isAbsolute(executable) || !executable.toLowerCase().endsWith(".exe") || !isAbsolute(cwd)
    || args.length > 4096 || [executable, cwd, ...args].some(value => typeof value !== "string" || value.includes("\0"))
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 60000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 67108864
    || !Number.isInteger(normalExitGraceMs) || normalExitGraceMs < 0 || normalExitGraceMs > cleanupTimeoutMs
    || !["terminate-descendants", "require-empty"].includes(normalExitPolicy)) throw new Error("Invalid fixed observer input");
  if (input.inputBytes !== undefined && !(input.inputBytes instanceof Uint8Array)) throw new Error("Invalid fixed observer bytes");
  const inputBytes = Buffer.from(input.inputBytes ?? []);
  if (inputBytes.length > 16 * 1024 * 1024) throw new Error("Fixed observer input bound exceeded");
  validateBundle(state);
  const guardian = consumeWindowsGuardianSlot(backend, input.guardianSlot, cwd, "observer");
  if (!guardian) throw new Error("Original registered observer slot required");
  input.signal?.throwIfAborted();
  const remaining = Math.floor(timeoutMs - (performance.now() - begun));
  if (remaining < 1) throw new Error("Fixed observer deadline elapsed before launch");
  const token = randomUUID(), root = state.helperSystemRoot;
  const launch = JSON.stringify({ version: 1, kind: "launch", token, executable, args, cwd, env,
    timeoutMs: remaining, maxOutputBytes, cleanupTimeoutMs, normalExitPolicy, normalExitGraceMs,
    guardian, inputBase64: inputBytes.toString("base64") });
  if (Buffer.byteLength(launch) >= 24 * 1024 * 1024) throw new Error("Fixed observer launch bound exceeded");
  // Node's spawnSync normalizes detached and passes UV_PROCESS_DETACHED to libuv;
  // @types/node 24 omits that supported field from its synchronous options type.
  const options: SpawnSyncOptionsWithBufferEncoding & { readonly detached: boolean } = {
    cwd: state.directory, shell: false, windowsHide: true, detached: guardian !== undefined, input: `${launch}\n`,
    timeout: remaining + cleanupTimeoutMs + 5000, maxBuffer: Math.ceil(maxOutputBytes * 1.6) + 1024 * 1024,
    env: { SystemRoot: root, WINDIR: root, PATH: join(root, "System32") },
  };
  const child = (() => {
    try { return spawnSync(state.executable, ["--stdio-sync-v1"], options); }
    catch (cause) { throw markWindowsNativeFailure(new Error("Windows observer helper could not be spawned", { cause }), "native_spawn_failed",
      windowsNativeFailureDetail("guardian_observer_sync", null, undefined)); }
  })();
  let final: NativeClosure | undefined, protocolFailure = false;
  const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  let sequence = 0, ready = false, started = false, pid: number | null = null, creation: string | null = null, exit: number | null = null;
  let stdoutEof = false, stderrEof = false, bytes = 0;
  try {
    if (!Buffer.isBuffer(child.stdout) || !Buffer.isBuffer(child.stderr) || child.stderr.length > 65536) throw new Error("Invalid fixed observer output");
    const text = child.stdout.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("Incomplete fixed observer control frame");
    for (const line of text.slice(0, -1).split("\n")) {
      if (!line || Buffer.byteLength(line) > 65536 || final) throw new Error("Invalid fixed observer framing");
      const frame = JSON.parse(line) as { version?: unknown; sequence?: unknown; token?: unknown; kind?: unknown; payload?: unknown };
      if (frame.version !== 1 || frame.sequence !== sequence++ || !frame.payload || typeof frame.payload !== "object") throw new Error("Invalid fixed observer frame");
      const value = frame.payload as Record<string, unknown>;
      if (frame.kind === "ready") {
        if (ready || frame.sequence !== 0 || frame.token !== null || value.protocol !== "artoo.windows-job-process.v1" || value.atomicJobList !== true
          || !Array.isArray(value.capabilities) || !value.capabilities.includes("artoo.windows-runtime-guardian.v1")) throw new Error("Invalid observer capability");
        ready = true; continue;
      }
      if (!ready || frame.token !== token) throw new Error("Unbound fixed observer frame");
      if (frame.kind === "created") {
        if (pid !== null || exit !== null || !Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || (value.pid as number) > 0xffffffff
          || value.jobMember !== true || typeof value.creationTime !== "string" || !/^\d{1,20}$/.test(value.creationTime)) throw new Error("Invalid observer creation");
        pid = value.pid as number; creation = value.creationTime;
      } else if (frame.kind === "started") {
        if (started || exit !== null || pid === null || value.pid !== pid) throw new Error("Invalid observer start"); started = true;
      } else if (frame.kind === "root_exit") {
        if (exit !== null || !Number.isSafeInteger(value.code) || (value.code as number) < 0 || (value.code as number) > 0xffffffff) throw new Error("Invalid observer exit");
        exit = value.code as number;
      } else if (frame.kind === "output") {
        if ((value.stream !== "stdout" && value.stream !== "stderr") || typeof value.data !== "string" || value.data.length > 24000
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
          || (value.stream === "stdout" ? stdoutEof : stderrEof)) throw new Error("Invalid observer data");
        const data = Buffer.from(value.data, "base64"); bytes += data.length;
        if (bytes > maxOutputBytes) throw new Error("Fixed observer output bound exceeded"); output[value.stream].push(data);
      } else if (frame.kind === "pipe_eof") {
        if (value.stream === "stdout" && !stdoutEof) stdoutEof = true;
        else if (value.stream === "stderr" && !stderrEof) stderrEof = true;
        else throw new Error("Invalid observer EOF");
      } else if (frame.kind === "complete") {
        const value = nativeClosure(frame.payload);
        if (value.rootStarted !== started || value.rootPid !== pid || value.rootCreationTime !== creation || value.rootExitCode !== exit
          || value.stdoutEof !== stdoutEof || value.stderrEof !== stderrEof || value.outputBytesCaptured !== bytes || value.outputBytesObserved < bytes
          || value.rootCreated === value.noTargetCreated || (value.rootStarted && (!value.rootCreated || !value.atomicJobMember))
          || (value.rootCreated && (pid === null || !value.jobCreated || !value.stdoutCreated || !value.stderrCreated || !value.atomicJobMember))
          || (value.noTargetCreated && (pid !== null || value.rootWaitObserved || exit !== null || started || value.atomicJobMember || creation !== null))
          || (value.rootWaitObserved && !value.rootCreated) || (exit !== null && !value.rootWaitObserved)
          || (value.stdoutEof && !value.stdoutCreated) || (value.stderrEof && !value.stderrCreated) || (value.jobEmptyObserved && !value.jobCreated)
          || (value.cleanupConfirmed && (!(value.noTargetCreated || value.rootWaitObserved) || (value.stdoutCreated && !stdoutEof)
            || (value.stderrCreated && !stderrEof) || (value.jobCreated && !value.jobEmptyObserved)))) throw new Error("Inconsistent observer closure");
        final = value;
      } else throw new Error("Unknown observer frame");
    }
  } catch { protocolFailure = true; }
  const helperClosed = !child.error && Number.isSafeInteger(child.pid) && child.pid > 0 && child.status !== null && child.signal === null;
  const confirmed = helperClosed && child.status === 0 && !protocolFailure && !!final?.cleanupConfirmed;
  const receipt: WindowsOwnedClosureReceipt = Object.freeze({ version: 1, token, elapsedMs: performance.now() - begun,
    rootCreated: final?.rootCreated ?? pid !== null, rootStarted: final?.rootStarted ?? started, rootPid: final?.rootPid ?? pid,
    rootCreationTime: final?.rootCreationTime ?? creation, atomicJobMember: final?.atomicJobMember ?? false,
    rootWaitObserved: final?.rootWaitObserved ?? false, rootExitCode: final?.rootExitCode ?? exit,
    stdoutEof: final?.stdoutEof ?? stdoutEof, stderrEof: final?.stderrEof ?? stderrEof, jobEmptyObserved: final?.jobEmptyObserved ?? false,
    noTargetCreated: final?.noTargetCreated ?? false, terminationReason: protocolFailure ? "control_protocol" : final?.terminationReason ?? null,
    nativeTerminationReason: final?.terminationReason ?? null, failureCode: protocolFailure ? "control_protocol" : final?.failureCode ?? null,
    nativeError: final?.nativeError ?? null, outputBytesObserved: final?.outputBytesObserved ?? bytes, outputBytesCaptured: final?.outputBytesCaptured ?? bytes,
    helperSpawnObserved: Number.isSafeInteger(child.pid) && child.pid > 0, helperExitObserved: helperClosed, helperCloseObserved: helperClosed,
    helperExitCode: child.status, helperSignal: child.signal, cleanupConfirmed: confirmed });
  receipts.add(receipt);
  if (!confirmed) throw markWindowsNativeFailure(new WindowsOwnedCleanupError(receipt), synchronousNativeFailure(child, protocolFailure),
    windowsNativeFailureDetail("guardian_observer_sync", child.status, child.stderr, receipt));
  return Object.freeze({ stdout: Buffer.concat(output.stdout), stderr: Buffer.concat(output.stderr), receipt });
}
