// Controlled filesystem and original-authority stand-ins only. These tests do
// not qualify a real Windows installation, start a process or prove publication.
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

type File = { bytes: Buffer; ino: bigint; ctime: bigint; links: bigint; symlink: boolean };
const controlled = vi.hoisted(() => ({ files: new Map<string, File>(), directories: new Map<string, number>(),
  code: new Map<object, { directory: string; snapshot: string }>(), storage: new Map<object, { directory: string; identity: number }>(),
  backend: Object.freeze({}), application: Object.freeze({}), native: true, unsafe: "", afterRead: (_path: string) => {},
  verifierAssert: vi.fn(), applicationRead: vi.fn(), applicationForVerifier: vi.fn(), backendForVerifier: vi.fn(),
  backendAssert: vi.fn(), inputCapability: vi.fn(), nativeDescribe: vi.fn(), codePrepare: vi.fn(), codeAudit: vi.fn(),
  storagePrepare: vi.fn(), storageAudit: vi.fn(), forbidden: vi.fn(),
}));
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>(); return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock("node:child_process", () => ({ spawn: controlled.forbidden, spawnSync: controlled.forbidden,
  exec: controlled.forbidden, execFile: controlled.forbidden, fork: controlled.forbidden }));
vi.mock("node:http", () => ({ createServer: controlled.forbidden, request: controlled.forbidden }));
vi.mock("node:fs", () => ({ lstatSync: (path: string) => {
  const file = controlled.files.get(path); if (!file) throw Error("Missing controlled file");
  return { size: BigInt(file.bytes.length), nlink: file.links, isFile: () => true, isSymbolicLink: () => file.symlink };
} }));
vi.mock("./verification.js", () => ({ assertLocallyPreparedVerificationProfile: controlled.verifierAssert,
  readPreparedApplicationVerificationProfile: controlled.applicationForVerifier, readWindowsVerificationBackend: controlled.backendForVerifier }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: controlled.applicationRead }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: controlled.nativeDescribe }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: controlled.backendAssert,
  assertWindowsProcessTargetInputCapability: controlled.inputCapability }));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: controlled.codePrepare, auditWindowsCodeInstallation: controlled.codeAudit }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.storagePrepare, auditWindowsReleaseStorage: controlled.storageAudit }));
vi.mock("./windows-local-acl.js", async () => {
  const { win32: windows } = await import("node:path");
  const canonical = (path: string) => {
    if (typeof path !== "string" || !/^[A-Z]:\\/u.test(path) || path.includes("/") || windows.normalize(path) !== path)
      throw Error("Controlled canonical Windows path required");
  };
  return { assertNativeWindows: () => { if (!controlled.native) throw Error("Native Windows required"); },
    assertCanonicalWindowsPath: canonical, physicalWindowsDirectory: (path: string) => {
      canonical(path); if (!controlled.directories.has(path)) throw Error("Controlled physical directory required"); return path;
    }, windowsPathsOverlap: (a: string, b: string) => {
      a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
    } };
});
vi.mock("./application-runtime-installation.js", async () => {
  const { createHash: hash } = await import("node:crypto");
  return { readApplicationRuntimePin: (pin: ApplicationRuntimeFilePin) => {
    const file = controlled.files.get(pin.path);
    if (!file || file.symlink || file.links !== 1n || pin.bytes !== file.bytes.length
      || pin.sha256 !== `sha256:${hash("sha256").update(file.bytes).digest("hex")}`) throw Error("Controlled pinned bytes differ");
    const bytes = Buffer.from(file.bytes); controlled.afterRead(pin.path); return bytes;
  } };
});
import { prepareApplicationPublicationProfile, readApplicationPublicationProfile, assertApplicationPublicationProfile,
  type ApplicationPublicationConfiguration, type PreparedApplicationPublicationProfile } from "./application-publication-profile.js";

