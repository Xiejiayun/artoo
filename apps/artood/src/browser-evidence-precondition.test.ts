import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ProductBrowserProgramV3Schema, storagePreconditionReportFromTraceV1, type BrowserOperationTraceV3,
  type ProductStoragePreconditionBindingV1, type StaticWebAcceptanceReportV3, type StoragePreconditionTraceV1 } from "@artoo/domain";
import { browserCaptureV3Filename, browserTraceV3Filename, readBrowserEvidence, sealBrowserEvidence,
  type ExpectedBrowserProgramV3 } from "./browser-evidence.js";
import { deriveStoragePreconditionExpectation } from "./web-acceptance-precondition.js";
import { canonicalWebAcceptance as canonical } from "./web-acceptance-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Controlled PNG and trace fixtures exercise sealing, not native browser execution or product behavior. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4); header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-precondition-evidence-"))); roots.push(root);
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
  const binding = { requestId: "seed_fixture", profileId: "profile", profileDigest: sha("profile"), subjectDigest: sha("subject"),
    checkId: "seed", scope: "preview" as const };
  const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
  const viewport = { id: "compact", width: 320, height: 240 }, image = png(viewport.width, viewport.height);
  const program = ProductBrowserProgramV3Schema.parse({ version: 3, contract_digest: sha("contract"), steps: [
    { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#error", text: "Invalid" },
    { action: "click", page: "main", selector: "#cancel" }, { action: "assert_text", page: "main", selector: "#error", text: "Invalid" },
    { action: "reload", page: "main" }, { action: "assert_value", page: "main", selector: "#draft", value: "Retained" },
  ] });
  const criterion = { requirement_id: "malformed", criterion_index: 0 };
  const input: ProductStoragePreconditionBindingV1 = { source: { path: ".artoo/product/design.json", checksum: sha("fixed design"), size: 1024, case_id: "malformed" },
    precondition: { version: 1, local_storage: { key: "journal", value: "{" }, requirement_criteria: [criterion], ui_assertion_steps: [1, 3, 5],
      preservation_checks: [{ after_step: 3, requirement_criteria: [criterion], ui_assertion_steps: [3] },
        { after_step: 5, requirement_criteria: [criterion], ui_assertion_steps: [5] }] } };
  const plannedSeed = deriveStoragePreconditionExpectation(input, program);
  const { installation_script_digest, ...controlledFacts } = structuredClone(plannedSeed);
  const actual: StoragePreconditionTraceV1 = { ...controlledFacts, origin: "http://127.0.0.1:4174",
    installation: { script_digest: installation_script_digest, confirmed: true }, sequence: ["empty-baseline", "native-seed-readback", "resumed"] };
  const trace: BrowserOperationTraceV3 = { version: 3, format: "static-web-trace.v3", case_id: input.source.case_id, viewport, device_scale_factor: 1,
    program_digest: sha(canonical(program)), operations: program.steps.map((step, index) => ({ index, page_id: step.page,
      planned_step_digest: sha(canonical(step)), action: step.action,
      observation: step.action === "navigate" || step.action === "reload" ? { kind: "navigation", status_code: 200 }
        : step.action === "click" ? { kind: "action-completed" } : { kind: "assertion", passed: true } })) as BrowserOperationTraceV3["operations"],
    captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha(image) }], storage_precondition: actual };
  const expected: ExpectedBrowserProgramV3 = { case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest,
    steps: trace.operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
      expected_observation: structuredClone(observation.kind === "navigation" ? { kind: "navigation" } : observation) })),
    captures: [{ page_id: "main", timing: { kind: "case-end" } }], storage_precondition: plannedSeed };
  const report: StaticWebAcceptanceReportV3 = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true,
    requirements: 1, device_scale_factor: 1, capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest,
      config_digest: sha("config"), contract_digest: sha("contract") }, cases: [{ case_id: trace.case_id, viewport: { ...viewport },
      program_digest: trace.program_digest, operation_count: trace.operations.length, assertions: 3, trace_digest: sha("pending"), trace_size: 1,
      captures: structuredClone(trace.captures), storage_precondition: storagePreconditionReportFromTraceV1(actual) }] };
  const tracePath = join(directory, browserTraceV3Filename(trace.case_id, viewport.id)), reportPath = join(directory, "result.json");
  const persistReport = () => writeFileSync(reportPath, JSON.stringify(report));
  const persistTrace = (projectReport = true) => {
    const bytes = Buffer.from(JSON.stringify(trace)), item = report.cases[0]!;
    item.trace_digest = sha(bytes); item.trace_size = bytes.length;
    if (projectReport) {
      if (trace.storage_precondition) item.storage_precondition = storagePreconditionReportFromTraceV1(trace.storage_precondition);
      else delete item.storage_precondition;
    }
    writeFileSync(tracePath, bytes); persistReport();
  };
  writeFileSync(join(directory, browserCaptureV3Filename(trace.case_id, viewport.id, "main")), image); persistTrace();
  return { input, program, trace, expected, report, evidenceRoot, binding, directory, tracePath, reportPath, persistReport, persistTrace,
    seal: () => sealBrowserEvidence({ ...binding, evidenceRoot, report, expectedPrograms: [expected] }) };
}

