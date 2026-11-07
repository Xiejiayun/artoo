// Controlled schema/mapping fixtures only; no authenticated node, process or research receipt is fabricated as evidence.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { storagePreconditionCapabilitiesV1 } from "./storage-precondition.js";
import { productDevelopmentContext } from "./product-development.js";
import { canonicalReleaseJson, CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, ReleaseCapabilitiesV1Schema } from "./release-capabilities.js";
import { canonicalProductSourceTransferValueV1 as canonical, productSourceTransferRequestDigestV1 } from "./product-source-transfer.js";
import { ProductSourceExportV2Schema, ProductSourceTransferRequestV2Schema, assertProductResearchProvenanceV1,
  assertProductResearchProvenanceV2, productSourceExportDigestV2, productSourceTransferRequestDigestV2,
  PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1 } from "./product-source-semantics.js";
import { describeProductSourceMeasurementMappingV1 } from "./product-source-measurement.js";
import { ProductSourceVerificationEnvelopeV1Schema, ProductSourceVerificationEnvelopeV2Schema,
  inspectProductSourceVerificationEnvelope, inspectProductSourceVerificationEnvelopeV1,
  inspectProductSourceVerificationEnvelopeV2 } from "./product-source-verification.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture(version: 1 | 2 = 2) {
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
  const source = VerificationCapabilitiesSchema.parse({ version: 1, profile_digest: sha("source profile"), measurement_plan_policy: policy,
    checks: [{ command_id: "source-browser", config_digest: sha("source config"), contract_digest: sha(canonicalReleaseJson(contract)), contract }] });
  const destination = structuredClone(source); destination.profile_digest = sha("destination profile");
  destination.checks[0]!.command_id = "destination-browser"; destination.checks[0]!.config_digest = sha("destination config");
  const release = (profile: typeof source, workspace: string, id: string) => {
    const releaseContract = { version: 1, kind: "configured-static-release", claim: "configured", execution_phase: "after-stage-acceptance",
      endpoint_scope: "configured-origin", measurement_scope: "node-http-point-in-time", lifecycle: "while-configured-node-service-running",
      health_checks: [{ path: "/", expected_status: 200, body: "immutable-artifact-equality", identity: "release-id-and-artifact-digest-headers" }],
      criterion: { id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement: CONFIGURED_STATIC_PUBLICATION_STATEMENT,
        statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST } };
    return ReleaseCapabilitiesV1Schema.parse({ version: 1, contract: releaseContract, binding: { version: 1,
      release_profile_id: `${id}-release`, release_profile_digest: sha(`${id} release`), contract_digest: sha(canonicalReleaseJson(releaseContract)),
      project_id: "project", workspace_root: workspace, verification_profile_id: `${id}-verify`, verification_profile_digest: profile.profile_digest } });
  };
  const sourceRelease = release(source, "C:/source", "source"), destinationRelease = release(destination, "D:/destination", "destination");
  const metadata = { id: `source_${"a".repeat(32)}`, url: "https://example.com/spec", title: "Controlled schema fixture",
    retrieved_at: "2026-11-05T00:00:00Z", content_digest: sha("controlled content") };
  const check = source.checks[0]!;
  const research: any = { version: 1, objective: "Controlled first-hop research", assumptions: [],
    requirements: [{ id: "edit", description: "Edit", priority: "must", acceptance_criteria: ["  Normal UI saves text  "] }],
    sources: [metadata], findings: [{ summary: "Controlled research metadata", source_ids: [metadata.id] }], decisions: [],
    measurement_plan: { version, profile_digest: source.profile_digest, entries: [{ ...(version === 2 ? { method: "workspace-check" } : {}),
      requirement_id: "edit", criterion_index: 0, command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest,
      actions: ["navigate", "click", "assert_text"], keys: [], viewports: contract.viewports, needs: [] }] } };
  if (version === 2) {
    research.requirements.push({ id: "publish", description: "Publish", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] });
    research.measurement_plan.entries.push({ method: "configured-static-release", requirement_id: "publish", criterion_index: 0,
      release_binding: sourceRelease.binding, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM, statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST });
  }
  let bytes = new TextEncoder().encode(JSON.stringify(research));
  const provenance: any = { version: 1, chain_depth: 0, research: { path: ".artoo/product/research.json", checksum: sha(bytes), size: bytes.length },
    sources: [{ metadata, metadata_digest: sha(canonical(metadata)), content_bytes: 18,
      // Retrieval predates the later export run; these original IDs must survive.
      origin: { node_id: "source-node", run_id: "retrieval-run", task_id: "retrieval-task", project_id: "project", goal_id: "goal", workspace_root: "C:/source" } }] };
  const byteExport: any = { version: 1, export_id: sha("export"), node_id: "source-node", run_id: "source-run", task_id: "source-task",
    project_id: "project", goal_id: "goal", plan_id: "plan", verification_request_id: "source-request", profile_id: "source-verify",
    profile_digest: source.profile_digest, subject_digest: sha("source subject"), context_digest: sha("source context"), verification_digest: sha("source verification"),
    capsule_digest: sha("capsule"), manifest_digest: sha("manifest"), capsule_bytes: 4096, author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false };
  const proof: any = { version: 2, byte_export: byteExport, stage: "research", source_capabilities: source,
    research_provenance: provenance, research_provenance_digest: sha(canonical(provenance)),
    ...(version === 2 ? { measurement_v2: { version: 1, source_release: sourceRelease } } : {}) };
  const request: any = { version: 2, kind: "product-source-transfer.v2", source_export: proof, source_export_digest: productSourceExportDigestV2(proof, sha),
    command_pairs: [{ source_command_id: "source-browser", destination_command_id: "destination-browser" }],
    ...(version === 2 ? { measurement_v2: { version: 1, destination_release: destinationRelease } } : {}),
    byte_request: { version: 1, kind: "product-source-transfer.v1", transfer_id: "transfer", organization_id: "org", project_id: "project", goal_id: "goal", plan_id: "plan",
      authorization: { actor_user_id: "user", consent_id: null, policy_version: "policy" },
      source: { node_id: "source-node", task_id: "source-task", run_id: "source-run", evidence_id: "source-evidence", verification_request_id: "source-request",
        profile_id: "source-verify", profile_digest: source.profile_digest, workspace_root: "C:/source", subject_digest: byteExport.subject_digest,
        review_id: "source-review", reviewer_run_id: "reviewer-run", reviewer_evidence_id: "reviewer-evidence",
        capsule_digest: byteExport.capsule_digest, manifest_digest: byteExport.manifest_digest, capsule_bytes: byteExport.capsule_bytes },
      destination: { node_id: "destination-node", profile_id: "destination-verify", workspace_root: "D:/destination", capabilities: destination,
        capability_digest: sha(canonical(destination)) } } };
  const repinResearch = () => {
    bytes = new TextEncoder().encode(JSON.stringify(research)); provenance.research.checksum = sha(bytes); provenance.research.size = bytes.length;
  };
  const seal = () => {
    proof.research_provenance_digest = sha(canonical(provenance)); request.source_export_digest = productSourceExportDigestV2(proof, sha);
    request.byte_request.destination.capability_digest = sha(canonical(destination));
    return productSourceTransferRequestDigestV2(request, sha);
  };
  const envelope = (): any => {
    const requestDigest = seal(), base = request.byte_request;
    const ready = { version: 1, transfer_id: base.transfer_id, request_digest: productSourceTransferRequestDigestV1(base, sha),
      capsule_digest: base.source.capsule_digest, manifest_digest: base.source.manifest_digest,
      destination: { node_id: base.destination.node_id, project_id: base.project_id, profile_id: base.destination.profile_id,
        profile_digest: destination.profile_digest, workspace_root: base.destination.workspace_root, subject_digest: sha("destination subject") },
      git_metadata_digest: sha("git metadata"), git_processes_closed: true, verification_passed: false, execution_authorized: false, semantic_mapping_accepted: false };
    const described = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: requestDigest, capsule_digest: ready.capsule_digest,
      source_subject_digest: base.source.subject_digest, destination_subject_digest: ready.destination.subject_digest }, researchPin: provenance.research,
      researchBytes: bytes, sourceCapabilities: source, destinationCapabilities: destination, commandPairs: request.command_pairs,
      ...(version === 2 ? { sourceRelease, destinationRelease } : {}), sha256: sha });
    const context = { task: { id: "destination-task", title: "Controlled research", description: "Fixed mapping", acceptance_criteria: [] },
      project: { id: "project", name: "Fixture", default_workspace: "D:/destination" }, workspace: { root: "D:/destination", file_scope: [] },
      policy: { filesystem_write_scope: ["D:/destination"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      goal_context: { version: 1, goal_id: "goal", objective: research.objective, acceptance_criteria: [], plan: { id: "plan", version: 1, rationale: "First hop", spec_ref: null } },
      product_development: productDevelopmentContext("research"), verification_capabilities: { ...destination, profile_id: "destination-verify" },
      ...(version === 2 ? { release_capabilities: destinationRelease } : {}) };
    return { version, request, request_digest: requestDigest, ready, mapping: described.mapping,
      run_start: { run_id: "destination-run", task_id: "destination-task", agent_instance_id: "destination-agent", runtime: "fixture",
        workspace: { root: "D:/destination" }, context_pack: { id: "destination-context", payload: context },
        policy_snapshot: { filesystem_write_scope: ["D:/destination"], requires_approval: [] }, artifact_rules: { paths: [] },
        verification: { version: 1, request_id: "destination-request", profile_id: "destination-verify", expected_subject_digest: ready.destination.subject_digest,
          capability_binding: { version: 1, profile_digest: destination.profile_digest,
            checks: destination.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) },
          ...(version === 2 ? { release_capability_binding: destinationRelease.binding } : {}) } } };
  };
  return { request, proof, provenance, source, destination, sourceRelease, destinationRelease, research,
    get bytes() { return bytes; }, repinResearch, seal, envelope };
}

