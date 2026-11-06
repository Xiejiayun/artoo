// Native ACL/helper admission and runtime execution are controlled here; no child process is started.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
import { ProductSourceTransferRequestV2Schema, type ReleaseCapabilitiesV1 } from "@artoo/domain";
const io = vi.hoisted(() => ({ read: undefined as unknown as typeof readFileSync, stat: undefined as unknown as typeof lstatSync }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>(); io.read = actual.readFileSync; io.stat = actual.lstatSync;
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), lstatSync: vi.fn(actual.lstatSync) };
});
const control = vi.hoisted(() => ({ prepare: vi.fn(() => Object.freeze({})), current: vi.fn(), close: vi.fn(), client: vi.fn(() => ({})),
  release: vi.fn<(profile: PreparedReleaseProfile) => ReleaseCapabilitiesV1 | undefined>(),
  recovery: vi.fn(() => Object.freeze({})), recoveredSource: vi.fn(() => Object.freeze({})), validation: vi.fn(),
  recoveredCurrent: vi.fn<typeof import("./windows-source-recovery.js").assertWindowsSourceRuntimeConfiguration>(),
  recoveryOperation: vi.fn((_runtime: unknown, _descriptor: unknown, work: () => unknown) => work()),
  storage: vi.fn(() => ({})), audit: vi.fn(), backend: vi.fn(), design: vi.fn(), designReview: vi.fn(), execution: vi.fn(), roles: vi.fn(() => ({ semantic: true, measurementV2: true, importedReview: true, importedDesign: true, importedDesignReview: true, importedExecution: true })) }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: control.storage, assertWindowsReleaseStorage: vi.fn(), auditWindowsReleaseStorage: control.audit }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: control.backend }));
vi.mock("./verification.js", () => ({ assertImportedDesignVerificationProfile: control.design, assertImportedDesignReviewVerificationProfile: control.designReview,
  assertImportedExecutionVerificationProfile: control.execution, assertImportedValidationVerificationProfile: control.validation }));
vi.mock("./product-release.js", () => ({ readReleaseCapabilities: control.release }));
vi.mock("./product-source-runtime.js", () => ({ prepareProductSourceRuntime: control.prepare, assertProductSourceRuntimeConfiguration: control.current,
  closeProductSourceRuntime: control.close, readProductSourceRuntimeCapabilities: control.roles }));
vi.mock("./product-source-semantic-client.js", () => ({ createProductSourceSemanticClient: control.client }));
vi.mock("./windows-source-recovery.js", () => ({ prepareWindowsSourceRecoveryConfiguration: control.recovery,
  readWindowsRecoverySourceRuntime: control.recoveredSource,
  assertWindowsSourceRuntimeConfiguration: control.recoveredCurrent,
  withWindowsSourceRecoveryOperation: control.recoveryOperation }));
