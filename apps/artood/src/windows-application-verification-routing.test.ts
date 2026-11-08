// Application toolchain preparation is controlled; profile/backend preparation,
// manifest pinning and attachment are real. No native process or ACL qualification
// is performed by this suite, and its executable files are inert fixture bytes.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationCapabilitiesV1 } from "@artoo/domain";
import { applicationVerificationSupported, attachWindowsVerificationBackend, prepareVerificationProfiles,
  readVerificationCapabilities, readWindowsVerificationBackend, type VerificationProfile } from "./verification.js";
import { prepareWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const application = vi.hoisted(() => ({ prepare: vi.fn(), read: vi.fn(), audit: vi.fn() }));
vi.mock("./application-verification-profile.js", () => ({ prepareApplicationVerificationProfile: application.prepare,
  readApplicationVerificationProfile: application.read, assertApplicationVerificationProfile: application.audit }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inputCapability = "artoo.windows-target-input.v1";
const capabilities: ApplicationCapabilitiesV1 = { version: 1, kind: "local-application-development", claim: "configured",
  config_digest: sha("controlled configuration"), contract_digest: sha("controlled contract"),
  source_paths: ["product/client", "product/server", ".artoo/product/application.json"],
  definition_format: "artoo.application-definition.v1", test_scope: "normal-api-browser-reopen", failure_recovery: "unsupported",
  browser_viewport: { width: 1280, height: 900, device_scale_factor: 1 }, publication: "unsupported", qualified_for_product: false };

beforeEach(() => {
  vi.resetAllMocks(); Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});
afterEach(() => {
  vi.unstubAllEnvs(); Object.defineProperty(process, "platform", platform);
  // Only directories exclusively created by this non-executing fixture are removed.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function writeProtected(path: string, value: string): void {
  writeFileSync(path, value); readFileSync(path);
}
function fixture(kind: "ordinary" | "static" | "application", targetInput = false, remoteCapabilities?: unknown) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-application-routing-"))); roots.push(root);
  const workspace = join(root, "workspace"), bundle = join(root, "bundle"), evidence = join(root, "evidence");
  for (const directory of [workspace, bundle, evidence]) mkdirSync(directory);
  vi.stubEnv("SystemRoot", root);
  const executable = "CONTROLLED TEST BYTES, NOT A WINDOWS EXECUTABLE";
  writeProtected(join(bundle, "Artoo.WindowsProcessHost.exe"), executable);
  const manifest = JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64",
    executable: "Artoo.WindowsProcessHost.exe", files: [{ path: "Artoo.WindowsProcessHost.exe", size: Buffer.byteLength(executable), sha256: sha(executable) }],
    ...(targetInput ? { capabilities: [inputCapability] } : {}) });
  writeProtected(join(bundle, "manifest.json"), manifest);
  const installationAudit = vi.fn();
  const backend = prepareWindowsProcessBackend({ directory: bundle, manifestSha256: sha(manifest), assertLocalInstallation: installationAudit });
  const script = join(root, "check.mjs"); writeProtected(script, "// controlled protected verifier");
  const raw: VerificationProfile = { id: "profile", project_id: "project", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1000 }], required_files: [], subject_paths: ["product", ".artoo/product"] };
  if (kind !== "ordinary") {
    const config = join(root, "browser.json"), browser = join(root, "browser.exe"); writeProtected(browser, executable);
    writeProtected(config, JSON.stringify({ browser_executable: browser, evidence_root: evidence,
      browser_program: { version: 3, viewports: [{ id: "desktop", width: 1280, height: 900 }] } }));
    raw.commands = [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config],
      timeout_ms: 1000, observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }];
  }
  if (kind === "application") {
    const configuration = { path: join(root, "application.json"), bytes: 2, sha256: sha("{}") };
    writeProtected(configuration.path, "{}"); raw.application = { version: 1, configuration };
    const prepared = Object.freeze({}), saved = { configuration, files: [{ name: "configuration.json", pin: configuration }],
      capabilities: { ...capabilities, config_digest: configuration.sha256 } };
    application.prepare.mockImplementation((selection, writeRoots) => {
      expect(selection).toEqual(raw.application); expect(writeRoots).toEqual([workspace]); return prepared;
    });
    application.read.mockImplementation(value => { expect(value).toBe(prepared); return saved; });
    application.audit.mockImplementation(value => { expect(value).toBe(prepared); });
  }
  if (remoteCapabilities !== undefined) Object.assign(raw, { capabilities: remoteCapabilities });
  const profile = prepareVerificationProfiles([raw], [workspace])[0]!;
  installationAudit.mockClear();
  return { root, bundle, workspace, profile, backend, installationAudit };
}

