// Controlled original Windows owner facts only: no native host, filesystem admission,
// application runtime or product qualification is exercised by this suite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import type { ApplicationInstallationPlan } from "./application-installation.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import type { PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import type { OriginalTargetInputReceipt, PreparedWindowsProcessBackend, WindowsOwnedClosureReceipt } from "./owned/windows-owned-process.js";

const mocked = vi.hoisted(() => ({ start: vi.fn(), isReceipt: vi.fn(), isInputReceipt: vi.fn(), scope: vi.fn(), reserve: vi.fn(),
  realpath: vi.fn(), createOwner: vi.fn(), auditInstallation: vi.fn(), readProfile: vi.fn(), readCandidate: vi.fn(), describeBackend: vi.fn(), readPin: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("Direct ChildProcess launch is forbidden"); } }));
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>(); return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock("./owned/windows-owned-process.js", () => ({ startWindowsOwnedProcess: mocked.start,
  isWindowsOwnedClosureReceipt: mocked.isReceipt, isWindowsOwnedTargetInputReceipt: mocked.isInputReceipt }));
vi.mock("./owned/windows-guardian-scope.js", () => ({ readWindowsGuardianOperation: mocked.scope, WINDOWS_GUARDIAN_JOB_BOUNDARY: "atomic-job-subtree.v1" }));
vi.mock("./owned/windows-runtime-guardian.js", () => ({ reserveWindowsGuardianSlot: mocked.reserve }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(),
  realpathSync: Object.assign(vi.fn(), { native: mocked.realpath }) }));
vi.mock("./application-installation.js", () => ({ createApplicationInstallationOwner: mocked.createOwner, auditApplicationInstallation: mocked.auditInstallation }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: mocked.readProfile }));
vi.mock("./application-verification-candidate.js", () => ({ readApplicationVerificationCandidate: mocked.readCandidate }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: mocked.describeBackend }));
vi.mock("./application-runtime-installation.js", () => ({ readApplicationRuntimePin: mocked.readPin }));
import { initializeApplicationVerificationStore, readApplicationVerificationStore, startApplicationVerificationService,
  type InitializedApplicationVerificationStore } from "./application-verification-bootstrap-process.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const pin = (path: string): ApplicationRuntimeFilePin => ({ path, bytes: 18, sha256: sha("controlled fixture") });
// Windows path semantics and local admission are controlled. The actual strict
// status and file-pin schemas remain active on every host running this suite.
const root = "C:\\controlled", systemRoot = win32.join(root, "Windows"), nodeId = "controlled-node";
const storeId = "11111111-1111-4111-8111-111111111111";
const profile = Object.freeze({}) as PreparedApplicationVerificationProfile;
const candidate = Object.freeze({}) as PreparedApplicationVerificationCandidate;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
const configured = {
  config: { node: pin(win32.join(root, "toolchain", "node.exe")), hostManifest: pin(win32.join(root, "host", "application-service-host-manifest.json")),
    installation_parent: win32.join(root, "installations"), selection_parent: win32.join(root, "selections"), origin: "http://127.0.0.1:31000" },
  roots: [win32.join(root, "workspace")], hostEntry: pin(win32.join(root, "host", "application-service-bootstrap.mjs")),
};
const native = { directory: win32.join(root, "native"), manifestSha256: sha("controlled backend") };
const candidateRecord = { manifest: pin(win32.join(root, "candidate", "candidate.json")) };
const reference = pin(win32.join(configured.config.installation_parent, storeId, "control", "REOPEN.v1.json"));
const initialized = () => ({ version: 1, kind: "application-service.initialized", reference, qualified_for_product: false,
  closure: { version: 1, scope: "original-native-owners", create_broker_normal: true, installation_audited: true, session_released: true } });
const listening = () => ({ version: 1, kind: "application-service.listening", origin: configured.config.origin,
  qualified_for_product: false, maximum_requests: 256, maximum_concurrent: 1 });
const closed = (invocations = 2) => ({ version: 1, kind: "application-service.closed", started: true, reason: "stdin", qualified_for_product: false,
  closure: { version: 1, scope: "original-native-owners", invocations, runtime_normal_closures: invocations,
    broker_normal_closures: invocations, listener_closed: true, preflight_normal: true, installation_audited: true, session_released: true } });