describe("optional native storage precondition evidence sealing", () => {
  it("seals seed-only trace/report native observations and preserves bounded evidence grants", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!;
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const full = readBrowserEvidence(grant, refs.trace_ref); if (full.mime_type !== "application/json") throw new Error("Expected JSON trace");
    expect(full.text).toBe(readFileSync(f.tracePath, "utf8")); expect(JSON.parse(full.text).storage_precondition.seed_apply_count).toBe(1);
    expect(full.text).not.toContain('"local_storage"'); expect(full.text).not.toContain('"journal"');
    expect(readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref).mime_type).toBe("image/png");
    for (const change of [{ requestId: "other" }, { profileDigest: sha("other") }, { subjectDigest: sha("other") },
      { checkId: "other" }, { scope: "final" as const }]) expect(() => readBrowserEvidence({ ...grant, ...change }, refs.trace_ref)).toThrow();
  });

  it("leaves old trace and report bytes untouched when the extension is absent", () => {
    const f = fixture(); delete f.trace.storage_precondition; delete f.expected.storage_precondition; f.persistTrace();
    const beforeTrace = readFileSync(f.tracePath), beforeReport = readFileSync(f.reportPath), bundle = f.seal();
    const actual = readBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id,
      manifest_digest: bundle.manifest_digest }, bundle.case_refs[0]!.trace_ref);
    if (actual.mime_type !== "application/json") throw new Error("Expected JSON trace");
    expect(actual.text).toBe(beforeTrace.toString("utf8")); expect(actual.text).not.toContain("storage_precondition");
    expect(readFileSync(f.reportPath)).toEqual(beforeReport);
  });

  it.each(["unplanned", "missing-actual", "missing-trace", "missing-report"])("rejects %s native sidecar even without storage-fault", mode => {
    const f = fixture();
    if (mode === "unplanned") delete f.expected.storage_precondition;
    if (mode === "missing-actual") { delete f.trace.storage_precondition; delete f.report.cases[0]!.storage_precondition; }
    if (mode === "missing-trace") delete f.trace.storage_precondition;
    if (mode === "missing-report") delete f.report.cases[0]!.storage_precondition;
    f.persistTrace(false); expect(() => f.seal()).toThrow(/storage precondition/);
    expect(existsSync(join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`))).toBe(false);
  });

  it.each(["descriptor", "source-checksum", "source-size", "initializer", "native-digest", "native-bytes", "missing-checkpoint", "checkpoint-refs"])(
    "rejects self-consistent trace/report %s substitution against independently derived source", mode => {
      const f = fixture(), actual = f.trace.storage_precondition!;
      if (mode === "descriptor") actual.descriptor_digest = sha("different fixture");
      if (mode === "source-checksum") actual.source.checksum = sha("different source");
      if (mode === "source-size") actual.source.size++;
      if (mode === "initializer") actual.installation.script_digest = sha("untrusted initializer");
      if (mode === "native-digest" || mode === "native-bytes") {
        if (mode === "native-digest") actual.native_storage.seeded.digest = sha("different native bytes");
        else actual.native_storage.seeded.utf8_bytes++;
        for (const check of actual.preservation_checks) check.native_storage.snapshot = structuredClone(actual.native_storage.seeded);
      }
      if (mode === "missing-checkpoint") actual.preservation_checks.pop();
      if (mode === "checkpoint-refs") actual.preservation_checks[0]!.ui_assertion_steps = [1, 3];
      f.persistTrace(); expect(() => f.seal()).toThrow(/independently derived plan/);
    });

  it.each(["readback", "baseline", "sequence", "confirmation", "reseed", "epoch", "reordered", "duplicate", "snapshot"])(
    "does not fabricate missing or inconsistent native fact: %s", mode => {
      const f = fixture(), actual = f.trace.storage_precondition!;
      if (mode === "readback") delete (actual.native_storage as Partial<typeof actual.native_storage>).seeded;
      if (mode === "baseline") actual.native_storage.before = structuredClone(actual.native_storage.seeded);
      if (mode === "sequence") Object.assign(actual, { sequence: ["empty-baseline", "resumed"] });
      if (mode === "confirmation") Object.assign(actual.installation, { confirmed: false });
      if (mode === "reseed") Object.assign(actual, { seed_apply_count: 2 });
      if (mode === "epoch") actual.preservation_checks[1]!.document_epoch = 1;
      if (mode === "reordered") actual.preservation_checks.reverse();
      if (mode === "duplicate") actual.preservation_checks.push(structuredClone(actual.preservation_checks[0]!));
      if (mode === "snapshot") actual.preservation_checks[0]!.native_storage.snapshot.digest = sha("different");
      f.persistTrace(false); expect(() => f.seal()).toThrow();
    });

  it.each(["source", "descriptor", "origin", "checkpoint"])("requires the exact report projection for %s", mode => {
    const f = fixture(), actual = f.report.cases[0]!.storage_precondition!;
    if (mode === "source") actual.source.checksum = sha("different");
    if (mode === "descriptor") actual.descriptor_digest = sha("different");
    if (mode === "origin") actual.origin = "http://127.0.0.1:4999";
    if (mode === "checkpoint") actual.preservation_checks.pop();
    f.persistReport(); expect(() => f.seal()).toThrow(/actual trace projection/);
  });

  it("revalidates report/trace projection when a sealed trace or image is read", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!;
    const path = join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`), manifest = JSON.parse(readFileSync(path, "utf8"));
    f.report.cases[0]!.storage_precondition!.descriptor_digest = sha("substituted"); f.persistReport();
    manifest.report = f.report; manifest.report_checksum = sha(readFileSync(f.reportPath));
    const bytes = Buffer.from(JSON.stringify(manifest)); chmodSync(path, 0o600); writeFileSync(path, bytes);
    // Controlled grant checksum replacement reaches structural checks; production callers cannot install this grant.
    const digest = sha(bytes), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: `browser_${digest.slice(7)}`, manifest_digest: digest };
    expect(() => readBrowserEvidence(grant, refs.trace_ref)).toThrow(/actual trace projection/);
    expect(() => readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref)).toThrow(/actual trace projection/);
  });
});
