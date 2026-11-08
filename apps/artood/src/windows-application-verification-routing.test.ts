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
  readVerificationCapabilities, readWindowsVerificationBackend, readPreparedApplicationVerificationProfile,
  readFinalApplicationVerificationBinding, type VerificationProfile } from "./verification.js";
import { prepareWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { ApplicationVerificationConfiguration, ApplicationVerificationFile,
  readApplicationVerificationProfile } from "./application-verification-profile.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

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
    const toolRoot = join(root, "application-tools"), candidateRoot = join(root, "candidates"),
      installationRoot = join(root, "installations"), selectionRoot = join(root, "selections");
    for (const directory of [toolRoot, candidateRoot, installationRoot, selectionRoot]) mkdirSync(directory);
    const files: ApplicationVerificationFile[] = [];
    const pin = (name: string, value: string): ApplicationRuntimeFilePin => {
      const path = join(toolRoot, name); writeProtected(path, value);
      const result = Object.freeze({ path, bytes: Buffer.byteLength(value), sha256: sha(value) });
      files.push({ name, pin: result }); return result;
    };
    // Complete typed owner state, with inert files outside all write roots. This
    // keeps the real profile's file and storage boundaries active in this fixture.
    const node = pin("node.exe", executable), runtime = {
      helper: pin("runtime-helper.exe", executable), helperManifest: pin("runtime-helper-manifest.json", "{}"),
      entry: pin("application-runtime.mjs", "// controlled runtime"), vendorManifest: pin("vendor-manifest.json", "{}"),
      guestBootstrap: pin("application-runtime-guest-bootstrap.js", "// controlled guest"),
    };
    const config: ApplicationVerificationConfiguration = { version: 1, format: "artoo.application-verification-profile.v1", node,
      compiler: { helper: pin("compiler-helper.exe", executable), helperManifest: pin("compiler-helper-manifest.json", "{}"), node,
        entry: pin("application-compiler.mjs", "// controlled compiler"), configuration: pin("compiler-configuration.json", "{}") },
      runtime, broker: pin("application-broker.mjs", "// controlled broker"),
      hostManifest: pin("application-service-host-manifest.json", "{}"), browser: pin("browser.exe", executable),
      candidate_parent: candidateRoot, installation_parent: installationRoot, selection_parent: selectionRoot,
      origin: "http://127.0.0.1:18080", timeout_ms: 10_000, operation_timeout_ms: 1000, action_timeout_ms: 500 };
    const hostEntry = pin("application-service-bootstrap.mjs", "// controlled bootstrap");
    pin("application-service-host-api.mjs", "// controlled host API");
    const configuration = pin("configuration.json", JSON.stringify(config)); raw.application = { version: 1, configuration };
    const prepared = Object.freeze({}), saved: ReturnType<typeof readApplicationVerificationProfile> = {
      config, configuration, roots: [workspace], files, packageFiles: [
        { name: "application-runtime.mjs", pin: runtime.entry }, { name: "application-broker.mjs", pin: config.broker },
        { name: "application-runtime-guest-bootstrap.js", pin: runtime.guestBootstrap },
        { name: "vendor/manifest.json", pin: runtime.vendorManifest }, { name: "native/runtime-helper.exe", pin: runtime.helper },
        { name: "native/runtime-helper-manifest.json", pin: runtime.helperManifest },
      ], toolchainDigest: sha(JSON.stringify(files.map(file => ({ path: file.name, bytes: file.pin.bytes, sha256: file.pin.sha256 })))),
      hostEntry, capabilities: { ...capabilities, config_digest: configuration.sha256 } };
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
    const original = readPreparedApplicationVerificationProfile(f.profile);
    expect(original).toBe(application.prepare.mock.results[0]!.value);
    expect(application.audit).toHaveBeenLastCalledWith(original);
    expect(() => readPreparedApplicationVerificationProfile(JSON.parse(JSON.stringify(f.profile)))).toThrow(/locally prepared profile/);
    expect(() => readFinalApplicationVerificationBinding(f.profile, {} as never, {} as never)).toThrow(/original completed application verification/);
  });

  it.each(["ordinary", "static"] as const)("keeps old bundles usable for a %s profile", kind => {
    const f = fixture(kind);
    expect(() => attachWindowsVerificationBackend(f.profile, f.backend)).not.toThrow();
    expect(readWindowsVerificationBackend(f.profile)).toBe(f.backend);
    expect(applicationVerificationSupported(f.profile)).toBe(false);
    expect(f.profile.capabilities?.application).toBeUndefined();
    expect(readPreparedApplicationVerificationProfile(f.profile)).toBeUndefined();
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
