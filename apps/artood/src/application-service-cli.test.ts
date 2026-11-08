// Entrypoint routing and signal ownership only; every native/HTTP owner is mocked.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./windows-process-installation.js";
import * as profile from "./application-service-profile.js";
import * as local from "./application-local-service.js";
import * as runner from "./node-runner.js";
import * as adapter from "./process-adapter.js";
import * as broker from "./application-broker-process.js";
import * as runtime from "./application-runtime-process.js";
vi.mock("node:http", async importOriginal => ({ ...await importOriginal<typeof import("node:http")>(),
  createServer: vi.fn(() => { throw Error("No actual HTTP listener in routing test"); }) }));
import { runDaemonEntrypoint, type ShutdownHost } from "./main.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
const authority = Object.freeze({}) as profile.PreparedApplicationServiceProfile;
const env = { ARTOO_APPLICATION_SERVICE_PROFILE_FILE: join(process.cwd(), "local-profile.json"), ARTOO_NODE_ID: "node1",
  ARTOO_ALLOWED_ROOTS: process.cwd(), ARTOO_WINDOWS_PROCESS_BUNDLE: process.cwd(), ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: `sha256:${"a".repeat(64)}` };
function host(args: string[] = ["--serve-application"]): ShutdownHost & EventEmitter {
  return Object.assign(new EventEmitter(), { argv: ["node", "main.js", ...args], exit: vi.fn() });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let count = 0; count < 100; count++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } throw Error("Controlled entrypoint did not reach expected state"); }
let closed: ReturnType<typeof deferred<void>>, service: local.LocalApplicationService;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(backend);
  vi.spyOn(profile, "prepareApplicationServiceProfile").mockReturnValue(authority);
  vi.spyOn(local, "initializeApplicationStore").mockResolvedValue({ normalShutdown: true } as broker.ApplicationBrokerProcessReceipt);
  closed = deferred(); service = { origin: "http://127.0.0.1:31000", closed: closed.promise, close: vi.fn(() => closed.promise) };
  vi.spyOn(local, "startLocalApplicationService").mockResolvedValue(service);
  vi.spyOn(runner, "createArtoodNode").mockImplementation(() => { throw Error("No node construction in standalone service routing"); });
  vi.spyOn(adapter, "createProcessAdapter").mockImplementation(() => { throw Error("No adapter construction in standalone service routing"); });
  vi.spyOn(broker, "startApplicationBrokerProcess").mockImplementation(() => { throw Error("No actual broker in routing test"); });
  vi.spyOn(runtime, "startApplicationRuntimeProcess").mockImplementation(() => { throw Error("No actual runtime in routing test"); });
  vi.mocked(http.createServer).mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
