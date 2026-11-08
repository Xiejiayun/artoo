// Real local configuration parsing, file pins and private daemon-configuration
// brand. Native/ACL and prepared verifier/release admissions are controlled;
// these tests neither launch a process nor establish a successor checkpoint.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseCapabilitiesV1 } from "@artoo/domain";
import type { ArtoodConfig } from "./main.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
const local = vi.hoisted(() => ({ backend: {}, supervisor: {}, installation: "", roots: [] as string[], manifest: {} as object,
  profiles: new Set<PreparedVerificationProfile>(), h7: new Set<PreparedVerificationProfile>(),
  releases: new Map<PreparedReleaseProfile, ReleaseCapabilitiesV1 | undefined>() }));
vi.mock("./verification.js", () => ({
  prepareVerificationProfiles: (profiles: PreparedVerificationProfile[]) => profiles,
  attachWindowsVerificationBackend: (profile: PreparedVerificationProfile, backend: object) => {
    if (!local.profiles.has(profile) || backend !== local.backend) throw Error("Controlled original native profile required");
  },
  assertLocallyPreparedVerificationProfile: (profile: PreparedVerificationProfile) => {
    if (!local.profiles.has(profile)) throw Error("Controlled original prepared verifier required");
  },
  assertImportedValidationVerificationProfile: (profile: PreparedVerificationProfile) => {
    if (!local.h7.has(profile)) throw Error("Controlled original H7 verifier required");
  },
}));
vi.mock("./product-release.js", () => ({ prepareReleaseProfiles: (profiles: PreparedReleaseProfile[]) => profiles,
  readReleaseCapabilities: (profile: PreparedReleaseProfile) => {
    if (!local.releases.has(profile)) throw Error("Controlled original prepared publisher required");
    return local.releases.get(profile);
  },
}));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: () => ({}), assertWindowsReleaseStorage: () => {} }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: (backend: object) => {
  if (backend !== local.backend) throw Error("Controlled native installation required");
  return { directory: local.installation, writableWorkspaceRoots: local.roots };
} }));
vi.mock("./windows-supervisor-authority.js", () => ({ readWindowsDaemonSupervisorAuthority: (supervisor: object, backend: object) => {
  if (supervisor !== local.supervisor || backend !== local.backend) throw Error("Controlled original native supervisor required");
  return { lifetimeOwnership: { runtimeManifest: local.manifest } };
} }));
vi.mock("./windows-local-acl.js", () => ({ physicalWindowsDirectory: (path: string) => realpathSync.native(path),
  windowsPathsOverlap: (left: string, right: string) => left === right || left.startsWith(right + sep) || right.startsWith(left + sep) }));
import { prepareCleanDaemonConfiguration, assertCleanDaemonControllerConfiguration } from "./windows-clean-local-configuration.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!, executable = Object.getOwnPropertyDescriptor(process, "execPath")!;
const roots: string[] = [], sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  local.profiles.clear(); local.h7.clear(); local.releases.clear();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "execPath", executable);
  const parent = realpathSync.native(tmpdir());
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent + sep + "artoo-clean-discovery-")) throw Error("Refusing cleanup outside controlled fixture parent");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(options: { mapped?: boolean; validation?: boolean; selected?: "missing" | "ambiguous" } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-clean-discovery-"))); roots.push(root);
  const workspace = join(root, "workspace"), store = join(root, "store"), family = join(root, "family"), control = join(root, "control"),
    runtime = join(root, "runtime"), native = join(root, "native"), programs = join(root, "programs"), codexHome = join(root, "codex-home");
  for (const path of [workspace, store, family, control, runtime, native, programs, codexHome]) mkdirSync(path);
  const write = (path: string, bytes: string) => { writeFileSync(path, bytes); return path; };
  const entry = write(join(runtime, "artood.mjs"), "controlled daemon bytes; never imported"),
    node = write(join(programs, "node.exe"), "controlled Node image; never executed"),
    git = write(join(programs, "git.exe"), "controlled Git image; never executed"),
    codex = write(join(programs, "codex.exe"), "controlled model image; never executed");
  Object.defineProperty(process, "execPath", { ...executable, value: node });
  const bundle = JSON.stringify({ format: "artoo.desktop-daemon.v1", node_target: "node24", tree: { directories: [],
    files: [{ path: "artood.mjs", size: readFileSync(entry).length, sha256: sha(readFileSync(entry)) }] } });
  local.manifest = { path: write(join(runtime, "bundle-manifest.json"), bundle), bytes: Buffer.byteLength(bundle), sha256: sha(bundle) };
  write(join(native, "Supervisor.exe"), "controlled native image; never executed");
  write(join(native, "manifest.json"), JSON.stringify({ executable: "Supervisor.exe", capabilities: ["artoo.windows-daemon-supervisor-lifetime.v1"] }));
  local.installation = native; local.roots = [workspace];
  const capabilities = structuredClone(data.admission.request.measurement_v2.destination_release) as ReleaseCapabilitiesV1;
  capabilities.binding.workspace_root = workspace;
  const profile = { id: capabilities.binding.verification_profile_id, digest: capabilities.binding.verification_profile_digest,
    project_id: capabilities.binding.project_id, workspace_root: workspace } as PreparedVerificationProfile;
  const release = { id: capabilities.binding.release_profile_id, digest: capabilities.binding.release_profile_digest,
    project_id: profile.project_id, verifier: profile } as PreparedReleaseProfile;
  local.profiles.add(profile); local.h7.add(profile); local.releases.set(release, capabilities);
  const releases = [release];
  if (options.selected === "ambiguous") {
    const second = { ...release, id: "second-publisher" };
    releases.push(second); local.releases.set(second, capabilities);
  }
  const source = write(join(root, "source.json"), JSON.stringify({ version: 1, storeRoot: store, gitExecutable: git,
    recovery: { version: 1, deviceId: "device", workspaceRoot: workspace, controlDirectory: control },
    operations: { version: 1, importedReview: true, importedDesign: true, importedDesignReview: true,
      importedExecution: true, importedExecutionReview: true, importedValidation: options.validation !== false },
    measurementV2: { version: 1, releaseProfileIds: options.selected === "missing" ? ["uninstalled-publisher"] : releases.map(value => value.id),
      destinationResearchMappings: options.mapped === false ? [] : [{ sourceProfileDigest: sha("source verifier"), destinationProfileId: profile.id,
        sourceRelease: capabilities, commandPairs: [{ source_command_id: "web", destination_command_id: "web" }] }] } }));
  const lineageFile = write(join(root, "lineage.json"), JSON.stringify({ version: 1, storeFamily: family, genesisStore: store }));
  const config = { nodeId: "node", url: "ws://127.0.0.1/api/v1/node", allowedRoots: [workspace], runtimes: ["codex"],
    codex: { binaryPath: codex, model: "controlled-model", baseUrl: "http://127.0.0.1:18181/v1" },
    productSourceConfigFile: source, windowsProcessBackend: local.backend, verificationProfiles: [profile], releaseProfiles: releases } as unknown as ArtoodConfig;
  const token = prepareCleanDaemonConfiguration({ config, env: { CODEX_HOME: codexHome, ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256: sha(bundle) },
    entry, lineageFile, supervisor: local.supervisor as never, observerId: "00000000-0000-4000-8000-000000000001" });
  return { token, input: { nodeId: "node", profiles: [profile], releases }, profile, release, capabilities, source };
}

