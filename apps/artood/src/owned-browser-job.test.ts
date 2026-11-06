// Controlled native-owner integration only; filesystem/CDP/receipt facts are simulated.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend, WindowsOwnedClosureReceipt, WindowsOwnedProcess, WindowsOwnedStart } from "./owned/windows-owned-process.js";

const controlled = vi.hoisted(() => ({ start: vi.fn(), directSpawn: vi.fn(), connect: vi.fn(), observer: vi.fn(),
  backends: new WeakSet<object>(), receipts: new WeakSet<object>() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: controlled.directSpawn }));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: controlled.connect, executablePath: () => process.execPath } }));
vi.mock("./owned/windows-browser-session.js", () => ({ WindowsBrowserObserverSession: class { constructor() { controlled.observer(); throw new Error("Unexpected global observer"); } } }));
vi.mock("./owned/windows-owned-process.js", () => ({ startWindowsOwnedProcess: controlled.start,
  isWindowsOwnedClosureReceipt: (value: unknown) => typeof value === "object" && value !== null && controlled.receipts.has(value) }));
import { launchOwnedBrowser } from "./owned-browser.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const pid = 59110, directories: string[] = [], backend = Object.freeze({}) as PreparedWindowsProcessBackend;
let profile: string, resolveClosed: (receipt: WindowsOwnedClosureReceipt) => void;
let processOwner: WindowsOwnedProcess & { stdout: PassThrough; stderr: PassThrough; exitCode: number | null };
let closeConnection: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function receipt(changes: Partial<WindowsOwnedClosureReceipt> = {}): WindowsOwnedClosureReceipt {
  const value: WindowsOwnedClosureReceipt = Object.freeze({ version: 1, token: "controlled-only", elapsedMs: 1, rootCreated: true,
    rootStarted: true, rootPid: pid, rootCreationTime: "133806600000000000", atomicJobMember: true, rootWaitObserved: true,
    rootExitCode: processOwner.exitCode ?? 0, stdoutEof: true, stderrEof: true, jobEmptyObserved: true, noTargetCreated: false,
    terminationReason: null, nativeTerminationReason: null, failureCode: null, nativeError: null,
    outputBytesObserved: 0, outputBytesCaptured: 0, helperSpawnObserved: true, helperExitObserved: true, helperCloseObserved: true,
    helperExitCode: 0, helperSignal: null, cleanupConfirmed: true, ...changes });
  controlled.receipts.add(value); return value;
}
function exitRoot(code = 0) { processOwner.exitCode = code; processOwner.emit("exit", code, null); }
function complete(changes: Partial<WindowsOwnedClosureReceipt> = {}) {
  if (processOwner.exitCode === null) exitRoot(changes.rootExitCode ?? 0);
  resolveClosed(receipt(changes)); processOwner.stdout.end(); processOwner.stderr.end();
}
function workspace() { const path = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-browser-job-controlled-")); directories.push(path); return path; }
function launch(signal?: AbortSignal, launchTimeoutMs = 1000) {
  return launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath, windowsProcessBackend: backend, signal, launchTimeoutMs });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  vi.clearAllMocks(); controlled.backends.add(backend); profile = "";
  closeConnection = vi.fn().mockResolvedValue(undefined);
  send = vi.fn(async (method: string) => { if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ id: pid, type: "browser" }] }; complete(); return {}; });
  controlled.connect.mockImplementation(async () => ({ newBrowserCDPSession: async () => ({ send, detach: vi.fn().mockResolvedValue(undefined) }), close: closeConnection }));
  controlled.directSpawn.mockImplementation(() => { throw new Error("Unexpected direct process spawn"); });
  controlled.start.mockImplementation((value: object, input: WindowsOwnedStart) => {
    if (!controlled.backends.has(value)) throw new Error("Backend was not locally prepared");
    profile = input.cwd; directories.push(profile);
    writeFileSync(join(profile, "DevToolsActivePort"), ["32123", "/devtools/browser/controlled-job", ""].join(String.fromCharCode(10)));
    processOwner = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      started: Promise.resolve({ pid }), closed: new Promise<WindowsOwnedClosureReceipt>(resolve => { resolveClosed = resolve; }),
      cancel: vi.fn(() => complete({ rootExitCode: 0xe0000001, terminationReason: "cancelled", nativeTerminationReason: "cancelled" })) });
    return processOwner;
  });
});
afterEach(async () => {
  if (processOwner) { processOwner.stdout.destroy(); processOwner.stderr.destroy(); }
  await tick(); vi.useRealTimers(); vi.restoreAllMocks(); Object.defineProperty(process, "platform", originalPlatform);
  for (const path of directories.splice(0)) {
    if (!existsSync(path)) continue;
    expect(dirname(realpathSync.native(path))).toBe(realpathSync.native(tmpdir()));
    rmSync(path, { recursive: true, force: true });
  }
});

