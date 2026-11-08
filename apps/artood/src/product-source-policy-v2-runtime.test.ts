// Controlled code-installation boundary; native ACL qualification is tested separately.
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: vi.fn(() => ({})), assertWindowsCodeInstallation: vi.fn() }));
// Controlled preparation/authority mocks only. No native process, authenticated
// transfer, browser, review or publisher is exercised by this suite.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalReleaseCapabilityContract, CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, type ReleaseCapabilitiesV1 } from "@artoo/domain";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import * as codeInstallation from "./windows-code-installation.js";
import * as mutableStorage from "./windows-release-storage.js";

const control = vi.hoisted(() => ({ releases: new Map<object, () => unknown>(), readerFactory: vi.fn(), verify: vi.fn() }));
vi.mock("./verification.js", () => ({ assertFinalVerificationExportBinding: vi.fn(), assertLocallyPreparedVerificationProfile: vi.fn(),
  prepareVerificationProfiles: vi.fn(value => value), subjectManifest: vi.fn(), selectVerificationProfile: vi.fn(), runTransferredResearchVerification: control.verify }));
vi.mock("./product-release.js", () => ({ prepareReleaseCapabilityReader: (profile: object) => {
  control.readerFactory(profile);
  const read = control.releases.get(profile); if (!read) throw new Error("Controlled factory requires original prepared release identity");
  return Object.freeze({ capabilities: read(), readCapabilities: read });
} }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: vi.fn(() => ({})),
  assertWindowsReleaseStorage: vi.fn(), auditWindowsReleaseStorage: vi.fn() }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn() }));
vi.mock("./protected-command.js", () => ({ runProtectedCommand: vi.fn(() => { throw new Error("Preparation suite must not execute a command"); }) }));
vi.mock("./process-adapter.js", () => ({ assertWindowsVerifiedExecutionExportBinding: vi.fn() }));
vi.mock("./research.js", () => ({ prepareResearchOptions: vi.fn(value => value), readResearchReceipt: vi.fn() }));
import { prepareProductSourceRuntime, productSourceSemanticExportEnabled, productSourceMeasurementV2ExportEnabled,
  closeProductSourceRuntime, readProductSourceVerificationAdmission, type ProductSourceRuntimeOptions,
  type PreparedProductSourceVerificationAdmission } from "./product-source-runtime.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); control.releases.clear(); vi.clearAllMocks(); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  const parent = `${realpathSync.native(tmpdir())}${sep}artoo-v2-preparation-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent)) throw new Error("Unexpected controlled preparation cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(version: 1 | 2 = 2) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-v2-preparation-"))); roots.push(root);
  const workspace = join(root, "workspace"), store = join(root, "store"), programs = join(root, "programs"), receipts = join(root, "receipts");
  for (const path of [workspace, store, programs, receipts]) mkdirSync(path);
  const git = join(programs, "git.exe"); writeFileSync(git, "controlled data; never executed");
  const policy = version === 1 ? { version: 1 as const, coverage: "every-must-criterion" as const }
    : { version: 2 as const, coverage: "every-must-criterion" as const, methods: ["workspace-check", "configured-static-release"] as ["workspace-check", "configured-static-release"] };
  // Verifier preparation is explicitly mocked; these are local gate inputs only.
  const profile = { id: "destination-verify", digest: sha("destination verifier"), project_id: "project", workspace_root: workspace,
    commands: [], required_files: [], subject_paths: ["product", ".artoo/product"], trustedFiles: [],
    capabilities: { version: 1, profile_digest: sha("destination verifier"), measurement_plan_policy: policy,
      checks: [{ command_id: "destination-browser" }] } } as unknown as PreparedVerificationProfile;
  const prepared = { id: "destination-release", digest: sha("destination release"), project_id: "project", verifier: profile } as PreparedReleaseProfile;
  const contract: ReleaseCapabilitiesV1["contract"] = { version: 1, kind: "configured-static-release", claim: "configured",
    execution_phase: "after-stage-acceptance", endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time",
    lifecycle: "while-configured-node-service-running", health_checks: [{ path: "/", expected_status: 200, body: "immutable-artifact-equality",
      identity: "release-id-and-artifact-digest-headers" }], criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM,
      statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } };
  let capabilities: ReleaseCapabilitiesV1 = { version: 1, contract, binding: { version: 1, release_profile_id: prepared.id,
    release_profile_digest: prepared.digest, verification_profile_id: profile.id, verification_profile_digest: profile.digest,
    project_id: profile.project_id, workspace_root: workspace, contract_digest: sha(canonicalReleaseCapabilityContract(contract)) } };
  let revoked = false;
  control.releases.set(prepared, () => { if (revoked) throw new Error("Controlled local release revoked"); return capabilities; });
  const sourceRelease = structuredClone(capabilities);
  Object.assign(sourceRelease.binding, { release_profile_id: "source-release", release_profile_digest: sha("source release"),
    verification_profile_id: "source-verify", verification_profile_digest: sha("source verifier"), workspace_root: "C:/source" });
  const mapping = { sourceProfileDigest: sourceRelease.binding.verification_profile_digest, destinationProfileId: profile.id, sourceRelease,
    commandPairs: [{ source_command_id: "source-browser", destination_command_id: "destination-browser" }] };
  const options: ProductSourceRuntimeOptions = { nodeId: "node", storeRoot: store, allowedRoots: [workspace], profiles: [profile],
    gitExecutable: git, windowsBackend: {} as PreparedWindowsProcessBackend, sourceResearch: { receiptDirectory: receipts },
    ...(version === 2 ? { measurementV2: { version: 1, releaseProfiles: [prepared], destinationResearchMappings: [mapping] } } : {}) };
  return { profile, prepared, options, mapping, get capabilities() { return capabilities; },
    changeCapabilities: (change: (value: ReleaseCapabilitiesV1) => void) => { capabilities = structuredClone(capabilities); change(capabilities); },
    revoke: () => { revoked = true; } };
}

