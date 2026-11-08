// Real source-runtime brands and Guardian AsyncLocalStorage scopes with explicitly
// controlled native, configuration and source readers. No native/model run or
// accepted successor checkpoint is manufactured by these lifecycle tests.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, type ProductSourceRecoveryRegistrationV1,
  type SourceSupervisorLaunchV1 } from "@artoo/domain";
import type { NodeSideTransport, NodeToServerMessage, ServerToNodeMessage } from "@artoo/protocol";
import { importedCleanValidationRequestFixture, cleanValidationFixtureSha as sha } from "./test-fixtures/imported-clean-validation-request.js";
const local = vi.hoisted(() => ({ guardian: {}, backend: {}, source: {}, configuration: {}, profile: vi.fn(), audit: vi.fn(),
  sourceRead: vi.fn(), sourcePrepare: vi.fn(), quarantine: vi.fn(), launch: vi.fn(), mode: "active", configDigest: "", workspace: "", bound: false,
  registration: undefined as ProductSourceRecoveryRegistrationV1 | undefined, events: [] as string[] }));
vi.mock("./owned/windows-runtime-guardian.js", () => ({
  readWindowsGuardianLocalRuntime: (guardian: object) => {
    if (guardian !== local.guardian) throw Error("Controlled original guardian required");
    return { mode: local.mode, backend: local.backend, epoch: local.registration!.epoch, binding: local.registration!.binding,
      local: { configurationDigest: local.configDigest, workspaceRoot: local.workspace } };
  },
  windowsGuardianForBackend: (backend: object) => local.bound && backend === local.backend ? local.guardian : undefined,
  hasPreparedWindowsGuardian: () => local.bound, auditWindowsGuardianRuntime: local.audit,
}));
vi.mock("./product-source-runtime.js", () => ({ prepareGuardianProductSourceRuntime: local.sourcePrepare,
  readGuardianProductSourceConfiguration: local.sourceRead, readCleanGuardianProductSourceConfiguration: local.sourceRead }));
vi.mock("./windows-clean-local-configuration.js", () => ({ readCleanDaemonGuardian: () => local.configuration,
  readCleanDaemonQuarantine: local.quarantine, describeCleanDaemonLaunch: local.launch }));
vi.mock("./verification.js", () => ({ assertLocallyPreparedVerificationProfile: local.profile }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: vi.fn(() => ({})), assertWindowsReleaseStorage: vi.fn() }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: () => ({ directory: "controlled installation" }) }));
vi.mock("./windows-supervisor-authority.js", () => ({ readWindowsDaemonSupervisorAuthority: () => ({ launchIdentityDigest: "sha256:" + "a".repeat(64) }) }));
vi.mock("./windows-local-acl.js", () => ({ physicalWindowsDirectory: (path: string) => path,
  windowsPathsOverlap: (left: string, right: string) => left === right }));
import { prepareWindowsSourceRecoveryConfiguration, windowsGuardianConfiguration, prepareWindowsSourceRecoveryRuntime,
  readWindowsRecoverySourceRuntime, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { readWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";
import { createWindowsCleanDaemonClient } from "./windows-clean-daemon-client.js";
import type { ProductSourceRuntimeOptions } from "./product-source-runtime.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
function scoped(label: string) {
  const active = readWindowsGuardianOperation(local.backend as never);
  if (!active) throw Error("Controlled reader requires the original real scope");
  local.events.push(label); return active;
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); vi.resetAllMocks();
  local.mode = "active"; local.bound = false; local.events = [];
  local.audit.mockImplementation(() => { scoped("audit"); });
  local.sourcePrepare.mockImplementation(() => { scoped("prepare"); return local.source; });
  local.sourceRead.mockImplementation(() => { scoped("source"); return {}; });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  const parent = realpathSync.native(tmpdir());
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep + "artoo-clean-scope-")) throw Error("Refusing fixture cleanup outside its parent");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const f = importedCleanValidationRequestFixture(), registration = f.checkpoint.lifecycle_registration.registration;
  local.registration = structuredClone(registration);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-clean-scope-"))); roots.push(root);
  const store = join(root, "store"), workspace = join(root, "workspace"), control = join(root, "control"), git = join(root, "git.exe");
  for (const directory of [store, workspace, control]) mkdirSync(directory); writeFileSync(git, "controlled git bytes");
  local.workspace = workspace;
  const source = { nodeId: registration.binding.node_id, storeRoot: store, allowedRoots: [workspace],
    profiles: [{ id: "profile", project_id: "project", workspace_root: workspace, digest: sha("profile") }],
    gitExecutable: git, windowsBackend: local.backend } as unknown as ProductSourceRuntimeOptions;
  const configuration = prepareWindowsSourceRecoveryConfiguration({ version: 1, source, workspaceRoot: workspace,
    controlDirectory: control, deviceId: registration.binding.device_id, supervisor: {} as never });
  local.configDigest = windowsGuardianConfiguration(configuration, registration.epoch.session_id).configurationDigest; local.bound = true;
  const runtime = prepareWindowsSourceRecoveryRuntime(configuration, local.guardian as never);
  local.quarantine.mockImplementation(() => { scoped("quarantine"); return { node_id: registration.binding.node_id,
    store_root: store, workspace_root: workspace, expected_grant: undefined }; });
  local.launch.mockImplementation(() => { scoped("launch"); return f.checkpoint.lifecycle_registration.launch; });
  const sent: NodeToServerMessage[] = []; let live = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {},
    send: vi.fn(async message => { scoped("send-before"); await Promise.resolve(); scoped("send-after"); sent.push(message); }) };
  const options = { configuration: local.configuration as never, guardian: local.guardian as never, runtime,
    registration, transport, isCurrent: () => live, onReady: vi.fn(() => { scoped("ready"); }), onFailure: vi.fn(),
    bindParent: vi.fn(async (_launch: SourceSupervisorLaunchV1) => { scoped("parent-before"); await Promise.resolve(); scoped("parent-after"); }) };
  local.events = []; return { ...f, options, runtime, sent, invalidate: () => { live = false; } };
}
function registered(f: ReturnType<typeof fixture>): ServerToNodeMessage {
  const event = f.sent.find(message => message.kind === "product.source.lifecycle.register.v1");
  if (!event || event.kind !== "product.source.lifecycle.register.v1") throw Error("Expected original lifecycle submission");
  return { kind: "command", id: "registered", idempotency_key: "registered", type: "product.source.lifecycle.registered.v1", payload: {
    version: 1, observer_id: event.payload.launch.observer_id, registration_id: event.payload.registration.registration_id,
    registration_digest: sha(canonical(event.payload)), lineage_id: f.grant.lineage_id } };
}

