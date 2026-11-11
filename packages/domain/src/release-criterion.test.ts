import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunVerificationPayloadSchema, VerificationRequirementSchema } from "./autonomy.js";
import { ContextPackSchema } from "./context-pack.js";
import { GoalPlanningCapabilitySnapshotSchema } from "./planning-capabilities.js";
import { ProductDesignV1Schema, ProductDesignV2Schema, ProductResearchReportSchema, ProductResearchReportV2Schema,
  ProductValidationReportSchema, ProductValidationReportV2Schema, isWorkspaceValidationCase, productDevelopmentContext,
  validateProductDevelopmentHandoff } from "./product-development.js";
import { MeasurementPlanPolicyV2Schema, MeasurementPlanSummaryV2Schema, ProductMeasurementPlanV2Schema,
  canonicalMeasurementPlanV2, evaluateDeclaredMeasurementPlanV2 } from "./measurement-plan.js";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  ReleaseCapabilitiesV1Schema, ReleaseCapabilityContractV1Schema, canonicalReleaseAcceptanceBinding,
  canonicalReleaseCapabilityContract, canonicalReleaseCriterion, canonicalReleaseJson } from "./release-capabilities.js";
import { ProductReleaseHealthReportSchema, ProductReleaseReceiptSchema, ProductReleaseRequestSchema, ProductReleaseSchema,
  ReleaseProfileAdvertisementSchema, productReleaseRequestsEqual } from "./release.js";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { ReviewVerificationContextSchema } from "./verification-observation.js";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const profileDigest = hash("protected verifier"), contractDigest = hash("protected browser contract"), configDigest = hash("protected browser config");
