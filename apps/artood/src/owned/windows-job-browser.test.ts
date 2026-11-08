// Controlled API/stream/receipt regressions only. No Windows process is launched.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend, WindowsOwnedClosureReceipt, WindowsOwnedProcess } from "./windows-owned-process.js";

const bridge = vi.hoisted(() => ({ start: vi.fn(), backends: new WeakSet<object>(), receipts: new WeakSet<object>() }));
vi.mock("./windows-owned-process.js", () => ({
  startWindowsOwnedProcess: bridge.start,
  isWindowsOwnedClosureReceipt: (value: unknown) => typeof value === "object" && value !== null && bridge.receipts.has(value),
}));
import { assertWindowsBrowserSessionClosure, startWindowsJobBrowserProcess } from "./windows-job-browser.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pid = 47111;
let child: WindowsOwnedProcess & { stdout: PassThrough; stderr: PassThrough };
let resolveStarted: (value: { pid: number }) => void, rejectStarted: (error: Error) => void;
let resolveClosed: (value: WindowsOwnedClosureReceipt) => void, rejectClosed: (error: Error) => void;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
const input = { executable: "C:/tools/chrome.exe", args: ["--headless"], cwd: "C:/profiles/test", env: { SystemRoot: "C:/Windows" } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function receipt(overrides: Partial<WindowsOwnedClosureReceipt> = {}): WindowsOwnedClosureReceipt {
  const value: WindowsOwnedClosureReceipt = Object.freeze({ version: 1, token: "controlled-only", elapsedMs: 1,
    rootCreated: true, rootStarted: true, rootPid: pid, rootCreationTime: "133806600000000000", atomicJobMember: true,
    rootWaitObserved: true, rootExitCode: 0, stdoutEof: true, stderrEof: true, jobEmptyObserved: true, noTargetCreated: false,
    terminationReason: null, nativeTerminationReason: null, failureCode: null, nativeError: null,
    outputBytesObserved: 0, outputBytesCaptured: 0, helperSpawnObserved: true, helperExitObserved: true,
    helperCloseObserved: true, helperExitCode: 0, helperSignal: null, cleanupConfirmed: true, ...overrides });
  bridge.receipts.add(value); return value;
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  bridge.backends.add(backend); bridge.start.mockReset();
  child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    started: new Promise<{ pid: number }>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; }),
    closed: new Promise<WindowsOwnedClosureReceipt>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; }), cancel: vi.fn() });
  void child.started.catch(() => {}); void child.closed.catch(() => {});
  bridge.start.mockImplementation((value: object) => { if (!bridge.backends.has(value)) throw new Error("Backend was not locally prepared"); return child; });
});
afterEach(async () => {
  rejectStarted(new Error("Controlled teardown")); rejectClosed(new Error("Controlled teardown"));
  child.stdout.destroy(); child.stderr.destroy(); await tick();
  Object.defineProperty(process, "platform", platform);
});
function begin() { const owner = startWindowsJobBrowserProcess(backend, input); resolveStarted({ pid }); return owner; }
function endStreams() { child.stdout.end(); child.stderr.end(); }

