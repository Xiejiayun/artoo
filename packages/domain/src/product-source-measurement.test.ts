import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeProductSourceMeasurementMappingV1, ProductSourceMeasurementMappingV1Schema } from "./product-source-measurement.js";
import { ProductResearchReportSchema } from "./product-development.js";
import { evaluateDeclaredMeasurementPlanV1, evaluateDeclaredMeasurementPlanV2 } from "./measurement-plan.js";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { canonicalReleaseJson, CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, ReleaseCapabilitiesV1Schema } from "./release-capabilities.js";

const sha256 = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(version: 1 | 2 = 2, publication = false) {
  const contract = { version: 3, kind: "static-web", claim: "configured", browser_steps_version: 3,
    legacy_browser_steps: "rejected", actions: ["navigate", "click", "assert_text"],
    viewports: [{ id: "compact", width: 390, height: 844 }], device_scale_factor: 1,
    stage_policy: { research: "no-browser", design: "declared-cases", implementation: "declared-cases", validation: "declared-cases" },
    screenshots: "each-created-page-visible-viewport", pages: { max_pages: 3, counting: "cumulative-created", same_origin: true,
      same_browser_context: true, name_reuse: "rejected", main_close: "rejected" },
    keyboard: { allowed_keys: ["Tab"], typing_max_length: 1000, focus_setup: "programmatic", focus_scope: "main-frame-dom" },
    limits: { max_cases: 50, max_steps_per_case: 100, action_timeout_ms: 5000 },
    checks: ["horizontal-overflow", "dom-control-name-heuristic"], unavailable: ["storage-exception-injection", "native-screen-reader", "browser-zoom"] };
  const policy = { version, coverage: "every-must-criterion", ...(version === 2 ? { methods: ["workspace-check", "configured-static-release"] } : {}) };
  const source = VerificationCapabilitiesSchema.parse({ version: 1, profile_digest: sha256("source profile"), measurement_plan_policy: policy,
    checks: [{ command_id: "source-browser", config_digest: sha256("C:/source/evidence"), contract_digest: sha256(canonicalReleaseJson(contract)), contract }] });
  const destination = structuredClone(source); destination.profile_digest = sha256("destination profile");
  destination.checks[0]!.command_id = "destination-browser"; destination.checks[0]!.config_digest = sha256("D:/destination/evidence");
  const release = (profile: typeof source, workspace: string) => {
    const releaseContract = { version: 1, kind: "configured-static-release", claim: "configured", execution_phase: "after-stage-acceptance",
      endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time", lifecycle: "while-configured-node-service-running",
      health_checks: [{ path: "/", expected_status: 200, body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" }],
      criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
        statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } };
    return ReleaseCapabilitiesV1Schema.parse({ version: 1, contract: releaseContract, binding: { version: 1, release_profile_id: "release",
      release_profile_digest: sha256(`release ${workspace}`), contract_digest: sha256(canonicalReleaseJson(releaseContract)), project_id: "project",
      workspace_root: workspace, verification_profile_id: "verify", verification_profile_digest: profile.profile_digest } });
  };
  const sourceRelease = publication ? release(source, "C:/source") : undefined;
  const destinationRelease = publication ? release(destination, "D:/destination") : undefined;
  const check = source.checks[0]!;
  const research: any = { version: 1, objective: "Controlled schema fixture", assumptions: [],
    requirements: [{ id: "edit", description: "Edit entries", priority: "must", acceptance_criteria: ["Normal UI saves text"] }],
    sources: [{ id: "source_fixture", url: "https://example.com/spec", title: "Schema fixture, not a retrieval receipt",
      retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha256("controlled content") }],
    findings: [{ summary: "Edit and save", source_ids: ["source_fixture"] }], decisions: [],
    measurement_plan: { version, profile_digest: source.profile_digest, entries: [{
      ...(version === 2 ? { method: "workspace-check" } : {}), command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest,
      requirement_id: "edit", criterion_index: 0, actions: ["navigate", "click", "assert_text"], keys: [], viewports: contract.viewports, needs: [],
    }] } };
  if (sourceRelease) {
    research.requirements.push({ id: "publish", description: "Publish", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] });
    research.measurement_plan.entries.push({ method: "configured-static-release", requirement_id: "publish", criterion_index: 0,
      release_binding: sourceRelease.binding, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST });
  }
  const input = { transfer: { request_digest: sha256("request"), capsule_digest: sha256("capsule"), source_subject_digest: sha256("source subject"), destination_subject_digest: sha256("destination subject") },
    researchPin: { path: ".artoo/product/research.json", checksum: "", size: 0 }, researchBytes: new Uint8Array(),
    sourceCapabilities: source, destinationCapabilities: destination,
    commandPairs: [{ source_command_id: "source-browser", destination_command_id: "destination-browser" }],
    sourceRelease, destinationRelease, sha256 };
  const encode = () => { input.researchBytes = new TextEncoder().encode(JSON.stringify(research)); input.researchPin = {
    path: ".artoo/product/research.json", checksum: sha256(input.researchBytes), size: input.researchBytes.length }; };
  encode(); return { input, research, source, destination, encode, run: () => describeProductSourceMeasurementMappingV1(input) };
}