describe("paired measurement-v2 transfer extensions", () => {
  it("preserves absent-option legacy bytes, digest and private-envelope semantics", () => {
    const f = fixture(1), raw = JSON.stringify(f.request), digest = f.seal();
    expect(JSON.stringify(f.request)).toBe(raw);
    expect(productSourceExportDigestV2(f.proof, sha)).toBe(sha(canonical(f.proof)));
    expect(digest).toBe(sha(canonical(f.request)));
    expect(ProductSourceExportV2Schema.parse(f.proof)).not.toHaveProperty("measurement_v2");
    expect(ProductSourceTransferRequestV2Schema.parse(f.request)).not.toHaveProperty("measurement_v2");
    const envelope = f.envelope();
    expect(inspectProductSourceVerificationEnvelope(envelope, f.bytes, sha)).toEqual(inspectProductSourceVerificationEnvelopeV1(envelope, f.bytes, sha));
    expect(ProductSourceVerificationEnvelopeV2Schema.safeParse({ ...envelope, version: 2 }).success).toBe(false);
  });
  it("retains both complete release objects and each side's different workspace/profile", () => {
    const f = fixture(), parsed = ProductSourceTransferRequestV2Schema.parse(f.request);
    expect(parsed.measurement_v2?.destination_release).toEqual(f.destinationRelease);
    expect(parsed.source_export.measurement_v2?.source_release).toEqual(f.sourceRelease);
    expect(f.sourceRelease.binding.workspace_root).not.toBe(f.destinationRelease.binding.workspace_root);
    expect(f.sourceRelease.binding.verification_profile_id).not.toBe(f.destinationRelease.binding.verification_profile_id);
    expect(PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1).toBe("product-source-transfer.measurement-v2.v1");
    expect(f.seal()).not.toBe(productSourceTransferRequestDigestV1(f.request.byte_request, sha));
  });
  it.each(["missing-source", "missing-destination", "source-version", "destination-version", "unknown-field", "source-policy", "destination-policy"])("rejects incomplete/mixed extensions: %s", change => {
    const f = fixture();
    if (change === "missing-source") delete f.proof.measurement_v2;
    if (change === "missing-destination") delete f.request.measurement_v2;
    if (change === "source-version") f.proof.measurement_v2.version = 2;
    if (change === "destination-version") f.request.measurement_v2.version = 2;
    if (change === "unknown-field") f.request.measurement_v2.argv = ["untrusted"];
    if (change === "source-policy") f.source.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    if (change === "destination-policy") f.destination.measurement_plan_policy = { version: 1, coverage: "every-must-criterion" };
    expect(() => ProductSourceTransferRequestV2Schema.parse(f.request)).toThrow();
  });
  it("reports absent policies as schema failures without throwing from safeParse", () => {
    for (const side of ["source", "destination"] as const) {
      const f = fixture(); delete f[side].measurement_plan_policy;
      expect(ProductSourceTransferRequestV2Schema.safeParse(f.request).success).toBe(false);
    }
  });
  it.each(["source", "destination"] as const)("rejects each %s release scope mismatch before mapping", side => {
    for (const field of ["project_id", "workspace_root", "verification_profile_id", "verification_profile_digest"] as const) {
      const f = fixture(), binding = side === "source" ? f.sourceRelease.binding : f.destinationRelease.binding;
      binding[field] = field.endsWith("digest") ? sha("foreign") : "foreign";
      expect(() => ProductSourceTransferRequestV2Schema.parse(f.request), field).toThrow();
    }
  });
  it.each(["source", "destination"] as const)("includes complete %s release identity in the full immutable digest", side => {
    for (const field of ["release_profile_id", "release_profile_digest"] as const) {
      const f = fixture(), before = f.seal(), sourceDigest = f.request.source_export_digest;
      const binding = side === "source" ? f.sourceRelease.binding : f.destinationRelease.binding;
      binding[field] = field.endsWith("digest") ? sha("new release") : "new-release";
      expect(f.seal()).not.toBe(before);
      if (side === "source") expect(f.request.source_export_digest).not.toBe(sourceDigest);
    }
  });
  it("rejects unequal release contracts, forged equal digests and stripped source digest bindings", () => {
    const different = fixture(); different.destinationRelease.contract.health_checks[0]!.path = "/different";
    expect(() => ProductSourceTransferRequestV2Schema.parse(different.request)).toThrow();
    const forged = fixture(); forged.sourceRelease.binding.contract_digest = forged.destinationRelease.binding.contract_digest = sha("forged");
    expect(forged.seal).toThrow(/contract digest/);
    const stripped = fixture(); stripped.sourceRelease.binding.release_profile_id = "changed";
    expect(() => productSourceTransferRequestDigestV2(stripped.request, sha)).toThrow(/export/);
  });
  it("preserves original retrieval attribution and exact v2 report criteria without rewriting bytes", () => {
    const f = fixture(), before = f.bytes.slice(), parsed = assertProductResearchProvenanceV2(f.provenance, f.bytes, sha);
    expect(parsed.requirements[0]!.acceptance_criteria[0]).toBe("  Normal UI saves text  ");
    expect(f.provenance.sources[0].origin.run_id).toBe("retrieval-run");
    expect(f.provenance.sources[0].origin.task_id).toBe("retrieval-task");
    expect(f.bytes).toEqual(before);
    expect(() => assertProductResearchProvenanceV1(f.provenance, f.bytes, sha)).toThrow();
    const legacy = fixture(1); expect(() => assertProductResearchProvenanceV2(legacy.provenance, legacy.bytes, sha)).toThrow();
  });
  it.each(["bytes", "size", "checksum", "metadata-digest", "metadata-set", "chain-depth", "utf8"])("rejects invalid v2 provenance: %s", change => {
    const f = fixture(); let bytes = f.bytes;
    if (change === "bytes") { bytes = bytes.slice(); bytes[0] = 0; }
    if (change === "size") f.provenance.research.size++;
    if (change === "checksum") f.provenance.research.checksum = sha("wrong");
    if (change === "metadata-digest") f.provenance.sources[0].metadata_digest = sha("wrong");
    if (change === "metadata-set") f.provenance.sources[0].metadata = { ...f.provenance.sources[0].metadata, id: `source_${"b".repeat(32)}` };
    if (change === "chain-depth") f.provenance.chain_depth = 1;
    if (change === "utf8") { bytes = Uint8Array.of(255); f.provenance.research.size = bytes.length; f.provenance.research.checksum = sha(bytes); }
    expect(() => assertProductResearchProvenanceV2(f.provenance, bytes, sha)).toThrow();
  });
});