describe("clean controller discovery binds protected local policy to prepared node controllers", () => {
  it("accepts the exact protected mapping, H7 verifier and selected publisher before a checkpoint exists", () => {
    const f = fixture(); expect(() => assertCleanDaemonControllerConfiguration(f.token, f.input)).not.toThrow();
  });
  it("rejects a cloned configuration token and a different node", () => {
    const f = fixture();
    expect(() => assertCleanDaemonControllerConfiguration(structuredClone(f.token), f.input)).toThrow(/Original native clean daemon configuration/);
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, nodeId: "other-node" })).toThrow(/protected complete H7 configuration/);
  });
  it.each([{ mapped: false }, { validation: false }])("rejects missing protected continuation policy: %j", options => {
    const f = fixture(options);
    expect(() => assertCleanDaemonControllerConfiguration(f.token, f.input)).toThrow(/protected (fixed-workspace mapping|complete H7 configuration)/);
  });
  it.each(["missing", "ambiguous"] as const)("rejects %s protected release selection", selected => {
    const f = fixture({ selected });
    expect(() => assertCleanDaemonControllerConfiguration(f.token, f.input)).toThrow(/exact protected release selection/);
  });
  it("rejects a cloned verifier even when all public fields match", () => {
    const f = fixture(), copied = { ...f.profile };
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, profiles: [copied] })).toThrow(/original prepared verifier/);
  });
  it("requires current H7 qualification and the unique matching verifier", () => {
    const f = fixture();
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, profiles: [f.profile, f.profile] })).toThrow(/changed its prepared verifier/);
    local.h7.delete(f.profile);
    expect(() => assertCleanDaemonControllerConfiguration(f.token, f.input)).toThrow(/original H7 verifier/);
  });
  it("rejects substitution of a publisher with a different verifier object", () => {
    const f = fixture(), copied = { ...f.release, verifier: { ...f.profile } };
    local.releases.set(copied, f.capabilities);
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, releases: [copied] })).toThrow(/changed its prepared publisher/);
  });
  it("compares the separately prepared publisher capabilities and requires criterion acceptance", () => {
    const f = fixture(), prepared = { ...f.release };
    local.releases.set(prepared, { ...f.capabilities, binding: { ...f.capabilities.binding, release_profile_digest: sha("different publication") } });
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, releases: [prepared] })).toThrow(/protected publication capabilities/);
    local.releases.set(prepared, undefined);
    expect(() => assertCleanDaemonControllerConfiguration(f.token, { ...f.input, releases: [prepared] })).toThrow(/protected publication capabilities/);
  });
  it("rechecks pinned configuration bytes before advertising controllers", () => {
    const f = fixture(); writeFileSync(f.source, readFileSync(f.source, "utf8") + " ");
    expect(() => assertCleanDaemonControllerConfiguration(f.token, f.input)).toThrow(/fixed bytes changed/);
  });
});
