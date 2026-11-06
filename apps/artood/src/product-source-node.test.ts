// Native ACL/helper admission and runtime execution are controlled here; no child process is started.
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
const io = vi.hoisted(() => ({ read: undefined as unknown as typeof readFileSync, stat: undefined as unknown as typeof lstatSync }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>(); io.read = actual.readFileSync; io.stat = actual.lstatSync;
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), lstatSync: vi.fn(actual.lstatSync) };
});
const control = vi.hoisted(() => ({ prepare: vi.fn(() => Object.freeze({})), current: vi.fn(), close: vi.fn(), client: vi.fn(() => ({})),
  storage: vi.fn(() => ({})), audit: vi.fn(), backend: vi.fn(), design: vi.fn(), roles: vi.fn(() => ({ semantic: true, measurementV2: true, importedReview: true, importedDesign: true })) }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: control.storage, assertWindowsReleaseStorage: vi.fn(), auditWindowsReleaseStorage: control.audit }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: control.backend }));
vi.mock("./verification.js", () => ({ assertImportedDesignVerificationProfile: control.design }));
vi.mock("./product-source-runtime.js", () => ({ prepareProductSourceRuntime: control.prepare, assertProductSourceRuntimeConfiguration: control.current,
  closeProductSourceRuntime: control.close, readProductSourceRuntimeCapabilities: control.roles }));