const checkBinding = { command_id: "browser", config_digest: configDigest, contract_digest: contractDigest };
const policy = MeasurementPlanPolicyV2Schema.parse({ version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] });
function fixture() {
  const contract = ReleaseCapabilityContractV1Schema.parse({ version: 1, kind: "configured-static-release", claim: "configured",
    execution_phase: "after-stage-acceptance", endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time",
    lifecycle: "while-configured-node-service-running", health_checks: [{ path: "/", expected_status: 200,
      body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" }],
    criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
      statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } });
  const releaseCapabilities = ReleaseCapabilitiesV1Schema.parse({ version: 1, contract,
    binding: { version: 1, release_profile_id: "static", release_profile_digest: hash("protected publisher"),
      contract_digest: hash(canonicalReleaseCapabilityContract(contract)), project_id: "project", workspace_root: "/workspace/product",
      verification_profile_id: "acceptance", verification_profile_digest: profileDigest } });
  const capabilities = VerificationCapabilitiesSchema.parse({ version: 1, profile_digest: profileDigest, measurement_plan_policy: policy,
    checks: [{ ...checkBinding, contract: { version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3,
      actions: ["navigate", "assert_text"], viewports: [{ id: "compact", width: 390, height: 844 }],
      stage_policy: { research: "no-browser", design: "prototype-only", implementation: "declared-cases", validation: "declared-cases" },
      screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
        same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
      limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 1000 }, checks: [],
      unavailable: ["storage-exception-injection", "native-screen-reader", "browser-zoom"], legacy_browser_steps: "rejected", device_scale_factor: 1,
      keyboard: { allowed_keys: ["Tab"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
    } }] });
  const releaseEntry = { method: "configured-static-release", requirement_id: "publish", criterion_index: 0,
    release_binding: releaseCapabilities.binding, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST };
  const research = ProductResearchReportV2Schema.parse({ version: 1, objective: "Publish a working journal", assumptions: [],
    requirements: [{ id: "save", description: "Show the journal", priority: "must", acceptance_criteria: ["Journal is visible"] },
      { id: "publish", description: "Configured static publication", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
    sources: [{ id: "source", url: "https://example.com/spec", title: "Controlled contract fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: hash("source") }],
    findings: [{ summary: "Static deployment has a limited measurement scope", source_ids: ["source"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: profileDigest, entries: [
      { method: "workspace-check", requirement_id: "save", criterion_index: 0, ...checkBinding, actions: ["navigate", "assert_text"], keys: [],
        viewports: capabilities.checks[0]!.contract.viewports, needs: [] }, releaseEntry,
    ] } });
  const design = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["save", "publish"], information_architecture: ["Journal"],
    user_flows: [{ id: "read", name: "Read journal", requirement_ids: ["save"], steps: ["Open journal"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Read entries", states: ["Empty", "Ready"], accessibility: ["Named heading"], responsive: ["One column"] }],
    prototype: { entrypoint: "product/prototype.html", description: "Local prototype" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Static product", rationale: "No backend needed" }], validation_cases: [
      { id: "visible", requirement_ids: ["save"], procedure: ["Open journal"], expected_result: "Journal heading is visible", method: "workspace-check",
        requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }], browser_program: { version: 3, contract_digest: contractDigest,
          steps: [{ action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "h1", text: "Journal" }] } },
      { id: "published", requirement_ids: ["publish"], procedure: ["Protected publisher checks endpoint"], expected_result: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
        method: "configured-static-release", requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }],
        release_binding: releaseEntry.release_binding, claim_id: releaseEntry.claim_id, statement_digest: releaseEntry.statement_digest },
    ] });
  const validation = ProductValidationReportV2Schema.parse({ version: 2, known_limitations: [], cases: design.validation_cases.map(item => ({
    case_id: item.id, method: item.method, requirement_ids: item.requirement_ids, requirement_criteria: item.requirement_criteria,
    observations: item.method === "workspace-check" ? "Observed journal heading" : "Protected publication has not run",
    ...(item.method === "workspace-check" ? { outcome: "passed", evidence_paths: ["product/evidence.txt"] }
      : { release_binding: item.release_binding, claim_id: item.claim_id, statement_digest: item.statement_digest, outcome: "pending-release", evidence_paths: [] }),
  })) });
  const evaluate = () => evaluateDeclaredMeasurementPlanV2({ research, policy, capabilities, releaseCapabilities, digest: hash });
  return { research, design, validation, capabilities, releaseCapabilities, evaluate };
}
function publication() {
  const f = fixture(), evaluation = f.evaluate();
  const summary = MeasurementPlanSummaryV2Schema.parse({ version: 2, claim: "declared-mapping-feasibility", scope: "final", policy,
    research: { path: ".artoo/product/research.json", checksum: hash(JSON.stringify(f.research)), size: 1000 },
    measurement_plan_digest: hash(evaluation.canonical_plan), must_criterion_count: evaluation.must_criterion_count,
    mapped_criterion_count: evaluation.mapped_criterion_count, workspace_criterion_count: evaluation.workspace_criterion_count,
    release_criterion_count: evaluation.release_criterion_count, used_checks: evaluation.used_checks, pending_release: evaluation.pending_release });
  const request = ProductReleaseRequestSchema.parse({ version: 1, release_id: "release", goal_id: "goal", project_id: "project", run_id: "author_validation",
    release_profile_id: "static", verification_request_id: "verify", verification_profile_id: "acceptance", verification_profile_digest: profileDigest,
    subject_digest: hash("final immutable product"), acceptance_binding: { version: 1, plan: { id: "plan", version: 3 }, research: summary.research,
      measurement_plan_digest: summary.measurement_plan_digest, release_binding: f.releaseCapabilities.binding,
      criteria: evaluation.pending_release.map(({ requirement_id, criterion_index, criterion_digest, claim_id }) => ({ requirement_id, criterion_index, criterion_digest, claim_id })) } });
  const check = { path: "/", status_code: 200, body_digest: hash("index"), passed: true, checked_at: "2026-11-05T00:00:00Z" };
  const receipt = ProductReleaseReceiptSchema.parse({ request, release_profile_digest: f.releaseCapabilities.binding.release_profile_digest,
    artifact_digest: request.subject_digest, outcome: "published", endpoint: "https://product.example.com/", previous_release_id: null, health_checks: [check],
    acceptance: { version: 1, binding_digest: hash(canonicalReleaseAcceptanceBinding(request.acceptance_binding!)), scope: "node-http-point-in-time",
      settled_criteria: request.acceptance_binding!.criteria } });
  return { ...f, summary, request, receipt, check };
}

describe("explicit release measurement contracts", () => {
  it.each(["blocked", "failed"] as const)("measures a v2 %s workspace draft only in preview while publication remains pending", outcome => {
    const f = fixture(), workspace = f.validation.cases.find(item => item.method === "workspace-check")!;
    workspace.outcome = outcome;
    const before = structuredClone(f.validation);
    expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation, "preview")).toEqual([]);
    expect(f.validation).toEqual(before);
    expect(f.validation.cases.find(item => item.method === "configured-static-release")!.outcome).toBe("pending-release");
    for (const scope of [undefined, "final"] as const) {
      expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation, scope)).toEqual([`Validation case visible is ${outcome}.`]);
    }
  });
  it("preserves v2 method, criterion and release bindings during a draft preview", () => {
    const f = fixture();
    const actual = f.validation.cases.find(item => item.method === "workspace-check")!;
    actual.outcome = "blocked"; actual.requirement_criteria[0]!.criterion_index = 1;
    expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation, "preview"))
      .toContain("Validation case visible changes its accepted method or criterion coverage.");
    actual.requirement_criteria[0]!.criterion_index = 0;
    const release = f.validation.cases.find(item => item.method === "configured-static-release")!;
    release.release_binding.release_profile_id = "other";
    expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation, "preview"))
      .toContain("Validation case published changes its accepted release binding.");
    const swapped = structuredClone(f.validation);
    swapped.cases[0] = { ...release, case_id: "visible", requirement_ids: ["save"], requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }] };
    expect(validateProductDevelopmentHandoff(f.research, f.design, swapped, "preview"))
      .toContain("Validation case visible changes its accepted method or criterion coverage.");
    expect(validateProductDevelopmentHandoff(f.research, f.design, { ...f.validation, cases: [release] }, "preview"))
      .toContain("Missing validation result for visible.");
    expect(ProductValidationReportV2Schema.safeParse({ ...f.validation, cases: [{ ...actual, evidence_paths: [] }, release] }).success).toBe(false);
  });
  it("pins the exact canonical statement, hash vector and bounded point-in-time scope", () => {
    const f = fixture();
    expect(hash(CONFIGURED_STATIC_PUBLICATION_STATEMENT)).toBe(CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST);
    expect(ContextPackSchema.shape.release_capabilities.parse(f.releaseCapabilities)).toEqual(f.releaseCapabilities);
    for (const change of [{ measurement_scope: "browser-end-to-end" }, { lifecycle: "always-on" }, { argv: ["publish"] },
      { criterion: { ...f.releaseCapabilities.contract.criterion, statement: ` ${CONFIGURED_STATIC_PUBLICATION_STATEMENT}` } },
      { health_checks: [...f.releaseCapabilities.contract.health_checks, ...f.releaseCapabilities.contract.health_checks] }]) {
      expect(ReleaseCapabilityContractV1Schema.safeParse({ ...f.releaseCapabilities.contract, ...change }).success).toBe(false);
    }
    expect(canonicalReleaseJson({ b: 2, a: { y: 1, x: 0 } })).toBe(canonicalReleaseJson({ a: { x: 0, y: 1 }, b: 2 }));
    for (const path of ["//host/file", "/%2e%2e/file", "/.private", "/nested//file", "/%0a", "/file?query=1"]) {
      expect(ReleaseCapabilityContractV1Schema.safeParse({ ...f.releaseCapabilities.contract,
        health_checks: [{ ...f.releaseCapabilities.contract.health_checks[0], path }] }).success).toBe(false);
    }
  });
  it("partitions every must criterion once without claiming publication or browser success", () => {
    const f = fixture(), result = f.evaluate();
    expect(result).toMatchObject({ must_criterion_count: 2, mapped_criterion_count: 2, workspace_criterion_count: 1, release_criterion_count: 1 });
    expect(result.pending_release[0]?.criterion_digest).toBe(hash(canonicalReleaseCriterion(f.research.requirements[1]!, 0)));
    expect(result.canonical_plan).toBe(canonicalMeasurementPlanV2(f.research.measurement_plan));
    expect(result).not.toHaveProperty("passed"); expect(result).not.toHaveProperty("published");
  });
  it.each(["missing", "duplicate", "unknown", "profile", "binding", "no-capability", "prose", "whitespace", "endpoint-behavior", "workflow", "no-workspace", "downgrade"])("rejects incomplete or overstated measurement declarations: %s", change => {
    const f = fixture();
    if (change === "missing") f.research.measurement_plan.entries.pop();
    if (change === "duplicate") f.research.measurement_plan.entries.push(structuredClone(f.research.measurement_plan.entries[0]!));
    if (change === "unknown") f.research.measurement_plan.entries[1]!.requirement_id = "unknown";
    if (change === "profile") f.research.measurement_plan.profile_digest = hash("other");
    if (change === "binding") { const entry = f.research.measurement_plan.entries[1]!; if (entry.method === "configured-static-release") entry.release_binding.project_id = "other"; }
    if (change === "prose") f.research.requirements[1]!.acceptance_criteria[0] = "The deployment is successful";
    if (change === "whitespace") f.research.requirements[1]!.acceptance_criteria[0] += " ";
    if (change === "endpoint-behavior") f.research.requirements[1]!.acceptance_criteria[0] = `${CONFIGURED_STATIC_PUBLICATION_STATEMENT} Users can save data at that endpoint.`;
    if (change === "workflow") f.research.requirements[1]!.acceptance_criteria[0] = "The verifier independently tests and reviews the product";
    if (change === "no-workspace") { f.research.requirements.shift(); f.research.measurement_plan.entries.shift(); }
    if (change === "downgrade") Object.assign(f.research.measurement_plan, { version: 1 });
    if (change === "no-capability") expect(() => evaluateDeclaredMeasurementPlanV2({ ...f, policy, releaseCapabilities: undefined, digest: hash })).toThrow();
    else expect(f.evaluate).toThrow();
  });
  it("preserves v2 criterion bytes instead of trimming a stronger or altered publication statement", () => {
    const f = fixture(); f.research.requirements[1]!.acceptance_criteria[0] += " ";
    const parsed = ProductResearchReportSchema.parse(f.research);
    expect(parsed.requirements[1]!.acceptance_criteria[0]).toBe(`${CONFIGURED_STATIC_PUBLICATION_STATEMENT} `);
    expect(() => evaluateDeclaredMeasurementPlanV2({ ...f, research: parsed, policy, digest: hash })).toThrow(/exact configured/);
    expect(ProductMeasurementPlanV2Schema.safeParse({ ...f.research.measurement_plan, entries: [{ ...f.research.measurement_plan.entries[1], actions: [] }] }).success).toBe(false);
  });
  it("supports an explicit workspace-only v2 plan and does not map optional criteria", () => {
    const f = fixture(); f.research.requirements.pop(); f.research.measurement_plan.entries.pop();
    const result = evaluateDeclaredMeasurementPlanV2({ ...f, policy, releaseCapabilities: undefined, digest: hash });
    expect(result.release_criterion_count).toBe(0); expect(result.pending_release).toEqual([]);
    f.research.requirements[0]!.priority = "should";
    expect(f.evaluate).toThrow();
  });
  it("rejects inconsistent public routing, verifier and summary bindings", () => {
    const f = publication(), snapshot = { version: 1, computer_id: "computer", project_id: "project", workspace_root: "/workspace/product",
      verification_profile_id: "acceptance", capabilities: f.capabilities, release: { version: 1, capabilities: f.releaseCapabilities } };
    expect(GoalPlanningCapabilitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const change of [{ project_id: "other" }, { workspace_root: "/other" }, { verification_profile_id: "other" }, { capabilities: null }]) {
      expect(GoalPlanningCapabilitySnapshotSchema.safeParse({ ...snapshot, ...change }).success).toBe(false);
    }
    const requirement = { version: 1, request_id: "verify", profile_id: "acceptance", capability_binding: { version: 1, profile_digest: profileDigest, checks: [checkBinding] }, release_capability_binding: f.releaseCapabilities.binding };
    expect(VerificationRequirementSchema.safeParse(requirement).success).toBe(true);
    expect(VerificationRequirementSchema.safeParse({ ...requirement, capability_binding: undefined }).success).toBe(false);
    expect(ReleaseProfileAdvertisementSchema.safeParse({ profile_id: "static", project_id: "other", workspace_root: "/workspace/product",
      verification_profile_id: "acceptance", target_kind: "static_site", capabilities: f.releaseCapabilities }).success).toBe(false);
    for (const change of [{ mapped_criterion_count: 1 }, { workspace_criterion_count: 0 }, { release_criterion_count: 0 }, { pending_release: [] },
      { pending_release: [...f.summary.pending_release, ...f.summary.pending_release] }]) expect(MeasurementPlanSummaryV2Schema.safeParse({ ...f.summary, ...change }).success).toBe(false);
  });
});

