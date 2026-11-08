// Actual profile preparation and verifier execution logic; native processes,
// original writer admission and browser evidence are controlled test doubles.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedDesignContinuationRequestDigestV1,
  productSourceTransferRequestDigestV1, productSourceTransferRequestDigestV2, describeProductSourceMeasurementMappingV1,
  inspectProductSourceVerificationEnvelope, productSourceOperationDigestV1, importedProductReviewSubjectV1,
  importedProductReviewRequestDigestV1, transferredProductInputV1, importedDesignVerificationEchoV1,
  inspectImportedDesignContinuationRequestV1, inspectImportedDesignVerificationEnvelopeV1,
  ProductResearchReportSchema, evaluateDeclaredMeasurementPlanV2, type RunStartPayload } from "@artoo/domain";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
const control = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), privateWrite: vi.fn(), backend: Object.freeze({}),
  expected: vi.fn(), seal: vi.fn(), context: undefined as any }));
vi.mock("./product-source-runtime.js", () => ({ readImportedDesignVerificationAdmission: control.read }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn() }));
vi.mock("./windows-browser-process-authority.js", () => ({ assertWindowsBrowserProcessInstallation: vi.fn(), createWindowsBrowserProcessDescriptor: vi.fn((_backend, binding) => ({ controlled: true, binding })) }));
vi.mock("./windows-browser-private-context.js", () => ({ writeWindowsBrowserPrivateContext: control.privateWrite }));
vi.mock("./protected-command.js", async original => ({ ...await original<typeof import("./protected-command.js")>(), runProtectedCommand: control.command }));
vi.mock("./web-acceptance.js", async original => ({ ...await original<typeof import("./web-acceptance.js")>(), deriveExpectedWebAcceptanceV3: control.expected }));
vi.mock("./browser-evidence.js", async original => ({ ...await original<typeof import("./browser-evidence.js")>(), sealBrowserEvidence: control.seal }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  const resolve = (value: string) => fs.realpathSync.native(value.endsWith("dist\\web-acceptance-cli.js") || value.endsWith("dist/web-acceptance-cli.js")
    ? value.replace(/dist[\\/]web-acceptance-cli\.js$/, "src/web-acceptance-cli.ts") : value);
  return { ...fs, realpathSync: Object.assign(resolve, { native: resolve }) };
});
import { prepareVerificationProfiles, attachWindowsVerificationBackend, runTransferredDesignVerification,
  runTransferredDesignVerificationPreview, runVerification, assertFinalVerificationExportBinding, subjectManifest } from "./verification.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
