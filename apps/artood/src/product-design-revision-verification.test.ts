// Real local profile preparation, source measurement and production verifier logic.
// Native process authority, child execution and sealed browser output are controlled
// seams; these cases are not native/browser/provider acceptance evidence.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextPack } from "@artoo/domain";
import { designRevisionFixture, revisionReviewContext, revisionSha } from "./test-fixtures/design-revision.js";
import { inspectProductDesignRevision } from "./product-design-revision.js";

const controlled = vi.hoisted(() => ({ command: vi.fn(), privateWrite: vi.fn(), expected: vi.fn(), seal: vi.fn(),
  backend: Object.freeze({}), envelope: undefined as any }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn() }));
vi.mock("./windows-browser-process-authority.js", () => ({ assertWindowsBrowserProcessInstallation: vi.fn(),
  createWindowsBrowserProcessDescriptor: vi.fn((_backend, binding) => ({ controlled: true, binding })) }));
vi.mock("./windows-browser-private-context.js", () => ({ writeWindowsBrowserPrivateContext: controlled.privateWrite }));
vi.mock("./protected-command.js", async original => ({ ...await original<typeof import("./protected-command.js")>(), runProtectedCommand: controlled.command }));
vi.mock("./web-acceptance.js", async original => ({ ...await original<typeof import("./web-acceptance.js")>(), deriveExpectedWebAcceptanceV3: controlled.expected }));
vi.mock("./browser-evidence.js", async original => ({ ...await original<typeof import("./browser-evidence.js")>(), sealBrowserEvidence: controlled.seal }));

import { prepareVerificationProfiles, attachWindowsVerificationBackend, productDesignRevisionVerificationSupported,
  assertProductDesignRevisionVerificationProfile, selectVerificationProfile, runVerification, runVerificationPreview, subjectManifest,
  type VerificationProfile } from "./verification.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
import { ProtectedCommandError } from "./protected-command.js";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";
import { deriveWebAcceptanceV3Plan } from "./web-acceptance-plan-v3.js";
import { isV3WebAcceptanceOptions } from "./web-acceptance-config.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const temporary = new Set<string>(), retained = new Set<string>();
beforeEach(() => { vi.clearAllMocks(); controlled.envelope = undefined; Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const root of temporary) {
    if (retained.has(root)) continue;
    const tail = relative(realpathSync.native(tmpdir()), root);
    if (isAbsolute(tail) || tail.startsWith("..") || !tail.startsWith("artoo-design-revision-")) throw Error("Unsafe controlled fixture cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
  temporary.clear();
});
const write = (file: string, bytes: string | Uint8Array) => { writeFileSync(file, bytes); readFileSync(file); };
function fixture(options: { capture?: boolean; windows?: boolean; policy?: 1 | 2 } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-design-revision-"))); temporary.add(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "browser.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const configuration = { evidence_root: evidence, design_capture_cases: options.capture ?? true,
    ...(options.windows === false ? {} : { windows_browser_process: { version: 1 as const } }),
    browser_program: { version: 3 as const, viewports: [{ id: "compact", width: 390, height: 844 }] } };
  write(config, JSON.stringify(configuration));
  const raw: VerificationProfile = { id: "checks", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config], timeout_ms: 30000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"],
    measurement_plan_policy: options.policy === 1 ? { version: 1, coverage: "every-must-criterion" }
      : { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] } };
  const profile = prepareVerificationProfiles([raw], [workspace])[0]!;
  if (options.windows !== false) attachWindowsVerificationBackend(profile, controlled.backend as never);
  const f = designRevisionFixture({ workspace, capabilities: profile.capabilities! });
  const researchPath = join(workspace, ".artoo/product/research.json"), designPath = join(workspace, ".artoo/product/design.json");
  write(researchPath, f.researchBytes); write(designPath, f.revisedBytes); write(join(workspace, "product/index.html"), "<title>Controlled journal</title><p id=entry>Saved</p>");
  controlled.privateWrite.mockImplementation((_backend, path, envelope) => { const bytes = Buffer.from(JSON.stringify(envelope)); writeFileSync(path, bytes, { flag: "wx" }); return revisionSha(bytes); });
  controlled.command.mockImplementation(async (_request, commandOptions) => {
    const privateBytes = readFileSync(commandOptions.environment.ARTOO_VERIFICATION_CONTEXT_FILE);
    const envelope = JSON.parse(privateBytes.toString("utf8")); controlled.envelope = envelope;
    expect(revisionSha(privateBytes)).toBe(commandOptions.environment.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256);
    expect(envelope.subject_digest).toBe(subjectManifest(profile).digest);
    const echo = inspectProductDesignRevision(envelope.context, readFileSync(researchPath), readFileSync(designPath));
    const report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 1,
      device_scale_factor: 1, capability_binding: envelope.static_web_capabilities.binding, cases: [], ...(echo ? { product_design_revision: echo } : {}) };
    return { status: 0, elapsedMs: 1, stdout: Buffer.from(JSON.stringify(report)), stderr: Buffer.alloc(0) };
  });
  // The real source-derived all-case plan is checked independently below. These
  // empty controlled observations isolate verifier handshake/closure handling.
  controlled.expected.mockReturnValue({ stage: "design", requirements: 1, programs: [] });
  controlled.seal.mockReturnValue({ bundle_id: "controlled_revision_bundle", manifest_digest: revisionSha("controlled browser evidence"), case_refs: [] });
  return { ...f, root, workspace, evidence, raw, profile, configuration, config, researchPath, designPath };
}
type Fixture = ReturnType<typeof fixture>;
function expectedEvidence(f: Fixture, context = f.context) { return inspectProductDesignRevision(context, readFileSync(f.researchPath), readFileSync(f.designPath)); }