describe("Windows browser Job owner", () => {
  it("uses the genuine backend, fixed lifetime/output bounds and descendant termination without changing caller arguments", async () => {
    const signal = new AbortController().signal;
    const owner = startWindowsJobBrowserProcess(backend, { ...input, signal }); resolveStarted({ pid });
    expect(bridge.start).toHaveBeenCalledExactlyOnceWith(backend, { ...input, signal, timeoutMs: 43_200_000,
      maxOutputBytes: 67_108_864, cleanupTimeoutMs: 5000, normalExitPolicy: "terminate-descendants", normalExitGraceMs: 250 });
    expect(await owner.started).toEqual({ pid });
    owner.cancel(); owner.cancel(); expect(child.cancel).toHaveBeenCalledTimes(1);
    const original = receipt(); resolveClosed(original); endStreams(); expect(await owner.closed).toBe(original);
  });
  it("rejects an unprepared backend without a fallback", () => {
    expect(() => startWindowsJobBrowserProcess({} as PreparedWindowsProcessBackend, input)).toThrow(/not locally prepared/);
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });
  it("rejects an explicitly supplied backend outside Windows before native start", () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(() => startWindowsJobBrowserProcess(backend, input)).toThrow(/only on Windows/); expect(bridge.start).not.toHaveBeenCalled();
  });
  it("consumes both pipes and waits for both actual readable completions after the bridge receipt", async () => {
    const owner = begin(); let done = false; void owner.closed.then(() => { done = true; });
    child.stdout.write(Buffer.alloc(256 * 1024)); child.stderr.write(Buffer.alloc(256 * 1024));
    resolveClosed(receipt()); child.stdout.end(); await tick(); expect(done).toBe(false);
    child.stderr.end(); await owner.closed; expect(done).toBe(true); expect(child.stdout.readableLength).toBe(0); expect(child.stderr.readableLength).toBe(0);
  });
  it("rejects a serialized copy even when every field matches an authentic receipt", async () => {
    const owner = begin(); resolveClosed(JSON.parse(JSON.stringify(receipt())) as WindowsOwnedClosureReceipt); endStreams();
    await expect(owner.closed).rejects.toThrow(/closure is unconfirmed/);
  });
  it.each([
    ["root mismatch", { rootPid: pid + 1 }], ["root wait", { rootWaitObserved: false }], ["membership", { atomicJobMember: false }],
    ["Job empty", { jobEmptyObserved: false }], ["stdout EOF", { stdoutEof: false }], ["stderr EOF", { stderrEof: false }],
    ["helper close", { helperCloseObserved: false }], ["helper exit", { helperExitObserved: false }],
    ["helper status", { helperExitCode: 1 }], ["cleanup", { cleanupConfirmed: false }],
  ] satisfies [string, Partial<WindowsOwnedClosureReceipt>][]) ("retains on missing %s proof", async (_name, changes) => {
    const owner = begin(); resolveClosed(receipt(changes)); endStreams(); await expect(owner.closed).rejects.toThrow(/profile is retained/);
  });
  it("rejects a mismatched original started PID and cancels only once", async () => {
    const owner = startWindowsJobBrowserProcess(backend, input); resolveStarted({ pid: pid + 1 });
    await expect(owner.started).rejects.toThrow(/root identity/);
    resolveClosed(receipt()); endStreams(); await expect(owner.closed).rejects.toThrow(/root identity/);
    expect(child.cancel).toHaveBeenCalledTimes(1);
  });
  it("preserves a pipe error even if a genuine bridge closure later arrives", async () => {
    const owner = begin(); child.stdout.destroy(new Error("Controlled broken stdout")); await tick();
    expect(child.cancel).toHaveBeenCalledTimes(1); resolveClosed(receipt()); child.stderr.end();
    await expect(owner.closed).rejects.toThrow("Controlled broken stdout");
  });
  it("accepts authenticated no-target cleanup only for draining a failed launch, never a healthy session", async () => {
    Object.defineProperty(child, "pid", { value: undefined });
    const owner = startWindowsJobBrowserProcess(backend, input); rejectStarted(new Error("Controlled no target"));
    const value = receipt({ rootCreated: false, rootStarted: false, rootPid: null, rootCreationTime: null,
      atomicJobMember: false, rootWaitObserved: false, rootExitCode: null, stdoutEof: false, stderrEof: false,
      jobEmptyObserved: false, noTargetCreated: true, terminationReason: "cancelled", nativeTerminationReason: "cancelled" });
    resolveClosed(value); endStreams(); expect(await owner.closed).toBe(value);
    expect(() => assertWindowsBrowserSessionClosure(value, true)).toThrow(/session failed/);
  });
  it("does not convert rejected native closure into a passed receipt", async () => {
    const owner = begin(); rejectClosed(new Error("Controlled unconfirmed native closure")); endStreams();
    await expect(owner.closed).rejects.toThrow("Controlled unconfirmed native closure"); expect(child.cancel).toHaveBeenCalledTimes(1);
  });
});

describe("cleanup is separate from browser session acceptance", () => {
  it("accepts normal root exit with separately terminated descendants", () => {
    expect(() => assertWindowsBrowserSessionClosure(receipt({ terminationReason: "normal_exit_descendants", nativeTerminationReason: "normal_exit_descendants" }), false)).not.toThrow();
  });
  it("accepts the fixed native termination code only for locally requested close cancellation", () => {
    const value = receipt({ rootExitCode: 0xe0000001, terminationReason: "cancelled", nativeTerminationReason: "cancelled" });
    expect(() => assertWindowsBrowserSessionClosure(value, true)).not.toThrow();
    expect(() => assertWindowsBrowserSessionClosure(value, false)).toThrow(/ended abnormally/);
  });
  it.each(["timeout", "output_limit", "control_protocol", "parent_eof"])("does not hide earlier %s behind local cancellation", nativeReason => {
    expect(() => assertWindowsBrowserSessionClosure(receipt({ terminationReason: "cancelled", nativeTerminationReason: nativeReason }), true)).toThrow(/ended abnormally/);
  });
  it("rejects nonzero root failure and lost output despite complete cleanup", () => {
    expect(() => assertWindowsBrowserSessionClosure(receipt({ rootExitCode: 7, terminationReason: "cancelled", nativeTerminationReason: "cancelled" }), true)).toThrow(/ended abnormally/);
    expect(() => assertWindowsBrowserSessionClosure(receipt({ outputBytesObserved: 2, outputBytesCaptured: 1 }), false)).toThrow(/session failed/);
    expect(() => assertWindowsBrowserSessionClosure(receipt({ failureCode: "terminate_job" }), false)).toThrow(/session failed/);
  });
});