describe("criterion-specific product handoffs", () => {
  it("allows multiple workspace cases per criterion and leaves the separate release case pending", () => {
    const f = fixture();
    expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation)).toEqual([]);
    f.design.validation_cases.push({ ...structuredClone(f.design.validation_cases[0]!), id: "visible_again" });
    f.validation.cases.push({ ...structuredClone(f.validation.cases[0]!), case_id: "visible_again" });
    expect(ProductDesignV2Schema.safeParse(f.design).success).toBe(true);
    expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation)).toEqual([]);
    expect(f.design.validation_cases.filter(isWorkspaceValidationCase)).toHaveLength(2);
  });
  it.each(["mixed", "browser", "storage", "binding", "unknown", "duplicate-release", "missing-criterion", "wrong-validation-refs", "wrong-validation-binding"])("rejects drift or fabricated release coverage: %s", change => {
    const f = fixture(), planned = f.design.validation_cases[1]!, actual = f.validation.cases[1]!;
    if (change === "mixed") { planned.requirement_ids.push("save"); planned.requirement_criteria.push({ requirement_id: "save", criterion_index: 0 }); }
    if (change === "browser") Object.assign(planned, { browser_program: f.design.validation_cases[0]!.browser_program });
    if (change === "storage") Object.assign(planned, { storage_checks: {} });
    if (change === "binding" && planned.method === "configured-static-release") planned.release_binding.contract_digest = hash("other");
    if (change === "unknown") planned.requirement_criteria[0]!.criterion_index = 99;
    if (change === "duplicate-release") f.design.validation_cases.push({ ...structuredClone(planned), id: "published_again" });
    if (change === "missing-criterion") f.research.requirements[0]!.acceptance_criteria.push("Another required behavior");
    if (change === "wrong-validation-refs") actual.requirement_criteria[0]!.criterion_index = 1;
    if (change === "wrong-validation-binding" && actual.method === "configured-static-release") actual.release_binding.release_profile_digest = hash("other");
    if (["mixed", "browser", "storage"].includes(change)) expect(ProductDesignV2Schema.safeParse(f.design).success).toBe(false);
    else expect(validateProductDevelopmentHandoff(f.research, f.design, f.validation).length).toBeGreaterThan(0);
  });
  it("rejects passed release claims, fabricated release files and missing workspace evidence", () => {
    const f = fixture();
    for (const change of [{ outcome: "passed" }, { evidence_paths: ["product/deployed.txt"] }]) {
      expect(ProductValidationReportSchema.safeParse({ ...f.validation, cases: [f.validation.cases[0], { ...f.validation.cases[1], ...change }] }).success).toBe(false);
    }
    expect(ProductValidationReportSchema.safeParse({ ...f.validation, cases: [{ ...f.validation.cases[0], evidence_paths: [] }, f.validation.cases[1]] }).success).toBe(false);
    const old = ProductDesignV1Schema.parse({ ...f.design, version: 1 });
    expect(validateProductDevelopmentHandoff(f.research, old)).toContain("Design version must match the accepted research measurement-plan version.");
    expect(validateProductDevelopmentHandoff(f.research, f.design, { ...f.validation, version: 1 } as never)).toContain("Validation version must match the accepted design version.");
  });
  it("instructs only opt-in workflows to use v2 and explains unresolved publication", () => {
    const f = fixture();
    for (const stage of ["research", "design", "implementation", "validation"] as const) {
      const context = productDevelopmentContext(stage, f.capabilities, f.releaseCapabilities);
      expect(context.instructions.length).toBeLessThanOrEqual(20);
      expect(context.instructions.join(" ")).toContain("pending-release");
      expect(context.instructions.join(" ")).toContain("stronger original publication conditions");
    }
    expect(productDevelopmentContext("design", f.capabilities, f.releaseCapabilities).instructions.join(" ")).not.toContain("Write design.json with version:1");
    expect(productDevelopmentContext("validation", f.capabilities, f.releaseCapabilities).instructions.join(" ")).not.toContain("Write validation.json with version:1");
    expect(productDevelopmentContext("research", f.capabilities).instructions.join(" ")).toContain("No release_capabilities is configured");
    expect(productDevelopmentContext("research").instructions.join(" ")).not.toContain("pending-release");
  });
});