vi.mock("./product-source-semantic-client.js", () => ({ createProductSourceSemanticClient: control.client }));
import { prepareProductSourceNode } from "./product-source-node.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readFileSync).mockImplementation(io.read); vi.mocked(lstatSync).mockImplementation(io.stat);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => { Object.defineProperty(process, "platform", platform); });
const token = "sk_device_fixture_" + "a".repeat(64);
function fixture(config: Record<string, unknown> = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-source-node-config-"))), workspace = join(root, "workspace"); mkdirSync(workspace);
  const file = join(root, "source.json"), research = { receiptDirectory: join(root, "research") };
  const profile = Object.freeze({ id: "local", project_id: "project", workspace_root: workspace }) as PreparedVerificationProfile;
  const release = Object.freeze({ id: "publish", verifier: profile }) as PreparedReleaseProfile;
  const value = { version: 1, storeRoot: join(root, "store"), gitExecutable: join(root, "git.exe"), ...config };
  writeFileSync(file, JSON.stringify(value));
  const options = { file, url: `wss://control.example/api/v1/node?token=${token}`, nodeId: "node", allowedRoots: [workspace],
    windowsBackend: Object.freeze({}) as PreparedWindowsProcessBackend, profiles: [profile], releaseProfiles: [release], research, acknowledgeRunEvents: true };
  return { options, profile, release, research, file, value };
}
describe("standard source-node protected configuration", () => {
  it("reuses the original node identity, profiles, release reader selections and author research configuration", () => {
    const f = fixture({ sourceResearch: true, measurementV2: { version: 1, releaseProfileIds: ["publish"] }, operations: { version: 1 } });
    const prepared = prepareProductSourceNode(f.options), call = control.prepare.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].profiles).toBe(f.options.profiles); expect(call[0].sourceResearch).toBe(f.research);
    expect((call[0].measurementV2 as { releaseProfiles: unknown[] }).releaseProfiles[0]).toBe(f.release);
    expect(control.client).toHaveBeenCalledWith({ serverOrigin: "https://control.example", nodeId: "node", nodeToken: token });
    expect(control.storage).toHaveBeenCalledWith({ directory: join(f.file, ".."), writableWorkspaceRoots: f.options.allowedRoots });
    prepared.assertCurrent(); expect(control.current).toHaveBeenCalledWith(prepared.runtime, "node", f.options.allowedRoots, f.options.profiles);
    expect(control.audit).toHaveBeenCalledTimes(1); prepared.assertDiscovery(); expect(control.audit).toHaveBeenCalledTimes(2);
    prepared.close(); expect(control.close).toHaveBeenCalledWith(prepared.runtime);
  });
  it("pins the physical configuration bytes after preparation and detects a changed local mapping", () => {
    const f = fixture(), prepared = prepareProductSourceNode(f.options);
    writeFileSync(f.file, JSON.stringify({ ...f.value, sourceResearch: true }));
    expect(() => prepared.assertCurrent()).toThrow(/changed after preparation/);
  });
  it.each([false, true])("requires second-read ctime stability after a controlled first-read metadata update (second changes: %s)", secondChanges => {
    const f = fixture(); let stats = 0;
    vi.mocked(lstatSync).mockImplementation(((...args: unknown[]) => {
      const value = Reflect.apply(io.stat, undefined, args);
      if (args[0] === f.file && ++stats <= 3) value.ctimeNs = stats === 1 ? 1n : stats === 3 && secondChanges ? 3n : 2n;
      return value;
    }) as typeof lstatSync);
    if (secondChanges) expect(() => prepareProductSourceNode(f.options)).toThrow(/did not stabilize/);
    else expect(prepareProductSourceNode(f.options).runtime).toBeDefined();
  });
  it("rejects bytes changed during the second read instead of parsing a mixed configuration", () => {
    const f = fixture(), replacement = io.read(f.file, "utf8").replace('"version":1', '"version":2'); let reads = 0;
    vi.mocked(readFileSync).mockImplementation(((...args: unknown[]) => {
      if (args[0] === f.file && ++reads === 2) writeFileSync(f.file, replacement);
      return Reflect.apply(io.read, undefined, args);
    }) as typeof readFileSync);
    expect(() => prepareProductSourceNode(f.options)).toThrow(/did not stabilize/); expect(control.prepare).not.toHaveBeenCalled();
  });
  it("detects same-size byte changes even when a controlled writer preserves mtime", () => {
    const f = fixture(), prepared = prepareProductSourceNode(f.options), originalStat = io.stat(f.file, { bigint: true });
    const replacement = io.read(f.file, "utf8").replace('"version":1', '"version":2'); writeFileSync(f.file, replacement);
    vi.mocked(lstatSync).mockImplementation(((...args: unknown[]) => {
      const value = Reflect.apply(io.stat, undefined, args);
      if (args[0] === f.file) value.mtimeNs = originalStat.mtimeNs;
      return value;
    }) as typeof lstatSync);
    expect(() => prepared.assertCurrent()).toThrow(/changed after preparation/);
  });
  it("prepares a destination-only H3 configuration using complete source release data and the original local verifier", () => {
    const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
    const request = data.admission.request, destinationResearchMappings = [{ sourceProfileDigest: request.source_export.byte_export.profile_digest,
      destinationProfileId: "local", commandPairs: request.command_pairs, sourceRelease: request.source_export.measurement_v2.source_release }];
    const f = fixture({ measurementV2: { version: 1, releaseProfileIds: ["publish"], destinationResearchMappings },
      operations: { version: 1, importedReview: true, importedDesign: true } });
    const prepared = prepareProductSourceNode(f.options);
    expect(prepared.importedReview).toBe(true); expect(prepared.importedDesign).toBe(true);
    expect(control.design).toHaveBeenCalledWith(f.profile);
    const call = control.prepare.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call[0].sourceResearch).toBeUndefined();
    expect((call[0].measurementV2 as { destinationResearchMappings: unknown }).destinationResearchMappings).toEqual(destinationResearchMappings);
  });
  it.each([
    "wss://control.example/other", `wss://control.example/api/v1/node?token=${token}&token=${token}`,
    `wss://user@control.example/api/v1/node?token=${token}`, `wss://control.example/api/v1/node?token=${token}#fragment`,
    `wss://control.example/api/v1/node?token=${token}&origin=other`, `ws://remote.example/api/v1/node?token=${token}`,
    "wss://control.example/api/v1/node?token=dev",
  ])("rejects unpaired or downgraded endpoint %# before storage/runtime side effects", url => {
    const f = fixture(); expect(() => prepareProductSourceNode({ ...f.options, url })).toThrow();
    expect(control.storage).not.toHaveBeenCalled(); expect(control.prepare).not.toHaveBeenCalled();
  });
  it("accepts a paired loopback endpoint without exposing its token in runtime configuration", () => {
    const f = fixture({ sourceResearch: true, operations: { version: 1 } });
    prepareProductSourceNode({ ...f.options, url: `ws://127.0.0.1:4000/api/v1/node?token=${token}` });
    expect(control.client).toHaveBeenCalledWith({ serverOrigin: "http://127.0.0.1:4000", nodeId: "node", nodeToken: token });
    expect(JSON.stringify(control.prepare.mock.calls)).not.toContain(token);
  });
  it.each([
    { version: 2 }, { operations: { version: 1, importedDesign: true } }, { operations: { version: 1 } },
    { operations: { version: 1, importedReview: true } }, { sourceResearch: true, measurementV2: { version: 1, releaseProfileIds: ["missing"] } },
    { sourceResearch: true, measurementV2: { version: 1, releaseProfileIds: ["publish", "publish"] } },
    { serverOrigin: "https://task-supplied.example" }, { gitExecutable: "relative" },
  ])("rejects malformed, unsupported or absent local dependencies %# before runtime preparation", config => {
    const f = fixture(config); expect(() => prepareProductSourceNode(f.options)).toThrow(); expect(control.prepare).not.toHaveBeenCalled();
  });
  it("requires the author research receipt store and does not synthesize one", () => {
    const f = fixture({ sourceResearch: true }); expect(() => prepareProductSourceNode({ ...f.options, research: undefined })).toThrow(/reuse/);
    expect(control.prepare).not.toHaveBeenCalled();
  });
});