describe("owned browser with a locally prepared Windows Job backend", () => {
  it("keeps Chrome/CDP setup and removes the profile only after complete authenticated Job closure", async () => {
    const owned = await launch(); expect(owned.processId).toBe(pid);
    expect(controlled.observer).not.toHaveBeenCalled(); expect(controlled.directSpawn).not.toHaveBeenCalled();
    expect(controlled.start.mock.calls[0]![1]).toMatchObject({ normalExitPolicy: "terminate-descendants", timeoutMs: 43_200_000 });
    expect(controlled.start.mock.calls[0]![1].args).toContain("--remote-debugging-port=0");
    const first = owned.close(); expect(owned.close()).toBe(first); await first;
    expect(closeConnection).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(false);
  });
  it("does not substitute root exit for Job-empty/helper-close/pipe completion", async () => {
    const owned = await launch(); send.mockImplementation(async () => { exitRoot(); });
    const closing = owned.close(); await tick(); expect(existsSync(profile)).toBe(true);
    resolveClosed(receipt()); processOwner.stdout.end(); await tick(); expect(existsSync(profile)).toBe(true);
    processOwner.stderr.end(); await closing; expect(existsSync(profile)).toBe(false);
  });
  it("permits locally requested forced closure only with genuine clean native cancellation", async () => {
    const owned = await launch(); send.mockRejectedValue(new Error("Controlled graceful-close error")); await owned.close(); expect(processOwner.cancel).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(false);
  });
  it("binds the admitted CDP browser root to the native Job root within the launch deadline", async () => {
    send.mockResolvedValue({ processInfo: [{ id: pid + 1, type: "browser" }] });
    await expect(launch()).rejects.toThrow(/startup failed/); expect(existsSync(profile)).toBe(true);
    expect(processOwner.cancel).toHaveBeenCalledTimes(1); expect(closeConnection).toHaveBeenCalledTimes(1);
  });
  it("rejects a copied backend before direct Chrome or global observer fallback", async () => {
    const pending = launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath,
      windowsProcessBackend: JSON.parse(JSON.stringify(backend)) as PreparedWindowsProcessBackend });
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(pending).rejects.toThrow(/not locally prepared/);
    await tick(); await vi.advanceTimersByTimeAsync(3999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(controlled.observer).not.toHaveBeenCalled(); expect(controlled.directSpawn).not.toHaveBeenCalled();
  });
  it("rejects a backend on a non-Windows host before creating any process", async () => {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
    await expect(launch()).rejects.toThrow(/only on Windows/); expect(controlled.start).not.toHaveBeenCalled();
  });
  it("does not start a helper or observer for a pre-aborted native launch", async () => {
    const controller = new AbortController(); controller.abort();
    const pending = launch(controller.signal);
    let settled = false; void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await tick(); await vi.advanceTimersByTimeAsync(3999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected; expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(controlled.start).not.toHaveBeenCalled(); expect(controlled.observer).not.toHaveBeenCalled();
  });
  it("uses the remaining shared launch budget after backend preparation", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const start = controlled.start.getMockImplementation()!;
    controlled.start.mockImplementation((...args: unknown[]) => { const result = start(...args); clock.mockReturnValue(900); return result; });
    const owned = await launch(); expect(controlled.connect.mock.calls[0]![1].timeout).toBe(200); await owned.close();
  });
  it("retains the profile when backend startup consumes the original launch deadline", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const start = controlled.start.getMockImplementation()!;
    controlled.start.mockImplementation((...args: unknown[]) => { const result = start(...args); clock.mockReturnValue(1100); return result; });
    await expect(launch()).rejects.toThrow(/startup failed/); expect(controlled.connect).not.toHaveBeenCalled();
    expect(processOwner.cancel).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(true);
  });
  it("retains cancellation even when native closure is complete", async () => {
    const controller = new AbortController(), owned = await launch(controller.signal); controller.abort();
    await expect(owned.close()).rejects.toThrow(/launch or session failed/); expect(existsSync(profile)).toBe(true);
    expect(processOwner.cancel).toHaveBeenCalledTimes(1);
  });
  it("does not erase external cancellation arriving during a local close", async () => {
    const controller = new AbortController(), owned = await launch(controller.signal);
    send.mockImplementation(async () => { controller.abort(); });
    await expect(owned.close()).rejects.toThrow(/launch or session failed/); expect(existsSync(profile)).toBe(true);
  });
  it("treats unexpected root exit as a session failure even when the final Job receipt is clean", async () => {
    const owned = await launch(); complete(); await expect(owned.close()).rejects.toThrow(/launch or session failed/); expect(existsSync(profile)).toBe(true);
  });
  it.each(["timeout", "output_limit", "control_protocol"])("retains an earlier native %s despite local cancel", async nativeReason => {
    const owned = await launch(); send.mockRejectedValue(new Error("Controlled close request failed"));
    vi.mocked(processOwner.cancel).mockImplementation(() => complete({ rootExitCode: 0xe0000001, terminationReason: "cancelled", nativeTerminationReason: nativeReason }));
    await expect(owned.close()).rejects.toThrow(/ended abnormally/); expect(existsSync(profile)).toBe(true);
  });
  it("retains a serialized receipt even when all its facts look complete", async () => {
    const owned = await launch(); send.mockImplementation(async () => {
      exitRoot(); resolveClosed(JSON.parse(JSON.stringify(receipt())) as WindowsOwnedClosureReceipt); processOwner.stdout.end(); processOwner.stderr.end();
    });
    await expect(owned.close()).rejects.toThrow(/unconfirmed/); expect(existsSync(profile)).toBe(true);
  });
  it("bounds an unconfirmed close once, with no late profile removal after a delayed receipt", async () => {
    const owned = await launch(); send.mockImplementation(async () => { exitRoot(); });
    const closing = owned.close(); const rejected = expect(closing).rejects.toThrow(/close deadline elapsed/);
    await vi.advanceTimersByTimeAsync(10000); await rejected; expect(owned.close()).toBe(closing); expect(existsSync(profile)).toBe(true);
    complete(); await tick(); expect(existsSync(profile)).toBe(true);
  });
  it("retains a late CDP connection after launch timeout and disconnects it without reviving admission", async () => {
    let connected!: (value: unknown) => void;
    controlled.connect.mockImplementation(() => new Promise(resolve => { connected = resolve; }));
    const pending = launch(); const rejected = expect(pending).rejects.toThrow(/startup failed/);
    await tick(); await vi.advanceTimersByTimeAsync(1000); await rejected; expect(existsSync(profile)).toBe(true);
    connected({ close: closeConnection }); await tick(); expect(closeConnection).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(true);
  });
});
