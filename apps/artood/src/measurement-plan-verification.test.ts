import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalMeasurementPlanV1, productDevelopmentContext, ProductResearchReportV1Schema as ProductResearchReportSchema,
  type ContextPack, type ProductResearchReport, type ProductMeasurementPlanV1, type RunVerificationPayload } from "@artoo/domain";
import { OwnedGitError, runOwnedGit } from "./owned/owned-git.js";
import { prepareVerificationProfiles, readVerificationCapabilities, runVerification, runVerificationPreview,
  subjectManifest, VerificationCleanupError, type VerificationProfile } from "./verification.js";

vi.mock("./owned/owned-git.js", async (load) => ({ ...await load<typeof import("./owned/owned-git.js")>(), runOwnedGit: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [], policy = { version: 1 as const, coverage: "every-must-criterion" as const };
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const cli = fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url));
const write = (path: string, value: string) => { writeFileSync(path, value); readFileSync(path); };
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.resetAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(enabled = true) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-measurement-plan-"))); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), config = join(root, "browser.json");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  write(config, JSON.stringify({ evidence_root: evidence, viewports: [390], design_capture_cases: true }));
  const raw: VerificationProfile = { id: "acceptance", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 1000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"], ...(enabled ? { measurement_plan_policy: policy } : {}) };
  const profile = prepareVerificationProfiles([raw])[0]!, capabilities = readVerificationCapabilities(profile)!;
  const binding = capabilities.checks[0]!;
  const research: ProductResearchReport & { measurement_plan: ProductMeasurementPlanV1 } = { version: 1, objective: "Preserve the complete user requirement", assumptions: [],
    requirements: [{ id: "R", description: "Two separately identified criteria", priority: "must", acceptance_criteria: ["Show saved content", "Show recovery status"] }],
    sources: [{ id: "fixture", url: "https://example.com/spec", title: "Controlled schema fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("fixture") }],
    findings: [{ summary: "Declare observable UI outcomes", source_ids: ["fixture"] }], decisions: [],
    measurement_plan: { version: 1, profile_digest: profile.digest, entries: [0, 1].map(criterion_index => ({
      requirement_id: "R", criterion_index, command_id: binding.command_id, config_digest: binding.config_digest,
      contract_digest: binding.contract_digest, actions: ["navigate", "assert_text"], keys: [],
      viewports: binding.contract.viewports.map(viewport => ({ ...viewport })), needs: [] })) } };
  const researchPath = join(workspace, ".artoo/product/research.json"), save = () => write(researchPath, JSON.stringify(research)); save();
  const context: ContextPack = { task: { id: "task", title: "Research", description: "Original", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("research", capabilities), verification_capabilities: capabilities };
  return { root, workspace, evidence, raw, profile, context, research, researchPath, save };
}
type Fixture = ReturnType<typeof fixture>;
type Route = "final" | "preview" | "peer";
const schemaFailurePrefix = "Verification: measurement-plan research does not satisfy its versioned report contract: ";
interface ResearchDiagnostic {
  version: number; format: string; file: string; omitted_issues: number;
  issues: { path: (string | number)[]; code: string; expected?: string }[];
}
function schemaDiagnostic(result: RunVerificationPayload): ResearchDiagnostic {
  expect(result.outcome).toBe("failed"); expect(result.checks).toEqual([]); expect(result.measurement_plan).toBeUndefined();
  expect(result.reason?.startsWith(schemaFailurePrefix)).toBe(true); expect(result.reason!.length).toBeLessThan(1800);
  expect(runOwnedGit).not.toHaveBeenCalled();
  const detail = JSON.parse(result.reason!.slice(schemaFailurePrefix.length)) as ResearchDiagnostic;
  expect(detail).toMatchObject({ version: 1, format: "artoo-research-schema-issues.v1", file: ".artoo/product/research.json" });
  expect(detail.issues.length).toBeLessThanOrEqual(8);
  return detail;
}
async function execute(f: Fixture, route: Route, signal = new AbortController().signal) {
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const context = structuredClone(f.context);
  if (route === "peer") {
    delete context.product_development;
    context.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
    context.review_subject = { version: 1, task_id: "author_task", run_id: "author_run", evidence_id: "author_evidence",
      subject_digest: subjectManifest(f.profile).digest, development_stage: "research" };
  }
  return route === "preview"
    ? (await runVerificationPreview(f.profile, route, signal, context)).verification
    : runVerification(f.profile, route, signal, context, route === "peer" ? subjectManifest(f.profile).digest : undefined);
}
function successfulCommand(f: Fixture, effect?: () => void, forgedSummary = false) {
  vi.mocked(runOwnedGit).mockImplementation(async (_request, options) => {
    const envelope = JSON.parse(readFileSync(options!.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!, "utf8"));
    const report = { version: 1, format: "static-web-acceptance.v1", stage: "research", passed: true,
      requirements: 1, cases: [], capability_binding: envelope.static_web_capabilities.binding,
      ...(forgedSummary ? { measurement_plan: { claim: "complete-user-requirement-coverage", must_criterion_count: 999 } } : {}) };
    const directory = join(f.evidence, sha(envelope.request_id).slice(7)); mkdirSync(directory);
    write(join(directory, "result.json"), JSON.stringify(report)); effect?.();
    // Controlled process result only; production admission, measured files and
    // evidence sealing execute normally on the host filesystem.
    Object.defineProperty(process, "platform", platform);
    return { status: 0, stdout: Buffer.from(JSON.stringify(report)), stderr: Buffer.alloc(0), receipt: { elapsedMs: 1, cleanupConfirmed: true } } as Awaited<ReturnType<typeof runOwnedGit>>;
  });
}

describe("node-owned declared measurement-plan feasibility", () => {
  it("changes the protected digest only when explicitly enabled and freezes the exact public policy", () => {
    const f = fixture(false), legacy = f.profile;
    const { capabilities: ignored, digest: ignoredDigest, ...digestInput } = legacy;
    expect(legacy.digest).toBe(sha(JSON.stringify(digestInput)));
    expect(legacy).not.toHaveProperty("measurement_plan_policy"); expect(ignored).not.toHaveProperty("measurement_plan_policy");
    const enabled = prepareVerificationProfiles([{ ...f.raw, measurement_plan_policy: policy }])[0]!;
    expect(enabled.digest).not.toBe(legacy.digest); expect(enabled.measurement_plan_policy).toEqual(policy);
    expect(enabled.capabilities!.measurement_plan_policy).toEqual(policy); expect(Object.isFrozen(enabled.measurement_plan_policy)).toBe(true);
    expect(prepareVerificationProfiles([enabled])[0]).toBe(enabled);
    expect(() => readVerificationCapabilities(structuredClone(enabled))).toThrow(/locally prepared/);
  });

  it("rejects unknown policy fields, unbound checks and incomplete product subject coverage", () => {
    const f = fixture(false);
    for (const measurement_plan_policy of [{ version: 2, coverage: "every-must-criterion" }, { ...policy, bypass: true }, null]) {
      expect(() => prepareVerificationProfiles([{ ...f.raw, measurement_plan_policy } as VerificationProfile])).toThrow(/measurement-plan policy/);
    }
    const unbound = structuredClone(f.raw); delete unbound.commands[0]!.observation!.capabilities;
    expect(() => prepareVerificationProfiles([{ ...unbound, measurement_plan_policy: policy }])).toThrow(/installed capability-bound/);
    expect(() => prepareVerificationProfiles([{ ...f.raw, measurement_plan_policy: policy, subject_paths: ["product"] }])).toThrow(/complete product/);
  });

  it.each<Route>(["final", "preview", "peer"])("recomputes actual research facts on the shared %s path", async (route) => {
    const f = fixture(); successfulCommand(f);
    const result = await execute(f, route), bytes = readFileSync(f.researchPath);
    expect(result.outcome).toBe("passed"); expect(vi.mocked(runOwnedGit)).toHaveBeenCalledOnce();
    expect(result.measurement_plan).toEqual({ version: 1, claim: "declared-mapping-feasibility", scope: route === "preview" ? "preview" : "final",
      policy, research: { path: ".artoo/product/research.json", checksum: sha(bytes), size: bytes.length },
      measurement_plan_digest: sha(canonicalMeasurementPlanV1(f.research.measurement_plan!)), must_criterion_count: 2, mapped_criterion_count: 2,
      used_checks: f.profile.capabilities!.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) });
    expect(result.required_files).toContainEqual(result.measurement_plan!.research);
    expect(result.checks[0]!.observation!.cases).toEqual([]); // Research does not invent a browser assertion.
  });

  it.each<Route>(["final", "preview", "peer"])("rejects an incomplete mapping before invoking any command on %s", async (route) => {
    const f = fixture(); f.research.measurement_plan!.entries.pop(); f.save(); successfulCommand(f);
    const result = await execute(f, route);
    expect(result.outcome).toBe("failed"); expect(result.measurement_plan).toBeUndefined();
    expect(runOwnedGit).not.toHaveBeenCalled(); expect(result.checks).toEqual([]);
  });

  it.each<Route>(["final", "preview", "peer"])("reports missing research fields without executing any command on %s", async (route) => {
    const f = fixture();
    const malformed = { version: 1, sources: f.research.sources,
      findings: [{ finding: "This alternate field cannot replace summary", source_ids: ["fixture"] }] };
    write(f.researchPath, JSON.stringify(malformed)); const before = readFileSync(f.researchPath);
    const detail = schemaDiagnostic(await execute(f, route));
    expect(detail.issues).toEqual([
      { path: ["objective"], code: "invalid_type", expected: "string" },
      { path: ["assumptions"], code: "invalid_type", expected: "array" },
      { path: ["requirements"], code: "invalid_type", expected: "array" },
      { path: ["findings", 0, "summary"], code: "invalid_type", expected: "string" },
      { path: ["decisions"], code: "invalid_type", expected: "array" },
    ]);
    expect(detail.omitted_issues).toBe(0); expect(readdirSync(f.evidence)).toEqual([]);
    expect(readFileSync(f.researchPath)).toEqual(before);
  });

  it("keeps many real schema failures as complete bounded JSON with an exact omitted count", async () => {
    const f = fixture(), malformed = { ...f.research, requirements: Array.from({ length: 100 }, () => ({})) };
    const parsed = ProductResearchReportSchema.safeParse(malformed); if (parsed.success) throw new Error("Expected invalid controlled research");
    write(f.researchPath, JSON.stringify(malformed));
    const detail = schemaDiagnostic(await execute(f, "preview"));
    expect(detail.issues).toHaveLength(8); expect(detail.omitted_issues).toBe(parsed.error.issues.length - 8);
    expect(detail.omitted_issues).toBeGreaterThan(0);
  });

  it("does not expose hostile input, arbitrary strict-object keys or literal/enum values", async () => {
    const f = fixture(), secret = "C:\\private\\HOST_SECRET_9127.txt https://example.invalid/PRIVATE_VALUE_9127";
    const malformed = { ...f.research, version: secret, objective: secret.repeat(200),
      requirements: [{ ...f.research.requirements[0]!, priority: secret }],
      measurement_plan: { ...f.research.measurement_plan!, [secret]: secret } };
    write(f.researchPath, JSON.stringify(malformed)); const result = await execute(f, "final"), detail = schemaDiagnostic(result);
    expect(detail.issues).toEqual(expect.arrayContaining([
      { path: ["version"], code: "invalid_literal", expected: "literal" },
      { path: ["objective"], code: "too_big" },
      { path: ["requirements", 0, "priority"], code: "invalid_enum_value", expected: "enum" },
      { path: ["measurement_plan"], code: "unrecognized_keys" },
    ]));
    for (const value of ["HOST_SECRET_9127", "PRIVATE_VALUE_9127", "example.invalid", f.workspace, f.root]) {
      expect(result.reason).not.toContain(value);
    }
    for (const issue of detail.issues) expect(Object.keys(issue).every(key => ["path", "code", "expected"].includes(key))).toBe(true);
  });

  it("preserves v1 diagnostic categories for real v4 format and discriminator failures", async () => {
    const f = fixture(), secret = "PRIVATE_INVALID_SCHEMA_VALUE_467";
    const malformed = { ...f.research,
      sources: [{ ...f.research.sources[0]!, retrieved_at: secret }],
      measurement_plan: { ...f.research.measurement_plan!,
        entries: f.research.measurement_plan!.entries.map((entry, index) => index ? entry : { ...entry, needs: [{ kind: secret }] }),
      },
    };
    const parsed = ProductResearchReportSchema.safeParse(malformed);
    if (parsed.success) throw new Error("Expected invalid controlled research");
    expect(parsed.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "invalid_format", path: ["sources", 0, "retrieved_at"] }),
      expect.objectContaining({ code: "invalid_union", discriminator: "kind" }),
    ]));
    write(f.researchPath, JSON.stringify(malformed));
    const result = await execute(f, "final"), detail = schemaDiagnostic(result);
    expect(detail.issues).toEqual(expect.arrayContaining([
      { path: ["sources", 0, "retrieved_at"], code: "invalid_string" },
      { path: ["measurement_plan", "entries", 0, "needs", 0, "kind"], code: "invalid_union_discriminator", expected: "enum" },
    ]));
    expect(result.reason).not.toContain(secret);
    expect(result.checks).toEqual([]); expect(runOwnedGit).not.toHaveBeenCalled();
  });

  it("bounds and sanitizes unexpected future issue paths and types without serializing custom messages", async () => {
    const f = fixture(), secret = "/private/FUTURE_SCHEMA_SECRET_8128", marker = "PRIVATE_EXPECTED_8128";
    // Controlled schema-error fixture tests the projection boundary; it never supplies a successful receipt.
    const issues = [
      { code: secret, path: ["measurement_plan", secret, Symbol(secret), 10001, -1, 0.5], message: secret, received: secret },
      { code: "invalid_type", path: ["objective"], expected: marker, message: secret },
      ...Array.from({ length: 20 }, () => ({ code: "invalid_type", path: Array(12).fill("same_browser_context"), expected: "string", message: secret })),
    ];
    const parse = vi.spyOn(ProductResearchReportSchema, "safeParse").mockReturnValueOnce({ success: false,
      error: { issues } } as unknown as ReturnType<typeof ProductResearchReportSchema.safeParse>);
    try {
      const result = await execute(f, "final"), detail = schemaDiagnostic(result);
      expect(detail.issues[0]).toEqual({ path: ["measurement_plan", "<field>", "<field>", "<index>", "<index>", "<index>"], code: "custom" });
      expect(detail.issues[1]).toEqual({ path: ["objective"], code: "invalid_type" });
      expect(detail.omitted_issues).toBe(issues.length - detail.issues.length); expect(detail.omitted_issues).toBeGreaterThan(0);
      expect(detail.issues.every(issue => issue.path.length <= 8 && issue.path.every(segment => typeof segment === "number" || segment.length <= 32))).toBe(true);
      expect(detail.issues.some(issue => issue.path.at(-1) === "<truncated>")).toBe(true);
      expect(result.reason).not.toContain(secret); expect(result.reason).not.toContain(marker);
    } finally { parse.mockRestore(); }
  });

  it("drops whole issue objects when safe schema paths would exceed the reason budget", async () => {
    const f = fixture();
    const issues = Array.from({ length: 20 }, () => ({ code: "invalid_union_discriminator",
      path: Array(12).fill("same_browser_context"), message: "Controlled long schema path" }));
    const parse = vi.spyOn(ProductResearchReportSchema, "safeParse").mockReturnValueOnce({ success: false,
      error: { issues } } as unknown as ReturnType<typeof ProductResearchReportSchema.safeParse>);
    try {
      const detail = schemaDiagnostic(await execute(f, "preview"));
      expect(detail.issues.length).toBeGreaterThan(0); expect(detail.issues.length).toBeLessThan(8);
      expect(detail.omitted_issues).toBe(issues.length - detail.issues.length);
      expect(detail.issues.every(issue => issue.code === "invalid_union_discriminator" && issue.expected === "enum")).toBe(true);
    } finally { parse.mockRestore(); }
  });

  it("keeps malformed JSON separate without returning parser snippets or starting commands", async () => {
    const f = fixture(); write(f.researchPath, '{"objective":"PRIVATE_JSON_9127",');
    const result = await execute(f, "preview");
    expect(result.outcome).toBe("failed"); expect(result.reason).toBe("Verification: measurement-plan research must be valid JSON");
    expect(result.checks).toEqual([]); expect(result.measurement_plan).toBeUndefined(); expect(runOwnedGit).not.toHaveBeenCalled();
  });

  it("requires a recognized stage and the locally bound policy, while legacy profiles cannot gain a summary from research", async () => {
    const f = fixture(); delete f.context.product_development; successfulCommand(f);
    const missingStage = await execute(f, "final"); expect(missingStage.outcome).toBe("failed"); expect(missingStage.reason).toMatch(/recognized author or review/);
    expect(runOwnedGit).not.toHaveBeenCalled();
    f.context.product_development = productDevelopmentContext("research");
    f.context.verification_capabilities = structuredClone(f.context.verification_capabilities!);
    delete f.context.verification_capabilities.measurement_plan_policy;
    const injected = await execute(f, "final"); expect(injected.outcome).toBe("failed"); expect(injected.reason).toMatch(/capability context differs/);
    const legacy = fixture(false); successfulCommand(legacy);
    const result = await execute(legacy, "final"); expect(result.outcome).toBe("passed"); expect(result.measurement_plan).toBeUndefined();
  });

  it.each(["changed-source", "cancelled", "forged-stdout"])("withholds a summary after %s", async (mode) => {
    const f = fixture(), controller = new AbortController();
    successfulCommand(f, () => {
      if (mode === "changed-source") write(f.researchPath, JSON.stringify({ ...f.research, objective: "Changed behind the verifier" }));
      if (mode === "cancelled") controller.abort();
    }, mode === "forged-stdout");
    const result = await execute(f, "final", controller.signal);
    expect(result.outcome).toBe(mode === "cancelled" ? "cancelled" : "failed");
    expect(result.measurement_plan).toBeUndefined(); expect(result.checks.every(check => check.observation === undefined)).toBe(true);
  });

  it.each(["timeout", "cleanup_uncertain"] as const)("never publishes a feasibility candidate after %s", async (code) => {
    const f = fixture(); let directory = "";
    vi.mocked(runOwnedGit).mockImplementation(async (_request, options) => {
      directory = dirname(options!.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!); roots.push(directory);
      Object.defineProperty(process, "platform", platform);
      throw new OwnedGitError(code, { childStatus: null, elapsedMs: 1, cleanupConfirmed: code !== "cleanup_uncertain" } as ConstructorParameters<typeof OwnedGitError>[1], Buffer.alloc(0), Buffer.alloc(0));
    });
    if (code === "cleanup_uncertain") {
      await expect(execute(f, "final")).rejects.toBeInstanceOf(VerificationCleanupError);
      expect(existsSync(join(directory, "context.json"))).toBe(true);
    } else {
      const result = await execute(f, "final"); expect(result.outcome).toBe("timed_out"); expect(result.measurement_plan).toBeUndefined();
      expect(existsSync(directory)).toBe(false);
    }
  });

  it.each(["oversized", "hard-link", "wrong-pin"])("rejects %s research before measuring feasibility", async (mode) => {
    const f = fixture(); successfulCommand(f);
    if (mode === "oversized") write(f.researchPath, JSON.stringify(f.research).padEnd(1024 * 1024 + 1, " "));
    if (mode === "hard-link") { const target = join(f.root, "linked.json"); renameSync(f.researchPath, target); linkSync(target, f.researchPath); }
    if (mode === "wrong-pin") {
      f.context.product_development = { ...productDevelopmentContext("design"), accepted_inputs: { version: 1, files: [{
        path: ".artoo/product/research.json", checksum: sha("different accepted bytes"), size: 24,
        source_task_id: "accepted_task", source_run_id: "accepted_run", evidence_id: "accepted_evidence" }] } };
    }
    const result = await execute(f, "final"); expect(result.outcome).toBe("failed"); expect(result.measurement_plan).toBeUndefined();
    expect(runOwnedGit).not.toHaveBeenCalled();
  });
});
