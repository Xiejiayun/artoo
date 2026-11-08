// Controlled protocol regression only: spawn, filesystem, Windows paths and native
// lifecycle events are simulated. No Win32 process or Job is created by this suite.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productSourceRecoveryRegistrationDigestV1 } from "@artoo/domain";
import type { PreparedWindowsReleaseStorage } from "../windows-release-storage.js";
import type { PreparedWindowsDaemonSupervisorAuthority } from "../windows-supervisor-authority.js";

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(),
  files: new Map<string, Buffer>(),
  directories: new Set<string>(),
  bundle: "C:\\artoo-controlled-helper",
  systemRoot: "C:\\Windows",
}));

vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
// Only the OS/storage boundary is controlled. Guardian preparation, registration,
// reservation and the bridge's one-use slot consumption below are real code.
vi.mock("../windows-supervisor-authority.js", () => ({ readWindowsDaemonSupervisorAuthority: () => ({ launchIdentityDigest: "sha256:" + "1".repeat(64) }) }));
vi.mock("../windows-release-storage.js", () => ({ auditWindowsReleaseStorage: vi.fn(), assertWindowsReleaseStorage: vi.fn(), assertWindowsReleaseStorageWorkspace: vi.fn() }));
vi.mock("../windows-local-acl.js", () => ({ physicalWindowsDirectory: (path: string) => path,
  windowsPathsOverlap: (left: string, right: string) => left === right }));
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    const directory = mocked.directories.has(path), bytes = mocked.files.get(path);
    if (!directory && !bytes) throw new Error("Controlled filesystem path not found");
    return { isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
      nlink: 1, ino: directory ? 1 : 2, dev: 1, size: bytes?.length ?? 0, mtimeMs: 1 };
  },
  readFileSync: (path: string) => {
    const bytes = mocked.files.get(path);
    if (!bytes) throw new Error("Controlled filesystem file not found");
    return Buffer.from(bytes);
  },
  readdirSync: (path: string) => {
    if (path !== mocked.bundle) throw new Error("Unexpected controlled directory read");
    return ["Artoo.WindowsProcessHost.exe", "manifest.json"];
  },
  realpathSync: Object.assign((path: string) => path, { native: (path: string) => {
    if (!mocked.directories.has(path) && !mocked.files.has(path)) throw new Error("Controlled realpath not found");
    return path;
  } }),
}));

import {
  isWindowsOwnedClosureReceipt, isWindowsOwnedTargetInputReceipt, prepareWindowsProcessBackend, startWindowsOwnedProcess,
  assertWindowsProcessTargetInputCapability,
  WindowsOwnedCleanupError, WindowsOwnedStartupError, type WindowsOwnedClosureReceipt, type WindowsOwnedProcess,
  type WindowsOwnedStart,
} from "./windows-owned-process.js";
import { bootstrapWindowsGuardian, createWindowsGuardianRegistration, acceptWindowsGuardianRegistration,
  reserveWindowsGuardianSlot, windowsGuardianForBackend } from "./windows-runtime-guardian.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ROOT_PID = 4242, CREATION_TIME = "133806600000000000";
let manifestSha256: string;

interface ControlWrite { kind: string; token?: string; env?: Record<string, string>; [key: string]: unknown }

