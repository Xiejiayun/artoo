import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { storageFaultReportFromTraceV1, type BrowserOperationTraceV3, type BrowserOperationV3,
  type StaticWebAcceptanceReportV3, type StorageFaultTraceWindowV1 } from "@artoo/domain";
import { browserCaptureV3Filename, browserTraceV3Filename, readBrowserEvidence, sealBrowserEvidence,
  type ExpectedBrowserProgramV3 } from "./browser-evidence.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** A valid controlled PNG; these tests exercise evidence binding, not browser rendering. */
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-storage-evidence-"))); roots.push(root);
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
  const binding = { requestId: "storage_fixture", profileId: "profile", profileDigest: sha("profile"), subjectDigest: sha("subject"),
    checkId: "storage-fault", scope: "preview" as const };
  const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
  const viewport = { id: "compact", width: 320, height: 240 }, image = png(viewport.width, viewport.height);
  const operations: BrowserOperationV3[] = [
    { index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate"), observation: { kind: "navigation", status_code: 200 } },
    { index: 1, page_id: "main", action: "assert_text", planned_step_digest: sha("load-error"), observation: { kind: "assertion", passed: true } },
    { index: 2, page_id: "main", action: "click", planned_step_digest: sha("seed-normal-ui"), observation: { kind: "action-completed" } },
    { index: 3, page_id: "main", action: "reload", planned_step_digest: sha("reload"), observation: { kind: "navigation", status_code: 200 } },
    { index: 4, page_id: "main", action: "click", planned_step_digest: sha("save-quota"), observation: { kind: "action-completed" } },
    { index: 5, page_id: "main", action: "assert_value", planned_step_digest: sha("old-value"), observation: { kind: "assertion", passed: true } },
    { index: 6, page_id: "main", action: "assert_count", planned_step_digest: sha("saved-count"), observation: { kind: "assertion", passed: true } },
  ];
  const first: StorageFaultTraceWindowV1 = { id: "load-denied", page_id: "main", mode: "read-security", arm_before_step: 0, settle_after_step: 1,
    start_step_digest: operations[0]!.planned_step_digest, end_step_digest: operations[1]!.planned_step_digest,
    requirement_criteria: [{ requirement_id: "R-load", criterion_index: 0 }], ui_assertion_steps: [1], baseline_phase: "first-document-paused", document_epoch: 1,
    installation: { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true }, sequence: ["baseline", "armed", "settled", "disarmed"],
    hits: { baseline: 0, final: 2, delta: 2 }, native_storage: { scope: "all", comparison: "sampled-equal",
      before: { digest: sha("[]"), key_count: 0, utf8_bytes: 0 }, after: { digest: sha("[]"), key_count: 0, utf8_bytes: 0 }, equal: true },
    events: { coverage: "observed-only", observed_mutations: 0 } };
  // The reload baseline belongs to the preceding document; epoch 2 identifies the newly faulted document.
  const second: StorageFaultTraceWindowV1 = { ...structuredClone(first), id: "save-quota", mode: "write-quota", arm_before_step: 3, settle_after_step: 6,
    start_step_digest: operations[3]!.planned_step_digest, end_step_digest: operations[6]!.planned_step_digest,
    requirement_criteria: [{ requirement_id: "R-save", criterion_index: 1 }], ui_assertion_steps: [5, 6], baseline_phase: "before-step", document_epoch: 2,
    hits: { baseline: 0, final: 1, delta: 1 }, native_storage: { scope: "all", comparison: "sampled-equal",
      before: { digest: sha('[["saved","old-value"]]'), key_count: 1, utf8_bytes: 14 },
      after: { digest: sha('[["saved","old-value"]]'), key_count: 1, utf8_bytes: 14 }, equal: true } };
  const trace: BrowserOperationTraceV3 = { version: 3, format: "static-web-trace.v3", case_id: "storage-case", viewport,
    device_scale_factor: 1, program_digest: sha("program"), operations,
    captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha(image) }],
    storage_fault: { version: 1, checks_digest: sha("checks"), windows: [first, second] } };
  const expected: ExpectedBrowserProgramV3 = { case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest,
    steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
      expected_observation: structuredClone(observation.kind === "navigation" ? { kind: "navigation" } : observation) })),
    captures: [{ page_id: "main", timing: { kind: "case-end" } }],
    storage_fault: { version: 1, checks_digest: sha("checks"), installation_script_digest: STORAGE_FAULT_INITIALIZER_DIGEST,
      windows: [first, second].map(window => ({ id: window.id, page_id: window.page_id, mode: window.mode, arm_before_step: window.arm_before_step,
        settle_after_step: window.settle_after_step, start_step_digest: window.start_step_digest, end_step_digest: window.end_step_digest,
        requirement_criteria: structuredClone(window.requirement_criteria), ui_assertion_steps: [...window.ui_assertion_steps], min_hits: 1,
        native_storage: { scope: "all", comparison: "sampled-equal" }, baseline_phase: window.baseline_phase, document_epoch: window.document_epoch })) } };
  const report: StaticWebAcceptanceReportV3 = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true,
    requirements: 2, device_scale_factor: 1, capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest,
      config_digest: sha("config"), contract_digest: sha("contract") }, cases: [{ case_id: trace.case_id, viewport: { ...viewport },
      program_digest: trace.program_digest, operation_count: operations.length, assertions: 3, trace_digest: sha("pending"), trace_size: 1,
      captures: structuredClone(trace.captures), storage_fault: storageFaultReportFromTraceV1(trace.storage_fault!) }] };
  const tracePath = join(directory, browserTraceV3Filename(trace.case_id, viewport.id)), reportPath = join(directory, "result.json");
  const persistReport = () => writeFileSync(reportPath, JSON.stringify(report));
  const persistTrace = (projectReport = true) => {
    const bytes = Buffer.from(JSON.stringify(trace)), item = report.cases[0]!;
    item.trace_digest = sha(bytes); item.trace_size = bytes.length;
    if (projectReport) {
      if (trace.storage_fault) item.storage_fault = storageFaultReportFromTraceV1(trace.storage_fault);
      else delete item.storage_fault;
    }
    writeFileSync(tracePath, bytes); persistReport();
  };
  writeFileSync(join(directory, browserCaptureV3Filename(trace.case_id, viewport.id, "main")), image); persistTrace();
  return { root, evidenceRoot, binding, directory, trace, expected, report, tracePath, reportPath, persistReport, persistTrace,
    seal: () => sealBrowserEvidence({ ...binding, evidenceRoot, report, expectedPrograms: [expected] }) };
}