describe("standalone local application selectors", () => {
  it("initializes only through the separate create command and preserves its actual receipt", async () => {
    const owner = host(["--initialize-application-store"]); await runDaemonEntrypoint(env, owner);
    expect(local.initializeApplicationStore).toHaveBeenCalledWith(authority, expect.any(AbortSignal));
    expect(local.startLocalApplicationService).not.toHaveBeenCalled(); expect(runner.createArtoodNode).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toMatchObject({ kind: "application-store.initialized", qualified_for_product: false, receipt: { normalShutdown: true } });
    expect(owner.listenerCount("SIGINT")).toBe(0); expect(owner.listenerCount("SIGTERM")).toBe(0);
  });
  it("serves without a provider/server connection and waits for original closure after SIGINT", async () => {
    const owner = host(), work = runDaemonEntrypoint(env, owner); await until(() => vi.mocked(console.log).mock.calls.length > 0);
    expect(profile.prepareApplicationServiceProfile).toHaveBeenCalledWith({ file: env.ARTOO_APPLICATION_SERVICE_PROFILE_FILE,
      nodeId: "node1", allowedRoots: [process.cwd()], backend });
    owner.emit("SIGINT"); expect(service.close).toHaveBeenCalledOnce();
    let done = false; void work.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    closed.resolve(); await work; expect(owner.listenerCount("SIGINT")).toBe(0);
    expect(local.initializeApplicationStore).not.toHaveBeenCalled(); expect(http.createServer).not.toHaveBeenCalled();
  });
  it("retains a signal during asynchronous listener startup and does not report listening", async () => {
    const startup = deferred<local.LocalApplicationService>(); vi.mocked(local.startLocalApplicationService).mockReturnValue(startup.promise);
    const owner = host(), work = runDaemonEntrypoint(env, owner); await until(() => vi.mocked(local.startLocalApplicationService).mock.calls.length > 0);
    owner.emit("SIGTERM"); startup.resolve(service); await until(() => vi.mocked(service.close).mock.calls.length > 0);
    expect(console.log).not.toHaveBeenCalled(); closed.resolve(); await work;
    const messages = vi.mocked(console.log).mock.calls.map(call => JSON.parse(call[0] as string).kind);
    expect(messages).toEqual(["application-service.closed"]);
  });
  it("closes and awaits the original listener if readiness reporting throws after startup", async () => {
    vi.mocked(console.log).mockImplementationOnce(() => { throw Error("controlled readiness output failure"); });
    const owner = host(), work = runDaemonEntrypoint(env, owner);
    let done = false; void work.catch(() => { done = true; }); await until(() => vi.mocked(service.close).mock.calls.length > 0);
    expect(done).toBe(false); closed.resolve(); await expect(work).rejects.toThrow("controlled readiness output failure");
    expect(owner.listenerCount("SIGINT")).toBe(0);
    expect(JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string).service_cleanup).toEqual([{ status: "fulfilled" }, { status: "fulfilled" }]);
  });
  it.each(["--initialize-application-store", "--windows-supervised", "--check-application-broker-profile", "--file=remote.json", "task text"])
    ("rejects mixed selectors and arbitrary argv: %s", async extra => {
      await expect(runDaemonEntrypoint(env, host(["--serve-application", extra]))).rejects.toThrow("one standalone selector");
      expect(installation.prepareWindowsProcessInstallation).not.toHaveBeenCalled();
    });
  it.each(["--serve-application=remote.json", "--initialize-application-store=remote.json"])("rejects equals-form selector %s", async selector => {
    await expect(runDaemonEntrypoint(env, host([selector]))).rejects.toThrow("one standalone selector");
  });
  it.each([true, false])("rejects IPC-owned workers connected=%s", async connected => {
    await expect(runDaemonEntrypoint(env, Object.assign(host(), { connected }))).rejects.toThrow("standalone");
  });
  it.each(["ARTOO_WORKER_LAUNCH_ID", "ARTOO_WORKTREE_BASE_REPO", "ARTOO_OWNED_RESULT_PROFILES_FILE", "ARTOO_MANAGED_EXECUTION", "ARTOO_JOURNAL_VERSION"])
    ("rejects incompatible local setting %s", async key => {
      await expect(runDaemonEntrypoint({ ...env, [key]: "0" }, host())).rejects.toThrow("ordinary local node settings");
    });
  it.each(["ARTOO_APPLICATION_SERVICE_PROFILE_FILE", "ARTOO_NODE_ID", "ARTOO_ALLOWED_ROOTS"])("requires %s", async key => {
    await expect(runDaemonEntrypoint({ ...env, [key]: "" }, host())).rejects.toThrow("absolute local profile file");
  });
  it("does not fall back to ordinary startup on profile admission failure", async () => {
    vi.mocked(profile.prepareApplicationServiceProfile).mockImplementation(() => { throw Error("strict metadata mismatch"); });
    const owner = host(); await expect(runDaemonEntrypoint(env, owner)).rejects.toThrow("strict metadata mismatch");
    expect(local.startLocalApplicationService).not.toHaveBeenCalled(); expect(runner.createArtoodNode).not.toHaveBeenCalled(); expect(console.log).not.toHaveBeenCalled();
    expect(owner.listenerCount("SIGINT")).toBe(0); expect(console.error).toHaveBeenCalledOnce();
  });
  it("does not select the application commands merely because a profile environment variable exists", async () => {
    await expect(runDaemonEntrypoint(env, host([]))).rejects.toThrow("ARTOO_NODE_URL"); expect(profile.prepareApplicationServiceProfile).not.toHaveBeenCalled();
  });
});