describe("private measurement-v2 first-hop verification envelope", () => {
  it("recomputes destination mapping and pending release configuration without granting authority", () => {
    const f = fixture(), envelope = f.envelope(), bytes = f.bytes.slice(), before = JSON.stringify(envelope);
    const inspected = inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha);
    expect(inspectProductSourceVerificationEnvelope(envelope, f.bytes, sha)).toEqual(inspected);
    expect(inspected.admission_digest).toBe(sha(canonical(inspected.envelope)));
    expect(inspected.effective_plan.version).toBe(2); expect(inspected.effective_plan.profile_digest).toBe(f.destination.profile_digest);
    expect(inspected.effective_plan.entries[1]).toMatchObject({ release_binding: f.destinationRelease.binding });
    expect(f.research.measurement_plan.entries[1].release_binding).toEqual(f.sourceRelease.binding);
    expect(inspected.mapping).toMatchObject({ verification_passed: false, execution_authorized: false });
    expect(inspected.mapping).not.toHaveProperty("settled_criteria"); expect(inspected).not.toHaveProperty("automatic_review_authorized");
    expect(inspected.envelope.request.source_export.research_provenance.sources[0]!.origin.run_id).toBe("retrieval-run");
    expect(f.bytes).toEqual(bytes); expect(JSON.stringify(envelope)).toBe(before);
    expect(ProductSourceVerificationEnvelopeV1Schema.safeParse({ ...envelope, version: 1 }).success).toBe(false);
    expect(() => inspectProductSourceVerificationEnvelopeV1({ ...envelope, version: 1 }, f.bytes, sha)).toThrow();
  });
  it.each(["context-release-missing", "context-release-source", "context-release-contract", "start-release-missing", "start-release-source",
    "request-digest", "source-digest", "byte-digest", "ready-subject", "run-workspace", "run-profile", "run-capability", "context-capability",
    "goal", "plan", "stage", "review", "mapping", "release-mapping", "authority"])("rejects a changed bound input: %s", change => {
    const f = fixture(), envelope = f.envelope(), context = envelope.run_start.context_pack.payload;
    if (change === "context-release-missing") delete context.release_capabilities;
    if (change === "context-release-source") context.release_capabilities = f.sourceRelease;
    if (change === "context-release-contract") context.release_capabilities = { ...f.destinationRelease, contract: { ...f.destinationRelease.contract,
      health_checks: [{ ...f.destinationRelease.contract.health_checks[0]!, path: "/changed" }] } };
    if (change === "start-release-missing") delete envelope.run_start.verification.release_capability_binding;
    if (change === "start-release-source") envelope.run_start.verification.release_capability_binding = f.sourceRelease.binding;
    if (change === "request-digest") envelope.request_digest = sha("other");
    if (change === "source-digest") envelope.request.source_export_digest = sha("other");
    if (change === "byte-digest") envelope.ready.request_digest = sha("other");
    if (change === "ready-subject") envelope.ready.destination.subject_digest = sha("other");
    if (change === "run-workspace") envelope.run_start.workspace.root = "E:/other";
    if (change === "run-profile") envelope.run_start.verification.profile_id = "other";
    if (change === "run-capability") envelope.run_start.verification.capability_binding.checks[0].config_digest = sha("other");
    if (change === "context-capability") context.verification_capabilities = { ...context.verification_capabilities, profile_digest: sha("other") };
    if (change === "goal") context.goal_context.goal_id = "other";
    if (change === "plan") context.goal_context.plan.id = "other";
    if (change === "stage") context.product_development.stage = "design";
    if (change === "review") context.review_subject = { version: 1, task_id: "review", run_id: "review-run", evidence_id: "review-evidence", subject_digest: sha("review") };
    if (change === "mapping") envelope.mapping.effective_measurement_plan_digest = sha("other");
    if (change === "release-mapping") delete envelope.mapping.release;
    if (change === "authority") envelope.mapping.execution_authorized = true;
    expect(() => inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha)).toThrow();
  });
  it("rejects incomplete command mapping and changed full browser contracts even with recomputed request digests", () => {
    const f = fixture(), envelope = f.envelope();
    f.source.checks.push({ ...structuredClone(f.source.checks[0]!), command_id: "optional-check" });
    envelope.request_digest = f.seal(); envelope.ready.request_digest = productSourceTransferRequestDigestV1(f.request.byte_request, sha);
    expect(() => inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha)).toThrow(/complete check mapping/);
    const changed = fixture(), next = changed.envelope(); changed.destination.checks[0]!.contract.viewports[0]!.width = 400;
    changed.destination.checks[0]!.contract_digest = sha(canonicalReleaseJson(changed.destination.checks[0]!.contract));
    next.request_digest = changed.seal(); next.ready.request_digest = productSourceTransferRequestDigestV1(changed.request.byte_request, sha);
    next.run_start.verification.capability_binding.checks[0].contract_digest = changed.destination.checks[0]!.contract_digest;
    expect(() => inspectProductSourceVerificationEnvelopeV2(next, changed.bytes, sha)).toThrow(/contracts differ/);
  });
  it("rejects rewriting the source report to the destination before admission", () => {
    const f = fixture(), envelope = f.envelope();
    f.research.measurement_plan.profile_digest = f.destination.profile_digest; f.repinResearch();
    envelope.request_digest = f.seal();
    expect(() => inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha)).toThrow(/profile digest/);
  });
});