let originalReceipts = new WeakSet<object>(), originalInputReceipts = new WeakSet<object>();
interface Completion {
  omit?: "exit" | "stdout" | "stderr";
  exitCode?: number | null; closeCode?: number | null;
  exitSignal?: NodeJS.Signals | null; closeSignal?: NodeJS.Signals | null;
}
class OriginalChild extends EventEmitter {
  readonly pid = 12345;
  readonly token = `00000000-0000-4000-8000-${String(children.length + 1).padStart(12, "0")}`;
  readonly creationTime = "133806600000000000";
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly cancel = vi.fn(() => {});
  readonly started: Promise<{ pid: number; creationTime: string }>;
  readonly closed: Promise<WindowsOwnedClosureReceipt>;
  private resolveStarted!: (value: { pid: number; creationTime: string }) => void;
  private rejectStarted!: (error: unknown) => void;
  private resolveClosed!: (value: WindowsOwnedClosureReceipt) => void;
  private rejectClosed!: (error: unknown) => void;
  private resolveInput?: (value: OriginalTargetInputReceipt) => void;
  private rejectInput?: (error: unknown) => void;
  private inputBytes?: Buffer;
  private inputAcknowledged = false;
  private rootStarted = false;
  private rootExited = false;
  private rootCode: number | null = null;
  private rootSignal: NodeJS.Signals | null = null;
  receiptChanges: Partial<WindowsOwnedClosureReceipt> = {};
  originalReceipt = true;
  isClosed = false;
  constructor(deferStarted = false) {
    super();
    this.started = new Promise((resolve, reject) => { this.resolveStarted = resolve; this.rejectStarted = reject; });
    this.closed = new Promise((resolve, reject) => { this.resolveClosed = resolve; this.rejectClosed = reject; });
    void this.started.catch(() => {}); void this.closed.catch(() => {});
    if (!deferStarted) this.start();
  }
  start() { this.rootStarted = true; this.resolveStarted({ pid: this.pid, creationTime: this.creationTime }); }
  failStartup(error: unknown) { this.rejectStarted(error); }
  readonly endInput = vi.fn((bytes: Uint8Array) => {
    if (this.inputBytes) return Promise.reject(Error("Controlled input was already requested"));
    this.inputBytes = Buffer.from(bytes);
    return new Promise<OriginalTargetInputReceipt>((resolve, reject) => { this.resolveInput = resolve; this.rejectInput = reject; });
  });
  acknowledge(changes: Partial<OriginalTargetInputReceipt> = {}, original = true) {
    if (!this.inputBytes || !this.resolveInput) throw Error("No controlled input request");
    const receipt = Object.freeze({ version: 1 as const, token: this.token, requestId: this.token,
      bytesWritten: this.inputBytes.length, sha256: sha(this.inputBytes), inputClosed: true as const, ...changes });
    this.inputAcknowledged = true; if (original) originalInputReceipts.add(receipt); this.resolveInput(receipt);
  }
  failInput(error: unknown) { this.rejectInput?.(error); }
  failClosure(error: unknown) {
    if (this.isClosed) return; this.isClosed = true; this.rejectStarted(error); this.rejectInput?.(error);
    this.stdout.end(); this.stderr.end(); this.rejectClosed(error);
  }
  send(event: unknown) { this.output(Buffer.from(JSON.stringify(event) + "\n")); }
  output(bytes: Buffer) { this.stdout.write(bytes); }
  exit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.rootExited = true; this.rootCode = code; this.rootSignal = signal; this.emit("exit", code, signal);
  }
  close(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    if (this.isClosed) return; this.isClosed = true;
    const receipt: WindowsOwnedClosureReceipt = Object.freeze({ version: 1, token: this.token, elapsedMs: 1,
      rootCreated: true, rootStarted: this.rootStarted, rootPid: this.pid, rootCreationTime: this.creationTime, atomicJobMember: true,
      rootWaitObserved: this.rootExited, rootExitCode: this.rootCode, stdoutEof: this.stdout.writableEnded, stderrEof: this.stderr.writableEnded,
      jobEmptyObserved: true, noTargetCreated: false, terminationReason: this.rootSignal ? "controlled_signal" : null,
      nativeTerminationReason: this.rootSignal ? "controlled_signal" : null, failureCode: null, nativeError: null,
      outputBytesObserved: 0, outputBytesCaptured: 0, helperSpawnObserved: true, helperExitObserved: this.rootExited,
      helperCloseObserved: true, helperExitCode: code, helperSignal: signal, cleanupConfirmed: true,
      targetInput: Object.freeze({ version: 1, pipeCreated: true, writeRequested: !!this.inputBytes, requestId: this.inputBytes ? this.token : null,
        bytesWritten: this.inputAcknowledged ? this.inputBytes!.length : 0, inputClosed: true }), ...this.receiptChanges });
    if (!this.rootStarted) this.rejectStarted(Error("Controlled native root did not start"));
    if (this.inputBytes && !this.inputAcknowledged) this.rejectInput?.(Error("Controlled owner completed without ACK"));
    // The facade ends its streams even when the independent native EOF fact is
    // false, exactly as the production bridge does on failed settlement.
    this.stdout.end(); this.stderr.end();
    if (this.originalReceipt) originalReceipts.add(receipt); this.resolveClosed(receipt); this.emit("close", code, signal);
  }
  complete({ omit, exitCode = 0, closeCode = 0, exitSignal = null, closeSignal = null }: Completion = {}) {
    if (this.isClosed) return;
    if (omit !== "exit") this.exit(exitCode, exitSignal);
    if (omit !== "stdout") this.stdout.end();
    if (omit !== "stderr") this.stderr.end();
    this.close(closeCode, closeSignal);
  }
}
const children: OriginalChild[] = [], work: Promise<unknown>[] = [];
const selections: { generationId: string; directory: string; installation: object; plan?: ApplicationInstallationPlan }[] = [];
function observe<T>(promise: Promise<T>) {
  const observation = { promise, settled: false };
  work.push(promise);
  void promise.then(() => { observation.settled = true; }, () => { observation.settled = true; });
  return observation;
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function causeTree(value: unknown, seen = new Set<unknown>()): unknown[] {
  if (seen.has(value)) return []; seen.add(value);
  return [value, ...(value instanceof AggregateError ? value.errors.flatMap(error => causeTree(error, seen)) : []),
    ...(value instanceof Error && value.cause !== undefined ? causeTree(value.cause, seen) : [])];
}
function begin(deadline = performance.now() + 60_000, controller = new AbortController()) {
  const result = observe(initializeApplicationVerificationStore(profile, candidate, nodeId, backend, deadline, controller.signal));
  return { ...result, child: children.at(-1)!, controller, observation: result };
}
async function initializedStore() {
  const init = begin(); init.child.send(initialized()); init.child.complete(); return init.promise;
}
async function runningService() {
  const token = await initializedStore(), controller = new AbortController();
  const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, controller.signal));
  const child = children.at(-1)!; child.send(listening());
  const service = await startup.promise;
  return { token, child, controller, service, closure: observe(service.closed) };
}
function selection(index: number) {
  const record = selections[index]!, member = record.plan!.files.find(file => file.path === "selection.json")!;
  if (!("content" in member)) throw Error("Controlled selection content missing");
  const bytes = Buffer.from(member.content);
  expect(member.bytes).toBe(bytes.length); expect(member.sha256).toBe(sha(bytes));
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(process, "kill").mockImplementation(() => { throw Error("PID cleanup is forbidden in this controlled suite"); });
  for (const mock of Object.values(mocked)) mock.mockReset();
  originalReceipts = new WeakSet(); originalInputReceipts = new WeakSet();
  mocked.isReceipt.mockImplementation(value => originalReceipts.has(value));
  mocked.isInputReceipt.mockImplementation(value => originalInputReceipts.has(value));
  mocked.realpath.mockReturnValue(systemRoot);
  mocked.readProfile.mockImplementation(value => { expect(value).toBe(profile); return configured; });
  mocked.readCandidate.mockImplementation(value => { expect(value).toBe(candidate); return candidateRecord; });
  mocked.describeBackend.mockImplementation(value => { expect(value).toBe(backend); return native; });
  mocked.readPin.mockReturnValue(Buffer.from("controlled fixture"));
  mocked.createOwner.mockImplementation(() => {
    const generationId = `22222222-2222-4222-8222-${String(selections.length + 1).padStart(12, "0")}`;
    const record = { generationId, directory: win32.join(configured.config.selection_parent, generationId),
      installation: Object.freeze({}), plan: undefined as ApplicationInstallationPlan | undefined };
    selections.push(record);
    return { generationId, directory: record.directory,
      install: (plan: ApplicationInstallationPlan) => { record.plan = plan; return record.installation; },
      describeAttempt: () => ({ phase: "claimed" }), abandon: vi.fn() };
  });
  mocked.auditInstallation.mockImplementation(value => { expect(selections.some(record => record.installation === value)).toBe(true); });
  mocked.start.mockImplementation(() => { const child = new OriginalChild(); children.push(child); return child; });
});
afterEach(async () => {
  for (const child of children) child.complete({ exitCode: 1, closeCode: 1 });
  await Promise.allSettled(work);
  children.length = 0; selections.length = 0; work.length = 0;
  vi.clearAllTimers(); vi.useRealTimers();
  try { expect(process.kill).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); }
});

