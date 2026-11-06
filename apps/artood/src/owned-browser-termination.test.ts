import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchOwnedBrowser } from "./owned-browser.js";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), observe: vi.fn(), audit: vi.fn(), bind: vi.fn(), abort: vi.fn(), cleanup: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: fixture.spawn }));
vi.mock("playwright", () => ({ chromium: { connectOverCDP: fixture.connect, executablePath: () => process.execPath } }));
// Observer transport/actual-close ordering is independently tested. These cases
// keep the launcher's real shutdown state machine and controlled browser child.
vi.mock("./owned/windows-browser-session.js", () => ({ WindowsBrowserObserverSession: class {
  failed = false; completed = false;
  bind(pid: number) { return fixture.bind(pid); }
  observe() { return this.failed ? Promise.reject(new Error("Controlled observer is tainted")) : fixture.observe(); }
  async finalAudit(remaining: number) {
    if (this.failed) throw new Error("Controlled observer is tainted");
    const result = await fixture.audit(remaining) as number[]; if (!result.length) this.completed = true; return result;
  }
  abort() { this.failed = true; fixture.abort(); }
  cleanup() { return fixture.cleanup(); }
  assertCompleted() { if (this.failed || !this.completed) throw new Error("Controlled observer closure unconfirmed"); }
} }));

const parentPid = 902101, directories: string[] = [];
let child: EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; kill: ReturnType<typeof vi.fn> };
let profile: string;
beforeEach(() => {
  vi.clearAllMocks();
  child = Object.assign(new EventEmitter(), { pid: parentPid, exitCode: null as number | null, signalCode: null as string | null, kill: vi.fn() });
  fixture.spawn.mockImplementation((_executable: string, argv: string[]) => {
    profile = argv.find(value => value.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    directories.push(profile); writeFileSync(join(profile, "DevToolsActivePort"), "32123\n/devtools/browser/controlled-fixture\n");
    return child;
  });
  fixture.connect.mockResolvedValue({ newBrowserCDPSession: async () => ({ send: async (method: string) => {
    if (method === "SystemInfo.getProcessInfo") return { processInfo: [{ id: parentPid }] };
    throw new Error("Controlled graceful-close failure");
  } }), close: vi.fn().mockResolvedValue(undefined) });
  fixture.observe.mockResolvedValue([parentPid]); fixture.audit.mockResolvedValue([]);
  fixture.bind.mockResolvedValue(undefined); fixture.cleanup.mockResolvedValue(undefined);
  // Controlled PID probe only: this test is not a native Windows process measurement.
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    if (!existsSync(directory)) continue;
    expect(dirname(realpathSync.native(directory))).toBe(realpathSync.native(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});
function workspace() {
  const value = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-browser-termination-test-")); directories.push(value); return value;
}
describe.runIf(process.platform === "win32")("Windows browser termination uses its original ChildProcess", () => {
  it("kills the original child and still requires parent close and final empty audit before profile removal", async () => {
    child.kill.mockImplementation(() => { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); return true; });
    const owned = await launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath });
    await owned.close();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(fixture.spawn).toHaveBeenCalledTimes(1); // No taskkill process or PID tree scan.
    expect(fixture.audit).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(false);
    expect(fixture.abort).not.toHaveBeenCalled(); // Expected browser exit does not poison final drain.
  });
  it("does not treat kill failure or disappearing PIDs as actual parent close", async () => {
    child.kill.mockReturnValue(false);
    const owned = await launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath });
    await expect(owned.close()).rejects.toThrow("process exit remains unconfirmed");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(fixture.spawn).toHaveBeenCalledTimes(1); expect(fixture.audit).not.toHaveBeenCalled();
    expect(existsSync(profile)).toBe(true);
  });
  it("rejects a pre-aborted launch before creating Chrome", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
  it("uses the remaining shared launch deadline instead of granting CDP a new minimum timeout", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    child.kill.mockImplementation(() => { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); return true; });
    const original = await fixture.connect.getMockImplementation()!();
    fixture.connect.mockImplementation(async (_endpoint: string, options: { timeout: number }) => {
      expect(options.timeout).toBe(1000); clock.mockReturnValue(1100); return original;
    });
    await expect(launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath, launchTimeoutMs: 1000 })).rejects.toThrow("Browser startup failed");
    expect(fixture.bind).not.toHaveBeenCalled(); expect(fixture.abort).toHaveBeenCalled(); expect(existsSync(profile)).toBe(true);
  });
  it("wires active cancellation to both locally owned resources and retains a tainted profile", async () => {
    child.kill.mockImplementation(() => { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); return true; });
    const controller = new AbortController();
    const owned = await launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath, signal: controller.signal });
    controller.abort();
    await expect(owned.close()).rejects.toThrow("process exit remains unconfirmed");
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL"); expect(fixture.abort).toHaveBeenCalled();
    expect(fixture.cleanup).toHaveBeenCalledTimes(1); expect(existsSync(profile)).toBe(true);
  });
  it("cleans the observer on unexpected browser exit without converting it into accepted shutdown", async () => {
    const owned = await launchOwnedBrowser({ workspace: workspace(), executablePath: process.execPath });
    child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null);
    await expect(owned.close()).rejects.toThrow("process exit remains unconfirmed");
    expect(fixture.abort).toHaveBeenCalled(); expect(existsSync(profile)).toBe(true);
  });
});
