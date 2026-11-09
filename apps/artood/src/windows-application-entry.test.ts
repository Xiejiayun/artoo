// Controlled configuration-admission stand-ins only. No native installation,
// application process, provider or filesystem is qualified by these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtoodConfig } from "./main.js";
import type { PreparedVerificationProfile, VerificationProfile } from "./verification.js";

const controlled = vi.hoisted(() => ({ native: true, backend: Object.freeze({}), application: Object.freeze({}),
  prepare: vi.fn(), attach: vi.fn(), applicationForVerifier: vi.fn(), applicationRead: vi.fn(), nativeDescribe: vi.fn(),
}));
vi.mock("./verification.js", () => ({ prepareVerificationProfiles: controlled.prepare,
  attachWindowsVerificationBackend: controlled.attach, readPreparedApplicationVerificationProfile: controlled.applicationForVerifier }));
vi.mock("./application-verification-profile.js", () => ({ readApplicationVerificationProfile: controlled.applicationRead }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: controlled.nativeDescribe }));
vi.mock("./windows-local-acl.js", () => ({ assertNativeWindows: () => {
  if (!controlled.native) throw Error("Controlled native Windows admission failed");
}, physicalWindowsDirectory: (path: string) => {
  if (typeof path !== "string" || !/^[A-Z]:\\/u.test(path)) throw Error("Controlled physical Windows directory required");
  return path;
} }));
import { describeWindowsApplicationEntryVerifier } from "./windows-application-entry.js";

const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const digest = `sha256:${"a".repeat(64)}`, changed = `sha256:${"b".repeat(64)}`;
const pin = (path: string) => ({ path, bytes: 42, sha256: digest });
const roots = ["C:\\work\\application", "C:\\work\\ordinary"];
let config: ArtoodConfig;
let verifier: PreparedVerificationProfile;
let ordinary: VerificationProfile;
let facts: { configuration: ReturnType<typeof pin>; roots: string[]; hostEntry: ReturnType<typeof pin>;
  toolchainDigest: string; capabilities: { config_digest: string; contract_digest: string };
  config: { hostManifest: ReturnType<typeof pin>; origin: string }; private_token: object };
let installation: { directory: string; manifestSha256: string; writableWorkspaceRoots: string[] };

beforeEach(() => {
  vi.resetAllMocks(); controlled.native = true;
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  facts = { configuration: pin("C:\\protected\\application.json"), roots: [...roots],
    hostEntry: pin("C:\\protected\\host\\application-service-bootstrap.mjs"), toolchainDigest: digest,
    capabilities: { config_digest: digest, contract_digest: digest },
    config: { hostManifest: pin("C:\\protected\\host\\application-service-host-manifest.json"), origin: "http://127.0.0.1:18182" },
    private_token: controlled.application };
  const raw: VerificationProfile = { id: "application", project_id: "project", workspace_root: roots[0]!,
    commands: [], required_files: [], subject_paths: ["product", ".artoo/product"],
    application: { version: 1, configuration: facts.configuration } };
  ordinary = { ...raw, id: "ordinary", workspace_root: roots[1]! }; delete ordinary.application;
  // The actual profile validator is mocked; this small capability stands for its
  // admitted output and deliberately includes no executable authority.
  verifier = { ...raw, digest, trustedFiles: [], capabilities: { version: 1, profile_digest: digest,
    application: facts.capabilities, checks: [{ command_id: "prototype", contract: { version: 3 } }] } } as unknown as PreparedVerificationProfile;
  config = { url: "ws://127.0.0.1:18183/node?token=private-node-token", nodeId: "node", runtimes: ["codex"],
    allowedRoots: [...roots], verificationProfiles: [raw, ordinary],
    windowsProcessBackend: controlled.backend as NonNullable<ArtoodConfig["windowsProcessBackend"]> };
  installation = { directory: "C:\\protected\\native", manifestSha256: digest, writableWorkspaceRoots: [...roots] };
  controlled.nativeDescribe.mockImplementation(backend => {
    if (backend !== controlled.backend) throw Error("Original native installation required"); return installation;
  });
  controlled.prepare.mockReturnValue([verifier, ordinary]);
  controlled.attach.mockImplementation((profile, backend) => {
    if (profile !== verifier || backend !== controlled.backend) throw Error("Original verifier/backend required");
  });
  controlled.applicationForVerifier.mockImplementation(profile => {
    if (profile !== verifier) throw Error("Original local verifier required"); return controlled.application;
  });
  controlled.applicationRead.mockImplementation(application => {
    if (application !== controlled.application) throw Error("Original application profile required"); return facts;
  });
});
afterEach(() => { Object.defineProperty(process, "arch", architecture); });
const describeEntry = () => describeWindowsApplicationEntryVerifier(config, "application");