describe("immutable release acceptance receipts", () => {
  it("compares complete requests by value across JSON transport and rejects nested changes", () => {
    const f = publication(), transported = JSON.parse(JSON.stringify(f.request));
    expect(productReleaseRequestsEqual(f.request, transported)).toBe(true);
    transported.acceptance_binding.plan.version++;
    expect(productReleaseRequestsEqual(f.request, transported)).toBe(false);
    expect(ProductReleaseRequestSchema.safeParse({ ...f.request, project_id: "other" }).success).toBe(false);
  });
  it.each(["missing", "empty", "extra", "criterion", "profile", "failed-settlement", "unbound-settlement"])("rejects receipts that cannot settle the exact configured release criteria: %s", change => {
    const f = publication();
    if (change === "missing") delete f.receipt.acceptance;
    if (change === "empty") f.receipt.acceptance!.settled_criteria = [];
    if (change === "extra") f.receipt.acceptance!.settled_criteria.push({ ...f.receipt.acceptance!.settled_criteria[0]!, requirement_id: "z" });
    if (change === "criterion") f.receipt.acceptance!.settled_criteria[0]!.criterion_digest = hash("other");
    if (change === "profile") f.receipt.release_profile_digest = hash("other");
    if (change === "failed-settlement") f.receipt.outcome = "failed";
    if (change === "unbound-settlement") delete f.receipt.request.acceptance_binding;
    expect(ProductReleaseReceiptSchema.safeParse(f.receipt).success).toBe(false);
  });
  it("preserves legacy receipts and permits a bound failure without claiming settlement", () => {
    const f = publication();
    expect(ProductReleaseReceiptSchema.safeParse(f.receipt).success).toBe(true);
    expect(ProductReleaseReceiptSchema.safeParse({ ...f.receipt, outcome: "failed", artifact_digest: null, endpoint: null, health_checks: [], acceptance: undefined }).success).toBe(true);
    const legacy = structuredClone(f.receipt); delete legacy.acceptance; delete legacy.request.acceptance_binding;
    expect(ProductReleaseReceiptSchema.parse(legacy)).toEqual(legacy);
  });
  it("binds subsequent health and transport copies to the complete immutable request", () => {
    const f = publication(), health = ProductReleaseHealthReportSchema.parse({ version: 1, event_id: "health", sequence: 1,
      request: JSON.parse(JSON.stringify(f.request)), release_profile_digest: f.receipt.release_profile_digest, artifact_digest: f.request.subject_digest,
      state: "healthy", active_release_id: "release", active_artifact_digest: f.request.subject_digest, consecutive_failures: 0,
      health_checks: [f.check], recovery_checks: [], checked_at: f.check.checked_at });
    const release = { id: "release", goal_id: "goal", project_id: "project", computer_id: "node", run_id: f.request.run_id, evidence_id: "evidence",
      status: "published", request: f.request, receipt: JSON.parse(JSON.stringify(f.receipt)), health, created_at: f.check.checked_at, updated_at: f.check.checked_at };
    expect(ProductReleaseSchema.safeParse(release).success).toBe(true);
    health.request.acceptance_binding!.plan.version++;
    expect(ProductReleaseSchema.safeParse(release).success).toBe(false);
    delete (release as { health?: unknown }).health;
    release.receipt.request.acceptance_binding.plan.version++;
    expect(ProductReleaseSchema.safeParse(release).success).toBe(false);
  });
  it("keeps pending criteria tied to the measured verifier in author and review receipts", () => {
    const f = publication(), observation = { version: 3, format: "static-web-acceptance.v3", scope: "final", stage: "validation", device_scale_factor: 1,
      capability_binding: { ...checkBinding, version: 1, profile_digest: profileDigest }, cases: [], evidence_bundle: { bundle_id: "bundle", manifest_digest: hash("bundle") } };
    const run = { version: 1, request_id: "verify", profile_id: "acceptance", profile_digest: profileDigest, subject_digest: f.request.subject_digest,
      outcome: "passed", checks: [{ id: "browser", exit_code: 0, duration_ms: 1, output_digest: hash("output"), observation }],
      required_files: [f.summary.research], measurement_plan: f.summary };
    const review = { version: 1, request_id: "verify", profile_id: "acceptance", profile_digest: profileDigest,
      checks: [{ id: "browser", output_digest: hash("output"), observation }], measurement_plan: f.summary };
    expect(RunVerificationPayloadSchema.safeParse(run).success).toBe(true); expect(ReviewVerificationContextSchema.safeParse(review).success).toBe(true);
    f.summary.pending_release[0]!.release_binding.verification_profile_id = "other";
    expect(RunVerificationPayloadSchema.safeParse(run).success).toBe(false); expect(ReviewVerificationContextSchema.safeParse(review).success).toBe(false);
  });
});