describe("application verification bootstrap original controlled process", () => {
  it("uses the protected selection and fixed host without sending initialization EOF or shutdown", async () => {
    const init = begin(), record = selections[0]!;
    expect(mocked.createOwner).toHaveBeenCalledWith({ parent: configured.config.selection_parent, nodeId,
      allowedRoots: configured.roots, node: configured.config.node, backend, signal: init.controller.signal });
    expect(selection(0)).toEqual({ version: 1, node_id: nodeId, writable_workspace_roots: configured.roots, node: configured.config.node,
      host_manifest: configured.config.hostManifest, backend: { directory: native.directory, manifest_sha256: native.manifestSha256 },
      system_root: systemRoot, shutdown: "stdin", format: "artoo.application-initialize-selection.v1",
      installation_parent: configured.config.installation_parent, source_manifest: candidateRecord.manifest });
    expect(mocked.start).toHaveBeenCalledWith(backend, {
      executable: configured.config.node.path, args: [configured.hostEntry.path, `--selection=${win32.join(record.directory, "selection.json")}`],
      cwd: win32.dirname(configured.hostEntry.path), timeoutMs: expect.any(Number), cleanupTimeoutMs: 5000,
      maxOutputBytes: 12_288, normalExitPolicy: "require-empty", normalExitGraceMs: 250,
      targetInput: { version: 1, mode: "single-message-eof", maximumBytes: 4096 }, signal: expect.any(AbortSignal),
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: win32.join(systemRoot, "System32") } });
    expect(init.child.endInput).not.toHaveBeenCalled();
    init.child.send(initialized()); await tick(); expect(init.observation.settled).toBe(false);
    expect(init.child.endInput).not.toHaveBeenCalled();
    init.child.exit(); init.child.stdout.end(); init.child.stderr.end(); await tick();
    expect(init.observation.settled).toBe(false);
    init.child.close(); const token = await init.promise;
    expect(readApplicationVerificationStore(token)).toEqual({ testStoreId: storeId });
    expect(mocked.readPin).toHaveBeenCalledWith(reference);
    expect(init.child.endInput).not.toHaveBeenCalled(); expect(init.child.cancel).not.toHaveBeenCalled();
    expect(() => readApplicationVerificationStore({ ...token })).toThrow("Original initialized application store required");
  });

  it.each(["exit", "stdout", "stderr"] as const)("requires the original %s even with a valid marker and close code 0", async omit => {
    const init = begin(); init.child.send(initialized()); init.child.complete({ omit });
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("cannot replace original owner closure with root exit or a separate wrapper cleanup timer", async () => {
    const init = begin(); init.child.send(initialized()); init.child.exit(); init.child.stdout.end(); init.child.stderr.end();
    await tick(); expect(init.observation.settled).toBe(false);
    init.controller.abort(); expect(init.child.cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(init.observation.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(init.observation.settled).toBe(false);
    const cleanup = Error("controlled original native cleanup remained unconfirmed"); init.child.failClosure(cleanup);
    await expect(init.promise).rejects.toThrow("Original application bootstrap closure is unconfirmed");
  });

  it.each([
    { name: "exit code", exitCode: 1 }, { name: "close code", closeCode: 1 },
    { name: "unknown exit code", exitCode: null }, { name: "unknown close code", closeCode: null },
    { name: "exit signal", exitSignal: "SIGTERM" as const }, { name: "close signal", closeSignal: "SIGTERM" as const },
  ])("rejects abnormal $name despite a valid internal closure report", async ({ name: _name, ...completion }) => {
    const init = begin(); init.child.send(initialized()); init.child.complete(completion);
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not accept an initialization marker plus CLI exit 0 without the internal owner report", async () => {
    const init = begin(), { closure: _closure, ...marker } = initialized();
    init.child.send(marker); init.child.complete();
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError); expect(init.child.cancel).toHaveBeenCalledOnce();
  });

  it.each(["create_broker_normal", "installation_audited", "session_released"])("requires initialization closure field %s", async field => {
    const init = begin(), marker = initialized();
    init.child.send({ ...marker, closure: { ...marker.closure, [field]: false } }); init.child.complete();
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not credit another original child, even with the same PID, to a pending owner", async () => {
    const first = begin(), replacement = begin(); first.child.send(initialized());
    expect(first.child.pid).toBe(replacement.child.pid);
    replacement.child.send(initialized()); replacement.child.complete(); await replacement.promise;
    expect(first.observation.settled).toBe(false);
    // The second owner's EOF and exit cannot fill the first owner's missing ones.
    first.child.close(); await expect(first.promise).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(mocked.start).toHaveBeenCalledTimes(2);
  });

  it.each(["synchronous-error", "throw"])("attempts native cancellation once when original cancel produces %s", async mode => {
    const init = begin(); init.child.send(initialized());
    init.child.cancel.mockImplementation(() => {
      if (mode === "throw") throw Error("controlled kill throw");
      init.child.emit("error", Error("controlled synchronous kill error")); return true;
    });
    expect(() => init.child.stderr.emit("data", Buffer.from("failure"))).not.toThrow();
    init.child.stdout.emit("error", Error("second transport failure"));
    expect(init.child.cancel).toHaveBeenCalledOnce(); await tick(); expect(init.observation.settled).toBe(false);
    init.child.complete(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["duplicate", "json", "utf8", "line-bound", "total-bound", "partial-tail", "stderr"])("rejects %s output despite normal original exit", async fault => {
    const init = begin();
    if (fault === "json") init.child.output(Buffer.from("{\n"));
    else if (fault === "utf8") init.child.output(Buffer.from([0xff, 10]));
    else if (fault === "line-bound") init.child.output(Buffer.alloc(4096, 32));
    else if (fault === "total-bound") init.child.output(Buffer.alloc(12_289, 32));
    else {
      init.child.send(initialized());
      if (fault === "duplicate") init.child.send(initialized());
      if (fault === "partial-tail") init.child.output(Buffer.from("{"));
      if (fault === "stderr") init.child.stderr.emit("data", Buffer.from("diagnostic"));
    }
    init.child.complete(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["readProfile", "readCandidate", "auditInstallation", "readPin"] as const)("reaudits %s after the original host closes", async boundary => {
    const init = begin(); init.child.send(initialized()); const failure = Error(`controlled changed ${boundary}`);
    mocked[boundary].mockImplementation(() => { throw failure; });
    init.child.complete(); await expect(init.promise).rejects.toBe(failure);
  });

  it.each(["parent", "generation", "control", "filename"])("rejects an initialized reference with a different %s", async field => {
    const init = begin();
    const paths = { parent: win32.join(root, "other", storeId, "control", "REOPEN.v1.json"),
      generation: win32.join(configured.config.installation_parent, "not-a-guid", "control", "REOPEN.v1.json"),
      control: win32.join(configured.config.installation_parent, storeId, "other", "REOPEN.v1.json"),
      filename: win32.join(configured.config.installation_parent, storeId, "control", "other.json") };
    init.child.send({ ...initialized(), reference: pin(paths[field as keyof typeof paths]) }); init.child.complete();
    await expect(init.promise).rejects.toThrow("escaped its selected store");
  });

  it("reads the final store pin before issuing its opaque token", async () => {
    const init = begin(), failure = Error("controlled store pin changed"); init.child.send(initialized());
    mocked.readPin.mockImplementation((file: ApplicationRuntimeFilePin) => {
      if (file.path === reference.path) throw failure; return Buffer.from("controlled fixture");
    });
    init.child.complete(); await expect(init.promise).rejects.toBe(failure);
  });

  it("rejects cancellation and elapsed deadlines before spawn", async () => {
    const controller = new AbortController(), failure = Error("already aborted"); controller.abort(failure);
    await expect(begin(undefined, controller).promise).rejects.toBe(failure);
    await expect(begin(performance.now() - 1).promise).rejects.toThrow("before spawn");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it("does not qualify closure when its final synchronous audit crosses the deadline", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const init = begin(200); init.child.send(initialized());
    mocked.readCandidate.mockImplementation(() => { now = 200; return candidateRecord; });
    init.child.complete(); await expect(init.promise).rejects.toThrow("deadline elapsed");
  });

  it("sends exactly one fixed shutdown, requires the original input ACK, and reads counts only after closure", async () => {
    const { child, service, closure } = await runningService();
    expect(selection(1)).toMatchObject({ format: "artoo.application-service-selection.v1", installation_reference: reference, shutdown: "stdin" });
    expect(selection(1)).not.toHaveProperty("source_manifest");
    expect(child.endInput).not.toHaveBeenCalled(); expect(() => service.invocations()).toThrow("not normally closed");
    const first = service.close(), second = service.close(); expect(first).toBe(second); expect(first).toBe(service.closed);
    expect(child.endInput).toHaveBeenCalledExactlyOnceWith(Buffer.from('{"version":1,"kind":"shutdown"}\n'));
    child.acknowledge(); child.send(closed()); child.exit(); child.stdout.end(); child.stderr.end(); await tick();
    expect(closure.settled).toBe(false); expect(() => service.invocations()).toThrow("not normally closed");
    child.close(); await first; expect(service.invocations()).toBe(2); expect(child.cancel).not.toHaveBeenCalled();
  });

  it.each(["input-ack", "internal-report"])("requires service %s despite fixed shutdown and exit code 0", async missing => {
    const { child, service } = await runningService(); void service.close();
    if (missing !== "input-ack") child.acknowledge();
    if (missing !== "internal-report") child.send(closed());
    child.complete(); await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(() => service.invocations()).toThrow("not normally closed");
  });

  it.each(["runtime_normal_closures", "broker_normal_closures"])("requires %s to equal the invocation count", async field => {
    const { child, service } = await runningService(), report = closed(); void service.close(); child.acknowledge();
    child.send({ ...report, closure: { ...report.closure, [field]: report.closure.invocations - 1 } }); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each(["listener_closed", "preflight_normal", "installation_audited", "session_released"])("requires service closure field %s", async field => {
    const { child, service } = await runningService(), report = closed(); void service.close(); child.acknowledge();
    child.send({ ...report, closure: { ...report.closure, [field]: false } }); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each([0, 256])("accepts %i invocations only with equal internal normal closure counts", async count => {
    const { child, service } = await runningService(); void service.close(); child.acknowledge(); child.send(closed(count)); child.complete();
    await service.closed; expect(service.invocations()).toBe(count);
  });

  it.each(["unsolicited-close", "duplicate-listening", "wrong-reason", "not-started", "over-budget"])("rejects service %s", async fault => {
    const { child, service } = await runningService();
    if (fault === "unsolicited-close") child.send(closed());
    else if (fault === "duplicate-listening") child.send(listening());
    else {
      void service.close(); child.acknowledge();
      child.send(fault === "wrong-reason" ? { ...closed(), reason: "budget-exhausted" }
        : fault === "not-started" ? { ...closed(), started: false } : closed(257));
    }
    child.complete(); await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("joins the original failed startup before rejecting a wrong listening origin", async () => {
    const token = await initializedStore();
    const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, new AbortController().signal));
    const child = children.at(-1)!; child.send({ ...listening(), origin: "http://127.0.0.1:31001" });
    await tick(); expect(startup.settled).toBe(false); expect(child.cancel).toHaveBeenCalledOnce();
    child.complete(); await expect(startup.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("does not turn cancellation after readiness into a normal closure", async () => {
    const { child, service, controller, closure } = await runningService(); controller.abort();
    expect(child.cancel).toHaveBeenCalledOnce(); await tick(); expect(closure.settled).toBe(false);
    void service.close(); expect(child.endInput).not.toHaveBeenCalled(); child.send(closed()); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("rejects a fabricated initialized store before spawning any service", async () => {
    await expect(startApplicationVerificationService({} as InitializedApplicationVerificationStore,
      performance.now() + 60_000, new AbortController().signal)).rejects.toThrow("Original initialized application store required");
    expect(mocked.start).not.toHaveBeenCalled();
  });

  it.each(["atomicJobMember", "rootWaitObserved", "jobEmptyObserved", "helperSpawnObserved", "helperExitObserved", "helperCloseObserved", "cleanupConfirmed"] as const)
    ("requires original native %s independently of a successful internal summary", async field => {
      const init = begin(); init.child.receiptChanges = { [field]: false }; init.child.send(initialized()); init.child.complete();
      await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
    });

  it.each([
    { terminationReason: "cancelled" }, { nativeTerminationReason: "lingering_processes" }, { failureCode: "input_close_failed" },
    { nativeError: 5 }, { rootPid: 999 }, { rootCreationTime: "133806600000000001" },
  ])("rejects nonnormal or rebound native facts: %j", async changes => {
    const init = begin(); init.child.receiptChanges = changes; init.child.send(initialized()); init.child.complete();
    const caught = await init.promise.then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(VerificationCleanupError);
    expect(caught.cause.errors).toContainEqual(expect.objectContaining({ token: init.child.token, ...changes }));
  });

  it("rejects a copied native closure receipt", async () => {
    const init = begin(); init.child.originalReceipt = false; init.child.send(initialized()); init.child.complete();
    await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it.each([undefined,
    { version: 1, pipeCreated: true, writeRequested: false, requestId: null, bytesWritten: 0, inputClosed: false },
    { version: 1, pipeCreated: false, writeRequested: false, requestId: null, bytesWritten: 0, inputClosed: true },
    { version: 1, pipeCreated: true, writeRequested: true, requestId: "unexpected", bytesWritten: 1, inputClosed: true },
  ])("requires a naturally closed idle input writer during initialization: %j", async inputFact => {
    const init = begin(); init.child.receiptChanges = { targetInput: inputFact as WindowsOwnedClosureReceipt["targetInput"] };
    init.child.send(initialized()); init.child.complete(); await expect(init.promise).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(init.child.endInput).not.toHaveBeenCalled();
  });

  it.each([{ token: "other-owner" }, { requestId: "other-input" }, { bytesWritten: 1 }, { sha256: sha("other-input") }])
    ("requires the original shutdown ACK binding: %j", async changes => {
      const { child, service } = await runningService(); void service.close(); child.acknowledge(changes); child.send(closed()); child.complete();
      await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
    });

  it("rejects a copied shutdown ACK even when its fields match", async () => {
    const { child, service } = await runningService(); void service.close(); child.acknowledge({}, false); child.send(closed()); child.complete();
    await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
  });

  it("waits for original started even if listening was received first", async () => {
    const token = await initializedStore();
    mocked.start.mockImplementationOnce(() => { const child = new OriginalChild(true); children.push(child); return child; });
    const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, new AbortController().signal));
    const child = children.at(-1)!; child.send(listening()); await tick(); expect(startup.settled).toBe(false);
    child.start(); const service = await startup.promise; void service.close(); child.acknowledge(); child.send(closed()); child.complete(); await service.closed;
  });

  it("joins startup failure to the original owner closure and retains both errors", async () => {
    const token = await initializedStore();
    mocked.start.mockImplementationOnce(() => { const child = new OriginalChild(true); children.push(child); return child; });
    const startup = observe(startApplicationVerificationService(token, performance.now() + 60_000, new AbortController().signal));
    const child = children.at(-1)!, first = Error("controlled native startup failure"), cleanup = Error("controlled native closure failure");
    child.failStartup(first); await tick(); expect(startup.settled).toBe(false); expect(child.cancel).toHaveBeenCalledOnce();
    child.failClosure(cleanup); const caught = await startup.promise.then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(VerificationCleanupError); expect(causeTree(caught)).toContain(first);
    expect(causeTree(caught)).toContain(cleanup);
  });

  it("retains synchronous setup and cancellation errors after joining the original owner", async () => {
    const setup = Error("controlled listener setup failure"), cancel = Error("controlled original cancellation failure");
    mocked.start.mockImplementationOnce(() => {
      const child = new OriginalChild(); children.push(child);
      vi.spyOn(child.stdout, "on").mockImplementation(() => { throw setup; });
      child.cancel.mockImplementation(() => { throw cancel; }); return child;
    });
    const init = begin(); await tick(); expect(init.observation.settled).toBe(false); expect(init.child.cancel).toHaveBeenCalledOnce();
    init.child.complete(); const caught = await init.promise.then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(VerificationCleanupError); expect(causeTree(caught)).toContain(setup); expect(causeTree(caught)).toContain(cancel);
    expect(causeTree(caught)).toContainEqual(expect.objectContaining({ token: init.child.token, rootExitCode: 0 }));
  });

  it("retains a failed shutdown ACK and the original native termination facts", async () => {
    const { child, service } = await runningService(), ackError = Error("controlled native input close failed");
    void service.close(); child.failInput(ackError); await tick();
    child.receiptChanges = { terminationReason: "input_close_failed", nativeTerminationReason: "input_close_failed" };
    child.complete(); const caught = await service.closed.then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(VerificationCleanupError); expect(causeTree(caught)).toContain(ackError);
    expect(causeTree(caught)).toContainEqual(expect.objectContaining({ token: child.token, terminationReason: "input_close_failed" }));
  });

  it("does not grant normal completion when cancellation is followed by a genuine late input ACK", async () => {
    const { child, service, controller } = await runningService(); void service.close(); controller.abort(Error("cancel after shutdown write"));
    child.acknowledge(); child.send(closed()); child.complete(); await expect(service.closed).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(child.cancel).toHaveBeenCalledOnce();
  });

  it("accepts native close before the stream end callbacks have drained", async () => {
    const init = begin(); init.child.send(initialized()); init.child.exit(); init.child.stdout.end(); init.child.stderr.end(); init.child.close();
    expect(init.observation.settled).toBe(false); await init.promise; expect(init.child.cancel).not.toHaveBeenCalled();
  });

  it("counts the first profile audit against the original deadline", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    mocked.readProfile.mockImplementation(() => { now = 200; return configured; });
    await expect(begin(200).promise).rejects.toThrow("deadline elapsed"); expect(mocked.start).not.toHaveBeenCalled();
  });

  it("checks the final returned store pin audit against the same deadline", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const init = begin(200); init.child.send(initialized());
    mocked.readPin.mockImplementation((value: ApplicationRuntimeFilePin) => { if (value.path === reference.path) now = 200; return Buffer.from("controlled fixture"); });
    init.child.complete(); await expect(init.promise).rejects.toThrow("deadline elapsed after store audit");
  });

  it("reserves the original scope and recomputes native timeout after reservation", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    const scope = { guardian: Object.freeze({}), workspaceRoot: configured.roots[0], operationId: "original-operation",
      bindingDigest: sha("operation"), serverOperation: null }, slot = Object.freeze({});
    mocked.scope.mockReturnValue(scope); mocked.reserve.mockImplementation(async () => { now = 400; return slot; });
    const init = begin(1000); expect(mocked.start).not.toHaveBeenCalled(); await tick();
    const child = children.at(-1)!, launch = mocked.start.mock.calls[0]![1];
    expect(launch).toMatchObject({ cwd: scope.workspaceRoot, timeoutMs: 600, guardianSlot: slot, normalExitPolicy: "require-empty" });
    const { timeoutMs: _timeout, signal: _signal, guardianSlot: _slot, ...boundLaunch } = launch;
    const record = selections[0]!, member = record.plan!.files.find(file => file.path === "selection.json")!;
    expect(mocked.reserve).toHaveBeenCalledExactlyOnceWith(scope.guardian, { operationKind: "verifier", operationId: scope.operationId,
      bindingDigest: sha(Buffer.from(JSON.stringify({ version: 1, format: "artoo.application-bootstrap-launch.v1", boundary: "atomic-job-subtree.v1",
        operation: scope.bindingDigest, selection: { path: win32.join(record.directory, "selection.json"), bytes: member.bytes, sha256: member.sha256 },
        deadline: 1000, launch: boundLaunch }))), serverOperation: null });
    child.send(initialized()); child.complete(); await init.promise;
  });

  it("cannot launch with an unconsumed slot returned after the original deadline", async () => {
    let now = 100; vi.spyOn(performance, "now").mockImplementation(() => now);
    mocked.scope.mockReturnValue({ guardian: {}, workspaceRoot: configured.roots[0], operationId: "original-operation", bindingDigest: sha("operation"), serverOperation: null });
    mocked.reserve.mockImplementation(async () => { now = 200; return Object.freeze({}); });
    await expect(begin(200).promise).rejects.toThrow("deadline elapsed");
    expect(mocked.start).not.toHaveBeenCalled(); expect(mocked.isReceipt).not.toHaveBeenCalled();
  });

  it("preserves reservation failure and cancellation without fabricating process closure", async () => {
    const controller = new AbortController(), cancellation = Error("cancelled while reserving"), reservation = Error("original reservation failed");
    mocked.scope.mockReturnValue({ guardian: {}, workspaceRoot: configured.roots[0], operationId: "original-operation", bindingDigest: sha("operation"), serverOperation: null });
    mocked.reserve.mockImplementation(async () => { controller.abort(cancellation); throw reservation; });
    const init = begin(undefined, controller), caught = await init.promise.then(() => undefined, error => error);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors).toEqual([cancellation, reservation]);
    expect(mocked.start).not.toHaveBeenCalled(); expect(mocked.isReceipt).not.toHaveBeenCalled();
  });
});