const configurationPath = "C:\\protected\\publication\\profile.json", manifestPath = "C:\\protected\\native\\manifest.json";
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const roots = ["C:\\work\\one", "C:\\work\\two"];
let verifier: PreparedVerificationProfile;
let config: ApplicationPublicationConfiguration;
const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
function addDirectory(path: string): void {
  for (let current = path;; current = win32.dirname(current)) {
    if (!controlled.directories.has(current)) controlled.directories.set(current, controlled.directories.size + 1);
    if (current === win32.dirname(current)) break;
  }
}
function put(path: string, bytes: string): ApplicationRuntimeFilePin {
  addDirectory(win32.dirname(path)); controlled.files.set(path, { bytes: Buffer.from(bytes), ino: BigInt(controlled.files.size + 1), ctime: 1n, links: 1n, symlink: false });
  return pin(path);
}
function pin(path: string): ApplicationRuntimeFilePin {
  const bytes = controlled.files.get(path)!.bytes; return { path, bytes: bytes.length, sha256: digest(bytes) };
}
function save(change: Partial<ApplicationPublicationConfiguration> = {}) {
  return { version: 1 as const, configuration: put(configurationPath, JSON.stringify({ ...config, ...change })) };
}
function prepare(change: Partial<ApplicationPublicationConfiguration> = {}) {
  return prepareApplicationPublicationProfile(save(change), { nodeId: "node1", verifier, backend: controlled.backend as PreparedWindowsProcessBackend });
}
function codeSnapshot(directory: string): string {
  return JSON.stringify([...controlled.files].filter(([path]) => path.startsWith(`${directory}\\`)).sort(([a], [b]) => a.localeCompare(b))
    .map(([path, file]) => [path, file.bytes.toString("hex"), String(file.ino), String(file.ctime), String(file.links), file.symlink]));
}
beforeEach(() => {
  vi.resetAllMocks(); controlled.files.clear(); controlled.directories.clear(); controlled.code.clear(); controlled.storage.clear();
  controlled.native = true; controlled.unsafe = ""; controlled.afterRead = () => {};
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  controlled.forbidden.mockImplementation(() => { throw Error("No process or HTTP execution is allowed in controlled profile tests"); });
  roots.forEach(addDirectory);
  verifier = { id: "verify1", project_id: "project1", workspace_root: roots[0]!, digest: digest("original verifier"),
    trustedFiles: [], commands: [], required_files: [], subject_paths: [] };
  const applicationConfiguration = put("C:\\protected\\verifier\\application.json", "original application config");
  const hostManifest = put("C:\\protected\\host\\application-service-host-manifest.json", "original host manifest");
  const hostEntry = put("C:\\protected\\host\\application-service-bootstrap.mjs", "original host entry");
  const node = put("C:\\protected\\node\\node.exe", "original Node bytes");
  const candidateParent = "C:\\verification\\candidates", installationParent = "C:\\verification\\installations", selectionParent = "C:\\verification\\selections";
  [candidateParent, installationParent, selectionParent].forEach(addDirectory);
  put(manifestPath, JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64",
    capabilities: ["artoo.windows-target-input.v1", "artoo.windows-job-member-observation.v1"] }));
  const application = { configuration: applicationConfiguration, roots, hostEntry, toolchainDigest: digest("original toolchain"),
    capabilities: { config_digest: applicationConfiguration.sha256, contract_digest: digest("application contract") },
    config: { node, hostManifest, candidate_parent: candidateParent, installation_parent: installationParent, selection_parent: selectionParent,
      origin: "http://127.0.0.1:18182", operation_timeout_ms: 30_000 },
    files: [applicationConfiguration, hostManifest, hostEntry, node].map((file, index) => ({ name: `file${index}`, pin: file })) };
  controlled.verifierAssert.mockImplementation((actual: unknown) => { if (actual !== verifier) throw Error("Original verifier required"); });
  controlled.applicationForVerifier.mockImplementation((actual: unknown) => { controlled.verifierAssert(actual); return controlled.application; });
  controlled.backendForVerifier.mockImplementation((actual: unknown) => { controlled.verifierAssert(actual); return controlled.backend; });
  controlled.applicationRead.mockImplementation((actual: unknown) => { if (actual !== controlled.application) throw Error("Original application profile required"); return application; });
  controlled.backendAssert.mockImplementation((actual: unknown) => { if (actual !== controlled.backend) throw Error("Original native backend required"); });
  controlled.inputCapability.mockImplementation(controlled.backendAssert);
  controlled.nativeDescribe.mockImplementation((actual: unknown) => { controlled.backendAssert(actual);
    return { directory: win32.dirname(manifestPath), manifestSha256: pin(manifestPath).sha256, writableWorkspaceRoots: roots }; });
  controlled.codePrepare.mockImplementation(({ directory, writableWorkspaceRoots }: { directory: string; writableWorkspaceRoots: string[] }) => {
    if (writableWorkspaceRoots.some(root => directory === root || directory.startsWith(`${root}\\`))) throw Error("Code overlaps workspace");
    const token = Object.freeze({}); controlled.code.set(token, { directory, snapshot: codeSnapshot(directory) }); return token;
  });
  controlled.codeAudit.mockImplementation((token: object, directory: string) => {
    const saved = controlled.code.get(token);
    if (!saved || saved.directory !== directory || saved.snapshot !== codeSnapshot(directory) || controlled.unsafe === directory)
      throw Error("Original controlled code inventory or ACL changed");
  });
  controlled.storagePrepare.mockImplementation(({ directory }: { directory: string }) => {
    const token = Object.freeze({}); controlled.storage.set(token, { directory, identity: controlled.directories.get(directory)! }); return token;
  });
  controlled.storageAudit.mockImplementation((token: object, directory: string) => {
    const saved = controlled.storage.get(token);
    if (!saved || saved.directory !== directory || saved.identity !== controlled.directories.get(directory) || controlled.unsafe === directory)
      throw Error("Original controlled storage identity or ACL changed");
  });
  config = { version: 1, format: "artoo.application-publication-profile.v1", id: "publish1", project_id: verifier.project_id, computer_id: "node1",
    verification_profile_id: verifier.id, verification_profile_digest: verifier.digest,
    application_configuration: applicationConfiguration, application_contract_digest: application.capabilities.contract_digest,
    application_toolchain_digest: application.toolchainDigest, backend: { directory: win32.dirname(manifestPath), manifest_sha256: pin(manifestPath).sha256 },
    host_manifest: hostManifest, host_entry: hostEntry, deployment_parent: "C:\\publication\\deployments", selection_parent: "C:\\publication\\selections",
    journal_parent: "C:\\publication\\journal", origin: application.config.origin, limits: { root_lifetime_ms: 600_000, startup_timeout_ms: 30_000,
      health_timeout_ms: 15_000, normal_drain_reserve_ms: 60_000, health_interval_ms: 30_000, health_freshness_ms: 10_000,
      maximum_service_generations: 2, maximum_requests_per_generation: 256, maximum_concurrent: 1, maximum_health_rounds: 16 } };
  [config.deployment_parent, config.selection_parent, config.journal_parent].forEach(addDirectory);
});
afterEach(() => { Object.defineProperty(process, "arch", architecture); expect(controlled.forbidden).not.toHaveBeenCalled(); });

