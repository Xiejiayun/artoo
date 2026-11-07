import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnedGitError, runOwnedGit, type OwnedGitReceipt, type OwnedGitOptions } from "./owned/owned-git.js";
import { ProtectedCommandError, runProtectedCommand } from "./protected-command.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
import type { PreparedWindowsProcessBackend, WindowsOwnedClosureReceipt, WindowsOwnedProcess } from "./owned/windows-owned-process.js";

const bridge = vi.hoisted(() => ({ start: vi.fn(), backends: new WeakSet<object>(), receipts: new WeakSet<object>() }));
vi.mock("./owned/windows-owned-process.js", () => ({
  assertWindowsProcessBackend: (value: object) => { if (!bridge.backends.has(value)) throw new Error("Unprepared backend"); },
  startWindowsOwnedProcess: bridge.start,
  isWindowsOwnedClosureReceipt: (value: object) => bridge.receipts.has(value),
}));
vi.mock("./owned/owned-git.js", async (load) => ({ ...await load<typeof import("./owned/owned-git.js")>(), runOwnedGit: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.unstubAllEnvs(); vi.clearAllMocks(); bridge.start.mockReset(); });
function onWindows() {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
}
function backend(): PreparedWindowsProcessBackend {
  const value = Object.freeze({}) as PreparedWindowsProcessBackend; bridge.backends.add(value); return value;
}
function receipt(patch: Partial<WindowsOwnedClosureReceipt> = {}): WindowsOwnedClosureReceipt {
  const value: WindowsOwnedClosureReceipt = { version: 1, token: "controlled-fixture", elapsedMs: 42,
    rootCreated: true, rootStarted: true, rootPid: 1234, rootCreationTime: "1000", atomicJobMember: true,
    rootWaitObserved: true, rootExitCode: 0, stdoutEof: true, stderrEof: true, jobEmptyObserved: true,
    noTargetCreated: false, terminationReason: null, nativeTerminationReason: null, failureCode: null, nativeError: null,
    outputBytesObserved: 0, outputBytesCaptured: 0, helperSpawnObserved: true, helperExitObserved: true,
    helperCloseObserved: true, helperExitCode: 0, helperSignal: null, cleanupConfirmed: true, ...patch };
  bridge.receipts.add(value); return value;
}
function processFixture() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (value: WindowsOwnedClosureReceipt) => void, reject!: (error: Error) => void;
  const closed = new Promise<WindowsOwnedClosureReceipt>((ok, fail) => { resolve = ok; reject = fail; });
  const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: 1234, exitCode: null, signalCode: null,
    started: Promise.resolve({ pid: 1234 }), closed, cancel: vi.fn() }) satisfies WindowsOwnedProcess;
  bridge.start.mockReturnValue(child);
  return { child, finish: (value = receipt()) => { stdout.end(); stderr.end(); resolve(value); },
    fail: () => { stdout.end(); stderr.end(); reject(new Error("controlled helper loss")); } };
}
const request = { cwd: "C:\\Product", args: ["check.mjs"], kind: "materialize" as const };
const options: OwnedGitOptions = { gitExecutable: "C:\\Node\\node.exe", readTimeoutMs: 100, materializeTimeoutMs: 900,
  maxOutputBytes: 1024, guardParent: true, environment: { PATH: "controlled-path", LANG: "C.UTF-8" } };