describe("Windows application entry configuration projection", () => {
  it("keeps full profile/write scope and returns isolated frozen JSON, without private configuration or tokens", () => {
    const result = describeEntry();
    expect(controlled.prepare).toHaveBeenCalledExactlyOnceWith(config.verificationProfiles, config.allowedRoots);
    expect(controlled.attach).toHaveBeenCalledExactlyOnceWith(verifier, controlled.backend);
    expect(Object.keys(result).sort()).toEqual(["verification_profile_id", "verification_profile_digest", "application_configuration",
      "application_contract_digest", "application_toolchain_digest", "host_manifest", "host_entry", "backend", "origin", "verification_capabilities"].sort());
    expect(result.verification_capabilities).toEqual(verifier.capabilities);
    expect(result.verification_capabilities).not.toHaveProperty("profile_id");
    expect(result.backend).toEqual({ directory: installation.directory, manifest_sha256: digest });
    expect(result).toEqual(JSON.parse(JSON.stringify(result)));
    expect(JSON.stringify(result)).not.toContain("private-node-token");
    expect(result).not.toHaveProperty("private_token");
    for (const value of [result, result.host_entry, result.backend, result.verification_capabilities,
      result.verification_capabilities.checks, result.verification_capabilities.checks[0]]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { (result.host_entry as { path: string }).path = "C:\\replaced.exe"; }).toThrow(TypeError);
    facts.configuration.path = "C:\\changed.json"; facts.capabilities.contract_digest = changed;
    expect(result.application_configuration.path).toBe("C:\\protected\\application.json");
    expect(result.verification_capabilities.application?.contract_digest).toBe(digest);
  });

  it.each(["missing-backend", "foreign-backend", "managed", "worktree", "owned-result", "non-windows", "non-x64"])
  ("rejects an unsupported local execution configuration: %s", variant => {
    if (variant === "missing-backend") delete config.windowsProcessBackend;
    if (variant === "foreign-backend") config.windowsProcessBackend = {} as NonNullable<ArtoodConfig["windowsProcessBackend"]>;
    if (variant === "managed") config.managedJournal = {} as NonNullable<ArtoodConfig["managedJournal"]>;
    if (variant === "worktree") config.worktreeBaseRepo = "C:\\repo";
    if (variant === "owned-result") config.ownedResultProfilesFile = "C:\\protected\\owned.json";
    if (variant === "non-windows") controlled.native = false;
    if (variant === "non-x64") Object.defineProperty(process, "arch", { ...architecture, value: "arm64" });
    expect(describeEntry).toThrow(); expect(controlled.prepare).not.toHaveBeenCalled();
  });

  it.each(["missing", "ordinary-only", "multiple", "different-id"])("does not choose a fallback application verifier: %s", variant => {
    if (variant === "missing") delete config.verificationProfiles;
    if (variant === "ordinary-only") config.verificationProfiles = [ordinary];
    if (variant === "multiple") config.verificationProfiles = [...config.verificationProfiles!, { ...config.verificationProfiles![0]!, id: "second-application" }];
    const selected = variant === "different-id" ? "unconfigured" : "application";
    expect(() => describeWindowsApplicationEntryVerifier(config, selected)).toThrow(/one matching/);
    expect(controlled.prepare).not.toHaveBeenCalled();
  });

  it.each(["empty", "duplicate", "native-narrowed", "application-narrowed"])("rejects incomplete or aliased write roots: %s", variant => {
    if (variant === "empty") config.allowedRoots = [];
    if (variant === "duplicate") config.allowedRoots.push(config.allowedRoots[0]!);
    if (variant === "native-narrowed") installation.writableWorkspaceRoots.pop();
    if (variant === "application-narrowed") facts.roots.pop();
    expect(describeEntry).toThrow(/write roots/);
  });

  it.each(["nativeDescribe", "prepare", "attach", "applicationForVerifier", "applicationRead"] as const)
  ("propagates original admission failure without a descriptor: %s", stage => {
    const failure = Error("Original local admission failed");
    controlled[stage].mockImplementationOnce(() => { throw failure; });
    expect(describeEntry).toThrow(failure);
  });

  it("requires original application authority even when serialized profile metadata is present", () => {
    controlled.applicationForVerifier.mockReturnValue(undefined);
    expect(describeEntry).toThrow(/original locally prepared/);
    expect(controlled.applicationRead).not.toHaveBeenCalled();
  });

  it("rejects capability facts that no longer match their prepared verifier", () => {
    facts.capabilities = { ...facts.capabilities, contract_digest: changed };
    expect(describeEntry).toThrow(/capability binding changed/);
  });
});