class ControlledHelper extends EventEmitter {
  readonly pid = 10_000 + helpers.length;
  readonly writes: ControlWrite[] = [];
  readonly stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  readonly stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.writes.push(JSON.parse(Buffer.from(chunk).toString("utf8")) as ControlWrite);
    callback();
  } });
  readonly kill = vi.fn(() => true);
  readonly unref = vi.fn();
  sequence = 0;

  get launch(): ControlWrite | undefined { return this.writes.find(write => write.kind === "launch"); }
  send(kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): void {
    const frame = { version: 1, token: this.launch?.token ?? null, sequence: this.sequence++, kind, payload, ...overrides };
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }
  ready(capabilities?: readonly string[]): void { this.send("ready", { protocol: "artoo.windows-job-process.v1", atomicJobList: true,
    ...(capabilities ? { capabilities } : {}) }, { token: null }); }
  created(): void { this.send("created", { pid: ROOT_PID, creationTime: CREATION_TIME, jobMember: true }); }
  started(): void { this.send("started", { pid: ROOT_PID }); }
  rootExit(code = 0): void { this.send("root_exit", { code }); }
  eof(stream: "stdout" | "stderr"): void { this.send("pipe_eof", { stream }); }
  exit(code = 0): void { this.emit("exit", code, null); }
  close(code = 0): void { this.emit("close", code, null); }
  guardianResult(kind: "guardian_ready" | "guardian_result", payload: Record<string, unknown>): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify({ version: 1, kind, payload })}\n`));
    if (kind === "guardian_result") { this.stdout.emit("end"); this.stderr.emit("end"); this.exit(); this.close(); }
  }
}

const helpers: ControlledHelper[] = [], runs: WindowsOwnedProcess[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  vi.stubEnv("SystemRoot", mocked.systemRoot);
  mocked.files.clear(); mocked.directories.clear(); helpers.length = 0; runs.length = 0;
  mocked.directories.add(mocked.bundle); mocked.directories.add(mocked.systemRoot);
  const executable = Buffer.from("CONTROLLED TEST BYTES, NOT A WINDOWS EXECUTABLE");
  mocked.files.set(`${mocked.bundle}\\Artoo.WindowsProcessHost.exe`, executable);
  const manifest = Buffer.from(JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64",
    executable: "Artoo.WindowsProcessHost.exe", files: [{ path: "Artoo.WindowsProcessHost.exe", size: executable.length, sha256: sha(executable) }] }));
  mocked.files.set(`${mocked.bundle}\\manifest.json`, manifest); manifestSha256 = sha(manifest);
  mocked.spawn.mockReset().mockImplementation(() => { const helper = new ControlledHelper(); helpers.push(helper); return helper; });
});

afterEach(async () => {
  // Finish every simulated owner even after an assertion fails. These are explicit
  // simulated failure events, not evidence that a real helper was killed or closed.
  for (const helper of helpers) { helper.exit(1); helper.close(1); helper.stdin.destroy(); }
  await Promise.all(runs.map(run => run.closed.then(() => undefined, () => undefined)));
  try { expect(vi.getTimerCount()).toBe(0); }
  finally {
    vi.useRealTimers(); vi.unstubAllEnvs(); Object.defineProperty(process, "platform", originalPlatform);
  }
});

function prepare(assertLocalInstallation: () => void = () => undefined) {
  return prepareWindowsProcessBackend({ directory: mocked.bundle, manifestSha256, assertLocalInstallation });
}
function input(overrides: Partial<WindowsOwnedStart> = {}): WindowsOwnedStart {
  return { executable: "C:\\tools\\node.exe", args: ["--version"], cwd: "C:\\workspace\\controlled",
    env: { SystemRoot: mocked.systemRoot, ARTOO_TEST_SECRET: "fixture-only-secret" }, timeoutMs: 20_000,
    maxOutputBytes: 65_536, cleanupTimeoutMs: 5000, normalExitPolicy: "require-empty", normalExitGraceMs: 250, ...overrides };
}
function begin(overrides: Partial<WindowsOwnedStart> = {}) {
  const run = startWindowsOwnedProcess(prepare(), input(overrides)); runs.push(run);
  const helper = helpers.at(-1)!; helper.emit("spawn");
  return { run, helper };
}
const INPUT_CAPABILITY = "artoo.windows-target-input.v1";
const INPUT_SELECTION = { version: 1, mode: "single-message-eof", maximumBytes: 4096 } as const;
function advertiseInput(): void {
  const manifest = JSON.parse(mocked.files.get(`${mocked.bundle}\\manifest.json`)!.toString("utf8"));
  manifest.capabilities = [INPUT_CAPABILITY]; const bytes = Buffer.from(JSON.stringify(manifest));
  mocked.files.set(`${mocked.bundle}\\manifest.json`, bytes); manifestSha256 = sha(bytes);
}
function beginInput(overrides: Partial<WindowsOwnedStart> = {}) {
  advertiseInput(); const value = begin({ targetInput: INPUT_SELECTION, ...overrides });
  value.helper.ready([INPUT_CAPABILITY]); value.helper.created(); value.helper.started(); return value;
}
function inputRequest(helper: ControlledHelper): ControlWrite {
  const request = helper.writes.find(write => write.kind === "target_input");
  if (!request) throw new Error("Controlled input was not submitted"); return request;
}
function acknowledgeInput(helper: ControlledHelper, payload: Record<string, unknown> = {}, frame: Record<string, unknown> = {}): void {
  const request = inputRequest(helper), bytes = Buffer.from(request.dataBase64 as string, "base64");
  helper.send("target_input_closed", { requestId: request.requestId, bytesWritten: bytes.length, sha256: sha(bytes), inputClosed: true, ...payload }, frame);
}
function inputFinal(helper: ControlledHelper, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const request = helper.writes.find(write => write.kind === "target_input");
  return { version: 1, pipeCreated: true, writeRequested: !!request, requestId: request?.requestId ?? null,
    bytesWritten: request ? Buffer.from(request.dataBase64 as string, "base64").length : 0, inputClosed: true, ...overrides };
}
async function beginRegisteredGuardian() {
  const capability = "artoo.windows-runtime-guardian.v1", uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const manifest = JSON.parse(mocked.files.get(`${mocked.bundle}\\manifest.json`)!.toString("utf8"));
  manifest.capabilities = [capability]; const bytes = Buffer.from(JSON.stringify(manifest));
  mocked.files.set(`${mocked.bundle}\\manifest.json`, bytes); manifestSha256 = sha(bytes);
  const backend = prepare(), workspaceRoot = input().cwd;
  const booting = bootstrapWindowsGuardian(backend, { nodeId: "node", deviceId: "device", sessionId: "session", configurationDigest: sha("configuration"),
    storeDirectory: "C:\\private-guardian-store", workspaceRoot, storage: {} as PreparedWindowsReleaseStorage,
    controlDirectory: "C:\\private-guardian-control", controlStorage: {} as PreparedWindowsReleaseStorage,
    supervisor: {} as PreparedWindowsDaemonSupervisorAuthority, topology: "supervisor-plain-daemon.v1" });
  const bootstrap = helpers.at(-1)!; bootstrap.emit("spawn");
  const endpoint = { version: 1, capability, pipeName: `artoo-guardian-${uuid(1)}`, guardianInstanceId: uuid(1),
    guardianPid: bootstrap.pid, guardianCreationTime: CREATION_TIME, executableDigest: sha(mocked.files.get(`${mocked.bundle}\\Artoo.WindowsProcessHost.exe`)!) };
  const binding = { version: 1, node_id: "node", device_id: "device", guardian_instance_id: uuid(1), store_identity_digest: sha("store"),
    configuration_digest: sha("configuration"), workspace_root: workspaceRoot, workspace_identity_digest: sha("workspace") };
  const epoch = { version: 1, epoch_id: uuid(2), generation: 0, session_id: "session", roster_revision: 0, roster_digest: sha("[]") };
  bootstrap.guardianResult("guardian_ready", { endpoint, binding, epoch });
  const guardian = await booting, registration = createWindowsGuardianRegistration(guardian);
  expect(windowsGuardianForBackend(backend)).toBe(guardian);
  const activating = acceptWindowsGuardianRegistration(guardian, { kind: "command", id: "registered", idempotency_key: "registered",
    type: "product.source.recovery.registered.v1", payload: { version: 1, registration_id: registration.registration_id,
      registration_digest: productSourceRecoveryRegistrationDigestV1(registration, sha), session_id: "session", status: "accepted" } });
  const activation = helpers.at(-1)!; activation.emit("spawn"); activation.guardianResult("guardian_result", { activated: true }); await activating;
  const reserving = reserveWindowsGuardianSlot(guardian, { operationKind: "author", operationId: "controlled-author", bindingDigest: sha("operation"), serverOperation: null });
  const reservation = helpers.at(-1)!; reservation.emit("spawn");
  const enrollment = { version: 1, endpoint, epochId: epoch.epoch_id, slotId: uuid(3), ticket: uuid(4) };
  reservation.guardianResult("guardian_result", enrollment); const slot = await reserving;
  const count = helpers.length;
  expect(() => startWindowsOwnedProcess(backend, input())).toThrow(/unused registered launch/);
  expect(() => startWindowsOwnedProcess(backend, input({ guardianSlot: structuredClone(slot) }))).toThrow(/unused registered launch/);
  expect(helpers).toHaveLength(count);
  const run = startWindowsOwnedProcess(backend, input({ guardianSlot: slot, timeoutMs: 43_200_000 })); runs.push(run);
  const helper = helpers.at(-1)!; helper.emit("spawn"); helper.ready([capability]); helper.created(); helper.started();
  expect(helper.launch?.guardian).toEqual(enrollment); expect(mocked.spawn.mock.calls.at(-1)![2].detached).toBe(true);
  expect(() => startWindowsOwnedProcess(backend, input({ guardianSlot: slot }))).toThrow(/unused registered launch/);
  return { run, helper };
}
function establishRoot(helper: ControlledHelper): void { helper.ready(); helper.created(); helper.started(); }
function normalFinal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { rootCreated: true, rootStarted: true, rootPid: ROOT_PID, rootCreationTime: CREATION_TIME,
    atomicJobMember: true, rootWaitObserved: true, rootExitCode: 0, stdoutEof: true, stderrEof: true,
    stdoutCreated: true, stderrCreated: true, jobCreated: true, jobEmptyObserved: true, noTargetCreated: false,
    terminationReason: null, failureCode: null, nativeError: null, outputBytesObserved: 0, outputBytesCaptured: 0,
    cleanupConfirmed: true, ...overrides };
}
function noTargetFinal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { rootCreated: false, rootStarted: false, rootPid: null, rootCreationTime: null,
    atomicJobMember: false, rootWaitObserved: false, rootExitCode: null, stdoutEof: false, stderrEof: false,
    stdoutCreated: false, stderrCreated: false, jobCreated: false, jobEmptyObserved: false, noTargetCreated: true,
    terminationReason: "parent_eof", failureCode: "no_launch", nativeError: null,
    outputBytesObserved: 0, outputBytesCaptured: 0, cleanupConfirmed: true, ...overrides };
}
function completeRoot(helper: ControlledHelper, overrides: Record<string, unknown> = {}): void {
  const final = normalFinal(overrides);
  helper.rootExit(final.rootExitCode as number);
  if (final.stdoutEof) helper.eof("stdout");
  if (final.stderrEof) helper.eof("stderr");
  helper.send("complete", final);
}
async function rejectedClosure(run: WindowsOwnedProcess, helper: ControlledHelper, failureCode = "control_protocol"): Promise<WindowsOwnedClosureReceipt> {
  helper.exit(); helper.close();
  const caught: unknown = await run.closed.then(() => { throw new Error("Unexpected controlled closure success"); }, error => error);
  expect(caught).toBeInstanceOf(WindowsOwnedCleanupError);
  const receipt = (caught as WindowsOwnedCleanupError).receipt;
  expect(isWindowsOwnedClosureReceipt(receipt)).toBe(true);
  expect(receipt.cleanupConfirmed).toBe(false); expect(receipt.failureCode).toBe(failureCode);
  return receipt;
}
async function expectPending(run: WindowsOwnedProcess): Promise<void> {
  const settled = vi.fn(); void run.closed.then(settled, settled);
  await Promise.resolve(); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
}

describe("controlled Windows protocol, not native containment", () => {
  it("keeps a synchronous pre-dispatch rejection unchanged and does not invent process diagnostics", () => {
    const controller = new AbortController(), reason = new Error("Controlled admission cancelled before dispatch");
    controller.abort(reason);
    expect(() => startWindowsOwnedProcess(prepare(), input({ signal: controller.signal }))).toThrow(reason);
    expect(mocked.spawn).not.toHaveBeenCalled(); expect(reason).not.toHaveProperty("diagnostic");
  });

  it("preserves simulated CreateProcess failure and native error after both helper exit and close events", async () => {
    const { run, helper } = begin(); helper.ready(); helper.eof("stdout"); helper.eof("stderr");
    helper.send("complete", noTargetFinal({ jobCreated: true, jobEmptyObserved: true, stdoutCreated: true, stderrCreated: true,
      stdoutEof: true, stderrEof: true, failureCode: "create_process", nativeError: 5, terminationReason: "create_process" }));
    await expectPending(run); helper.exit(); helper.close();
    const failure = await run.started.catch(error => error as WindowsOwnedStartupError), receipt = await run.closed;
    expect(failure).toBeInstanceOf(WindowsOwnedStartupError);
    expect(failure).toMatchObject({ diagnostic: { failureCode: "create_process", nativeError: 5, rootCreated: false, rootStarted: false,
      noTargetCreated: true, cleanupConfirmed: true, helperExitObserved: true, helperCloseObserved: true } });
    expect((failure as Error).message).toContain("Windows target did not start");
    expect((failure as Error).message).toContain('"nativeError":5'); expect((failure as Error).message).not.toContain("fixture-only-secret");
    expect((failure as Error).message).not.toContain("--version");
    expect(isWindowsOwnedClosureReceipt(receipt)).toBe(true);
    expect(isWindowsOwnedClosureReceipt((failure as WindowsOwnedStartupError).diagnostic)).toBe(false);
  });

  it("keeps unknown startup closure distinct from an observed no-target result", async () => {
    const { run, helper } = begin(); helper.ready(); helper.exit(1); helper.close(1);
    const startup = await run.started.catch(error => error as WindowsOwnedStartupError);
    const cleanup = await run.closed.catch(error => error as WindowsOwnedCleanupError);
    expect(startup).toBeInstanceOf(WindowsOwnedStartupError); expect(cleanup).toBeInstanceOf(WindowsOwnedCleanupError);
    expect(startup).toMatchObject({ diagnostic: { failureCode: "missing_complete", nativeError: null, cleanupConfirmed: false, noTargetCreated: false } });
    expect((cleanup as WindowsOwnedCleanupError).diagnostic).toEqual((startup as WindowsOwnedStartupError).diagnostic);
    expect((cleanup as Error).message).toContain("closure remains unconfirmed");
  });

  it("requires both helper exit and close after complete, and brands only local receipts", async () => {
    const { run, helper } = begin(); const closeEvent = vi.fn(); run.on("close", closeEvent);
    establishRoot(helper); completeRoot(helper); await expectPending(run);
    helper.exit(); await expectPending(run); expect(closeEvent).not.toHaveBeenCalled();
    helper.close(); const receipt = await run.closed;
    expect(receipt).toMatchObject({ cleanupConfirmed: true, rootExitCode: 0, rootWaitObserved: true,
      stdoutEof: true, stderrEof: true, jobEmptyObserved: true, helperSpawnObserved: true,
      helperExitObserved: true, helperCloseObserved: true, helperExitCode: 0 });
    expect(closeEvent).toHaveBeenCalledOnce(); expect(isWindowsOwnedClosureReceipt(receipt)).toBe(true);
    expect(isWindowsOwnedClosureReceipt({ ...receipt })).toBe(false);
    expect(isWindowsOwnedClosureReceipt(JSON.parse(JSON.stringify(receipt)))).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain("fixture-only-secret");
    expect(JSON.stringify(receipt)).not.toContain("--version");
  });

  it.each([
    ["stdout existence", { stdoutCreated: false, stdoutEof: false }],
    ["stderr existence", { stderrCreated: false, stderrEof: false }],
    ["Job existence", { jobCreated: false, jobEmptyObserved: false }],
    ["all existence flags", { stdoutCreated: false, stdoutEof: false, stderrCreated: false, stderrEof: false, jobCreated: false, jobEmptyObserved: false }],
    ["stdout EOF", { stdoutEof: false }],
    ["stderr EOF", { stderrEof: false }],
    ["Job empty", { jobEmptyObserved: false }],
    ["root wait", { rootWaitObserved: false }],
  ] as const)("rejects complete that skips %s proof after a started root", async (_label, overrides) => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper, overrides);
    await rejectedClosure(run, helper);
  });

  it.each([
    ["changed creation time", { rootCreationTime: "133806600000000001" }],
    ["missing creation time", { rootCreationTime: null }],
    ["changed PID", { rootPid: ROOT_PID + 1 }],
    ["missing membership", { atomicJobMember: false }],
    ["contradictory no-target", { rootCreated: false, noTargetCreated: true }],
  ] as const)("rejects %s instead of trusting complete metadata", async (_label, overrides) => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper, overrides);
    await rejectedClosure(run, helper);
  });

  it.each(["created", "started"] as const)("rejects %s after root_exit", async (kind) => {
    const { run, helper } = begin(); helper.ready(); if (kind === "started") helper.created();
    helper.rootExit(); if (kind === "created") helper.created(); else helper.started();
    await rejectedClosure(run, helper); await expect(run.started).rejects.toThrow("did not start");
  });

  it("preserves no-created-frame cleanup after a simulated membership failure", async () => {
    const { run, helper } = begin(); helper.ready(); helper.rootExit(0xE0000001); helper.eof("stdout"); helper.eof("stderr");
    helper.send("complete", normalFinal({ rootStarted: false, rootCreationTime: null, atomicJobMember: false,
      rootExitCode: 0xE0000001, terminationReason: "job_membership", failureCode: "job_membership", nativeError: 5 }));
    helper.exit(); helper.close(); const receipt = await run.closed;
    expect(receipt).toMatchObject({ cleanupConfirmed: true, rootCreated: true, rootStarted: false,
      rootWaitObserved: true, failureCode: "job_membership", rootExitCode: 0xE0000001 });
    await expect(run.started).rejects.toThrow("did not start");
  });

  it.each([
    ["wrong invocation nonce", { token: "00000000-0000-0000-0000-000000000000" }],
    ["skipped sequence", { sequence: 2 }],
    ["replayed sequence", { sequence: 0 }],
    ["wrong version", { version: 2 }],
  ] as const)("rejects %s even with otherwise valid created facts", async (_label, overrides) => {
    const { run, helper } = begin(); helper.ready();
    helper.send("created", { pid: ROOT_PID, creationTime: CREATION_TIME, jobMember: true }, overrides);
    await rejectedClosure(run, helper);
  });

  it("does not infer helper exit from the close event", async () => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper); helper.close();
    const failure = await run.closed.catch(error => error as WindowsOwnedCleanupError);
    expect(failure).toBeInstanceOf(WindowsOwnedCleanupError);
    expect((failure as WindowsOwnedCleanupError).receipt).toMatchObject({ cleanupConfirmed: false,
      helperCloseObserved: true, helperExitObserved: false });
  });

  it("rejects helper nonzero exit even when native complete claims success", async () => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper); helper.exit(1); helper.close(1);
    await expect(run.closed).rejects.toMatchObject({ receipt: { cleanupConfirmed: false, helperExitCode: 1,
      helperExitObserved: true, helperCloseObserved: true } });
  });

  it("rejects helper death without a complete frame", async () => {
    const { run, helper } = begin(); establishRoot(helper);
    await rejectedClosure(run, helper, "missing_complete");
  });

  it("rejects an extra terminal frame after complete", async () => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper);
    helper.send("complete", normalFinal()); await rejectedClosure(run, helper);
  });

  it("confirms cancellation before ready only through an explicit no-target terminal and helper closure", async () => {
    const { run, helper } = begin(); run.cancel();
    expect(helper.stdin.writableEnded).toBe(true); expect(helper.writes).toEqual([]);
    helper.ready(); helper.send("complete", noTargetFinal(), { token: null }); await expectPending(run);
    helper.exit(); helper.close(); const receipt = await run.closed;
    expect(helper.writes).toEqual([]);
    expect(receipt).toMatchObject({ cleanupConfirmed: true, noTargetCreated: true, rootCreated: false,
      rootStarted: false, terminationReason: "cancelled", nativeTerminationReason: "parent_eof" });
    await expect(run.started).rejects.toThrow("did not start");
  });

  it("rejects target work smuggled into a pre-dispatch terminal", async () => {
    const { run, helper } = begin(); run.cancel(); helper.ready();
    helper.send("complete", noTargetFinal({ jobCreated: true, jobEmptyObserved: true }), { token: null });
    await rejectedClosure(run, helper);
  });

  it("accepts a bound no-target validation failure as failure facts with confirmed cleanup", async () => {
    const { run, helper } = begin({ executable: "C:\\missing\\not-present.exe" }); helper.ready();
    expect(helper.launch?.token).toEqual(expect.any(String));
    helper.send("complete", noTargetFinal({ terminationReason: "invalid_request", failureCode: "invalid_request" }));
    helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, noTargetCreated: true,
      rootExitCode: null, rootStarted: false, failureCode: "invalid_request" });
    await expect(run.started).rejects.toThrow("did not start");
  });

  it.each(["resolved", "rejected"] as const)("rejects %s asynchronous installation qualification before spawn", async (outcome) => {
    const check = () => outcome === "resolved" ? Promise.resolve() : Promise.reject(new Error("controlled ACL failure"));
    expect(() => prepare(check)).toThrow("synchronous");
    await Promise.resolve(); await Promise.resolve(); expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("rechecks synchronous qualification at launch and rejects a later thenable", async () => {
    let asynchronous = false;
    const backend = prepare(() => asynchronous ? Promise.resolve() : undefined); asynchronous = true;
    expect(() => startWindowsOwnedProcess(backend, input())).toThrow("synchronous");
    await Promise.resolve(); expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("rejects an oversized launch frame before a helper can spawn", () => {
    expect(() => startWindowsOwnedProcess(prepare(), input({ env: { SystemRoot: mocked.systemRoot,
      TOO_LARGE: "x".repeat(1024 * 1024) } }))).toThrow("fixed bound");
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("keeps lifecycle-looking target output as data", async () => {
    const { run, helper } = begin(); const output: Buffer[] = []; run.stdout.on("data", chunk => output.push(Buffer.from(chunk)));
    establishRoot(helper);
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, kind: "complete", token: helper.launch?.token,
      sequence: 3, payload: normalFinal() })}\n`);
    helper.send("output", { stream: "stdout", data: bytes.toString("base64") }); await expectPending(run);
    completeRoot(helper, { outputBytesCaptured: bytes.length, outputBytesObserved: bytes.length });
    helper.exit(); helper.close(); expect((await run.closed).cleanupConfirmed).toBe(true);
    expect(Buffer.concat(output)).toEqual(bytes);
  });

  it("takes the helper system root from its prepared backend, independently of target env", async () => {
    const { run, helper } = begin({ env: { SystemRoot: "C:\\target-root", DOTNET_STARTUP_HOOKS: "target-only-hook" } }); helper.ready();
    const options = mocked.spawn.mock.calls[0]![2] as { env: Record<string, string> };
    expect(options.env).toEqual({ SystemRoot: mocked.systemRoot, WINDIR: mocked.systemRoot, PATH: `${mocked.systemRoot}\\System32` });
    expect(helper.launch?.env).toMatchObject({ SystemRoot: "C:\\target-root", DOTNET_STARTUP_HOOKS: "target-only-hook" });
    helper.send("complete", noTargetFinal({ terminationReason: "invalid_request", failureCode: "invalid_request" }));
    helper.exit(); helper.close(); expect((await run.closed).cleanupConfirmed).toBe(true);
  });

  it("keeps the fixed startup timer running after ready until started or terminal", async () => {
    const { run, helper } = begin(); helper.ready();
    expect(helper.launch).toBeDefined();
    vi.advanceTimersByTime(9999); expect(helper.writes.some(write => write.kind === "cancel")).toBe(false);
    vi.advanceTimersByTime(1); expect(helper.writes.filter(write => write.kind === "cancel")).toHaveLength(1);
    await expectPending(run);
    helper.send("complete", noTargetFinal({ terminationReason: "cancelled", failureCode: "cancelled_before_create" }));
    helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, noTargetCreated: true, terminationReason: "timeout" });
    await expect(run.started).rejects.toThrow("did not start");
  });

  it("does not renew the first cleanup timer on repeated cancel or output, and kill alone proves nothing", async () => {
    const { run, helper } = begin({ timeoutMs: 100_000 }); establishRoot(helper); run.cancel();
    vi.advanceTimersByTime(6000); run.cancel();
    helper.send("output", { stream: "stdout", data: Buffer.from("late output").toString("base64") });
    vi.advanceTimersByTime(1499); expect(helper.kill).not.toHaveBeenCalled(); await expectPending(run);
    vi.advanceTimersByTime(1); expect(helper.kill).toHaveBeenCalledOnce();
    await expect(run.closed).rejects.toMatchObject({ receipt: { cleanupConfirmed: false,
      failureCode: "cleanup_deadline", terminationReason: "cancelled", helperExitObserved: false, helperCloseObserved: false } });
  });

  it("bounds root exit without helper close and never renews its terminal deadline", async () => {
    const { run, helper } = begin({ timeoutMs: 43_200_000 }); establishRoot(helper);
    const closeEvent = vi.fn(); run.on("close", closeEvent);
    helper.rootExit(); vi.advanceTimersByTime(6000);
    helper.eof("stdout"); helper.eof("stderr"); helper.send("complete", normalFinal()); helper.exit();
    vi.advanceTimersByTime(1499); await expectPending(run);
    vi.advanceTimersByTime(1);
    const failure = await run.closed.catch(error => error as WindowsOwnedCleanupError);
    expect(failure).toBeInstanceOf(WindowsOwnedCleanupError);
    expect(failure).toMatchObject({ receipt: { failureCode: "terminal_closure_deadline", cleanupConfirmed: false,
      rootWaitObserved: true, helperExitObserved: true, helperCloseObserved: false, stdoutEof: true, stderrEof: true } });
    helper.close();
    expect(closeEvent).not.toHaveBeenCalled(); expect(helper.kill).toHaveBeenCalledOnce();
    await expect(run.closed).rejects.toBe(failure);
  });

  it("bounds complete without root creation while still requiring original helper close", async () => {
    const { run, helper } = begin({ timeoutMs: 43_200_000 }); helper.ready();
    helper.send("complete", noTargetFinal()); helper.exit();
    vi.advanceTimersByTime(2499); await expectPending(run); vi.advanceTimersByTime(1);
    await expect(run.closed).rejects.toMatchObject({ receipt: { failureCode: "terminal_closure_deadline",
      noTargetCreated: true, helperExitObserved: true, helperCloseObserved: false, cleanupConfirmed: false } });
    await expect(run.started).rejects.toBeInstanceOf(WindowsOwnedStartupError);
  });

  it("bounds original helper exit when neither complete nor close arrives", async () => {
    const { run, helper } = begin({ timeoutMs: 43_200_000 }); establishRoot(helper); helper.exit(2);
    vi.advanceTimersByTime(2500);
    await expect(run.closed).rejects.toMatchObject({ receipt: { failureCode: "terminal_closure_deadline",
      helperExitCode: 2, helperExitObserved: true, helperCloseObserved: false, cleanupConfirmed: false } });
  });

  it("rejects cleanup uncertainty even when the deadline's helper kill throws", async () => {
    const { run, helper } = begin({ timeoutMs: 43_200_000 }); establishRoot(helper); helper.exit(2);
    helper.kill.mockImplementation(() => { throw new Error("Controlled original helper kill failed"); });
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow();
    await expect(run.closed).rejects.toMatchObject({ receipt: { failureCode: "terminal_closure_deadline",
      helperExitObserved: true, helperCloseObserved: false, cleanupConfirmed: false } });
  });

  it("rejects an original close observed after the fixed deadline even before the timer callback", async () => {
    const { run, helper } = begin({ timeoutMs: 43_200_000 }); establishRoot(helper); completeRoot(helper);
    const elapsed = performance.now(), clock = vi.spyOn(performance, "now").mockReturnValue(elapsed + 8000);
    try {
      helper.exit(); helper.close();
      await expect(run.closed).rejects.toMatchObject({ receipt: { failureCode: "terminal_closure_deadline",
        helperExitObserved: true, helperCloseObserved: true, cleanupConfirmed: false } });
    } finally { clock.mockRestore(); }
  });

  it("allows the extra Guardian terminal exchanges only on the genuinely prepared and registered backend", async () => {
    const { run, helper } = await beginRegisteredGuardian(); helper.rootExit();
    vi.advanceTimersByTime(16_000); await expectPending(run); expect(helper.kill).not.toHaveBeenCalled();
    helper.eof("stdout"); helper.eof("stderr"); helper.send("complete", normalFinal()); helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, helperExitObserved: true, helperCloseObserved: true });
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it("does not renew the registered Guardian's 16.5s root deadline on complete or helper exit", async () => {
    const { run, helper } = await beginRegisteredGuardian(), closeEvent = vi.fn(); run.on("close", closeEvent);
    helper.rootExit(); vi.advanceTimersByTime(12_000); await expectPending(run);
    helper.eof("stdout"); helper.eof("stderr"); helper.send("complete", normalFinal());
    vi.advanceTimersByTime(4000); helper.exit(); vi.advanceTimersByTime(499); await expectPending(run);
    vi.advanceTimersByTime(1);
    const failure = await run.closed.catch(error => error as WindowsOwnedCleanupError);
    expect(failure).toMatchObject({ receipt: { failureCode: "terminal_closure_deadline", cleanupConfirmed: false,
      helperExitObserved: true, helperCloseObserved: false } });
    expect(helper.kill).toHaveBeenCalledOnce(); helper.close();
    await expect(run.closed).rejects.toBe(failure); expect(closeEvent).not.toHaveBeenCalled();
  });

  it("rejects registered Guardian late close even when the terminal timer has not run yet", async () => {
    const { run, helper } = await beginRegisteredGuardian(); completeRoot(helper);
    const elapsed = performance.now(), clock = vi.spyOn(performance, "now").mockReturnValue(elapsed + 17_000);
    try {
      helper.exit(); helper.close();
      await expect(run.closed).rejects.toMatchObject({ receipt: { failureCode: "terminal_closure_deadline", cleanupConfirmed: false,
        helperExitObserved: true, helperCloseObserved: true } });
    } finally { clock.mockRestore(); }
  });

  it("never dispatches a target after the abort observer cannot be installed", () => {
    const brokenSignal = { aborted: false, throwIfAborted: () => undefined,
      addEventListener: () => { throw new Error("controlled listener failure"); }, removeEventListener: vi.fn() } as unknown as AbortSignal;
    expect(() => startWindowsOwnedProcess(prepare(), input({ signal: brokenSignal }))).toThrow("target was not dispatched");
    const helper = helpers.at(-1)!; helper.emit("spawn"); helper.ready();
    expect(helper.writes).toEqual([]); expect(helper.stdin.writableEnded).toBe(true);
    helper.send("complete", noTargetFinal(), { token: null }); helper.exit(); helper.close();
  });
});

