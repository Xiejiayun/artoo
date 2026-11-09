import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext, type RunStartPayload } from "@artoo/domain";
import { prepareVerificationProfiles, loadPreparedVerificationProfilesFile, readVerificationCapabilities,
  selectVerificationProfile, runVerification, VerificationCleanupError,
  type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";
import { OwnedGitError, runOwnedGit } from "./owned/owned-git.js";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";
import { STATIC_WEB_MAX_CONFIG_BYTES } from "./web-acceptance-config.js";

vi.mock("./owned/owned-git.js", async (load) => ({ ...await load<typeof import("./owned/owned-git.js")>(), runOwnedGit: vi.fn() }));

const roots: string[] = [], originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const installedCli = realpathSync.native(fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)));
function writeProtected(path: string, bytes: string | Buffer): void {
  writeFileSync(path, bytes);
  // NTFS can update ctime on the first read of a newly written JSON file.
  // Settle that fixture access before testing the production no-change boundary.
  readFileSync(path);
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-capabilities-"))); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "browser.json"), browser = join(root, "browser");
  mkdirSync(workspace); mkdirSync(evidence); mkdirSync(join(workspace, "product")); mkdirSync(join(workspace, ".artoo", "product"), { recursive: true });
  writeProtected(browser, "protected browser fixture");
  writeProtected(join(workspace, ".artoo", "product", "research.json"), "controlled research artifact for mocked executor");
  const options = { browser_executable: browser, evidence_root: evidence, viewports: [768, 320], action_timeout_ms: 750, design_capture_cases: true };
  writeProtected(config, JSON.stringify(options));
  const profile: VerificationProfile = { id: "static", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, installedCli, config], timeout_ms: 1000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] };
  return { root, workspace, evidence, config, browser, options, profile };
}
function payload(profile: PreparedVerificationProfile): RunStartPayload {
  const capabilities = readVerificationCapabilities(profile)!;
  return { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: profile.workspace_root },
    context_pack: { id: "context", payload: { task: { id: "task", title: "Research", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Product", default_workspace: profile.workspace_root }, workspace: { root: profile.workspace_root, file_scope: [] },
      policy: { filesystem_write_scope: [profile.workspace_root], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      product_development: productDevelopmentContext("research"), verification_capabilities: capabilities } },
    policy_snapshot: { filesystem_write_scope: [profile.workspace_root], requires_approval: [] }, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: profile.id, request_id: "request", capability_binding: { version: 1, profile_digest: profile.digest,
      checks: capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) } } };
}
function admitOnSupportedPlatform() { Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" }); }

describe("protected static-web capability profiles", () => {
  it("reuses the explicit loader's original capability profile without changing its digest", () => {
    const f = fixture(), profilesFile = join(f.root, "profiles.json");
    writeProtected(profilesFile, JSON.stringify([f.profile]));
    const expected = prepareVerificationProfiles([f.profile], [f.workspace])[0]!;
    const loaded = loadPreparedVerificationProfilesFile(profilesFile, [f.workspace]);
    expect(loaded[0]!.digest).toBe(expected.digest);
    expect(readVerificationCapabilities(loaded[0]!)).toEqual(readVerificationCapabilities(expected));
    expect(prepareVerificationProfiles(loaded, [f.workspace])[0]).toBe(loaded[0]);
    for (const clone of [structuredClone(loaded[0]!), JSON.parse(JSON.stringify(loaded[0])) as PreparedVerificationProfile]) {
      expect(() => readVerificationCapabilities(clone)).toThrow(/locally prepared/);
      expect(() => prepareVerificationProfiles([clone], [f.workspace])).toThrow(/unknown capability profile field/);
    }
  });

  it.each(["browser", "configuration"] as const)("rechecks the loaded profile after an awaited %s change", async (target) => {
    const f = fixture(), profilesFile = join(f.root, "profiles.json");
    writeProtected(profilesFile, JSON.stringify([f.profile]));
    const loaded = loadPreparedVerificationProfilesFile(profilesFile, [f.workspace]);
    await Promise.resolve();
    if (target === "browser") writeProtected(f.browser, "changed protected browser fixture");
    else writeProtected(f.config, JSON.stringify({ ...f.options, action_timeout_ms: 800 }));
    expect(() => prepareVerificationProfiles(loaded, [f.workspace])).toThrow(/administrator verifier changed/);
  });

  it("derives only public configured capabilities from normalized protected options", () => {
    const f = fixture(), prepared = prepareVerificationProfiles([f.profile])[0]!;
    const expected = prepareStaticWebCapabilities(f.options), context = readVerificationCapabilities(prepared)!;
    expect(context).toEqual({ version: 1, profile_id: "static", profile_digest: prepared.digest,
      checks: [{ command_id: "browser", config_digest: expected.config_digest, contract_digest: expected.contract_digest, contract: expected.contract }] });
    expect(context.checks[0]!.contract).toMatchObject({ claim: "configured", viewports: [{ width: 768, height: 900 }, { width: 320, height: 900 }],
      stage_policy: { research: "no-browser", design: "declared-cases" }, screenshots: "final-visible-viewport", limits: { action_timeout_ms: 750 } });
    for (const privateValue of [f.evidence, f.browser, f.config, installedCli, "argv", "options", "trustedFiles"]) expect(JSON.stringify(context)).not.toContain(privateValue);
    expect(prepared.trustedFiles.some((file) => file.path === f.browser)).toBe(true);
    expect(Object.isFrozen(context.checks)).toBe(true); expect(Object.isFrozen(context.checks[0]!.contract.viewports)).toBe(true);
    expect(prepareVerificationProfiles([prepared])[0]).toBe(prepared);
    expect(() => prepareVerificationProfiles([structuredClone(prepared)])).toThrow(/unknown capability profile field/);
    expect(() => readVerificationCapabilities(structuredClone(prepared))).toThrow(/locally prepared/);
  });

  it("keeps legacy profile serialization and unknown capability scope unchanged", () => {
    const f = fixture(); delete f.profile.commands[0]!.observation!.capabilities;
    // Legacy profiles continue ignoring extra profile/command fields.
    Object.assign(f.profile, { old_operator_note: "unchanged" }); Object.assign(f.profile.commands[0]!, { old_note: true });
    const prepared = prepareVerificationProfiles([f.profile])[0]!;
    const legacy = { id: f.profile.id, project_id: f.profile.project_id, workspace_root: f.workspace,
      commands: [{ id: "browser", argv: [realpathSync.native(process.execPath), installedCli, f.config], timeout_ms: 1000,
        observation: { format: "static-web-acceptance.v1", evidence_root: f.evidence } }], required_files: [], subject_paths: ["product", ".artoo/product"],
      trustedFiles: prepared.trustedFiles };
    expect(prepared.digest).toBe(sha(JSON.stringify(legacy)));
    expect(prepared).not.toHaveProperty("capabilities"); expect(readVerificationCapabilities(prepared)).toBeUndefined();
    expect(prepared.trustedFiles.some((file) => file.path === f.browser)).toBe(false);
    expect(prepareVerificationProfiles([prepared])[0]!.digest).toBe(prepared.digest);
  });

  it("requires the installed CLI, current protected Node and exact argv", () => {
    const f = fixture(), command = f.profile.commands[0]!, wrapper = join(f.root, "web-acceptance-cli.js"), fakeNode = join(f.root, "node.exe");
    writeProtected(wrapper, readFileSync(installedCli)); writeProtected(fakeNode, "fake Node");
    for (const argv of [[process.execPath, wrapper, f.config], [fakeNode, installedCli, f.config],
      [process.execPath, installedCli, f.config, "extra"], [process.execPath, installedCli]]) {
      expect(() => prepareVerificationProfiles([{ ...f.profile, commands: [{ ...command, argv }] }])).toThrow(/exactly the installed/);
    }
  });

  it.each([2, 3] as const)("requires an opted-in v%s profile format exactly matching the protected program version", (version) => {
    const f = fixture(), command = f.profile.commands[0]!;
    command.observation!.format = version === 2 ? "static-web-acceptance.v2" : "static-web-acceptance.v3";
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/program version/);
    const { viewports: _, ...common } = f.options;
    writeProtected(f.config, JSON.stringify({ ...common, browser_program: { version,
      viewports: [{ id: "compact", width: 512, height: 650 }, { id: "tall", width: 512, height: 1000 }] } }));
    const prepared = prepareVerificationProfiles([f.profile])[0]!;
    expect(prepared.capabilities!.checks[0]!.contract).toMatchObject({ version, legacy_browser_steps: "rejected",
      viewports: [{ id: "compact", width: 512, height: 650 }, { id: "tall", width: 512, height: 1000 }] });
    command.observation!.format = "static-web-acceptance.v1";
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/program version/);
    command.observation!.format = version === 2 ? "static-web-acceptance.v3" : "static-web-acceptance.v2";
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/program version/);
    command.observation!.format = version === 2 ? "static-web-acceptance.v2" : "static-web-acceptance.v3";
    delete command.observation!.capabilities;
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/require.*opted-in/);
  });

  it("rejects unknown opt-in fields and unsupported configuration", () => {
    const f = fixture();
    for (const target of [f.profile, f.profile.commands[0]!, f.profile.commands[0]!.observation!.capabilities!]) {
      Object.assign(target, { invented: true }); expect(() => prepareVerificationProfiles([f.profile])).toThrow(/unknown/); delete (target as Record<string, unknown>).invented;
    }
    writeProtected(f.config, JSON.stringify({ ...f.options, actions: ["keyboard"] }));
    expect(() => prepareVerificationProfiles([f.profile])).toThrow();
    writeProtected(f.config, JSON.stringify({ ...f.options, viewports: [320, 320] }));
    expect(() => prepareVerificationProfiles([f.profile])).toThrow();
    writeProtected(f.config, JSON.stringify(f.options).padEnd(STATIC_WEB_MAX_CONFIG_BYTES, " "));
    expect(prepareVerificationProfiles([f.profile])[0]!.capabilities).toBeDefined();
    writeProtected(f.config, JSON.stringify(f.options).padEnd(STATIC_WEB_MAX_CONFIG_BYTES + 1, " "));
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/bounded regular file/);
  });

  it("requires physically equal evidence roots outside all coding workspaces", () => {
    const f = fixture(), other = join(f.root, "other"), nestedEvidence = join(other, "evidence"); mkdirSync(nestedEvidence, { recursive: true });
    delete f.profile.commands[0]!.observation!.evidence_root;
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/protected evidence root/);
    f.profile.commands[0]!.observation!.evidence_root = f.evidence;
    const { evidence_root: _, ...withoutEvidence } = f.options; writeProtected(f.config, JSON.stringify(withoutEvidence));
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/protected evidence root/);
    writeProtected(f.config, JSON.stringify({ ...f.options, evidence_root: nestedEvidence }));
    expect(() => prepareVerificationProfiles([f.profile])).toThrow(/evidence roots differ/);
    f.profile.commands[0]!.observation!.evidence_root = nestedEvidence;
    const second = { ...f.profile, id: "other", workspace_root: other, commands: [{ id: "check", argv: [process.execPath, installedCli], timeout_ms: 1000 }] };
    expect(() => prepareVerificationProfiles([f.profile, second])).toThrow(/evidence.*outside/i);
  });

  it("rejects browser files in any coding workspace and checks the prepared files before reuse", () => {
    const f = fixture(), other = join(f.root, "other"); mkdirSync(other);
    for (const root of [f.workspace, other]) {
      const browser = join(root, "browser"); writeProtected(browser, "browser"); writeProtected(f.config, JSON.stringify({ ...f.options, browser_executable: browser }));
      const second = { ...f.profile, id: "other", workspace_root: other, commands: [{ id: "check", argv: [process.execPath, installedCli], timeout_ms: 1000 }] };
      expect(() => prepareVerificationProfiles([f.profile, second])).toThrow(/outside.*coding workspace/);
    }
    writeProtected(f.config, JSON.stringify(f.options));
    const prepared = prepareVerificationProfiles([f.profile])[0]!; writeProtected(f.config, JSON.stringify({ ...f.options, viewports: [390] }));
    expect(() => prepareVerificationProfiles([prepared])).toThrow(/verifier changed/);
    expect(() => readVerificationCapabilities(prepared)).toThrow(/verifier changed/);
  });

  it("admits only matching context and requirement bindings; missing historical bindings fail closed", () => {
    const f = fixture(), profile = prepareVerificationProfiles([f.profile])[0]!, start = payload(profile); admitOnSupportedPlatform();
    expect(selectVerificationProfile(start, [profile], false)).toBe(profile);
    const mutations = [
      (run: RunStartPayload) => { delete run.verification!.capability_binding; },
      (run: RunStartPayload) => { delete run.context_pack.payload!.verification_capabilities; },
      (run: RunStartPayload) => { run.verification!.capability_binding!.profile_digest = sha("other"); },
      (run: RunStartPayload) => { run.verification!.capability_binding!.checks[0]!.config_digest = sha("other"); },
      (run: RunStartPayload) => { run.verification!.capability_binding!.checks[0]!.contract_digest = sha("other"); },
      (run: RunStartPayload) => { run.verification!.capability_binding!.checks[0]!.command_id = "other"; },
      (run: RunStartPayload) => { run.verification!.capability_binding!.checks.push({ ...run.verification!.capability_binding!.checks[0]! }); },
      (run: RunStartPayload) => { run.context_pack.payload!.verification_capabilities!.checks[0]!.contract.viewports[0]!.width = 390; },
      (run: RunStartPayload) => { run.context_pack.payload!.verification_capabilities!.profile_id = "other"; },
      (run: RunStartPayload) => { run.context_pack.payload!.project.id = "other"; },
      (run: RunStartPayload) => { delete run.verification; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(start); mutate(changed); expect(() => selectVerificationProfile(changed, [profile], false)).toThrow(); }
    delete f.profile.commands[0]!.observation!.capabilities;
    const legacy = prepareVerificationProfiles([f.profile])[0]!;
    expect(() => selectVerificationProfile(start, [legacy], false)).toThrow(/opted-in/);
    delete start.context_pack.payload!.verification_capabilities;
    expect(() => selectVerificationProfile(start, [legacy], false)).toThrow(/opted-in/);
    delete start.verification!.capability_binding;
    expect(selectVerificationProfile(start, [legacy], false)).toBe(legacy);
  });
});

