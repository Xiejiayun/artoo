// Real profile/context-file boundaries, controlled installation and process execution.
// This suite does not run a native helper, browser or provider.
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext } from "@artoo/domain";
import { attachWindowsVerificationBackend, prepareVerificationProfiles, readVerificationCapabilities, runVerification,
  subjectManifest, type VerificationProfile } from "./verification.js";
import { prepareWindowsBrowserProcessFromDescriptor } from "./windows-browser-process-authority.js";
import { runProtectedCommand } from "./protected-command.js";
import { readWindowsBrowserPrivateContext } from "./windows-browser-private-context.js";
import type { WindowsAclTarget } from "./windows-local-acl.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const state = vi.hoisted(() => ({
  backend: Object.freeze({ controlled: "parent backend" }), child: Object.freeze({ controlled: "child backend" }),
  describe: vi.fn(), prepare: vi.fn(), audit: vi.fn(), assertBackend: vi.fn(),
}));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: state.describe, prepareWindowsProcessInstallation: state.prepare }));
vi.mock("./owned/windows-owned-process.js", () => ({
  assertWindowsProcessBackend: (backend: unknown) => {
    if (backend !== state.backend && backend !== state.child) throw new Error("Unprepared controlled backend");
    state.assertBackend(backend);
  },
  startWindowsOwnedProcess: vi.fn(), isWindowsOwnedClosureReceipt: vi.fn(),
}));
vi.mock("./protected-command.js", async load => ({ ...await load<typeof import("./protected-command.js")>(), runProtectedCommand: vi.fn() }));
vi.mock("./windows-local-acl.js", async load => ({ ...await load<typeof import("./windows-local-acl.js")>(), collectWindowsAclFacts: state.audit }));
const roots: string[] = [], platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const installedCli = realpathSync.native(fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)));
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); vi.resetAllMocks();
  // Only known private fixture roots; all process implementations above are controlled mocks.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(enabled = true) {
  const clock = vi.spyOn(performance, "now").mockReturnValue(100);
  state.audit.mockImplementation((targets: readonly WindowsAclTarget[]) => ({ version: 1, currentSid: "S-1-5-21-100-200-300-1001",
    nodes: targets.map(target => ({ ...target, ownerSid: "S-1-5-21-100-200-300-1001", aces: [] })) }));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-browser-job-handoff-"))); roots.push(directory);
  const workspace = join(directory, "workspace"), evidence = join(directory, "evidence"), config = join(directory, "browser.json");
  mkdirSync(workspace); mkdirSync(evidence); mkdirSync(join(workspace, "product"));
  mkdirSync(join(workspace, ".artoo", "product"), { recursive: true });
  const research = join(workspace, ".artoo", "product", "research.json");
  writeFileSync(research, "controlled artifact, no native verification"); readFileSync(research);
  writeFileSync(config, JSON.stringify({ evidence_root: evidence, ...(enabled ? { windows_browser_process: { version: 1 } } : {}) })); readFileSync(config);
  const raw: VerificationProfile = { id: "browser-profile", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser-check", argv: [process.execPath, installedCli, config], timeout_ms: 1234,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] };
  const profile = prepareVerificationProfiles([raw])[0]!;
  const backend = state.backend as unknown as PreparedWindowsProcessBackend;
  const installation = { directory: join(directory, "protected-host"), manifestSha256: `sha256:${"d".repeat(64)}`, writableWorkspaceRoots: [workspace] };
  state.describe.mockImplementation(value => { if (value !== backend) throw new Error("Unqualified controlled installation"); return installation; });
  state.prepare.mockReturnValue(state.child);
  attachWindowsVerificationBackend(profile, backend);
  const capabilities = readVerificationCapabilities(profile)!;
  const context = { task: { id: "task", title: "Research", description: "", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("research"), verification_capabilities: capabilities };
  const check = capabilities.checks[0]!;
  const binding = { version: 1, command_id: check.command_id, profile_digest: profile.digest,
    config_digest: check.config_digest, contract_digest: check.contract_digest };
  const output = Buffer.from(JSON.stringify({ version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true,
    requirements: 0, cases: [], capability_binding: binding }));
  return { raw, profile, backend, context, installation, output, binding, workspace, evidence, clock };
}
function writeControlledObservation(f: ReturnType<typeof fixture>, requestId: string): void {
  const directory = join(f.evidence, createHash("sha256").update(requestId).digest("hex"));
  mkdirSync(directory); const file = join(directory, "result.json");
  writeFileSync(file, f.output); readFileSync(file);
}

describe.runIf(process.platform === "win32")("node to browser private Job handoff (controlled process)", () => {
  it("binds the exact request, command, source, profile and workspace outside the public ContextPack", async () => {
    const f = fixture();
    expect(JSON.stringify(f.context)).not.toContain("windows_browser_process");
    expect(JSON.stringify(f.context)).not.toContain(f.installation.directory);
    vi.mocked(runProtectedCommand).mockImplementation(async (_request, options, backend) => {
      expect(backend).toBe(f.backend); expect(options.materializeTimeoutMs).toBeGreaterThan(0); expect(options.materializeTimeoutMs).toBeLessThanOrEqual(1234);
      const envelope = JSON.parse(readWindowsBrowserPrivateContext(options.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!,
        options.environment!.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256!).toString("utf8"));
      const expected = { request_id: "request-bound", command_id: "browser-check", profile_digest: f.profile.digest,
        subject_digest: subjectManifest(f.profile).digest, workspace_root: f.workspace };
      expect(envelope.windows_browser_process).toEqual({ version: 1, ...expected, installation: f.installation });
      expect(envelope.static_web_capabilities.options.windows_browser_process).toEqual({ version: 1 });
      expect(prepareWindowsBrowserProcessFromDescriptor(envelope.windows_browser_process, expected, true)).toBe(state.child);
      expect(state.prepare).toHaveBeenCalledWith(f.installation);
      writeControlledObservation(f, envelope.request_id);
      return { status: 0, stdout: f.output, stderr: Buffer.alloc(0), elapsedMs: 42 };
    });
    const result = await runVerification(f.profile, "request-bound", new AbortController().signal, f.context);
    expect(result.outcome).toBe("passed"); expect(result.checks[0]?.exit_code).toBe(0);
  });
  it("preserves absent-option behavior and never transports an unrequested backend", async () => {
    const f = fixture(false);
    vi.mocked(runProtectedCommand).mockImplementation(async (_request, options) => {
      const envelope = JSON.parse(readFileSync(options.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!, "utf8"));
      expect(envelope).not.toHaveProperty("windows_browser_process");
      expect(options.environment).not.toHaveProperty("ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256");
      expect(envelope.static_web_capabilities.options).not.toHaveProperty("windows_browser_process");
      writeControlledObservation(f, envelope.request_id);
      return { status: 0, stdout: f.output, stderr: Buffer.alloc(0), elapsedMs: 42 };
    });
    expect((await runVerification(f.profile, "legacy-request", new AbortController().signal, f.context)).outcome).toBe("passed");
    expect(state.describe).not.toHaveBeenCalled(); expect(state.prepare).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("stops before dispatch if installation qualification is revoked after profile attachment", async () => {
    const f = fixture(); state.describe.mockImplementation(() => { throw new Error("Installation changed"); });
    const result = await runVerification(f.profile, "request-bound", new AbortController().signal, f.context);
    expect(result.outcome).toBe("failed"); expect(result.reason).toContain("Installation changed");
    expect(runProtectedCommand).not.toHaveBeenCalled();
  });
  it("rejects an opted-in profile on a non-Windows node at preparation", () => {
    const f = fixture(); Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(() => prepareVerificationProfiles([f.raw])).toThrow(/Windows browser Job profiles require Windows/);
  });
  it("does not dispatch after private-context admission consumes the original command budget", async () => {
    const f = fixture(), collect = state.audit.getMockImplementation()!;
    state.audit.mockImplementation((...args: unknown[]) => { f.clock.mockReturnValue(1400); return collect(...args); });
    const result = await runVerification(f.profile, "request-bound", new AbortController().signal, f.context);
    expect(result.outcome).toBe("failed"); expect(result.reason).toMatch(/original.*deadline/);
    expect(runProtectedCommand).not.toHaveBeenCalled();
  });
  it("charges the final backend re-audit before calculating the remaining dispatch timeout", async () => {
    const f = fixture(), collect = state.audit.getMockImplementation()!;
    let audits = 0, privateFileReady = false;
    state.audit.mockImplementation((...args: unknown[]) => { const result = collect(...args); if (++audits === 3) privateFileReady = true; return result; });
    state.assertBackend.mockImplementation(() => { if (privateFileReady) f.clock.mockReturnValue(1400); });
    const result = await runVerification(f.profile, "request-bound", new AbortController().signal, f.context);
    expect(result.outcome).toBe("failed"); expect(result.reason).toMatch(/original command deadline/);
    expect(runProtectedCommand).not.toHaveBeenCalled();
  });
});
