// Actual profile preparation and verifier execution logic; native processes,
// original H4 admission and browser evidence are controlled test doubles. No native/browser/provider execution.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical,
  productSourceTransferRequestDigestV1, productSourceTransferRequestDigestV2, describeProductSourceMeasurementMappingV1,
  inspectProductSourceVerificationEnvelope, productSourceOperationDigestV1, importedProductReviewSubjectV1,
  importedProductReviewRequestDigestV1, transferredProductInputV1,
  inspectImportedDesignContinuationRequestV1,
  importedDesignReviewRequestDigestV1, inspectImportedDesignReviewVerificationEnvelopeV1, importedDesignReviewVerificationEchoV1,
  ProductResearchReportSchema, evaluateDeclaredMeasurementPlanV2, type RunStartPayload } from "@artoo/domain";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
import { importedAllCaseRecordFixture, controlledDesignVerification, importedCompletedDesignResultFixture,
  h4RequestForCompletedFixture } from "./test-fixtures/imported-design-review-request.js";
const control = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), privateWrite: vi.fn(), backend: Object.freeze({}),
  expected: vi.fn(), seal: vi.fn(), context: undefined as any }));
vi.mock("./product-source-runtime.js", () => ({ readImportedDesignReviewVerificationAdmission: control.read,
  readImportedExecutionReviewVerificationAdmission: control.read, readImportedExecutionRepairVerificationAdmission: control.read }));
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
import { prepareVerificationProfiles, attachWindowsVerificationBackend, runImportedDesignReviewVerification,
  runVerification, runVerificationPreview, assertFinalVerificationExportBinding,
  assertImportedFinalVerificationBinding, assertImportedDesignReviewVerificationProfile, subjectManifest } from "./verification.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