describe("controlled target input protocol, not native WriteFile/CloseHandle evidence", () => {
  it("rejects local target-input admission for an old pinned manifest without spawning", () => {
    expect(() => assertWindowsProcessTargetInputCapability(prepare())).toThrow(/does not advertise target input/);
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("admits only original manifest capability authority, never serialized backend claims", () => {
    advertiseInput(); const backend = prepare();
    expect(() => assertWindowsProcessTargetInputCapability(backend)).not.toThrow();
    const remote = JSON.parse(JSON.stringify({ ...backend, capabilities: [INPUT_CAPABILITY] }));
    expect(() => assertWindowsProcessTargetInputCapability(remote)).toThrow(/not locally prepared/);
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("retains legacy NUL selection without exposing endInput even when a new helper advertises the capability", async () => {
    advertiseInput(); const { run, helper } = begin(); helper.ready([INPUT_CAPABILITY]); helper.created(); helper.started();
    expect(run.endInput).toBeUndefined(); expect(helper.launch).not.toHaveProperty("targetInput");
    completeRoot(helper); helper.exit(); helper.close(); expect((await run.closed).targetInput).toBeUndefined();
  });

  it("rejects an old manifest before spawning or consuming a launch slot", () => {
    expect(() => begin({ targetInput: INPUT_SELECTION })).toThrow(/does not advertise target input/);
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("requires the ready capability before sending launch to a helper", async () => {
    advertiseInput(); const { run, helper } = begin({ targetInput: INPUT_SELECTION }); helper.ready();
    expect(helper.launch).toBeUndefined(); await rejectedClosure(run, helper);
  });

  it.each([
    { version: 2, mode: "single-message-eof", maximumBytes: 4096 },
    { version: 1, mode: "stream", maximumBytes: 4096 },
    { version: 1, mode: "single-message-eof", maximumBytes: 4097 },
    { ...INPUT_SELECTION, remoteCommand: "not-allowed" }, null,
  ])("rejects a malformed local selection before spawning: %j", selection => {
    advertiseInput(); expect(() => begin({ targetInput: selection as WindowsOwnedStart["targetInput"] })).toThrow(/target input selection/);
    expect(mocked.spawn).not.toHaveBeenCalled();
  });

  it("copies the launch selection before the ready callback and admits input only after started", async () => {
    advertiseInput(); const selection = { ...INPUT_SELECTION }, { run, helper } = begin({ targetInput: selection });
    await expect(run.endInput!(Buffer.from("x"))).rejects.toThrow(/live target/);
    Object.assign(selection, { maximumBytes: 100 }); helper.ready([INPUT_CAPABILITY]); helper.created();
    expect(helper.launch?.targetInput).toEqual(INPUT_SELECTION);
    await expect(run.endInput!(Buffer.from("x"))).rejects.toThrow(/live target/);
    helper.started(); const writing = run.endInput!(Buffer.from("x")); acknowledgeInput(helper); await writing;
  });

  it.each([new Uint8Array(0), new Uint8Array(4097), "x"])("rejects invalid bytes before consuming the single request", async bytes => {
    const { run, helper } = beginInput(); await expect(run.endInput!(bytes as Uint8Array)).rejects.toThrow(/1 through 4096/);
    expect(helper.writes.filter(write => write.kind === "target_input")).toHaveLength(0);
    const writing = run.endInput!(Buffer.from("valid")); acknowledgeInput(helper); await writing;
  });

  it("copies the exact view, accepts 4096 bytes once, and leaves helper control stdin open after ACK", async () => {
    const { run, helper } = beginInput(), backing = new Uint8Array(4100).fill(7), view = backing.subarray(2, 4098);
    const expected = Buffer.from(view), writing = run.endInput!(view); backing.fill(9);
    await expect(run.endInput!(expected)).rejects.toThrow(/another input/);
    expect(Buffer.from(inputRequest(helper).dataBase64 as string, "base64")).toEqual(expected);
    expect(helper.writes.filter(write => write.kind === "target_input")).toHaveLength(1);
    acknowledgeInput(helper); const receipt = await writing;
    expect(receipt).toEqual({ version: 1, token: helper.launch!.token, requestId: inputRequest(helper).requestId,
      bytesWritten: 4096, sha256: sha(expected), inputClosed: true });
    expect(isWindowsOwnedTargetInputReceipt(receipt)).toBe(true); expect(Object.isFrozen(receipt)).toBe(true);
    expect(isWindowsOwnedTargetInputReceipt({ ...receipt })).toBe(false); expect(helper.stdin.writableEnded).toBe(false);
    await expectPending(run);
    completeRoot(helper, { targetInput: inputFinal(helper) }); await expectPending(run);
    helper.exit(); await expectPending(run); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, terminationReason: null, targetInput: inputFinal(helper) });
  });

  it("allows natural initialization exit without submitting input and requires the writer close fact", async () => {
    const { run, helper } = beginInput(); completeRoot(helper, { targetInput: inputFinal(helper) }); helper.exit(); helper.close();
    const receipt = await run.closed;
    expect(receipt).toMatchObject({ cleanupConfirmed: true, terminationReason: null,
      targetInput: { pipeCreated: true, writeRequested: false, requestId: null, bytesWritten: 0, inputClosed: true } });
    expect(Object.isFrozen(receipt.targetInput)).toBe(true);
    expect(helper.writes.some(write => write.kind === "target_input")).toBe(false);
  });

  it("accepts a pending real ACK after root_exit but never admits a new input after that exit", async () => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("shutdown\n"));
    helper.rootExit(); await expect(run.endInput!(Buffer.from("again"))).rejects.toThrow(/live target/);
    acknowledgeInput(helper); await writing; helper.eof("stdout"); helper.eof("stderr");
    helper.send("complete", normalFinal({ targetInput: inputFinal(helper) })); helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, terminationReason: null });
  });

  it.each([
    ["request ID", { requestId: "00000000-0000-4000-8000-000000000001" }],
    ["byte count", { bytesWritten: 0 }], ["digest", { sha256: sha("different") }],
    ["close evidence", { inputClosed: false }], ["extra fields", { extra: true }],
  ])("rejects an ACK with changed %s", async (_label, payload) => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/); acknowledgeInput(helper, payload as Record<string, unknown>);
    await rejected; await rejectedClosure(run, helper);
  });

  it.each([{ token: "other-launch" }, { sequence: 999 }])("rejects ACK frame rebinding: %j", async frame => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/); acknowledgeInput(helper, {}, frame);
    await rejected; await rejectedClosure(run, helper);
  });

  it("rejects unsolicited or replayed ACKs", async () => {
    const first = beginInput(); first.helper.send("target_input_closed", { requestId: "unrequested", bytesWritten: 1, sha256: sha("x"), inputClosed: true });
    await rejectedClosure(first.run, first.helper);
    const second = beginInput(), writing = second.run.endInput!(Buffer.from("x")); acknowledgeInput(second.helper); await writing;
    acknowledgeInput(second.helper); await rejectedClosure(second.run, second.helper);
  });

  it("rejects target input facts on an ordinary legacy launch", async () => {
    const { run, helper } = begin(); establishRoot(helper); completeRoot(helper, { targetInput: inputFinal(helper) });
    await rejectedClosure(run, helper);
  });

  it.each([
    ["absent facts", undefined], ["closed before pipe creation", { pipeCreated: false }],
    ["missing pipe for a created root", { pipeCreated: false, inputClosed: false }],
    ["writer not closed", { inputClosed: false }], ["unrequested write", { writeRequested: true }],
    ["unrequested bytes", { bytesWritten: 1 }], ["unsupported version", { version: 2 }], ["extra facts", { extra: true }],
  ])("does not accept normal closure with %s", async (_label, changes) => {
    const { run, helper } = beginInput();
    completeRoot(helper, { targetInput: changes === undefined ? undefined : inputFinal(helper, changes as Record<string, unknown>) });
    await rejectedClosure(run, helper);
  });

  it("does not replace a missing ACK with a successful-looking complete payload", async () => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/); completeRoot(helper, { targetInput: inputFinal(helper) });
    await rejected; await rejectedClosure(run, helper);
  });

  it("preserves actual partial-write failure while rejecting the input promise", async () => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("partial"));
    const rejected = expect(writing).rejects.toThrow(/without.*acknowledgement/);
    completeRoot(helper, { targetInput: inputFinal(helper, { bytesWritten: 2 }), terminationReason: "input_write_failed" });
    helper.exit(); helper.close(); await rejected;
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, terminationReason: "input_write_failed", targetInput: { bytesWritten: 2 } });
  });

  it("records a setup failure before a pipe existed without fabricating a writer close", async () => {
    advertiseInput(); const { run, helper } = begin({ targetInput: INPUT_SELECTION }); helper.ready([INPUT_CAPABILITY]);
    helper.send("complete", noTargetFinal({ terminationReason: "stdin_pipe", failureCode: "stdin_pipe", nativeError: 5,
      targetInput: inputFinal(helper, { pipeCreated: false, inputClosed: false }) })); helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, terminationReason: "stdin_pipe", targetInput: { pipeCreated: false, inputClosed: false } });
  });

  it.each(["cancel", "input deadline"])("retains the request binding after %s without allowing a late ACK to restore success", async reason => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/);
    if (reason === "cancel") run.cancel(); else vi.advanceTimersByTime(5000);
    await rejected; acknowledgeInput(helper);
    const terminationReason = reason === "cancel" ? "cancelled" : "target_input_timeout";
    completeRoot(helper, { targetInput: inputFinal(helper), terminationReason: "cancelled" }); helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ cleanupConfirmed: true, terminationReason, failureCode: null });
  });

  it("checks the original ACK deadline even before its timer callback executes", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
      const rejected = expect(writing).rejects.toThrow(/cancelled/); clock.mockReturnValue(5100); acknowledgeInput(helper); await rejected;
      completeRoot(helper, { targetInput: inputFinal(helper), terminationReason: "cancelled" }); helper.exit(); helper.close();
      expect(await run.closed).toMatchObject({ terminationReason: "target_input_timeout" });
    } finally { clock.mockRestore(); }
  });

  it("never renews the earlier original operation deadline to await input", async () => {
    const { run, helper } = beginInput({ timeoutMs: 1000 }), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/); vi.advanceTimersByTime(1000); await rejected;
    completeRoot(helper, { targetInput: inputFinal(helper, { bytesWritten: 0 }), terminationReason: "timeout" }); helper.exit(); helper.close();
    expect(await run.closed).toMatchObject({ terminationReason: "timeout" });
  });

  it("settles outstanding input on helper loss while keeping closure unconfirmed", async () => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/closed before/);
    await rejectedClosure(run, helper, "missing_complete"); await rejected;
  });

  it("rejects new input after the actual helper exit observation", async () => {
    const { run, helper } = beginInput(); helper.exit();
    await expect(run.endInput!(Buffer.from("x"))).rejects.toThrow(/live target/);
    expect(helper.writes.some(write => write.kind === "target_input")).toBe(false);
    await rejectedClosure(run, helper, "missing_complete");
  });

  it("rejects outstanding input on the original control stream error", async () => {
    const { run, helper } = beginInput(), writing = run.endInput!(Buffer.from("x"));
    const rejected = expect(writing).rejects.toThrow(/cancelled/);
    helper.stdin.emit("error", new Error("controlled pipe error")); await rejected;
    expect(helper.writes.some(write => write.kind === "cancel")).toBe(true);
    await rejectedClosure(run, helper, "control_write");
  });
});