describe("protected capability execution binding (controlled executor)", () => {
  it.each([true, false])("owns verifier temporary files and retains them if closure is unconfirmed: %s", async (cleanupConfirmed) => {
    const f = fixture(), profile = prepareVerificationProfiles([f.profile])[0]!, start = payload(profile);
    admitOnSupportedPlatform();
    let directory = "", marker = "";
    vi.mocked(runOwnedGit).mockImplementation(async (_request, options) => {
      const environment = options!.environment!;
      directory = dirname(environment.ARTOO_VERIFICATION_CONTEXT_FILE!); roots.push(directory);
      for (const key of ["TMPDIR", "TMP", "TEMP"]) expect(environment[key]).toBe(directory);
      expect(directory.startsWith(f.workspace)).toBe(false);
      const temporary = join(directory, "controlled-child-profile"); mkdirSync(temporary);
      marker = join(temporary, "cache"); writeFileSync(marker, "controlled temporary state");
      // No process was launched by this controlled executor. Restore the host
      // platform before exercising the actual directory retention/removal logic.
      Object.defineProperty(process, "platform", originalPlatform);
      throw new OwnedGitError(cleanupConfirmed ? "timeout" : "cleanup_uncertain", {
        cleanupConfirmed, childStatus: null, elapsedMs: 1,
      } as ConstructorParameters<typeof OwnedGitError>[1], Buffer.alloc(0), Buffer.alloc(0));
    });
    const pending = runVerification(profile, "temporary_ownership", new AbortController().signal, start.context_pack.payload);
    if (cleanupConfirmed) {
      expect((await pending).outcome).toBe("timed_out");
      expect(existsSync(directory)).toBe(false);
    } else {
      await expect(pending).rejects.toBeInstanceOf(VerificationCleanupError);
      expect(readFileSync(marker, "utf8")).toBe("controlled temporary state");
      expect(existsSync(join(directory, "context.json"))).toBe(true);
    }
  });
  it.each(["match", "missing", "wrong-command", "wrong-profile", "wrong-config", "wrong-contract", "wrong-format", "changed-config", "changed-source", "cancelled"])("keeps only fully bound, unchanged observations: %s", async (mode) => {
    const f = fixture(), profile = prepareVerificationProfiles([f.profile])[0]!, start = payload(profile), controller = new AbortController();
    admitOnSupportedPlatform();
    let protectedFile = "";
    vi.mocked(runOwnedGit).mockImplementation(async (_request, options) => {
      protectedFile = options!.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!;
      const envelope = JSON.parse(readFileSync(protectedFile, "utf8"));
      expect(envelope.static_web_capabilities.options).toEqual(f.options);
      expect(envelope.static_web_capabilities.binding).toMatchObject({ command_id: "browser", profile_digest: profile.digest });
      expect(envelope.context.verification_capabilities).toEqual(start.context_pack.payload!.verification_capabilities);
      const binding = { ...envelope.static_web_capabilities.binding };
      if (mode === "wrong-command") binding.command_id = "forged";
      if (mode === "wrong-profile") binding.profile_digest = sha("forged");
      if (mode === "wrong-config") binding.config_digest = sha("forged");
      if (mode === "wrong-contract") binding.contract_digest = sha("forged");
      if (mode === "changed-config") writeFileSync(f.config, JSON.stringify({ ...f.options, viewports: [390] }));
      if (mode === "changed-source") writeFileSync(join(f.workspace, "product", "index.html"), "changed");
      if (mode === "cancelled") controller.abort();
      const directory = join(f.evidence, sha("request").slice(7)); mkdirSync(directory);
      const report = JSON.stringify({ ...(mode === "wrong-format" ? { version: 2, format: "static-web-acceptance.v2", device_scale_factor: 1 }
        : { version: 1, format: "static-web-acceptance.v1" }), stage: "research", passed: true,
        requirements: 1, cases: [], ...(mode !== "missing" ? { capability_binding: binding } : {}) });
      writeProtected(join(directory, "result.json"), report);
      // Only the executor admission is simulated; evidence sealing uses the host filesystem.
      Object.defineProperty(process, "platform", originalPlatform);
      return { status: 0, stdout: Buffer.from(report), stderr: Buffer.alloc(0),
        receipt: { elapsedMs: 1, cleanupConfirmed: true } } as Awaited<ReturnType<typeof runOwnedGit>>;
    });
    const result = await runVerification(profile, "request", controller.signal, start.context_pack.payload);
    expect(result.outcome).toBe(mode === "match" ? "passed" : mode === "cancelled" ? "cancelled" : "failed");
    expect(result.checks[0]!.observation?.capability_binding).toEqual(mode === "match"
      ? { version: 1, profile_digest: profile.digest, ...start.verification!.capability_binding!.checks[0]! } : undefined);
    expect(() => readFileSync(protectedFile)).toThrow();
  });
});