describe("optional v3 storage fault evidence", () => {
  it("seals both baseline phases and returns the measured projection with unchanged reference and pagination formats", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!, grant = { ...f.binding, evidenceRoot: f.evidenceRoot,
      bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(bundle.version).toBe(3); expect(refs.captures).toHaveLength(1);
    const full = readBrowserEvidence(grant, refs.trace_ref); if (full.mime_type !== "application/json") throw new Error("Expected trace JSON");
    expect(full.text).toBe(readFileSync(f.tracePath, "utf8")); expect(full).not.toHaveProperty("offset");
    expect(JSON.parse(full.text).storage_fault.windows.map((window: StorageFaultTraceWindowV1) => [window.baseline_phase, window.document_epoch]))
      .toEqual([["first-document-paused", 1], ["before-step", 2]]);
    const manifest = readBrowserEvidence(grant, bundle.bundle_id); if (manifest.mime_type !== "application/json") throw new Error("Expected manifest JSON");
    expect(JSON.parse(manifest.text).report.cases[0].storage_fault).toEqual(storageFaultReportFromTraceV1(f.trace.storage_fault!));
    let offset = 0, text = "", eof = false;
    for (let i = 0; i < 128; i++) {
      const page = readBrowserEvidence(grant, refs.trace_ref, { offset, limit: 128, ...(offset ? { expected_checksum: sha(full.text) } : {}) });
      if (page.mime_type !== "application/json") throw new Error("Expected JSON page");
      text += page.text; if (page.eof) { eof = true; break; } offset = page.next_offset!;
    }
    expect(eof).toBe(true); expect(text).toBe(full.text);
    expect(readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref).mime_type).toBe("image/png");
  });

  it("keeps all new fields absent and original trace/report bytes when the sidecar is absent", () => {
    const f = fixture(); delete f.trace.storage_fault; delete f.expected.storage_fault; f.persistTrace();
    const traceBytes = readFileSync(f.tracePath), reportBytes = readFileSync(f.reportPath), bundle = f.seal();
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const trace = readBrowserEvidence(grant, bundle.case_refs[0]!.trace_ref); if (trace.mime_type !== "application/json") throw new Error("Expected JSON");
    expect(trace.text).toBe(traceBytes.toString("utf8")); expect(trace.text).not.toContain("storage_fault");
    expect(Object.keys(trace).sort()).toEqual(["mime_type", "provenance", "reference", "text"]);
    expect(readFileSync(f.reportPath)).toEqual(reportBytes);
    const manifest = readBrowserEvidence(grant, bundle.bundle_id); if (manifest.mime_type !== "application/json") throw new Error("Expected JSON");
    expect(manifest.text).not.toContain("storage_fault");
  });

  it.each(["unplanned", "missing-actual", "missing-trace", "missing-report", "empty-expected"])("requires both actual and planned sidecars: %s", mode => {
    const f = fixture();
    if (mode === "unplanned") delete f.expected.storage_fault;
    if (mode === "missing-actual") { delete f.trace.storage_fault; delete f.report.cases[0]!.storage_fault; }
    if (mode === "missing-trace") delete f.trace.storage_fault;
    if (mode === "missing-report") delete f.report.cases[0]!.storage_fault;
    if (mode === "empty-expected") f.expected.storage_fault!.windows = [];
    f.persistTrace(false); expect(() => f.seal()).toThrow(/storage fault/);
    expect(existsSync(join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`))).toBe(false);
  });

  it.each(["checks-digest", "missing-window", "extra-window", "id", "mode", "start-step", "end-step", "ui-refs", "ui-order", "criterion", "criterion-index", "initializer"])
    ("rejects self-consistent trace/report substitution against the independent plan: %s", mode => {
      const f = fixture(), fault = f.trace.storage_fault!, window = fault.windows[1]!;
      if (mode === "checks-digest") fault.checks_digest = sha("different-checks");
      if (mode === "missing-window") fault.windows.pop();
      if (mode === "extra-window") {
        window.settle_after_step = 5; window.end_step_digest = f.trace.operations[5]!.planned_step_digest; window.ui_assertion_steps = [5];
        fault.windows.push({ ...structuredClone(window), id: "unplanned-window", arm_before_step: 6, settle_after_step: 6,
          start_step_digest: f.trace.operations[6]!.planned_step_digest, end_step_digest: f.trace.operations[6]!.planned_step_digest,
          ui_assertion_steps: [6], hits: { baseline: 1, final: 2, delta: 1 } });
      }
      if (mode === "id") window.id = "another-window";
      if (mode === "mode") window.mode = "read-security";
      if (mode === "start-step") { window.arm_before_step = 4; window.start_step_digest = f.trace.operations[4]!.planned_step_digest; }
      if (mode === "end-step") { window.settle_after_step = 5; window.end_step_digest = f.trace.operations[5]!.planned_step_digest; window.ui_assertion_steps = [5]; }
      if (mode === "ui-refs") window.ui_assertion_steps = [6];
      if (mode === "ui-order") window.ui_assertion_steps.reverse();
      if (mode === "criterion") window.requirement_criteria[0]!.requirement_id = "R-other";
      if (mode === "criterion-index") window.requirement_criteria[0]!.criterion_index = 0;
      if (mode === "initializer") window.installation.script_digest = sha("unprotected-initializer");
      f.persistTrace(); expect(() => f.seal()).toThrow(/independently derived plan/);
    });

  it.each(["extra", "order", "phase", "epoch", "digest", "min-hits", "scope", "comparison"])("does not silently reinterpret expected window fields: %s", mode => {
    const f = fixture(), fault = f.expected.storage_fault!, window = fault.windows[1]!;
    if (mode === "extra") fault.windows.push(structuredClone(window));
    if (mode === "order") fault.windows.reverse();
    if (mode === "phase") window.baseline_phase = "first-document-paused";
    if (mode === "epoch") window.document_epoch = 1;
    if (mode === "digest") fault.installation_script_digest = sha("different-initializer");
    if (mode === "min-hits") Object.assign(window, { min_hits: 0 });
    if (mode === "scope") Object.assign(window.native_storage, { scope: "selected" });
    if (mode === "comparison") Object.assign(window.native_storage, { comparison: "never-mutated" });
    expect(() => f.seal()).toThrow(/independently derived plan/);
  });

  it.each(["phase", "epoch", "start-digest", "end-digest", "unconfirmed", "sequence", "delta", "no-hit", "counter", "snapshot-digest", "snapshot-count", "snapshot-bytes", "unequal", "event", "coverage", "reordered", "duplicate", "non-ui-ref"])
    ("rejects invalid measured facts even with refreshed trace checksums: %s", mode => {
      const f = fixture(), fault = f.trace.storage_fault!, window = fault.windows[1]!;
      if (mode === "phase") window.baseline_phase = "first-document-paused";
      if (mode === "epoch") window.document_epoch = 1;
      if (mode === "start-digest") window.start_step_digest = sha("different-start");
      if (mode === "end-digest") window.end_step_digest = sha("different-end");
      if (mode === "unconfirmed") Object.assign(window.installation, { confirmed: false });
      if (mode === "sequence") Object.assign(window, { sequence: ["baseline", "armed", "disarmed", "settled"] });
      if (mode === "delta") window.hits.final = 2;
      if (mode === "no-hit") Object.assign(window.hits, { baseline: 3, final: 3, delta: 0 });
      if (mode === "counter") window.hits.final = Number.MAX_SAFE_INTEGER + 1;
      if (mode === "snapshot-digest") window.native_storage.after.digest = sha("changed");
      if (mode === "snapshot-count") window.native_storage.after.key_count++;
      if (mode === "snapshot-bytes") window.native_storage.after.utf8_bytes++;
      if (mode === "unequal") Object.assign(window.native_storage, { equal: false });
      if (mode === "event") Object.assign(window.events, { observed_mutations: 1 });
      if (mode === "coverage") Object.assign(window.events, { coverage: "complete-window" });
      if (mode === "reordered") fault.windows.reverse();
      if (mode === "duplicate") fault.windows[1]!.id = fault.windows[0]!.id;
      if (mode === "non-ui-ref") window.ui_assertion_steps = [4];
      f.persistTrace(false); expect(() => f.seal()).toThrow();
    });

  it.each(["digest", "hits", "mode", "snapshot", "order", "missing"])("requires the unique report projection: %s", mode => {
    const f = fixture(), fault = f.report.cases[0]!.storage_fault!, window = fault.windows[1]!;
    if (mode === "digest") fault.checks_digest = sha("other-checks");
    if (mode === "hits") window.fresh_hits++;
    if (mode === "mode") window.mode = "read-security";
    if (mode === "snapshot") window.native_storage.digest = sha("other-snapshot");
    if (mode === "order") fault.windows.reverse();
    if (mode === "missing") fault.windows.pop();
    f.persistReport(); expect(() => f.seal()).toThrow(/actual trace projection/);
  });

  it("revalidates the storage projection when either a trace or its capture is read", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!;
    const path = join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`), manifest = JSON.parse(readFileSync(path, "utf8"));
    // Exercise structural read validation after matching digest checks, independent of the trusted grant installation.
    f.report.cases[0]!.storage_fault!.windows[0]!.fresh_hits++; f.persistReport();
    manifest.report = f.report; manifest.report_checksum = sha(readFileSync(f.reportPath));
    const bytes = Buffer.from(JSON.stringify(manifest)); chmodSync(path, 0o600); writeFileSync(path, bytes);
    const digest = sha(bytes), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: `browser_${digest.slice(7)}`, manifest_digest: digest };
    expect(() => readBrowserEvidence(grant, refs.trace_ref)).toThrow(/actual trace projection/);
    expect(() => readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref)).toThrow(/actual trace projection/);
  });

  it("rejects sealed storage trace and report mutations through the original grant", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!, grant = { ...f.binding, evidenceRoot: f.evidenceRoot,
      bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest }, original = readFileSync(f.tracePath);
    f.trace.storage_fault!.windows[1]!.installation.script_digest = sha("tampered");
    writeFileSync(f.tracePath, JSON.stringify(f.trace));
    expect(() => readBrowserEvidence(grant, refs.trace_ref)).toThrow(/trace integrity/);
    expect(() => readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref)).toThrow(/trace integrity/);
    writeFileSync(f.tracePath, original); f.report.cases[0]!.storage_fault!.windows[0]!.fresh_hits++; f.persistReport();
    expect(() => readBrowserEvidence(grant, refs.trace_ref)).toThrow(/report changed after sealing/);
  });
});