import { prepareProductSourceNode } from "./product-source-node.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { vi.clearAllMocks(); control.release.mockReset(); vi.mocked(readFileSync).mockImplementation(io.read); vi.mocked(lstatSync).mockImplementation(io.stat);
  control.recoveredCurrent.mockReset().mockImplementation(() => { throw Error("Controlled recovery configuration check was not configured"); });
  control.recoveryOperation.mockReset().mockImplementation((_runtime, _descriptor, work) => work());
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => { Object.defineProperty(process, "platform", platform); });
const token = "sk_device_fixture_" + "a".repeat(64);
function fixture(config: Record<string, unknown> = {}, capabilities?: PreparedVerificationProfile["capabilities"]) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-source-node-config-"))), workspace = join(root, "workspace"); mkdirSync(workspace);
  const file = join(root, "source.json"), research = { receiptDirectory: join(root, "research") };
  const profile = Object.freeze({ id: "local", project_id: "project", workspace_root: workspace, ...(capabilities ? { capabilities } : {}) }) as PreparedVerificationProfile;
  const release = Object.freeze({ id: "publish", verifier: profile }) as PreparedReleaseProfile;
  const value = { version: 1, storeRoot: join(root, "store"), gitExecutable: join(root, "git.exe"), ...config };
  writeFileSync(file, JSON.stringify(value));
  const options = { file, url: `wss://control.example/api/v1/node?token=${token}`, nodeId: "node", allowedRoots: [workspace],
    windowsBackend: Object.freeze({}) as PreparedWindowsProcessBackend, profiles: [profile], releaseProfiles: [release], research, acknowledgeRunEvents: true };
  return { options, profile, release, research, file, value };
}
describe("standard source-node protected configuration", () => {
  it("describes only protected source exports and freezes a fresh reader-derived snapshot", () => {
    const request = ProductSourceTransferRequestV2Schema.parse(JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8")).admission.request);
    const f = fixture({ sourceResearch: true, measurementV2: { version: 1, releaseProfileIds: ["publish"] }, operations: { version: 1 } }, request.source_export.source_capabilities);
    const release = structuredClone(request.source_export.measurement_v2!.source_release);
    Object.assign(release.binding, { release_profile_id: "publish", verification_profile_id: "local", workspace_root: f.profile.workspace_root });
    control.release.mockImplementation(profile => profile === f.release ? release : undefined);
    const prepared = prepareProductSourceNode(f.options), routes = prepared.routing;
    expect(routes).toEqual({ version: 1, source_exports: [release], destination_mappings: [] });
    expect(control.release).toHaveBeenCalledWith(f.release); expect(Object.isFrozen(routes.source_exports[0]!.binding)).toBe(true);
    expect(() => routes.source_exports.push(release)).toThrow();
    writeFileSync(f.file, JSON.stringify({ ...f.value, sourceResearch: false }));
    expect(() => prepared.routing).toThrow("changed after preparation");
  });
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
    { version: 2 }, { operations: { version: 1, importedDesign: true } }, { operations: { version: 1, importedDesignReview: true } },
    { operations: { version: 1, importedExecution: true } }, { operations: { version: 1, importedExecutionReview: true } }, { operations: { version: 1 } },
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
  it("enables H4 only with explicit local opt-in and the exact protected all-case destination profile", () => {
    const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
    const request = data.admission.request, destinationResearchMappings = [{ sourceProfileDigest: request.source_export.byte_export.profile_digest,
      destinationProfileId: "local", commandPairs: request.command_pairs, sourceRelease: request.source_export.measurement_v2.source_release }];
    const f = fixture({ measurementV2: { version: 1, releaseProfileIds: ["publish"], destinationResearchMappings },
      operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true } });
    const prepared = prepareProductSourceNode(f.options);
    expect(prepared.importedDesignReview).toBe(true); expect(control.designReview).toHaveBeenCalledWith(f.profile);
    control.designReview.mockImplementationOnce(() => { throw Error("protected prototype-only profile"); });
    expect(() => prepareProductSourceNode(f.options)).toThrow("prototype-only");
    expect(control.prepare).toHaveBeenCalledTimes(1);
  });
  it("enables H5 only with H4 and its original protected implementation verifier", () => {
    const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
    const request = data.admission.request, destinationResearchMappings = [{ sourceProfileDigest: request.source_export.byte_export.profile_digest,
      destinationProfileId: "local", commandPairs: request.command_pairs, sourceRelease: request.source_export.measurement_v2.source_release }];
    const f = fixture({ measurementV2: { version: 1, releaseProfileIds: ["publish"], destinationResearchMappings },
      operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true, importedExecution: true } });
    const prepared = prepareProductSourceNode(f.options);
    expect(prepared.importedExecution).toBe(true); expect(control.execution).toHaveBeenCalledWith(f.profile);
    control.execution.mockImplementationOnce(() => { throw Error("protected implementation profile unavailable"); });
    expect(() => prepareProductSourceNode(f.options)).toThrow("implementation profile unavailable"); expect(control.prepare).toHaveBeenCalledTimes(1);
  });
  it("requires explicit H6 opt-in, the original H5 profile and committed event receipts", () => {
    const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
    const request = data.admission.request;
    const f = fixture({ measurementV2: { version: 1, releaseProfileIds: ["publish"], destinationResearchMappings: [{
      sourceProfileDigest: request.source_export.byte_export.profile_digest, destinationProfileId: "local",
      commandPairs: request.command_pairs, sourceRelease: request.source_export.measurement_v2.source_release }] },
      operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true, importedExecution: true, importedExecutionReview: true } });
    expect(prepareProductSourceNode(f.options).importedExecutionReview).toBe(true);
    expect(control.execution).toHaveBeenCalledWith(f.profile);
    expect(() => prepareProductSourceNode({ ...f.options, acknowledgeRunEvents: false })).toThrow("committed run-event receipts");
    control.execution.mockImplementationOnce(() => { throw Error("H6 protected implementation profile unavailable"); });
    expect(() => prepareProductSourceNode(f.options)).toThrow("implementation profile unavailable");
    expect(control.prepare).toHaveBeenCalledTimes(1);
  });
});
function recoveryConfigurationFixture(capabilities?: PreparedVerificationProfile["capabilities"]) {
  const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
  const request = data.admission.request;
  const f = fixture({ measurementV2: { version: 1, releaseProfileIds: ["publish"], destinationResearchMappings: [{
    sourceProfileDigest: request.source_export.byte_export.profile_digest, destinationProfileId: "local",
    commandPairs: request.command_pairs, sourceRelease: request.source_export.measurement_v2.source_release }] },
    operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true,
      importedExecution: true, importedExecutionReview: true, importedValidation: true } }, capabilities);
  writeFileSync(f.file, JSON.stringify({ ...f.value, recovery: { version: 1, deviceId: "device",
    workspaceRoot: f.profile.workspace_root, controlDirectory: join(f.file, "..", "guardian-control") } }));
  return f;
}
describe("protected recovery startup selection (controlled authority factory)", () => {
  it("discovers a complete destination mapping after supervisor qualification without opening its runtime", () => {
    const request = ProductSourceTransferRequestV2Schema.parse(JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8")).admission.request);
    const f = recoveryConfigurationFixture(request.byte_request.destination.capabilities), release = structuredClone(request.measurement_v2!.destination_release);
    Object.assign(release.binding, { release_profile_id: "publish", verification_profile_id: "local", workspace_root: f.profile.workspace_root });
    control.release.mockImplementation(profile => profile === f.release ? release : undefined);
    const source = prepareProductSourceNode(f.options);
    expect(() => source.routing).toThrow("qualified native supervisor"); source.qualifyRecovery({} as never);
    expect(source.routing).toEqual({ version: 1, source_exports: [], destination_mappings: [{ source_release: request.source_export.measurement_v2!.source_release,
      destination_release: release, command_pairs: request.command_pairs }] });
    expect(control.prepare).not.toHaveBeenCalled(); expect(control.recoveredSource).not.toHaveBeenCalled();
    expect(() => source.runtime).toThrow("registration");
  });
  it("prepares configuration without acquiring an ordinary source owner or advertising before supervisor qualification", () => {
    const f = recoveryConfigurationFixture(), source = prepareProductSourceNode(f.options);
    expect(source.recoveryRequired).toBe(true); expect(source.recoveryConfiguration).toBeUndefined();
    expect(control.prepare).not.toHaveBeenCalled(); expect(control.recovery).not.toHaveBeenCalled();
    expect(() => source.runtime).toThrow("registration"); expect(() => source.features).toThrow("qualified native supervisor");
    const supervisor = Object.freeze({}); source.qualifyRecovery(supervisor as never);
    expect(control.recovery).toHaveBeenCalledWith(expect.objectContaining({ supervisor, source: expect.objectContaining({
      profiles: f.options.profiles, windowsBackend: f.options.windowsBackend }) }));
    expect(source.features).toContain("product.source.recovery.v1"); expect(control.prepare).not.toHaveBeenCalled();
  });
  it("does not publish recovery features after rejected supervisor qualification", () => {
    const f = recoveryConfigurationFixture(), source = prepareProductSourceNode(f.options);
    control.recovery.mockImplementationOnce(() => { throw Error("Original supervisor authority missing"); });
    expect(() => source.qualifyRecovery({} as never)).toThrow("Original supervisor");
    expect(() => source.features).toThrow("qualified native supervisor"); expect(control.prepare).not.toHaveBeenCalled();
  });
  it("activates only once and keeps the guardian store fence when the source node closes", () => {
    const f = recoveryConfigurationFixture(), source = prepareProductSourceNode(f.options);
    source.qualifyRecovery({} as never); const recoveredRuntime = Object.freeze({});
    const calls: string[] = [], descriptor = { operationId: "source-configuration",
      bindingDigest: "sha256:" + createHash("sha256").update(io.read(f.file)).digest("hex"), serverOperation: null };
    control.recoveryOperation.mockImplementation((runtime, operation, work) => {
      expect(runtime).toBe(recoveredRuntime); expect(operation).toEqual(descriptor); calls.push("scope.enter");
      try { return work(); } finally { calls.push("scope.leave"); }
    });
    control.recoveredCurrent.mockImplementation((runtime, nodeId, allowedRoots, profiles) => {
      expect(runtime).toBe(recoveredRuntime); expect(nodeId).toBe(f.options.nodeId);
      expect(allowedRoots).toBe(f.options.allowedRoots); expect(profiles).toBe(f.options.profiles); calls.push("configuration");
    });
    const actual = source.activateRecovery(recoveredRuntime as never);
    expect(control.recoveredSource).toHaveBeenCalledWith(recoveredRuntime); expect(source.runtime).toBe(actual);
    expect(calls).toEqual(["scope.enter", "configuration", "scope.leave"]);
    source.assertCurrent();
    expect(calls).toEqual(["scope.enter", "configuration", "scope.leave", "scope.enter", "configuration", "scope.leave"]);
    expect(control.recoveredCurrent).toHaveBeenCalledTimes(2); expect(control.current).not.toHaveBeenCalled();
    expect(() => source.activateRecovery(recoveredRuntime as never)).toThrow("already consumed");
    expect(control.recoveredSource).toHaveBeenCalledOnce(); expect(control.prepare).not.toHaveBeenCalled();
    source.close(); expect(control.close).not.toHaveBeenCalled();
  });
  it("propagates rejected recovery configuration without ordinary-runtime fallback or releasing its owner fence", () => {
    const f = recoveryConfigurationFixture(), source = prepareProductSourceNode(f.options);
    source.qualifyRecovery({} as never); const recoveredRuntime = Object.freeze({}), failure = Error("Controlled recovery configuration revoked");
    control.recoveredCurrent.mockImplementationOnce(() => { throw failure; });
    expect(() => source.activateRecovery(recoveredRuntime as never)).toThrow(failure);
    expect(control.recoveredCurrent).toHaveBeenCalledExactlyOnceWith(recoveredRuntime, f.options.nodeId, f.options.allowedRoots, f.options.profiles);
    expect(control.current).not.toHaveBeenCalled(); expect(control.prepare).not.toHaveBeenCalled();
    expect(() => source.activateRecovery(recoveredRuntime as never)).toThrow("already consumed");
    expect(control.recoveredSource).toHaveBeenCalledOnce();
    source.close(); expect(control.close).not.toHaveBeenCalled();
  });
});

describe("one strongest enabled source-verifier tier per synchronous preparation", () => {
  const tiers = ["importedDesign", "importedDesignReview", "importedExecution", "importedExecutionReview", "importedValidation"] as const;
  const checker = () => ({ design: control.design, designReview: control.designReview, execution: control.execution, validation: control.validation });
  function selected(level: number) {
    const f = recoveryConfigurationFixture();
    const operations = { version: 1, importedReview: true, ...Object.fromEntries(tiers.map((name, index) => [name, index < level])) };
    // Use the ordinary configuration here so preparation can reach the controlled
    // runtime factory. Native source and recovery authority remain test doubles.
    writeFileSync(f.file, JSON.stringify({ ...f.value, operations })); return f;
  }
  it.each([
    { level: 0, expected: null }, { level: 1, expected: "design" }, { level: 2, expected: "designReview" },
    { level: 3, expected: "execution" }, { level: 4, expected: "execution" }, { level: 5, expected: "validation" },
  ] as const)("selects $expected for enabled prefix $level without repeated direct lower-tier checks", ({ level, expected }) => {
    const f = selected(level); prepareProductSourceNode(f.options);
    for (const [name, check] of Object.entries(checker())) {
      expect(check).toHaveBeenCalledTimes(name === expected ? 1 : 0);
      if (name === expected) expect(check).toHaveBeenCalledWith(f.profile);
    }
    expect(control.prepare).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3, 4, 5])("still stops before source ownership when enabled tier %s rejects", level => {
    const f = selected(level), name = level === 1 ? "design" : level === 2 ? "designReview" : level < 5 ? "execution" : "validation";
    const failure = Error("Controlled original tier rejected its protected profile");
    checker()[name].mockImplementationOnce(() => { throw failure; });
    expect(() => prepareProductSourceNode(f.options)).toThrow(failure); expect(control.prepare).not.toHaveBeenCalled();
    expect(control.client).not.toHaveBeenCalled(); expect(control.recovery).not.toHaveBeenCalled();
  });
  it.each(["unbound-backend", "changed-protected-script"] as const)
  ("the actual highest-tier checker retains its lower-level %s failure", async variant => {
    const actual = await vi.importActual<typeof import("./verification.js")>("./verification.js"), f = selected(5);
    const script = join(f.file, "..", "controlled-check.mjs"); writeFileSync(script, "// controlled protected script\n");
    // Real local profile preparation and highest-tier call chain; neither this
    // profile nor its command can execute a native process in this test.
    const profile = actual.prepareVerificationProfiles([{ id: f.profile.id, project_id: f.profile.project_id,
      workspace_root: f.profile.workspace_root, subject_paths: ["product"], required_files: [],
      commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }] }])[0]!;
    if (variant === "changed-protected-script") writeFileSync(script, "// changed verifier bytes\n");
    control.validation.mockImplementationOnce(actual.assertImportedValidationVerificationProfile);
    expect(() => prepareProductSourceNode({ ...f.options, profiles: [profile] })).toThrow(variant === "unbound-backend"
      ? /Imported design requires an original native Windows Job verifier/ : /administrator verifier changed/);
    expect(control.validation).toHaveBeenCalledWith(profile); expect(control.design).not.toHaveBeenCalled();
    expect(control.designReview).not.toHaveBeenCalled(); expect(control.execution).not.toHaveBeenCalled();
    expect(control.prepare).not.toHaveBeenCalled(); expect(control.client).not.toHaveBeenCalled();
  });
});
