// Real prepared verifier/release identities and real storage layouts. Native ACL
// admission and HTTP listener lifecycle are controlled; no process or socket opens.
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductReleaseRequest } from "@artoo/domain";
import { attachWindowsVerificationBackend, prepareVerificationProfiles } from "./verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles, type ReleaseProfile } from "./product-release.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedWindowsReleaseStorage } from "./windows-release-storage.js";

interface ControlledListener {
  listening: boolean; completed: boolean; closeCalls: number; port: number;
  finishListening(): void; failListening(error: Error): void;
}
const controlled = vi.hoisted(() => ({
  backends: new WeakSet<object>(), revoked: new WeakSet<object>(), imagesChanged: new WeakSet<object>(),
  storages: new WeakMap<object, string>(), fullAudit: vi.fn(), imageAudit: vi.fn(),
  storageAudit: vi.fn(), batchAudit: vi.fn(), createServer: vi.fn(),
  listeners: [] as ControlledListener[], events: [] as string[],
}));
vi.mock("./owned/windows-owned-process.js", () => ({
  assertWindowsProcessBackend: (backend: object) => {
    controlled.fullAudit(backend); controlled.events.push("backend");
    if (!controlled.backends.has(backend) || controlled.revoked.has(backend)) throw Error("Controlled native installation revoked");
    if (controlled.imagesChanged.has(backend)) throw Error("Controlled native image changed");
  },
  assertWindowsProcessBackendImage: (backend: object) => {
    controlled.imageAudit(backend); controlled.events.push("image");
    if (!controlled.backends.has(backend) || controlled.imagesChanged.has(backend)) throw Error("Controlled native image changed");
  },
}));
vi.mock("./windows-release-storage.js", () => {
  const check = (storage: object, directory: string) => {
    if (controlled.storages.get(storage) !== directory) throw Error("Controlled storage authority revoked");
  };
  return {
    assertWindowsReleaseStorage: check,
    auditWindowsReleaseStorage: (storage: object, directory: string) => {
      controlled.events.push("storage-single"); controlled.storageAudit(storage, directory); check(storage, directory);
    },
    auditWindowsReleaseStorageBatch: (entries: readonly { storage: object; directory: string }[]) => {
      controlled.events.push("storage-batch"); controlled.batchAudit(entries);
      for (const entry of entries) check(entry.storage, entry.directory);
    },
  };
});
vi.mock("node:http", async importOriginal => {
  const actual = await importOriginal<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, createServer: (...args: unknown[]) => {
    controlled.createServer(...args); controlled.events.push("create-listener");
    const server = new class extends EventEmitter implements ControlledListener {
      listening = false; completed = false; closeCalls = 0; port = 0;
      private callback?: () => void;
      listen(port: number, _host: string, callback: () => void) {
        this.port = port; this.callback = callback; controlled.events.push("listen"); return this;
      }
      finishListening() {
        if (this.completed) return;
        this.completed = true; this.listening = true; this.callback?.();
      }
      failListening(error: Error) { this.completed = true; this.emit("error", error); }
      close(callback?: () => void) {
        this.closeCalls++; this.listening = false; this.emit("close"); queueMicrotask(() => callback?.()); return this;
      }
      closeAllConnections() {}
    }();
    controlled.listeners.push(server); return server;
  } };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const executors: ReturnType<typeof createProductReleaseExecutor>[] = [];
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  controlled.listeners.length = 0; controlled.events.length = 0;
  for (const mock of [controlled.fullAudit, controlled.imageAudit, controlled.storageAudit, controlled.batchAudit, controlled.createServer]) mock.mockReset();
});
afterEach(async () => {
  for (const listener of controlled.listeners) listener.finishListening();
  await Promise.all(executors.splice(0).map(executor => executor.stop()));
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  const prefix = `${realpathSync.native(tmpdir())}${sep}artoo-release-start-batch-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(prefix) || realpathSync.native(root) !== root) throw Error("Unexpected start-batch fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(backendIds: readonly number[] = [0, 0], windows = true) {
  if (!windows) Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-release-start-batch-"))); roots.push(root);
  const bindings = new Map<number, PreparedWindowsProcessBackend>();
  const entries = backendIds.map((id, index) => {
    const workspace = join(root, `workspace-${index}`), storage = join(root, `storage-${index}`), script = join(root, `verify-${index}.mjs`);
    mkdirSync(workspace); mkdirSync(storage); writeFileSync(script, "process.exit(0)");
    const verifier = prepareVerificationProfiles([{ id: `verify-${index}`, project_id: "project", workspace_root: workspace,
      commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["web"] }])[0]!;
    let backend = bindings.get(id);
    if (!backend) { backend = Object.freeze({}) as PreparedWindowsProcessBackend; bindings.set(id, backend); controlled.backends.add(backend); }
    if (windows) attachWindowsVerificationBackend(verifier, backend);
    const authority = Object.freeze({}) as PreparedWindowsReleaseStorage; controlled.storages.set(authority, storage);
    const raw: ReleaseProfile = { id: `release-${index}`, project_id: "project", verification_profile_id: verifier.id,
      storage_root: storage, output_path: "web", public_url: `http://127.0.0.1:${19500 + index}`, listen_host: "127.0.0.1", listen_port: 19500 + index,
      health_checks: [{ path: "/" }], health_timeout_ms: 1000 };
    const release = prepareReleaseProfiles([raw], [verifier], windows ? { windowsStorage: new Map([[storage, authority]]) } : {})[0]!;
    return { verifier, backend, storage, authority, release, script };
  });
  const executor = createProductReleaseExecutor(entries.map(entry => entry.release)); executors.push(executor);
  vi.clearAllMocks(); controlled.events.length = 0;
  return { entries, executor };
}
const finishListeners = () => { for (const listener of controlled.listeners) listener.finishListening(); };
const layouts = ["operations", "attestations", "artifacts", "health"];