describe("protected local application publication profile", () => {
  it("retains the original authorities and exact bounded configuration without executing or advertising", () => {
    const token = prepare(), saved = readApplicationPublicationProfile(token);
    expect(saved.verifier).toBe(verifier); expect(saved.application).toBe(controlled.application); expect(saved.backend).toBe(controlled.backend);
    expect(saved.capabilities.binding).toMatchObject({ computer_id: "node1", publication_profile_digest: saved.configuration.sha256,
      workspace_root_digest: digest(JSON.stringify({ version: 1, workspace_root: roots[0] })) });
    expect(saved.capabilities.contract).toMatchObject({ normal_reopen: "once-same-version-url-database", failure_recovery: "unsupported",
      automatic_rotation: "unsupported", limits: { maximum_service_generations: 2, maximum_requests_per_generation: 256 } });
    expect(Object.isFrozen(saved.config.limits)).toBe(true); expect(Object.isFrozen(saved.capabilities.binding)).toBe(true);
    expect("codes" in saved || "storage" in saved).toBe(false); expect(controlled.storagePrepare).toHaveBeenCalledTimes(3);
  });
  it("rejects copied or unknown profile tokens and copied verifier/backend identities", () => {
    const token = prepare(); expect(() => readApplicationPublicationProfile({ ...token } as PreparedApplicationPublicationProfile)).toThrow(/original current/);
    expect(() => prepareApplicationPublicationProfile(save(), { nodeId: "node1", verifier: { ...verifier }, backend: controlled.backend as PreparedWindowsProcessBackend })).toThrow(/Original verifier/);
    expect(() => prepareApplicationPublicationProfile(save(), { nodeId: "node1", verifier, backend: {} as PreparedWindowsProcessBackend })).toThrow(/original application verifier/);
  });
  it.each(["computer_id", "project_id", "verification_profile_id", "verification_profile_digest", "application_contract_digest", "application_toolchain_digest"] as const)
    ("rejects changed %s binding", field => {
      expect(() => prepare({ [field]: field.endsWith("digest") ? digest("wrong") : "wrong" })).toThrow(/configuration differs/);
    });
  it("rejects a different application configuration or installed host pin", () => {
    expect(() => prepare({ application_configuration: { ...config.application_configuration, sha256: digest("other") } })).toThrow(/configuration differs/);
    expect(() => prepare({ host_entry: { ...config.host_entry, path: "C:\\protected\\host\\alternate.mjs" } })).toThrow(/configuration differs/);
  });
  it.each(["http://127.0.0.1:18183", "http://localhost:18182", "http://127.0.0.1:18182/", "https://127.0.0.1:18182"])
    ("rejects origin replacement %s", origin => { expect(() => prepare({ origin })).toThrow(/fixed loopback origin/); });
  it.each(["deployment_parent", "selection_parent", "journal_parent"] as const)("keeps %s outside all write roots", field => {
    expect(() => prepare({ [field]: roots[1]! })).toThrow(/storage overlaps/);
  });
  it("rejects aliased parents and overlaps with test storage, code or native installation", () => {
    expect(() => prepare({ selection_parent: config.deployment_parent })).toThrow(/storage overlaps/);
    expect(() => prepare({ selection_parent: "C:\\verification\\installations" })).toThrow(/storage overlaps/);
    expect(() => prepare({ selection_parent: "C:\\protected\\host" })).toThrow(/storage overlaps/);
    expect(() => prepare({ selection_parent: "C:\\protected\\native" })).toThrow(/storage overlaps/);
  });
  it("rejects unknown command fields, insufficient root windows and too-small drain reserves", () => {
    expect(() => prepare({ command: "arbitrary" } as unknown as Partial<ApplicationPublicationConfiguration>)).toThrow();
    expect(() => prepare({ limits: { ...config.limits, root_lifetime_ms: 240_000 } })).toThrow();
    config.limits.root_lifetime_ms = 600_000;
    expect(() => prepare({ limits: { ...config.limits, normal_drain_reserve_ms: 47_499 } })).toThrow(/normal drain reserve/);
  });
  it.each(["artoo.windows-target-input.v1", "artoo.windows-job-member-observation.v1"])("requires native capability %s", missing => {
    const value = JSON.parse(controlled.files.get(manifestPath)!.bytes.toString()) as { capabilities: string[] };
    value.capabilities = value.capabilities.filter(value => value !== missing); put(manifestPath, JSON.stringify(value));
    expect(() => prepare({ backend: { ...config.backend, manifest_sha256: pin(manifestPath).sha256 } })).toThrow(/native input and live member/);
  });
  it("requires native Windows x64, the original application profile and complete backend write scope", () => {
    controlled.native = false; expect(() => prepare()).toThrow(/Native Windows/); controlled.native = true;
    Object.defineProperty(process, "arch", { ...architecture, value: "arm64" }); expect(() => prepare()).toThrow(/native x64/);
    Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
    controlled.applicationForVerifier.mockReturnValueOnce(undefined); expect(() => prepare()).toThrow(/original application verifier/);
    controlled.nativeDescribe.mockReturnValueOnce({ directory: config.backend.directory, manifestSha256: config.backend.manifest_sha256, writableWorkspaceRoots: [roots[0]] });
    expect(() => prepare()).toThrow(/complete write scope/);
  });
  it("does not resurrect a token after same-byte metadata drift or restored files", () => {
    const token = prepare(), file = controlled.files.get(configurationPath)!; file.ctime++;
    expect(() => assertApplicationPublicationProfile(token)).toThrow(/inventory or ACL/); file.ctime--;
    expect(() => assertApplicationPublicationProfile(token)).toThrow(/original current/);
  });
  it("rejects configuration replacement during its first read against the original code inventory", () => {
    controlled.afterRead = path => { if (path === configurationPath) controlled.files.get(path)!.ino++; };
    expect(() => prepare()).toThrow(/inventory or ACL/);
  });
  it("reaudits original application, native, storage and configuration authorities on later reads", () => {
    const token = prepare();
    controlled.directories.set(config.journal_parent, 999);
    expect(() => readApplicationPublicationProfile(token)).toThrow(/storage identity or ACL/);
    const second = prepare(); controlled.unsafe = config.backend.directory;
    expect(() => readApplicationPublicationProfile(second)).toThrow(/inventory or ACL/);
  });
  it("rejects later substitution of the original application or backend object", () => {
    const token = prepare(); controlled.applicationForVerifier.mockReturnValueOnce(Object.freeze({}));
    expect(() => readApplicationPublicationProfile(token)).toThrow(/verifier authority changed/);
    const second = prepare(); controlled.backendForVerifier.mockReturnValueOnce(Object.freeze({}));
    expect(() => readApplicationPublicationProfile(second)).toThrow(/verifier authority changed/);
  });
  it("rejects native manifest links and changed capability bytes after preparation", () => {
    controlled.files.get(manifestPath)!.links = 2n; expect(() => prepare()).toThrow(/native manifest/);
    controlled.files.get(manifestPath)!.links = 1n;
    const token = prepare(); controlled.files.get(manifestPath)!.bytes = Buffer.from("changed");
    expect(() => readApplicationPublicationProfile(token)).toThrow();
  });
});