describe("Windows application advertisement admission (controlled toolchain, not native qualification)", () => {
  it("rejects an old pinned bundle before attaching or advertising an application profile", () => {
    const f = fixture("application");
    expect(f.profile.capabilities?.application).toBeDefined();
    expect(() => attachWindowsVerificationBackend(f.profile, f.backend)).toThrow(/does not advertise target input/);
    expect(f.installationAudit).toHaveBeenCalledOnce();
    expect(readWindowsVerificationBackend(f.profile)).toBeUndefined();
    expect(applicationVerificationSupported(f.profile)).toBe(false);
  });

  it("advertises a locally prepared application only after binding a capable original backend", () => {
    const f = fixture("application", true);
    expect(applicationVerificationSupported(f.profile)).toBe(false);
    attachWindowsVerificationBackend(f.profile, f.backend);
    expect(applicationVerificationSupported(f.profile)).toBe(true);
    expect(readWindowsVerificationBackend(f.profile)).toBe(f.backend);
    expect(() => attachWindowsVerificationBackend(f.profile, f.backend)).not.toThrow();
  });

  it.each(["ordinary", "static"] as const)("keeps old bundles usable for a %s profile", kind => {
    const f = fixture(kind);
    expect(() => attachWindowsVerificationBackend(f.profile, f.backend)).not.toThrow();
    expect(readWindowsVerificationBackend(f.profile)).toBe(f.backend);
    expect(applicationVerificationSupported(f.profile)).toBe(false);
    expect(f.profile.capabilities?.application).toBeUndefined();
  });

  it("rejects JSON-cloned local profile and backend capability claims", () => {
    const f = fixture("application", true), remoteProfile = JSON.parse(JSON.stringify(f.profile));
    expect(() => attachWindowsVerificationBackend(remoteProfile, f.backend)).toThrow(/locally prepared profile/);
    expect(applicationVerificationSupported(remoteProfile)).toBe(false);
    const remoteBackend = JSON.parse(JSON.stringify({ capabilities: [inputCapability] })) as PreparedWindowsProcessBackend;
    expect(() => attachWindowsVerificationBackend(f.profile, remoteBackend)).toThrow(/not locally prepared/);
    expect(applicationVerificationSupported(f.profile)).toBe(false);
    expect(readWindowsVerificationBackend(f.profile)).toBeUndefined();
  });

  it("does not upgrade a legacy local profile using remote application capability JSON", () => {
    const remoteCapabilities = JSON.parse(JSON.stringify({ version: 1, application: capabilities }));
    const f = fixture("ordinary", false, remoteCapabilities);
    attachWindowsVerificationBackend(f.profile, f.backend);
    expect(applicationVerificationSupported(f.profile)).toBe(false);
    expect(readVerificationCapabilities(f.profile)).toBeUndefined();
    expect(application.prepare).not.toHaveBeenCalled();
  });

  it("still audits the pinned bundle before accepting its prepared capability", () => {
    const f = fixture("application", true);
    writeProtected(join(f.bundle, "manifest.json"), "{}");
    expect(() => attachWindowsVerificationBackend(f.profile, f.backend)).toThrow(/manifest changed/);
    expect(readWindowsVerificationBackend(f.profile)).toBeUndefined();
    expect(applicationVerificationSupported(f.profile)).toBe(false);
  });
});