describe("Windows publisher initial-start synchronous batches", () => {
  it("audits each distinct backend once and both independent storage rounds before any listener", async () => {
    const f = fixture([0, 0, 1]);
    controlled.batchAudit.mockImplementationOnce(entries => {
      expect(entries.map((entry: { directory: string }) => entry.directory)).toEqual(f.entries.map(entry => entry.storage));
      for (const { storage } of f.entries) for (const name of layouts) expect(existsSync(join(storage, name))).toBe(false);
      expect(controlled.createServer).not.toHaveBeenCalled();
    }).mockImplementationOnce(() => {
      for (const { storage } of f.entries) for (const name of layouts) expect(existsSync(join(storage, name))).toBe(true);
      expect(controlled.createServer).not.toHaveBeenCalled();
    });
    const started = f.executor.start();
    expect(controlled.fullAudit.mock.calls.map(call => call[0])).toEqual([f.entries[0]!.backend, f.entries[2]!.backend]);
    expect(controlled.imageAudit).toHaveBeenCalledTimes(1); expect(controlled.batchAudit).toHaveBeenCalledTimes(2);
    expect(controlled.listeners).toHaveLength(3); expect(controlled.storageAudit).not.toHaveBeenCalled();
    expect(controlled.events.filter(event => event === "storage-batch" || event === "create-listener")).toEqual([
      "storage-batch", "storage-batch", "create-listener", "create-listener", "create-listener",
    ]);
    finishListeners(); await started;
    expect(controlled.storageAudit.mock.calls.map(call => call[1])).toEqual(f.entries.map(entry => entry.storage));
  });

  it.each(["distinct revoked", "shared image changed"])("rejects a later %s backend before storage collection or listeners", async variant => {
    const f = fixture(variant === "distinct revoked" ? [0, 1] : [0, 0]);
    if (variant === "distinct revoked") controlled.revoked.add(f.entries[1]!.backend);
    else controlled.imageAudit.mockImplementationOnce(backend => { controlled.imagesChanged.add(backend); });
    await expect(f.executor.start()).rejects.toThrow(/revoked|image changed/);
    expect(controlled.batchAudit).not.toHaveBeenCalled(); expect(controlled.createServer).not.toHaveBeenCalled();
  });

  it("checks every profile's protected files before accepting a shared backend", async () => {
    const f = fixture(); writeFileSync(f.entries[1]!.script, "changed protected verifier");
    await expect(f.executor.start()).rejects.toThrow(/verifier changed/);
    expect(controlled.fullAudit).toHaveBeenCalledTimes(1); expect(controlled.createServer).not.toHaveBeenCalled();
  });

  it.each([1, 2])("starts no listener when the second storage fails audit round %i", async round => {
    const f = fixture();
    if (round === 2) controlled.batchAudit.mockImplementationOnce(() => {});
    controlled.batchAudit.mockImplementationOnce(() => { controlled.storages.delete(f.entries[1]!.authority); });
    await expect(f.executor.start()).rejects.toThrow(/storage admission failed/);
    expect(controlled.batchAudit).toHaveBeenCalledTimes(round); expect(controlled.createServer).not.toHaveBeenCalled();
    expect(f.executor.getHealthFaults().map(fault => fault.profile_id)).toEqual(f.entries.map(entry => entry.release.id));
    for (const { storage } of f.entries) for (const name of layouts) expect(existsSync(join(storage, name))).toBe(round === 2);
    controlled.storages.set(f.entries[1]!.authority, f.entries[1]!.storage);
    await expect(f.executor.start()).rejects.toThrow(/monitoring stopped/);
    expect(controlled.batchAudit).toHaveBeenCalledTimes(round); expect(controlled.createServer).not.toHaveBeenCalled();
  });

  it.each(["source-recovery.json", "source-clean-restart.json"])("keeps a second profile's %s fence ahead of every listener", async marker => {
    const f = fixture(); writeFileSync(join(f.entries[1]!.storage, marker), "{}");
    await expect(f.executor.start()).rejects.toThrow(/requires its original live checkpoint owner/);
    expect(controlled.batchAudit).not.toHaveBeenCalled(); expect(controlled.createServer).not.toHaveBeenCalled();
  });

  it("rejects startup after requestStop before storage collection or listener creation", async () => {
    const f = fixture(); f.executor.requestStop();
    await expect(f.executor.start()).rejects.toThrow(/executor stopped/);
    expect(controlled.batchAudit).not.toHaveBeenCalled(); expect(controlled.createServer).not.toHaveBeenCalled();
  });

  it("joins every pending listener before stop completes and closes listeners that finish during shutdown", async () => {
    const f = fixture(), started = f.executor.start(); let stopped = false;
    const stopping = f.executor.stop().then(() => { stopped = true; });
    controlled.listeners[0]!.finishListening(); await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false); controlled.listeners[1]!.finishListening();
    await Promise.all([started, stopping]);
    expect(stopped).toBe(true); expect(controlled.listeners.every(listener => !listener.listening && listener.closeCalls > 0)).toBe(true);
    await expect(f.executor.start()).rejects.toThrow(/executor stopped/);
    expect(controlled.listeners).toHaveLength(2);
  });

  it("deduplicates concurrent starts while each invocation freshly qualifies the backend", async () => {
    const f = fixture(), first = f.executor.start(), second = f.executor.start();
    expect(controlled.fullAudit).toHaveBeenCalledTimes(2); expect(controlled.batchAudit).toHaveBeenCalledTimes(2);
    expect(controlled.listeners).toHaveLength(2); finishListeners(); await Promise.all([first, second]);
    expect(controlled.storageAudit).toHaveBeenCalledTimes(2);
    await f.executor.start(); expect(controlled.fullAudit).toHaveBeenCalledTimes(3);
    expect(controlled.batchAudit).toHaveBeenCalledTimes(2); expect(controlled.listeners).toHaveLength(2);
    controlled.revoked.add(f.entries[0]!.backend);
    await expect(f.executor.start()).rejects.toThrow(/installation revoked/);
  });

  it("re-audits after listener completion and closes a profile whose storage was revoked during await", async () => {
    const f = fixture(), started = f.executor.start();
    const rejected = expect(started).rejects.toThrow(/storage admission failed/);
    controlled.storages.delete(f.entries[1]!.authority); finishListeners(); await rejected;
    expect(controlled.storageAudit).toHaveBeenCalledTimes(2);
    expect(controlled.listeners[1]!.listening).toBe(false); expect(controlled.listeners[1]!.closeCalls).toBeGreaterThan(0);
    expect(controlled.listeners[0]!.listening).toBe(true);
    await f.executor.stop(); expect(controlled.listeners.every(listener => !listener.listening && listener.closeCalls > 0)).toBe(true);
  });

  it("freshly audits a listener-start retry without reusing the failed initial batch", async () => {
    const f = fixture([0]), first = f.executor.start(), rejected = expect(first).rejects.toThrow("Controlled listen failure");
    controlled.listeners[0]!.failListening(Error("Controlled listen failure")); await rejected;
    expect(controlled.listeners[0]!.closeCalls).toBe(1);
    const retry = f.executor.start(); expect(controlled.fullAudit).toHaveBeenCalledTimes(2);
    expect(controlled.batchAudit).toHaveBeenCalledTimes(4); expect(controlled.listeners).toHaveLength(2);
    finishListeners(); await retry; expect(controlled.storageAudit).toHaveBeenCalledTimes(1);
  });

  it("retains fresh private per-profile admission after a later publication crosses await", async () => {
    const f = fixture([0]), started = f.executor.start(); finishListeners(); await started;
    const { verifier, release, backend } = f.entries[0]!;
    const request: ProductReleaseRequest = { version: 1, release_id: "controlled-release", goal_id: "goal", project_id: "project", run_id: "run",
      release_profile_id: release.id, verification_request_id: "verification", verification_profile_id: verifier.id,
      verification_profile_digest: verifier.digest, subject_digest: `sha256:${"a".repeat(64)}` };
    controlled.fullAudit.mockClear();
    const publishing = f.executor.release(request);
    expect(controlled.fullAudit).toHaveBeenCalledTimes(2); controlled.revoked.add(backend);
    await expect(publishing).rejects.toThrow(/installation revoked/);
    expect(controlled.fullAudit).toHaveBeenCalledTimes(3); expect(controlled.listeners).toHaveLength(1);
  });

  it("preserves POSIX initial starts without Windows backend or storage batch admission", async () => {
    const f = fixture([0, 1], false), started = f.executor.start();
    expect(controlled.listeners).toHaveLength(2); expect(controlled.fullAudit).not.toHaveBeenCalled();
    expect(controlled.batchAudit).not.toHaveBeenCalled(); expect(controlled.storageAudit).not.toHaveBeenCalled();
    for (const { storage } of f.entries) for (const name of layouts) expect(existsSync(join(storage, name))).toBe(true);
    finishListeners(); await started;
    expect(controlled.storageAudit).not.toHaveBeenCalled();
  });
});