describe("explicit transferred measurement configuration mapping", () => {
  it.each([1, 2] as const)("describes v%i equivalence while retaining original bytes and plan identity", version => {
    const f = fixture(version), bytes = f.input.researchBytes.slice(), before = JSON.stringify(f.input), result = f.run();
    expect(result.mapping.source_measurement_plan_digest).not.toBe(result.mapping.effective_measurement_plan_digest);
    expect(result.mapping).toMatchObject({ verification_passed: false, execution_authorized: false, transfer: f.input.transfer, research: f.input.researchPin });
    expect(result.mapping).not.toHaveProperty("semantic_mapping_accepted");
    expect(result.effective_plan.profile_digest).toBe(f.destination.profile_digest);
    expect(result.effective_plan.entries[0]).toMatchObject({ command_id: "destination-browser", config_digest: f.destination.checks[0]!.config_digest,
      contract_digest: f.source.checks[0]!.contract_digest, requirement_id: "edit", criterion_index: 0 });
    expect(f.input.researchBytes).toEqual(bytes); expect(JSON.stringify(f.input)).toBe(before);
    const research = ProductResearchReportSchema.parse(f.research), policy = f.destination.measurement_plan_policy!;
    expect(() => policy.version === 1 ? evaluateDeclaredMeasurementPlanV1({ research, policy, capabilities: f.destination })
      : evaluateDeclaredMeasurementPlanV2({ research, policy, capabilities: f.destination, digest: sha256 })).toThrow(/profile digest/);
  });
  it.each(["bytes", "size", "checksum", "utf8", "json", "oversized"])("rejects changed or malformed research: %s", change => {
    const f = fixture();
    if (change === "bytes") f.input.researchBytes[10] = f.input.researchBytes[10]! ^ 1;
    if (change === "size") f.input.researchPin.size++;
    if (change === "checksum") f.input.researchPin.checksum = sha256("wrong");
    if (change === "utf8" || change === "json") {
      f.input.researchBytes = change === "utf8" ? Uint8Array.of(255) : new TextEncoder().encode("{");
      f.input.researchPin.size = f.input.researchBytes.length; f.input.researchPin.checksum = sha256(f.input.researchBytes);
    }
    if (change === "oversized") f.input.researchPin.size = 1024 * 1024 + 1;
    expect(f.run).toThrow();
  });
  it.each(["policy", "contract-content", "contract-digest", "forged-equal-digests", "missing-map", "unknown-check", "duplicate-target", "unmapped-optional-check"])("rejects incompatible configurations: %s", change => {
    const f = fixture();
    if (change === "policy") f.destination.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    if (change === "contract-content") f.destination.checks[0]!.contract.viewports[0]!.width = 400;
    if (change === "contract-digest") f.destination.checks[0]!.contract_digest = sha256("different");
    if (change === "forged-equal-digests") f.source.checks[0]!.contract_digest = f.destination.checks[0]!.contract_digest = sha256("fabricated equal");
    if (change === "missing-map") f.input.commandPairs = [];
    if (change === "unknown-check") f.input.commandPairs[0]!.source_command_id = "unknown";
    if (change === "duplicate-target") f.input.commandPairs.push({ source_command_id: "other", destination_command_id: "destination-browser" });
    if (change === "unmapped-optional-check") f.source.checks.push({ ...structuredClone(f.source.checks[0]!), command_id: "optional" });
    expect(f.run).toThrow();
  });
  it.each(["source-profile", "source-config", "missing-criterion", "unsupported-action", "changed-viewport"])("still evaluates the original plan against the source: %s", change => {
    const f = fixture();
    if (change === "source-profile") f.research.measurement_plan.profile_digest = sha256("other");
    if (change === "source-config") f.research.measurement_plan.entries[0].config_digest = sha256("other");
    if (change === "missing-criterion") f.research.requirements[0].acceptance_criteria.push("Additional must criterion");
    if (change === "unsupported-action") f.research.measurement_plan.entries[0].actions.push("fill");
    if (change === "changed-viewport") f.research.measurement_plan.entries[0].viewports[0].width++;
    f.encode(); expect(f.run).toThrow();
  });
  it("maps release configuration explicitly without settling any release criterion", () => {
    const f = fixture(2, true), result = f.run();
    expect(result.mapping.release).toMatchObject({ contract_digest: f.input.sourceRelease!.binding.contract_digest });
    expect(result.effective_plan.entries[1]).toMatchObject({ release_binding: f.input.destinationRelease!.binding });
    expect(result.mapping).not.toHaveProperty("settled_criteria"); expect(result.mapping.execution_authorized).toBe(false);
    expect(f.research.measurement_plan.entries[1].release_binding.workspace_root).toBe("C:/source");
  });
  it.each(["missing-destination", "different-health", "forged-contract", "wrong-project", "wrong-profile", "wrong-source-plan"])("rejects changed release semantics: %s", change => {
    const f = fixture(2, true);
    if (change === "missing-destination") f.input.destinationRelease = undefined;
    if (change === "different-health") f.input.destinationRelease!.contract.health_checks[0]!.path = "/changed";
    if (change === "forged-contract") f.input.sourceRelease!.binding.contract_digest = f.input.destinationRelease!.binding.contract_digest = sha256("forged");
    if (change === "wrong-project") f.input.destinationRelease!.binding.project_id = "other-project";
    if (change === "wrong-profile") f.input.destinationRelease!.binding.verification_profile_digest = f.source.profile_digest;
    if (change === "wrong-source-plan") { f.research.measurement_plan.entries[1].release_binding = f.input.destinationRelease!.binding; f.encode(); }
    expect(f.run).toThrow();
  });
  it("rejects claims that mapping alone passed verification or authorized execution", () => {
    const mapping = fixture().run().mapping;
    for (const key of ["execution_authorized", "verification_passed"] as const) expect(ProductSourceMeasurementMappingV1Schema.safeParse({ ...mapping, [key]: true }).success).toBe(false);
    expect(ProductSourceMeasurementMappingV1Schema.safeParse({ ...mapping, semantic_mapping_accepted: true }).success).toBe(false);
  });
  it("returns detached values without modifying source or destination configuration", () => {
    const f = fixture(), before = JSON.stringify(f.input), result = f.run();
    result.mapping.checks[0]!.destination.config_digest = sha256("mutated"); result.effective_plan.entries[0]!.requirement_id = "mutated";
    expect(JSON.stringify(f.input)).toBe(before);
  });
});