describe("first-hop measurement v2 explicit local preparation", () => {
  it("prepares Git with read-only code policy while retaining mutable policy for source and research stores", () => {
    const f = fixture(), runtime = prepareProductSourceRuntime(f.options);
    const directory = f.options.gitExecutable.slice(0, f.options.gitExecutable.lastIndexOf(sep));
    expect(codeInstallation.prepareWindowsCodeInstallation).toHaveBeenCalledWith({ directory, writableWorkspaceRoots: f.options.allowedRoots });
    expect(mutableStorage.prepareWindowsReleaseStorage).not.toHaveBeenCalledWith(expect.objectContaining({ directory }));
    expect(mutableStorage.prepareWindowsReleaseStorage).toHaveBeenCalledWith({ directory: f.options.storeRoot, writableWorkspaceRoots: f.options.allowedRoots });
    closeProductSourceRuntime(runtime);
  });
  it("keeps the extension-absent v1 setup and does not opt it in to v2", () => {
    const f = fixture(1), runtime = prepareProductSourceRuntime(f.options);
    expect(productSourceSemanticExportEnabled(runtime)).toBe(true);
    expect(productSourceMeasurementV2ExportEnabled(runtime, f.profile)).toBe(false);
    expect(control.readerFactory).not.toHaveBeenCalled(); closeProductSourceRuntime(runtime);
  });
  it("requires an explicit release association for source research under v2", () => {
    const f = fixture(); delete f.options.measurementV2;
    expect(() => prepareProductSourceRuntime(f.options)).toThrow(/explicit prepared v2/);
  });
  it.each(["unknown-version", "empty-release-set"] as const)("rejects %s in the local opt-in", kind => {
    const f = fixture();
    if (kind === "unknown-version") (f.options.measurementV2 as { version: number }).version = 2;
    else f.options.measurementV2!.releaseProfiles = [];
    expect(() => prepareProductSourceRuntime(f.options)).toThrow(/explicit versioned local release preparation/);
    expect(control.readerFactory).not.toHaveBeenCalled();
  });
  it("uses the original prepared release factory and exact verifier identity", () => {
    const f = fixture(), runtime = prepareProductSourceRuntime(f.options);
    expect(control.readerFactory).toHaveBeenCalledExactlyOnceWith(f.prepared);
    expect(productSourceMeasurementV2ExportEnabled(runtime, f.profile)).toBe(true);
    expect(productSourceMeasurementV2ExportEnabled(runtime, structuredClone(f.profile))).toBe(false);
    closeProductSourceRuntime(runtime);
  });
  it("does not reconstruct a reader from serialized release metadata", () => {
    const f = fixture(); f.options.measurementV2!.releaseProfiles = [{ ...f.prepared }];
    expect(() => prepareProductSourceRuntime(f.options)).toThrow(/original prepared release identity/);
  });
  it("rejects two release profiles associated with the same verifier", () => {
    const f = fixture(); f.options.measurementV2!.releaseProfiles = [f.prepared, f.prepared];
    expect(() => prepareProductSourceRuntime(f.options)).toThrow(/associations are ambiguous/);
  });
  it.each(["workspace_root", "project_id", "verification_profile_id", "verification_profile_digest", "release_profile_id", "release_profile_digest", "contract_digest"] as const)(
    "binds the prepared capability's %s", field => {
      const f = fixture(); f.changeCapabilities(value => { value.binding[field] = field.endsWith("digest") ? sha("changed") : "changed"; });
      expect(() => prepareProductSourceRuntime(f.options)).toThrow(/exact verifier or contract/);
    });
  it.each(["missing-check", "duplicate-check", "source-digest", "release-contract", "duplicate-mapping"] as const)(
    "rejects %s in the locally selected destination mapping", kind => {
      const f = fixture();
      if (kind === "missing-check") f.mapping.commandPairs = [];
      if (kind === "duplicate-check") f.mapping.commandPairs.push({ ...f.mapping.commandPairs[0]! });
      if (kind === "source-digest") f.mapping.sourceProfileDigest = sha("other verifier");
      if (kind === "release-contract") {
        f.mapping.sourceRelease.contract.health_checks[0]!.path = "/changed";
        f.mapping.sourceRelease.binding.contract_digest = sha(canonicalReleaseCapabilityContract(f.mapping.sourceRelease.contract));
      }
      if (kind === "duplicate-mapping") f.options.measurementV2!.destinationResearchMappings = [f.mapping, f.mapping];
      expect(() => prepareProductSourceRuntime(f.options)).toThrow(/v2 research mapping/);
    });
  it("re-reads the complete original local capability after preparation", () => {
    const f = fixture(), runtime = prepareProductSourceRuntime(f.options);
    f.changeCapabilities(value => { value.binding.release_profile_digest = sha("replaced release"); });
    expect(() => productSourceMeasurementV2ExportEnabled(runtime, f.profile)).toThrow(/prepared release capability changed/);
  });
  it("fails closed when the original reader is revoked", () => {
    const f = fixture(), runtime = prepareProductSourceRuntime(f.options); f.revoke();
    expect(() => productSourceSemanticExportEnabled(runtime)).toThrow(/local release revoked/);
  });
  it("does not let a copied admission mint a reader or start a verifier", () => {
    const f = fixture();
    expect(() => readProductSourceVerificationAdmission({} as PreparedProductSourceVerificationAdmission, f.profile, "request", undefined)).toThrow(/original live semantic/);
    expect(control.verify).not.toHaveBeenCalled(); expect(control.readerFactory).not.toHaveBeenCalled();
  });
});