beforeEach(() => { vi.clearAllMocks(); });
function replace(value: any, from: string, to: string): any {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map(item => replace(item, from, to));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, from, to)])) : value;
}
function fixture() {
  const original = importedDesignRequestFixture(), root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-design-verifier-")));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), configuration = join(root, "check.json");
  mkdirSync(workspace); mkdirSync(evidence); mkdirSync(join(workspace, "product")); mkdirSync(join(workspace, ".artoo/product"), { recursive: true });
  writeFileSync(join(workspace, ".artoo/product/research.json"), original.bytes);
  // Browser planning and evidence are explicitly mocked; these bytes are still
  // measured by the actual profile and never constitute UI acceptance evidence.
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify({ controlled_handshake_fixture: true }));
  writeFileSync(join(workspace, "product/index.html"), "<title>Controlled design</title>");
  writeFileSync(configuration, JSON.stringify({ windows_browser_process: { version: 1 }, evidence_root: evidence,
    browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }));
  const policy = original.request.review_request.operation.intent.request.byte_request.destination.capabilities.measurement_plan_policy!;
  const profile = prepareVerificationProfiles([{ id: "destination", project_id: "project", workspace_root: workspace,
    commands: [{ id: "destination-browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), configuration], timeout_ms: 30000,
      observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
    subject_paths: ["product", ".artoo/product"], required_files: [], measurement_plan_policy: policy }])[0]!;
  attachWindowsVerificationBackend(profile, control.backend as never);
  const request = replace(original.request, original.request.run_start.workspace.root, workspace) as typeof original.request;
  const review = request.review_request, operation = review.operation, transfer = operation.intent.request;
  transfer.byte_request.destination.capabilities = structuredClone(profile.capabilities!);
  transfer.byte_request.destination.capability_digest = hash(profile.capabilities!);
  transfer.measurement_v2!.destination_release.binding.verification_profile_digest = profile.digest;
  const release = transfer.measurement_v2!.destination_release;
  const setStart = (start: RunStartPayload) => {
    start.context_pack.payload!.verification_capabilities = { ...profile.capabilities!, profile_id: profile.id };
    start.context_pack.payload!.release_capabilities = release;
    start.verification!.capability_binding = { version: 1, profile_digest: profile.digest, checks: profile.capabilities!.checks.map(check => ({
      command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest })) };
    start.verification!.release_capability_binding = release.binding;
  };
  [operation.intent.destination_start, review.before_start, review.after_start, review.review_start, request.run_start].forEach(setStart);
  const requestDigest = productSourceTransferRequestDigestV2(transfer, sha), byteDigest = productSourceTransferRequestDigestV1(transfer.byte_request, sha);
  if (review.result.outcome !== "verified") throw Error("Expected fixture import");
  const ready = review.result.admission.ready; ready.request_digest = byteDigest; ready.destination.profile_digest = profile.digest;
  const mapping = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: requestDigest, capsule_digest: ready.capsule_digest,
    source_subject_digest: transfer.byte_request.source.subject_digest, destination_subject_digest: ready.destination.subject_digest },
    researchPin: transfer.source_export.research_provenance.research, researchBytes: original.bytes,
    sourceCapabilities: transfer.source_export.source_capabilities, destinationCapabilities: profile.capabilities!, commandPairs: transfer.command_pairs,
    sourceRelease: transfer.source_export.measurement_v2!.source_release, destinationRelease: release, sha256: sha }).mapping;
  const measurement = (start: RunStartPayload) => {
    const inspected = inspectProductSourceVerificationEnvelope({ version: 2, request: transfer, request_digest: requestDigest, ready, run_start: start, mapping }, original.bytes, sha);
    if (review.result.outcome !== "verified") throw Error("Expected fixture import");
    const fresh = structuredClone(review.result.fresh), verification = fresh.verification;
    Object.assign(fresh, { request_digest: requestDigest, admission_digest: inspected.admission_digest, mapping_digest: hash(mapping), destination_run_id: start.run_id });
    verification.profile_digest = profile.digest; verification.request_id = start.verification!.request_id;
    const check = profile.capabilities!.checks[0]!;
    verification.checks[0]!.observation!.capability_binding = { version: 1, profile_digest: profile.digest, command_id: check.command_id,
      config_digest: check.config_digest, contract_digest: check.contract_digest };
    const research = ProductResearchReportSchema.parse(JSON.parse(Buffer.from(original.bytes).toString("utf8")));
    const { canonical_plan, ...counts } = evaluateDeclaredMeasurementPlanV2({ research: { ...research, measurement_plan: inspected.effective_plan },
      policy: policy as any, capabilities: profile.capabilities!, releaseCapabilities: release, digest: sha });
    verification.measurement_plan = { version: 2, claim: "declared-mapping-feasibility", scope: "final", policy: policy as any,
      research: transfer.source_export.research_provenance.research, measurement_plan_digest: sha(canonical_plan), ...counts };
    return { admission: inspected.envelope, fresh };
  };
  operation.request_digest = requestDigest;
  const first = measurement(operation.intent.destination_start);
  Object.assign(review.result, { request_digest: requestDigest, payload_digest: productSourceOperationDigestV1(operation, sha), ...first });
  review.review_start.context_pack.payload!.imported_review_subject = importedProductReviewSubjectV1(review, sha);
  if (request.review_result.outcome !== "reviewed") throw Error("Expected fixture review");
  Object.assign(request.review_result, { request_digest: importedProductReviewRequestDigestV1(review, sha), before: measurement(review.before_start), after: measurement(review.after_start) });
  request.review_result.reviewer.config_digest = hash(review.review_start);
  request.run_start.context_pack.payload.transferred_product_input = transferredProductInputV1(request, sha);
  inspectImportedDesignContinuationRequestV1(request, original.bytes, sha);
  const context = request.run_start.context_pack.payload, permit = Object.freeze({}), requestId = request.run_start.verification!.request_id;
  control.read.mockImplementation((token, selected, id, supplied, scope) => {
    if (token !== permit || selected !== profile || supplied !== context || (scope === "final" ? id !== requestId : !id.startsWith("preview-"))) throw Error("Controlled original writer binding differs");
    return { request, request_digest: importedDesignContinuationRequestDigestV1(request, sha), readReleaseCapabilities: () => release };
  });
  control.privateWrite.mockImplementation((_backend, path, envelope) => { const bytes = Buffer.from(JSON.stringify(envelope)); writeFileSync(path, bytes, { flag: "wx" }); return sha(bytes); });
  control.command.mockImplementation(async (_input, options) => {
    const bytes = readFileSync(options.environment.ARTOO_VERIFICATION_CONTEXT_FILE), envelope = JSON.parse(bytes.toString("utf8")); control.context = envelope;
    expect(sha(bytes)).toBe(options.environment.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256);
    expect(canonical(envelope.context)).toBe(canonical(envelope.product_source_design_verification.request.run_start.context_pack.payload));
    expect(envelope.subject_digest).toBe(subjectManifest(profile).digest);
    inspectImportedDesignVerificationEnvelopeV1(envelope.product_source_design_verification, original.bytes, sha);
    const report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 2, device_scale_factor: 1,
      capability_binding: envelope.static_web_capabilities.binding, cases: [], product_source_design_mapping: importedDesignVerificationEchoV1(envelope.product_source_design_verification, "destination-browser", sha) };
    return { status: 0, elapsedMs: 1, stdout: Buffer.from(JSON.stringify(report)), stderr: Buffer.alloc(0) };
  });
  control.expected.mockReturnValue({ stage: "design", requirements: 2, programs: [] });
  control.seal.mockReturnValue({ bundle_id: "controlled_bundle", manifest_digest: sha("controlled evidence"), case_refs: [] });
  return { root, workspace, profile, permit, context, requestId };
}
describe("actual imported-design verifier logic with controlled child/native/evidence seams", () => {
  it("writes a private final invocation, measures changed design bytes and requires its exact child echo", async () => {
    const f = fixture(), result = await runTransferredDesignVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never);
    expect(result).toMatchObject({ outcome: "passed", subject_digest: subjectManifest(f.profile).digest, measurement_plan: { scope: "final" } });
    expect(control.command).toHaveBeenCalledTimes(1); expect(control.read.mock.calls.length).toBeGreaterThan(4);
    expect(() => assertFinalVerificationExportBinding(f.profile, result, f.requestId, f.context)).toThrow("original completed final");
  });
  it.each(["missing", "run_id", "scope", "mapping_digest", "subject_digest", "verification_request_id"])("rejects missing or substituted child echo %s", async field => {
    const f = fixture(), implementation = control.command.getMockImplementation()!;
    control.command.mockImplementationOnce(async (...args) => { const result = await implementation(...args), report = JSON.parse(result.stdout.toString());
      if (field === "missing") delete report.product_source_design_mapping;
      else report.product_source_design_mapping[field] = field.endsWith("digest") ? sha("substituted") : "substituted";
      return { ...result, stdout: Buffer.from(JSON.stringify(report)) }; });
    const result = await runTransferredDesignVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never);
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("exact imported-design mapping") });
    expect(result.measurement_plan).toBeUndefined(); expect(result.checks.every(check => check.observation === undefined)).toBe(true); expect(control.seal).not.toHaveBeenCalled();
  });
  it("keeps preview scope and request distinct from final evidence", async () => {
    const f = fixture(), result = await runTransferredDesignVerificationPreview(f.profile, "preview-controlled", new AbortController().signal, f.context, f.permit as never);
    expect(result.verification).toMatchObject({ outcome: "passed", request_id: "preview-controlled", measurement_plan: { scope: "preview" } });
    expect(control.context.product_source_design_verification.scope).toBe("preview");
  });
  it("rejects the ordinary verifier shortcut before any protected child invocation", async () => {
    const f = fixture(); await expect(runVerification(f.profile, f.requestId, new AbortController().signal, f.context)).rejects.toThrow("dedicated verifier admission");
    expect(control.command).not.toHaveBeenCalled();
  });
  it("propagates uncertain verifier cleanup and retains the private context without evidence", async () => {
    const f = fixture(); let retained: string | undefined;
    control.command.mockImplementationOnce(async (_request, options) => {
      retained = options.environment.ARTOO_VERIFICATION_CONTEXT_FILE; throw new VerificationCleanupError("Controlled verifier closure is uncertain");
    });
    await expect(runTransferredDesignVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never)).rejects.toThrow("closure is uncertain");
    expect(retained).toBeDefined(); expect(existsSync(retained!)).toBe(true); expect(control.seal).not.toHaveBeenCalled();
  });
});