describe("design revision node verifier with controlled process/evidence seams", () => {
  it("admits only an original all-case policy-v2 native Job profile", () => {
    const f = fixture();
    expect(productDesignRevisionVerificationSupported(f.profile)).toBe(true);
    expect(() => assertProductDesignRevisionVerificationProfile(f.profile)).not.toThrow();
    expect(productDesignRevisionVerificationSupported(structuredClone(f.profile))).toBe(false);
    expect(productDesignRevisionVerificationSupported(Object.create(f.profile))).toBe(false);
    expect(productDesignRevisionVerificationSupported(fixture({ capture: false }).profile)).toBe(false);
    expect(productDesignRevisionVerificationSupported(fixture({ windows: false }).profile)).toBe(false);
    expect(productDesignRevisionVerificationSupported(fixture({ policy: 1 }).profile)).toBe(false);
  });
  it("selects the real profile before the author starts while the old design is still present", () => {
    const f = fixture(); write(f.designPath, f.baselineBytes);
    expect(selectVerificationProfile(f.start, [f.profile], false, undefined, "computer")).toBe(f.profile);
    expect(() => selectVerificationProfile(f.start, [f.profile], false, undefined, "different-computer")).toThrow("current node");
    const changed = structuredClone(f.start); changed.workspace.root += "-other";
    expect(() => selectVerificationProfile(changed, [f.profile], false, undefined, "computer")).toThrow("context mismatch");
    expect(controlled.command).not.toHaveBeenCalled();
  });
  it("derives both accepted and newly appended workspace cases from real protected configuration", () => {
    const f = fixture(), prepared = prepareStaticWebCapabilities(f.configuration), check = f.profile.capabilities!.checks[0]!;
    const binding = { version: 1 as const, command_id: check.command_id, profile_digest: f.profile.digest,
      config_digest: check.config_digest, contract_digest: check.contract_digest };
    if (!isV3WebAcceptanceOptions(prepared.options)) throw Error("Expected original v3 fixture configuration");
    const plan = deriveWebAcceptanceV3Plan(f.workspace, f.context, prepared.options, binding);
    expect(plan.casePrograms.map(test => test.case_id)).toEqual(["original", "literal-separator"]);
    expect(plan.programs).toHaveLength(2);
    const prototypeOnly = { ...prepared.options, design_capture_cases: false };
    expect(() => deriveWebAcceptanceV3Plan(f.workspace, f.context, prototypeOnly, binding)).toThrow("every declared design case");
  });
  it.each(["final", "preview", "independent-review"] as const)("binds the same revision source to separate %s verification scope", async route => {
    const f = fixture(), context = route === "independent-review" ? revisionReviewContext(f.context) : f.context;
    if (context.review_subject) context.review_subject.subject_digest = subjectManifest(f.profile).digest;
    const requestId = route === "preview" ? "preview-revision" : route === "independent-review" ? "independent-review-verification" : f.start.verification!.request_id;
    const result = route === "preview" ? (await runVerificationPreview(f.profile, requestId, new AbortController().signal, context)).verification
      : await runVerification(f.profile, requestId, new AbortController().signal, context, route === "independent-review" ? subjectManifest(f.profile).digest : undefined);
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: "passed", request_id: requestId, product_design_revision: expectedEvidence(f, context), measurement_plan: { scope: route === "preview" ? "preview" : "final" } });
    expect(controlled.envelope).toMatchObject({ request_id: requestId, scope: route === "preview" ? "preview" : "final", context: { product_design_revision: { author_run_id: "revised-author" } } });
    expect(controlled.command).toHaveBeenCalledOnce(); expect(controlled.seal).toHaveBeenCalledOnce();
  });
  it.each(["missing", "revision_id", "descriptor_digest", "baseline_checksum", "revised_design", "scope"])("rejects missing or substituted CLI revision echo: %s", field => {
    const f = fixture(), command = controlled.command.getMockImplementation()!;
    controlled.command.mockImplementationOnce(async (...args) => {
      const result = await command(...args), report = JSON.parse(result.stdout.toString());
      if (field === "missing") delete report.product_design_revision;
      else report.product_design_revision[field] = field.endsWith("digest") || field.endsWith("checksum") ? revisionSha("substitution") : "substitution";
      return { ...result, stdout: Buffer.from(JSON.stringify(report)) };
    });
    return runVerification(f.profile, "echo-verification", new AbortController().signal, f.context).then(result => {
      expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("exact design revision") });
      expect(controlled.command).toHaveBeenCalledOnce();
      expect(result.product_design_revision).toBeUndefined(); expect(result.measurement_plan).toBeUndefined();
      expect(result.checks.every(check => check.observation === undefined)).toBe(true); expect(controlled.seal).not.toHaveBeenCalled();
    });
  });
  it.each(["command-failed", "protected-failure", "cancelled", "changed-design", "changed-research"])("does not attest failed or changed execution: %s", async cause => {
    const f = fixture(), command = controlled.command.getMockImplementation()!, controller = new AbortController();
    controlled.command.mockImplementationOnce(async (...args) => {
      const result = await command(...args);
      if (cause === "command-failed") return { ...result, status: 1 };
      if (cause === "protected-failure") throw new ProtectedCommandError("execution_failed", 2, result.elapsedMs, result.stdout, result.stderr);
      if (cause === "cancelled") {
        controller.abort();
        throw new ProtectedCommandError("aborted", null, result.elapsedMs, result.stdout, result.stderr);
      }
      if (cause === "changed-design") write(f.designPath, Buffer.concat([f.revisedBytes, Buffer.from(" ")]));
      if (cause === "changed-research") write(f.researchPath, Buffer.concat([f.researchBytes, Buffer.from(" ")]));
      return result;
    });
    const result = await runVerification(f.profile, "failed-verification", controller.signal, f.context);
    expect(controlled.command).toHaveBeenCalledOnce();
    expect(result.checks).toHaveLength(1);
    const reason = cause === "command-failed" ? "Verification command browser exited 1"
      : cause === "protected-failure" ? "Verification command browser: execution_failed"
        : cause === "cancelled" ? "Verification command browser: aborted"
          : cause === "changed-design" ? "Verification subject changed during checks"
            : "Accepted product input .artoo/product/research.json changed";
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: cause === "cancelled" ? "cancelled" : "failed", reason: expect.stringContaining(reason),
      checks: [{ id: "browser", exit_code: cause === "command-failed" ? 1 : cause === "protected-failure" ? 2 : cause === "cancelled" ? null : 0 }] });
    expect(result.product_design_revision).toBeUndefined(); expect(result.measurement_plan).toBeUndefined();
    expect(result.checks.every(check => check.observation === undefined)).toBe(true); expect(controlled.seal).not.toHaveBeenCalled();
  });
  it("retains the private context and throws on uncertain process closure without returning attestations", async () => {
    const f = fixture(); let privateFile: string | undefined; retained.add(f.root);
    controlled.command.mockImplementationOnce(async (_command, options) => { privateFile = options.environment.ARTOO_VERIFICATION_CONTEXT_FILE; throw new VerificationCleanupError("Controlled closure is uncertain"); });
    await expect(runVerification(f.profile, "uncertain-verification", new AbortController().signal, f.context)).rejects.toThrow("closure is uncertain");
    expect(controlled.command).toHaveBeenCalledOnce();
    expect(privateFile).toBeDefined(); expect(existsSync(privateFile!)).toBe(true); expect(controlled.seal).not.toHaveBeenCalled();
  });
  it("rejects the initial unmodified design before any child invocation at verification time", async () => {
    const f = fixture(); write(f.designPath, f.baselineBytes);
    const result = await runVerification(f.profile, "old-design-verification", new AbortController().signal, f.context);
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("append") });
    expect(result.product_design_revision).toBeUndefined(); expect(controlled.command).not.toHaveBeenCalled();
  });
  it("preserves ordinary design verification when the extension is absent", async () => {
    const f = fixture(), context: ContextPack = structuredClone(f.context); delete context.product_design_revision;
    const result = await runVerification(f.profile, "ordinary-verification", new AbortController().signal, context);
    expect(result.outcome, JSON.stringify(result)).toBe("passed"); expect(result.product_design_revision).toBeUndefined(); expect(controlled.command).toHaveBeenCalledOnce();
  });
});