describe("ordinary protected command routing (controlled bridge fixtures, not native qualification)", () => {
  it("delegates POSIX options unchanged and does not manufacture group receipts", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    vi.mocked(runOwnedGit).mockResolvedValue({ status: 7, stdout: Buffer.from("out"), stderr: Buffer.from("err"),
      receipt: { elapsedMs: 9, cleanupConfirmed: true } as OwnedGitReceipt });
    expect(await runProtectedCommand(request, options)).toEqual({ status: 7, stdout: Buffer.from("out"), stderr: Buffer.from("err"), elapsedMs: 9 });
    expect(vi.mocked(runOwnedGit).mock.calls[0]![0]).toBe(request);
    expect(vi.mocked(runOwnedGit).mock.calls[0]![1]).toBe(options);
    expect(bridge.start).not.toHaveBeenCalled();
  });
  it("preserves POSIX safe failures and retains cleanup uncertainty", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    const safe = new OwnedGitError("timeout", { cleanupConfirmed: true } as OwnedGitReceipt, Buffer.alloc(0), Buffer.alloc(0));
    vi.mocked(runOwnedGit).mockRejectedValueOnce(safe);
    await expect(runProtectedCommand(request, options)).rejects.toBe(safe);
    vi.mocked(runOwnedGit).mockRejectedValueOnce(new OwnedGitError("cleanup_uncertain", { cleanupConfirmed: false } as OwnedGitReceipt, Buffer.alloc(0), Buffer.alloc(0)));
    await expect(runProtectedCommand(request, options)).rejects.toBeInstanceOf(VerificationCleanupError);
  });
  it("refuses Windows without local authority, including a serialized backend lookalike", async () => {
    onWindows();
    await expect(runProtectedCommand(request, options)).rejects.toThrow(/locally prepared/);
    await expect(runProtectedCommand(request, options, {} as PreparedWindowsProcessBackend)).rejects.toThrow(/Unprepared/);
    expect(bridge.start).not.toHaveBeenCalled(); expect(runOwnedGit).not.toHaveBeenCalled();
  });
  it("keeps budgets and stripped local environment, using unique Windows keys and the null device", async () => {
    onWindows(); vi.stubEnv("NODE_OPTIONS", "--import=untrusted"); vi.stubEnv("PYTHONSTARTUP", "untrusted.py"); vi.stubEnv("PROVIDER_TOKEN", "fixture-secret");
    const f = processFixture(), controller = new AbortController();
    const pending = runProtectedCommand({ ...request, signal: controller.signal }, { ...options, environment: {
      ...options.environment, path: "last-path", git_config_global: "untrusted", systemroot: "wrong", windir: "wrong" } }, backend());
    const input = bridge.start.mock.calls[0]![1];
    expect(input).toMatchObject({ executable: options.gitExecutable, cwd: request.cwd, timeoutMs: 900, maxOutputBytes: 1024,
      cleanupTimeoutMs: 5000, normalExitPolicy: "require-empty", normalExitGraceMs: 250, signal: controller.signal });
    expect(input.args).toEqual(request.args); expect(input.args).not.toBe(request.args);
    const keys = Object.keys(input.env).map(key => key.toUpperCase()); expect(new Set(keys).size).toBe(keys.length);
    expect(input.env).toMatchObject({ path: "last-path", SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", GIT_CONFIG_GLOBAL: "NUL",
      GIT_CONFIG_VALUE_1: "NUL", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0" });
    expect(keys).not.toContain("NODE_OPTIONS"); expect(keys).not.toContain("PYTHONSTARTUP"); expect(keys).not.toContain("PROVIDER_TOKEN");
    f.child.stdout.write("stdout"); f.child.stderr.write("stderr"); f.finish();
    expect(await pending).toEqual({ status: 0, stdout: Buffer.from("stdout"), stderr: Buffer.from("stderr"), elapsedMs: 42 });
  });
  it("does not settle on root exit before confirmed helper and output closure", async () => {
    onWindows(); const f = processFixture(); let settled = false;
    const pending = runProtectedCommand(request, options, backend()).then(result => { settled = true; return result; });
    f.child.emit("exit", 0, null); await Promise.resolve(); expect(settled).toBe(false);
    f.finish(); await pending; expect(settled).toBe(true);
  });
  it.each([0, 7, 259])("preserves a closed process's exact exit code %s", async status => {
    onWindows(); const f = processFixture(), pending = runProtectedCommand({ ...request, kind: "read" }, options, backend());
    expect(bridge.start.mock.calls[0]![1].timeoutMs).toBe(100);
    f.finish(receipt({ rootExitCode: status })); expect((await pending).status).toBe(status);
  });
  it.each([["cancelled", "aborted"], ["timeout", "timeout"], ["output_limit", "output_limit"],
    ["lingering_processes", "lingering_processes"], ["normal_exit_descendants", "execution_failed"]])(
    "does not turn cleaned %s into command success", async (terminationReason, code) => {
      onWindows(); const f = processFixture(), pending = runProtectedCommand(request, options, backend());
      f.finish(receipt({ terminationReason })); await expect(pending).rejects.toMatchObject({ name: "ProtectedCommandError", code, status: 0 });
    });
  it("keeps safe creation failure separate from cleanup uncertainty", async () => {
    onWindows(); const f = processFixture(), pending = runProtectedCommand(request, options, backend());
    f.finish(receipt({ rootCreated: false, rootStarted: false, rootExitCode: null, noTargetCreated: true, failureCode: "create_failed" }));
    await expect(pending).rejects.toBeInstanceOf(ProtectedCommandError);
  });
  it.each(["rejected", "unbranded", "unconfirmed"])("retains unknown closure for %s", async kind => {
    onWindows(); const f = processFixture(), pending = runProtectedCommand(request, options, backend());
    if (kind === "rejected") f.fail();
    else if (kind === "unbranded") f.finish({ ...receipt() });
    else f.finish(receipt({ cleanupConfirmed: false }));
    await expect(pending).rejects.toBeInstanceOf(VerificationCleanupError);
  });
});