// Concrete current-domain factory, with controlled digest inputs; no native execution is claimed.
function storagePreconditionTransferFixture() {
  const f = fixture();
  const initializer = sha("controlled storage precondition initializer");
  for (const capabilities of [f.source, f.destination]) {
    const check = capabilities.checks[0]!;
    if (check.contract.version !== 3) throw new Error("Expected v3 fixture contract");
    check.contract.storage_precondition = storagePreconditionCapabilitiesV1(initializer);
    check.contract_digest = sha(canonicalReleaseJson(check.contract));
  }
  f.research.requirements[0].acceptance_criteria = ["Malformed local storage shows recovery UI while preserving the seeded data"];
  const entry = f.research.measurement_plan.entries[0];
  entry.contract_digest = f.source.checks[0]!.contract_digest;
  entry.needs = [{ kind: "storage-precondition", version: 1, input: "raw-local-document",
    phase: "before-first-product-script", page_scope: "main-seed-same-origin-pages", preservation: "seeded-sampled-equal" }];
  f.repinResearch();
  return f;
}

describe("policy-v2 transfer with current storage precondition capability", () => {
  it("preserves the same concrete capability, original criteria and pending release mapping", () => {
    const f = storagePreconditionTransferFixture(), original = f.bytes.slice(), envelope = f.envelope();
    const inspected = inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha);
    expect(inspected.effective_plan.entries[0]).toMatchObject({ needs: f.research.measurement_plan.entries[0].needs,
      contract_digest: f.destination.checks[0]!.contract_digest });
    expect(inspected.mapping.checks[0]!.source.contract_digest).toBe(inspected.mapping.checks[0]!.destination.contract_digest);
    expect(inspected.mapping.research).toEqual(f.provenance.research);
    expect(inspected.mapping).toMatchObject({ verification_passed: false, execution_authorized: false });
    expect(inspected.mapping.release).toBeDefined();
    expect(inspected.effective_plan.entries[1]).toMatchObject({ method: "configured-static-release", release_binding: f.destinationRelease.binding });
    expect(f.bytes).toEqual(original);
    expect(assertProductResearchProvenanceV2(f.provenance, f.bytes, sha).requirements[0]!.acceptance_criteria)
      .toEqual(f.research.requirements[0].acceptance_criteria);
  });

  it.each(["missing", "changed"] as const)("rejects a %s destination precondition despite recomputed public digests", change => {
    const f = storagePreconditionTransferFixture(), original = f.bytes.slice(), envelope = f.envelope();
    const check = f.destination.checks[0]!;
    if (check.contract.version !== 3) throw new Error("Expected v3 fixture contract");
    if (change === "missing") delete check.contract.storage_precondition;
    else check.contract.storage_precondition = storagePreconditionCapabilitiesV1(sha("different controlled initializer"));
    check.contract_digest = sha(canonicalReleaseJson(check.contract));
    envelope.request_digest = f.seal();
    envelope.ready.request_digest = productSourceTransferRequestDigestV1(f.request.byte_request, sha);
    envelope.run_start.verification.capability_binding.checks[0].contract_digest = check.contract_digest;
    expect(() => inspectProductSourceVerificationEnvelopeV2(envelope, f.bytes, sha)).toThrow(/contracts differ/);
    expect(f.bytes).toEqual(original);
  });
});