beforeEach(() => { vi.clearAllMocks(); });
function replace(value: any, from: string, to: string): any {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map(item => replace(item, from, to));
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item, from, to)])) : value;
}
function fixture(phase: "before" | "after" = "before", pinnedDesign = false) {
  const original = importedDesignRequestFixture(importedAllCaseRecordFixture()), root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-h4-verifier-")));
  const workspace = join(root, "workspace"), evidence = join(root, "evidence"), configuration = join(root, "check.json");
  mkdirSync(workspace); mkdirSync(evidence); mkdirSync(join(workspace, "product")); mkdirSync(join(workspace, ".artoo/product"), { recursive: true });
  writeFileSync(join(workspace, ".artoo/product/research.json"), original.bytes);
  // Browser planning and evidence are explicitly mocked; these bytes are still
  // measured by the actual profile and never constitute UI acceptance evidence.
  writeFileSync(join(workspace, ".artoo/product/design.json"), JSON.stringify({ controlled_handshake_fixture: true }));
  writeFileSync(join(workspace, "product/index.html"), "<title>Controlled design</title>");
  writeFileSync(configuration, JSON.stringify({ windows_browser_process: { version: 1 }, evidence_root: evidence, design_capture_cases: true,
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
  // Controlled H3 browser observations, with real source pins from the temporary workspace.
  const pinned = pinnedDesign ? controlledPinnedDesignVerification(request, original.bytes) : undefined;
  if (pinned) writeFileSync(join(workspace, ".artoo/product/design.json"), pinned.designBytes);
  const verified = pinned?.verification ?? controlledDesignVerification(request), subject = subjectManifest(profile);
  verified.subject_digest = subject.digest;
  verified.required_files = [".artoo/product/research.json", ".artoo/product/design.json"].map(path => subject.files.get(path)!);
  const h4 = h4RequestForCompletedFixture(request, importedCompletedDesignResultFixture(request, verified));
  const start = phase === "before" ? h4.before_start : h4.after_start;
  const context = start.context_pack.payload!, permit = Object.freeze({}), requestId = start.verification!.request_id;
  control.read.mockImplementation((token, selected, id, supplied, selectedPhase) => {
    if (token !== permit || selected !== profile || supplied !== context || id !== requestId || selectedPhase !== phase) throw Error("Controlled original H4 binding differs");
    return { request: h4, request_digest: importedDesignReviewRequestDigestV1(h4, sha), start, phase, readReleaseCapabilities: () => release };
  });
  control.privateWrite.mockImplementation((_backend, path, envelope) => { const bytes = Buffer.from(JSON.stringify(envelope)); writeFileSync(path, bytes, { flag: "wx" }); return sha(bytes); });
  control.command.mockImplementation(async (_input, options) => {
    const bytes = readFileSync(options.environment.ARTOO_VERIFICATION_CONTEXT_FILE), envelope = JSON.parse(bytes.toString("utf8")); control.context = envelope;
    expect(sha(bytes)).toBe(options.environment.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256);
    expect(canonical(envelope.context)).toBe(canonical(start.context_pack.payload));
    expect(envelope.subject_digest).toBe(subjectManifest(profile).digest);
    expect(envelope.product_source_design_verification).toBeUndefined(); expect(envelope.product_source_verification).toBeUndefined();
    inspectImportedDesignReviewVerificationEnvelopeV1(envelope.product_source_design_review_verification, original.bytes, sha);
    const report = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true, requirements: 2, device_scale_factor: 1,
      capability_binding: envelope.static_web_capabilities.binding, cases: [], product_source_design_review_mapping: importedDesignReviewVerificationEchoV1(envelope.product_source_design_review_verification, "destination-browser", sha) };
    return { status: 0, elapsedMs: 1, stdout: Buffer.from(JSON.stringify(report)), stderr: Buffer.alloc(0) };
  });
  control.expected.mockReturnValue({ stage: "design", requirements: 2, programs: [] });
  control.seal.mockReturnValue({ bundle_id: "controlled_bundle", manifest_digest: sha("controlled evidence"), case_refs: [] });
  return { root, workspace, profile, permit, context, requestId, phase, h4, release, bytes: original.bytes };
}
describe("actual H4 verifier logic with controlled child/native/evidence seams", () => {
  it.each(["before", "after"] as const)("writes a private %s invocation and registers only its exact original evidence", async phase => {
    const f = fixture(phase), result = await runImportedDesignReviewVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never, phase);
    expect(result).toMatchObject({ outcome: "passed", subject_digest: subjectManifest(f.profile).digest, measurement_plan: { scope: "final" } });
    expect(control.command).toHaveBeenCalledTimes(1); expect(control.read.mock.calls.length).toBeGreaterThan(4);
    expect(() => assertFinalVerificationExportBinding(f.profile, result, f.requestId, f.context)).toThrow("original completed final");
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, phase)).not.toThrow();
    expect(() => assertImportedFinalVerificationBinding(f.profile, structuredClone(result), f.permit as never, f.requestId, f.context, phase)).toThrow();
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, {} as never, f.requestId, f.context, phase)).toThrow();
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, phase === "before" ? "after" : "before")).toThrow();
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, "author")).toThrow();
    result.reason = "changed result"; expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, phase)).toThrow();
  });
  it.each(["missing", "review_id", "request_digest", "phase", "run_id", "scope", "mapping_digest", "subject_digest", "verification_request_id", "completed_design_digest", "source_export_digest", "research_provenance_digest", "command_id"])("rejects missing or substituted child echo %s", async field => {
    const f = fixture(), implementation = control.command.getMockImplementation()!;
    control.command.mockImplementationOnce(async (...args) => { const result = await implementation(...args), report = JSON.parse(result.stdout.toString());
      if (field === "missing") delete report.product_source_design_review_mapping;
      else report.product_source_design_review_mapping[field] = field.endsWith("digest") ? sha("substituted") : "substituted";
      return { ...result, stdout: Buffer.from(JSON.stringify(report)) }; });
    const result = await runImportedDesignReviewVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never, "before");
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("exact H4 source and phase") });
    expect(result.measurement_plan).toBeUndefined(); expect(result.checks.every(check => check.observation === undefined)).toBe(true); expect(control.seal).not.toHaveBeenCalled();
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, "before")).toThrow();
  });
  it("rejects ordinary and preview verifier shortcuts before any protected child invocation", async () => {
    const f = fixture(); await expect(runVerification(f.profile, f.requestId, new AbortController().signal, f.context)).rejects.toThrow("dedicated verifier admission");
    await expect(runVerificationPreview(f.profile, f.requestId, new AbortController().signal, f.context)).rejects.toThrow("dedicated verifier admission");
    expect(control.command).not.toHaveBeenCalled();
  });
  it("propagates uncertain verifier cleanup and retains the private context without evidence", async () => {
    const f = fixture(); let retained: string | undefined;
    control.command.mockImplementationOnce(async (_request, options) => {
      retained = options.environment.ARTOO_VERIFICATION_CONTEXT_FILE; throw new VerificationCleanupError("Controlled verifier closure is uncertain");
    });
    await expect(runImportedDesignReviewVerification(f.profile, f.requestId, new AbortController().signal, f.context, f.permit as never, "before")).rejects.toThrow("closure is uncertain");
    expect(retained).toBeDefined(); expect(existsSync(retained!)).toBe(true); expect(control.seal).not.toHaveBeenCalled();
  });
  it.each(["wrong-phase", "wrong-request", "cloned-context", "wrong-permit"])("rejects %s before the protected process", async change => {
    const f = fixture();
    await expect(runImportedDesignReviewVerification(f.profile, change === "wrong-request" ? "other" : f.requestId, new AbortController().signal,
      change === "cloned-context" ? structuredClone(f.context) : f.context, (change === "wrong-permit" ? {} : f.permit) as never,
      change === "wrong-phase" ? "after" : "before")).rejects.toThrow("Controlled original H4 binding");
    expect(control.command).not.toHaveBeenCalled();
  });
  it.each(["design", "research", "session", "nonzero", "cancelled", "mixed-h3", "mixed-h2"])("does not register reusable evidence after %s failure", async change => {
    const f = fixture(), implementation = control.command.getMockImplementation()!, abort = new AbortController();
    control.command.mockImplementationOnce(async (...args) => {
      const result = await implementation(...args);
      if (change === "design") writeFileSync(join(f.workspace, ".artoo/product/design.json"), "changed");
      if (change === "research") writeFileSync(join(f.workspace, ".artoo/product/research.json"), "changed");
      if (change === "session") control.read.mockImplementation(() => { throw Error("Controlled session expired"); });
      if (change === "nonzero") return { ...result, status: 1 };
      if (change === "cancelled") abort.abort();
      if (change === "mixed-h3" || change === "mixed-h2") {
        const report = JSON.parse(result.stdout.toString());
        report[change === "mixed-h3" ? "product_source_design_mapping" : "product_source_mapping"] = {};
        return { ...result, stdout: Buffer.from(JSON.stringify(report)) };
      }
      return result;
    });
    let evidence;
    try { evidence = await runImportedDesignReviewVerification(f.profile, f.requestId, abort.signal, f.context, f.permit as never, "before"); }
    catch (error) { if (change !== "session") throw error; expect(String(error)).toContain("session expired"); }
    if (evidence) {
      expect(evidence.outcome).not.toBe("passed"); expect(evidence.measurement_plan).toBeUndefined();
      expect(evidence.checks.every(check => check.observation === undefined)).toBe(true);
      expect(() => assertImportedFinalVerificationBinding(f.profile, evidence!, f.permit as never, f.requestId, f.context, "before")).toThrow();
    }
  });
  it("rejects a public copy of the verifier profile", () => {
    const f = fixture(); expect(() => assertImportedDesignReviewVerificationProfile(structuredClone(f.profile))).toThrow();
  });
  it.each(["prototype-only", "v2-browser", "no-policy-v2", "no-native-options", "no-native-backend"])("rejects a protected %s profile", change => {
    const f = fixture(), evidence = join(f.root, "evidence"), configuration = join(f.root, "different-check.json");
    writeFileSync(configuration, JSON.stringify({ evidence_root: evidence, design_capture_cases: change !== "prototype-only",
      ...(change === "no-native-options" ? {} : { windows_browser_process: { version: 1 } }),
      browser_program: { version: change === "v2-browser" ? 2 : 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }));
    const profile = prepareVerificationProfiles([{ id: "destination", project_id: "project", workspace_root: f.workspace,
      commands: [{ id: "destination-browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), configuration],
        timeout_ms: 30000, observation: { format: change === "v2-browser" ? "static-web-acceptance.v2" : "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }],
      subject_paths: ["product", ".artoo/product"], required_files: [],
      ...(["no-policy-v2", "v2-browser"].includes(change) ? {} : { measurement_plan_policy: f.profile.capabilities!.measurement_plan_policy }) }])[0]!;
    if (change !== "no-native-backend") attachWindowsVerificationBackend(profile, control.backend as never);
    expect(() => assertImportedDesignReviewVerificationProfile(profile)).toThrow(); expect(control.command).not.toHaveBeenCalled();
  });
});

import { controlledPinnedDesignVerification, h5RequestForH4Fixture, controlledCompletedImplementation } from "./test-fixtures/imported-execution-request.js";
import { h6RequestForImplementationFixture, controlledImplementationReviewResult, repairRequestForH6Fixture } from "./test-fixtures/imported-execution-review-request.js";
import { ImportedImplementationSourceV1Schema, importedDesignReviewSubjectV1, importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1,
  inspectImportedExecutionReviewVerificationEnvelopeV1, inspectImportedExecutionRepairVerificationEnvelopeV1,
  importedExecutionReviewVerificationEchoV1, importedExecutionRepairVerificationEchoV1, type ImportedDesignReviewResultV1 } from "@artoo/domain";
import { runImportedExecutionReviewVerification, runImportedExecutionRepairVerification, runImportedExecutionRepairVerificationPreview } from "./verification.js";
function implementationVerifierFixture(kind: "before" | "after" | "repair-final" | "repair-preview") {
  const f = fixture("before", true), h4 = f.h4, design = h4.continuation_result.outcome === "finished" ? h4.continuation_result.verified_design : undefined;
  if (!design) throw Error("Controlled pinned design required");
  const measured = (start: RunStartPayload) => ({ run_id: start.run_id, config_digest: hash(start),
    closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-design-cases" as const,
    verification: { ...structuredClone(design.verification), request_id: start.verification!.request_id } });
  const subject = importedDesignReviewSubjectV1(h4, sha);
  const accepted: ImportedDesignReviewResultV1 = { version: 1, review_id: h4.review_id, request_digest: importedDesignReviewRequestDigestV1(h4, sha),
    execution_authorized: false, outcome: "reviewed", closed: true, before: measured(h4.before_start), after: measured(h4.after_start),
    reviewer: { run_id: h4.review_start.run_id, config_digest: hash(h4.review_start), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: h4.review_id, continuation_id: h4.continuation_request.continuation_id,
      completed_design_digest: subject.completed_design_digest, subject_digest: subject.subject_digest, outcome: "accepted",
      summary: "Controlled H4 verdict for verifier transport test", findings: [] } };
  const execution = h5RequestForH4Fixture(h4, accepted), completed = controlledCompletedImplementation(execution);
  writeFileSync(join(f.workspace, ".artoo/product/implementation.md"), "Controlled implementation");
  const actual = subjectManifest(f.profile);
  completed.subject_digest = actual.digest; completed.verification.subject_digest = actual.digest;
  completed.verification.required_files = [".artoo/product/research.json", ".artoo/product/design.json", ".artoo/product/implementation.md"].map(path => actual.files.get(path)!);
  const original = { version: 1, execution_id: execution.execution_id, request_digest: completed.request_digest, run_id: execution.run_start.run_id,
    outcome: "finished", closed: true, verified_execution: completed };
  const source = ImportedImplementationSourceV1Schema.parse({ version: 1, kind: "execution", operation_id: execution.execution_id,
    request_digest: completed.request_digest, result_digest: hash(original), author: execution.writer, run_start: execution.run_start,
    subject_digest: actual.digest, verification: completed.verification });
  const request = h6RequestForImplementationFixture(execution, source), repair = repairRequestForH6Fixture(request, controlledImplementationReviewResult(request));
  const isReview = kind === "before" || kind === "after", phase = kind === "before" ? "before" : "after";
  const start = isReview ? (phase === "before" ? request.before_start : request.after_start) : repair.run_start;
  const context = start.context_pack.payload, requestId = kind === "repair-preview" ? "controlled-repair-preview" : start.verification.request_id, permit = {};
  control.read.mockImplementation((token, selected, id, supplied, scope) => {
    if (token !== permit || selected !== f.profile || supplied !== context || id !== requestId
      || scope !== (isReview ? phase : kind === "repair-preview" ? "preview" : "final")) throw Error("Controlled original implementation binding differs");
    return { request: isReview ? request : repair,
      request_digest: isReview ? importedExecutionReviewRequestDigestV1(request, sha) : importedExecutionRepairRequestDigestV1(repair, sha),
      start, phase, readReleaseCapabilities: () => f.release };
  });
  const field = isReview ? "product_source_execution_review_mapping" : "product_source_execution_repair_mapping";
  control.command.mockImplementation(async (_input, options) => {
    const bytes = readFileSync(options.environment.ARTOO_VERIFICATION_CONTEXT_FILE), envelope = JSON.parse(bytes.toString("utf8")); control.context = envelope;
    expect(sha(bytes)).toBe(options.environment.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256);
    expect(canonical(envelope.context)).toBe(canonical(context));
    expect(envelope.product_source_execution_verification).toBeUndefined(); expect(envelope.product_source_design_review_verification).toBeUndefined();
    const privateEnvelope = isReview ? envelope.product_source_execution_review_verification : envelope.product_source_execution_repair_verification;
    const designBytes = readFileSync(join(f.workspace, ".artoo/product/design.json"));
    if (isReview) inspectImportedExecutionReviewVerificationEnvelopeV1(privateEnvelope, f.bytes, designBytes, sha);
    else inspectImportedExecutionRepairVerificationEnvelopeV1(privateEnvelope, f.bytes, designBytes, sha);
    const echo = isReview ? importedExecutionReviewVerificationEchoV1(privateEnvelope, "destination-browser", sha)
      : importedExecutionRepairVerificationEchoV1(privateEnvelope, "destination-browser", sha);
    return { status: 0, elapsedMs: 1, stdout: Buffer.from(JSON.stringify({ version: 3, format: "static-web-acceptance.v3",
      stage: "implementation", passed: true, requirements: 2, device_scale_factor: 1,
      capability_binding: envelope.static_web_capabilities.binding, cases: [], [field]: echo })), stderr: Buffer.alloc(0) };
  });
  control.expected.mockReturnValue({ stage: "implementation", requirements: 2, programs: [] });
  const signal = new AbortController().signal;
  const run = () => isReview ? runImportedExecutionReviewVerification(f.profile, requestId, signal, context, permit as never, phase)
    : kind === "repair-preview" ? runImportedExecutionRepairVerificationPreview(f.profile, requestId, signal, context, permit as never).then(result => result.verification)
      : runImportedExecutionRepairVerification(f.profile, requestId, signal, context, permit as never);
  return { ...f, context, requestId, permit, run, field, boundPhase: isReview
    ? phase === "before" ? "implementation-review-before" as const : "implementation-review-after" as const : "implementation-repair" as const };
}
describe("actual H6/repair verifier with controlled native command, plan and evidence seams", () => {
  it.each(["before", "after", "repair-final", "repair-preview"] as const)("binds the private %s invocation and only final object evidence", async kind => {
    const f = implementationVerifierFixture(kind), result = await f.run();
    expect(result).toMatchObject({ outcome: "passed", subject_digest: subjectManifest(f.profile).digest });
    expect(control.command).toHaveBeenCalledTimes(1); expect(control.read.mock.calls.length).toBeGreaterThan(4);
    if (kind === "repair-preview") expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, f.boundPhase)).toThrow();
    else {
      expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, f.boundPhase)).not.toThrow();
      expect(() => assertImportedFinalVerificationBinding(f.profile, structuredClone(result), f.permit as never, f.requestId, f.context, f.boundPhase)).toThrow();
      expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, "implementation")).toThrow();
    }
    await expect(runVerification(f.profile, f.requestId, new AbortController().signal, f.context)).rejects.toThrow("dedicated verifier admission");
    await expect(runVerificationPreview(f.profile, f.requestId, new AbortController().signal, f.context)).rejects.toThrow("dedicated verifier admission");
  });
  it.each(["before", "repair-final"] as const)("rejects a substituted %s echo and never seals or registers evidence", async kind => {
    const f = implementationVerifierFixture(kind), command = control.command.getMockImplementation()!;
    control.command.mockImplementationOnce(async (...args) => {
      const result = await command(...args), body = JSON.parse(result.stdout.toString("utf8"));
      body[f.field].source_digest = sha("substitution"); return { ...result, stdout: Buffer.from(JSON.stringify(body)) };
    });
    const result = await f.run(); expect(result.outcome).toBe("failed"); expect(control.seal).not.toHaveBeenCalled();
    expect(() => assertImportedFinalVerificationBinding(f.profile, result, f.permit as never, f.requestId, f.context, f.boundPhase)).toThrow();
  });
});
