// Real source-runtime brands and AsyncLocalStorage routing with controlled native/ACL/profile boundaries.
// No native process, model, recovery checkpoint or product acceptance is exercised here.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const local = vi.hoisted(() => ({ guardian: {}, backend: {}, source: {}, profile: vi.fn(), audit: vi.fn(),
  sourceRead: vi.fn(), sourcePrepare: vi.fn(), mode: "active", epoch: "epoch-original", configDigest: "", workspace: "",
  bound: false, events: [] as string[] }));
vi.mock("./owned/windows-runtime-guardian.js", () => ({
  readWindowsGuardianLocalRuntime: (guardian: object) => {
    if (guardian !== local.guardian) throw Error("Controlled original guardian required");
    return { mode: local.mode, backend: local.backend, epoch: { epoch_id: local.epoch }, local: { configurationDigest: local.configDigest, workspaceRoot: local.workspace } };
  },
  windowsGuardianForBackend: (backend: object) => local.bound && backend === local.backend ? local.guardian : undefined,
  hasPreparedWindowsGuardian: () => local.bound, auditWindowsGuardianRuntime: local.audit,
}));
vi.mock("./product-source-runtime.js", () => ({ prepareGuardianProductSourceRuntime: local.sourcePrepare,
  readGuardianProductSourceConfiguration: local.sourceRead }));
vi.mock("./verification.js", () => ({ assertLocallyPreparedVerificationProfile: local.profile }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: vi.fn(() => ({})), assertWindowsReleaseStorage: vi.fn() }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: () => ({ directory: "controlled installation" }) }));
vi.mock("./windows-supervisor-authority.js", () => ({ readWindowsDaemonSupervisorAuthority: () => ({ launchIdentityDigest: "sha256:" + "a".repeat(64) }) }));
vi.mock("./windows-local-acl.js", () => ({ physicalWindowsDirectory: (path: string) => path,
  windowsPathsOverlap: (left: string, right: string) => left === right }));
import { prepareWindowsSourceRecoveryConfiguration, windowsGuardianConfiguration, prepareWindowsSourceRecoveryRuntime,
  withWindowsSourceRecoveryOperation, readWindowsRecoverySourceRuntime, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { readWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";
import type { ProductSourceRuntimeOptions } from "./product-source-runtime.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const descriptor = { operationId: "activation", bindingDigest: "sha256:" + "b".repeat(64), serverOperation: null };
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); vi.clearAllMocks();
  local.mode = "active"; local.epoch = "epoch-original"; local.bound = false; local.events = [];
  local.audit.mockImplementation(() => {
    expect(readWindowsGuardianOperation(local.backend as never)?.guardian).toBe(local.guardian); local.events.push("audit");
  });
  local.sourcePrepare.mockImplementation(() => { expect(readWindowsGuardianOperation(local.backend as never)).toBeDefined(); return local.source; });
  local.sourceRead.mockImplementation(() => {
    readWindowsGuardianOperation(local.backend as never); local.events.push("source.read"); return {};
  });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  const parent = realpathSync.native(tmpdir());
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep + "artoo-recovery-scope-")) throw Error("Refusing controlled fixture cleanup outside its parent");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-recovery-scope-"))); roots.push(root);
  const store = join(root, "store"), workspace = join(root, "workspace"), control = join(root, "control"), git = join(root, "git.exe");
  for (const directory of [store, workspace, control]) mkdirSync(directory); writeFileSync(git, "controlled git bytes");
  local.workspace = workspace;
  const source = { nodeId: "node", storeRoot: store, allowedRoots: [workspace],
    profiles: [{ id: "profile", project_id: "project", workspace_root: workspace, digest: "sha256:" + "c".repeat(64) }],
    gitExecutable: git, windowsBackend: local.backend } as unknown as ProductSourceRuntimeOptions;
  const configuration = prepareWindowsSourceRecoveryConfiguration({ version: 1, source, workspaceRoot: workspace,
    controlDirectory: control, deviceId: "device", supervisor: {} as never });
  local.configDigest = windowsGuardianConfiguration(configuration, "session").configurationDigest; local.bound = true;
  const runtime = prepareWindowsSourceRecoveryRuntime(configuration, local.guardian as never);
  local.events = []; vi.clearAllMocks(); return { runtime, git };
}
describe("original source recovery scope admission order", () => {
  it("establishes the real guardian scope before full source capability checks and then invokes work", () => {
    const f = fixture();
    expect(withWindowsSourceRecoveryOperation(f.runtime, descriptor, () => {
      expect(readWindowsGuardianOperation(local.backend as never)?.operationId).toBe("activation"); local.events.push("work"); return "value";
    })).toBe("value");
    expect(local.events).toEqual(["audit", "source.read", "work"]); expect(local.profile).toHaveBeenCalled();
  });
  it("still rejects a bound backend/source reader outside the admitted scope", () => {
    const f = fixture(); expect(() => readWindowsRecoverySourceRuntime(f.runtime)).toThrow(/original authenticated operation scope/);
    expect(() => readWindowsGuardianOperation(local.backend as never)).toThrow(/original authenticated operation scope/);
  });
  it("rejects serialized runtime tokens before an audit or work callback", () => {
    fixture(); const work = vi.fn();
    expect(() => withWindowsSourceRecoveryOperation({} as PreparedWindowsSourceRecoveryRuntime, descriptor, work)).toThrow(/original current recovery runtime/);
    expect(local.audit).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });
  it.each(["epoch", "mode"])("rejects stale original runtime %s before an audit", variant => {
    const f = fixture(), work = vi.fn(); if (variant === "epoch") local.epoch = "replacement"; else local.mode = "recovery";
    expect(() => withWindowsSourceRecoveryOperation(f.runtime, descriptor, work)).toThrow(/another epoch/);
    expect(local.audit).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });
  it("rechecks the epoch after scope admission before work", () => {
    const f = fixture(), work = vi.fn(); local.audit.mockImplementationOnce(() => { local.epoch = "changed-during-audit"; });
    expect(() => withWindowsSourceRecoveryOperation(f.runtime, descriptor, work)).toThrow(/another epoch/); expect(work).not.toHaveBeenCalled();
  });
  it("retains complete configuration checks inside the scope", () => {
    const f = fixture(), work = vi.fn(); writeFileSync(f.git, "changed protected executable");
    expect(() => withWindowsSourceRecoveryOperation(f.runtime, descriptor, work)).toThrow(/Git program changed/);
    expect(local.audit).toHaveBeenCalledOnce(); expect(work).not.toHaveBeenCalled();
  });
  it("preserves source capability revocation and callback failures", () => {
    const f = fixture(), work = vi.fn(); local.sourceRead.mockImplementationOnce(() => {
      expect(readWindowsGuardianOperation(local.backend as never)).toBeDefined(); throw Error("controlled capability revoked");
    });
    expect(() => withWindowsSourceRecoveryOperation(f.runtime, descriptor, work)).toThrow(/capability revoked/); expect(work).not.toHaveBeenCalled();
    expect(() => withWindowsSourceRecoveryOperation(f.runtime, descriptor, () => { throw Error("original callback failure"); })).toThrow(/original callback failure/);
  });
});
