// Controlled node lifecycle; this suite never launches a helper or opens a source store.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./windows-process-installation.js";
import * as runner from "./node-runner.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { main, type ShutdownHost } from "./main.js";
import { withWindowsStartupDiagnostics, type WindowsStartupDiagnostic } from "./windows-startup-diagnostics.js";
import * as sourceConfiguration from "./product-source-config.js";
import * as bootstrapGit from "./product-bootstrap-git.js";
import * as processAdapter from "./process-adapter.js";
import type { PreparedWindowsReleaseStorage } from "./windows-release-storage.js";
import { join } from "node:path";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(Object.freeze({}) as PreparedWindowsProcessBackend);
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
const env = { ARTOO_NODE_URL: "wss://control.example/api/v1/node?token=fixture", ARTOO_NODE_ID: "node", ARTOO_RUNTIMES: "codex",
  ARTOO_ALLOWED_ROOTS: process.cwd(), ARTOO_WINDOWS_PROCESS_BUNDLE: process.cwd(), ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: `sha256:${"a".repeat(64)}`,
  ARTOO_PRODUCT_SOURCE_CONFIG_FILE: process.cwd() + "/source.json" };
function fixture() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const executionReady = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void executionReady.catch(() => {});
  const node = { start: vi.fn(async () => {}), stop: vi.fn(async () => { reject(Error("stopped before ACK")); }), executionReady };
  const create = vi.spyOn(runner, "createArtoodNode").mockReturnValue(node);
  const host = Object.assign(new EventEmitter(), { exit: vi.fn(), argv: ["node.exe", "artood.mjs", "--windows-supervised-daemon"] });
  return { node, create, host, resolve, reject };
}
describe("controlled daemon registration gate", () => {
  it("projects configuration failure before cleanup without exposing the cause", async () => {
    const f = fixture(), diagnostics: WindowsStartupDiagnostic[] = [];
    vi.spyOn(installation, "prepareWindowsProcessInstallation").mockImplementation(() => { throw Error("sensitive configuration path or key"); });
    await expect(withWindowsStartupDiagnostics(value => diagnostics.push(value), () => main(env, f.host as ShutdownHost, async () => {})))
      .rejects.toThrow("sensitive configuration path or key");
    expect(diagnostics.at(-1)).toMatchObject({ phase: "load_configuration", status: "failed", error_code: "startup_stage_failed" });
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive"); expect(f.create).not.toHaveBeenCalled();
  });
  it("emits readiness only after the actual source readiness promise", async () => {
    const f = fixture(), ready = vi.fn(async () => {}); const starting = main(env, f.host as ShutdownHost, ready);
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled(); f.resolve(); await starting;
    expect(ready).toHaveBeenCalledTimes(1); expect(f.create.mock.calls[0]![0].requireSupervisorLifetime).toBe(true);
    f.host.emit("message", { type: "shutdown" }); await Promise.resolve();
  });
  it("settles stop-before-ACK without publishing readiness", async () => {
    const f = fixture(), ready = vi.fn(async () => {}), starting = main(env, f.host as ShutdownHost, ready);
    const failure = expect(starting).rejects.toThrow(/stopped before ACK/);
    f.host.emit("message", { type: "shutdown" }); await failure; expect(ready).not.toHaveBeenCalled(); expect(f.node.stop).toHaveBeenCalledTimes(1);
  });
  it("preserves ordinary main startup without waiting for optional source readiness", async () => {
    const f = fixture(); await main(env, f.host as ShutdownHost); expect(f.node.start).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls[0]![0].requireSupervisorLifetime).toBeUndefined();
    f.host.emit("message", { type: "shutdown" }); await Promise.resolve();
  });
  it("routes only the protected supervisor Git selection through the local runtime and retains its configuration guard", async () => {
    const f = fixture(), ready = vi.fn(async () => {}), file = join(process.cwd(), "configured-git.exe");
    let identity = "original"; const bytes = Buffer.from("{}");
    vi.spyOn(sourceConfiguration, "prepareProductSourceConfiguration").mockReturnValue({ file: env.ARTOO_PRODUCT_SOURCE_CONFIG_FILE,
      directory: process.cwd(), storage: Object.freeze({}) as PreparedWindowsReleaseStorage,
      original: { bytes, identity }, config: { version: 1, storeRoot: process.cwd(), gitExecutable: file },
      read: () => ({ bytes, identity }) });
    const token = Object.freeze({}) as bootstrapGit.PreparedProductBootstrapGit;
    const prepare = vi.spyOn(bootstrapGit, "prepareProductBootstrapGit").mockReturnValue(token);
    const adapter = vi.spyOn(processAdapter, "createProcessAdapter");
    const descriptor = { version: 1, path: file, bytes: 42, sha256: "sha256:" + "a".repeat(64) };
    const starting = main({ ...env, ARTOO_INITIALIZE_REPOSITORY: "1", ARTOO_SUPERVISED_BOOTSTRAP_GIT: JSON.stringify(descriptor) }, f.host as ShutdownHost, ready);
    f.resolve(); await starting;
    expect(prepare).toHaveBeenCalledTimes(1); expect(prepare.mock.calls[0]![0]).toMatchObject({ file, allowedRoots: [process.cwd()], expected: descriptor });
    expect(adapter.mock.calls[0]![0].productBootstrapGit).toBe(token);
    expect(() => prepare.mock.calls[0]![0].assertConfigurationUnchanged!()).not.toThrow();
    identity = "changed"; expect(() => prepare.mock.calls[0]![0].assertConfigurationUnchanged!()).toThrow(/source configuration changed/);
    f.host.emit("message", { type: "shutdown" }); await Promise.resolve();
  });
  it("fails a supervised bootstrap without its derived Git descriptor before starting a node", async () => {
    const f = fixture();
    await expect(main({ ...env, ARTOO_INITIALIZE_REPOSITORY: "1" }, f.host as ShutdownHost, async () => {})).rejects.toThrow(/protected Git selection/);
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not accept an inherited bootstrap projection on the ordinary startup path", async () => {
    const f = fixture(), prepare = vi.spyOn(bootstrapGit, "prepareProductBootstrapGit"), adapter = vi.spyOn(processAdapter, "createProcessAdapter");
    await main({ ...env, ARTOO_INITIALIZE_REPOSITORY: "1", ARTOO_SUPERVISED_BOOTSTRAP_GIT: "untrusted" }, f.host as ShutdownHost);
    expect(prepare).not.toHaveBeenCalled(); expect(adapter.mock.calls[0]![0].productBootstrapGit).toBeUndefined();
    f.host.emit("message", { type: "shutdown" }); await Promise.resolve();
  });
});