describe("clean lifecycle starts and re-enters its exact registered Guardian scope", () => {
  it("scopes constructor checks while retaining missing-scope rejection for the raw reader", () => {
    const f = fixture(); createWindowsCleanDaemonClient(f.options);
    expect(local.events[0]).toBe("audit"); expect(local.events).toContain("quarantine"); expect(local.events).toContain("source");
    expect(() => readWindowsRecoverySourceRuntime(f.runtime)).toThrow(/original authenticated operation scope/);
    expect(() => readWindowsGuardianOperation(local.backend as never)).toThrow(/original authenticated operation scope/);
  });
  it("keeps parent binding and transport awaits inside the original scope", async () => {
    const f = fixture(), client = createWindowsCleanDaemonClient(f.options); local.events = [];
    await client.start(); expect(f.options.bindParent).toHaveBeenCalledOnce(); expect(f.sent).toHaveLength(1);
    expect(local.events).toEqual(expect.arrayContaining(["parent-before", "parent-after", "send-before", "send-after"]));
    expect(f.options.onReady).not.toHaveBeenCalled(); expect(client.isActive()).toBe(false);
    expect(() => readWindowsGuardianOperation(local.backend as never)).toThrow(/original authenticated operation scope/);
  });
  it("enters a new scope for the actual registration handler and pre-dispatch readers", async () => {
    const f = fixture(), client = createWindowsCleanDaemonClient(f.options); await client.start(); local.events = [];
    expect(await client.handle(registered(f))).toBe(true); expect(f.options.onReady).toHaveBeenCalledOnce(); expect(client.isActive()).toBe(true);
    expect(client.allowsOrdinary()).toBe(true); expect(client.readCheckpoint()).toBeUndefined();
    expect(() => client.assertOrdinaryWorkspace(local.workspace)).not.toThrow();
    expect(() => client.readAccepted(f.restart)).toThrow(/actual committed checkpoint receipt/);
    expect(local.events.filter(event => event === "audit").length).toBeGreaterThanOrEqual(5);
  });
  it("rejects a forged runtime before lifecycle configuration access", () => {
    const f = fixture(); local.events = [];
    expect(() => createWindowsCleanDaemonClient({ ...f.options, runtime: {} as PreparedWindowsSourceRecoveryRuntime })).toThrow(/original current recovery runtime/);
    expect(local.events).toEqual([]); expect(f.options.bindParent).not.toHaveBeenCalled();
  });
  it("retains full source revocation and epoch checks before readiness", async () => {
    const f = fixture(), client = createWindowsCleanDaemonClient(f.options); await client.start();
    local.sourceRead.mockImplementationOnce(() => { scoped("revoked-source"); throw Error("Controlled source revoked"); });
    await expect(client.handle(registered(f))).rejects.toThrow(/source revoked/);
    expect(f.options.onFailure).toHaveBeenCalledOnce(); expect(f.options.onReady).not.toHaveBeenCalled();
    local.registration = { ...local.registration!, epoch: { ...local.registration!.epoch, epoch_id: "00000000-0000-4000-8000-000000000999" } };
    expect(() => client.allowsOrdinary()).toThrow(/another epoch/);
  });
  it("rechecks the session after parent binding without announcing lifecycle readiness", async () => {
    const f = fixture(), client = createWindowsCleanDaemonClient(f.options);
    f.options.bindParent.mockImplementation(async () => { scoped("parent"); f.invalidate(); });
    await expect(client.start()).rejects.toThrow(/session is unavailable/);
    expect(f.sent).toHaveLength(0); expect(f.options.onReady).not.toHaveBeenCalled(); expect(client.isActive()).toBe(false);
  });
});
