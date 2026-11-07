import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserOperationTraceV3, BrowserOperationV3, StaticWebAcceptanceReportV3 } from "@artoo/domain";
import { browserCaptureV3Filename, browserTraceV3Filename, readBrowserEvidence, sealBrowserEvidence, type ExpectedBrowserProgramV3 } from "./browser-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Distinct valid fixture PNGs exercise identity and dimensions, not actual browser rendering. */
function png(width: number, height: number, color: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4); header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, color);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-browser-evidence-v3-"))); roots.push(root);
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
  const binding = { requestId: "v3_fixture", profileId: "profile", profileDigest: sha("profile"), subjectDigest: sha("subject"), checkId: "multiple-pages", scope: "preview" as const };
  const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
  const report: StaticWebAcceptanceReportV3 = { version: 3, format: "static-web-acceptance.v3", stage: "design", passed: true,
    requirements: 1, device_scale_factor: 1, capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest,
      config_digest: sha("config-v3"), contract_digest: sha("contract-v3") }, cases: [] };
  const expectedPrograms: ExpectedBrowserProgramV3[] = [], traces: BrowserOperationTraceV3[] = [];
  for (const viewport of [{ id: "short", width: 320, height: 240 }, { id: "tall", width: 320, height: 480 }]) {
    const operations: BrowserOperationV3[] = [
      { index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate-main"), observation: { kind: "navigation", status_code: 200 } },
      { index: 1, page_id: "peer", action: "open_page", planned_step_digest: sha("open-peer"), observation: { kind: "page-opened", status_code: 200 } },
      { index: 2, page_id: "audit", action: "open_page", planned_step_digest: sha("open-audit"), observation: { kind: "page-opened", status_code: 200 } },
      { index: 3, page_id: "main", action: "fill", planned_step_digest: sha("fill-main"), observation: { kind: "action-completed" } },
      { index: 4, page_id: "main", action: "click", planned_step_digest: sha("save-main"), observation: { kind: "action-completed" } },
      { index: 5, page_id: "peer", action: "assert_text", planned_step_digest: sha("read-peer"), observation: { kind: "assertion", passed: true } },
      { index: 6, page_id: "audit", action: "assert_text", planned_step_digest: sha("read-audit"), observation: { kind: "assertion", passed: true } },
      { index: 7, page_id: "peer", action: "close_page", planned_step_digest: sha("close-peer"), observation: { kind: "page-closed", closed: true } },
      { index: 8, page_id: "main", action: "assert_text", planned_step_digest: sha("read-main"), observation: { kind: "assertion", passed: true } },
    ];
    const trace: BrowserOperationTraceV3 = { version: 3, format: "static-web-trace.v3", case_id: "shared-storage", viewport,
      device_scale_factor: 1, program_digest: sha("fixed-source-v3-program"), operations, captures: [] };
    for (const [index, page_id] of ["main", "peer", "audit"].entries()) {
      const image = png(viewport.width, viewport.height, 40 + index * 50);
      writeFileSync(join(directory, browserCaptureV3Filename(trace.case_id, viewport.id, page_id)), image);
      trace.captures.push({ page_id, timing: page_id === "peer" ? { kind: "before-close", step_index: 7 } : { kind: "case-end" }, screenshot_digest: sha(image) });
    }
    traces.push(trace);
    expectedPrograms.push({ case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest,
      steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
        expected_observation: structuredClone(observation.kind === "navigation" || observation.kind === "page-opened" ? { kind: observation.kind } : observation) })),
      captures: trace.captures.map(({ page_id, timing }) => ({ page_id, timing: structuredClone(timing) })) });
    const bytes = Buffer.from(JSON.stringify(trace));
    writeFileSync(join(directory, browserTraceV3Filename(trace.case_id, viewport.id)), bytes);
    report.cases.push({ case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest, operation_count: operations.length,
      assertions: 3, trace_digest: sha(bytes), trace_size: bytes.length, captures: structuredClone(trace.captures) });
  }
  const persistReport = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report));
  persistReport();
  const persistTrace = (index = 0, copyCaptures = true) => {
    const trace = traces[index]!, item = report.cases[index]!, bytes = Buffer.from(JSON.stringify(trace));
    item.trace_digest = sha(bytes); item.trace_size = bytes.length; item.operation_count = trace.operations.length;
    item.assertions = trace.operations.filter(operation => operation.action.startsWith("assert_")).length;
    item.program_digest = trace.program_digest; item.viewport = { ...trace.viewport };
    if (copyCaptures) item.captures = structuredClone(trace.captures);
    writeFileSync(join(directory, browserTraceV3Filename(item.case_id, item.viewport.id)), bytes); persistReport();
  };
  return { root, evidenceRoot, binding, directory, report, traces, expectedPrograms, persistTrace, persistReport,
    seal: () => sealBrowserEvidence({ ...binding, evidenceRoot, report, expectedPrograms }) };
}

describe("version-3 page lifetime evidence", () => {
  it("seals every created page with its actual capture position and exact viewport dimensions", () => {
    const f = fixture(), bundle = f.seal(), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(bundle.version).toBe(3); expect(bundle.case_refs).toHaveLength(2);
    expect(new Set(bundle.case_refs.flatMap(item => [item.trace_ref, ...item.captures.map(capture => capture.screenshot_ref)])).size).toBe(8);
    for (const refs of bundle.case_refs) {
      const trace = readBrowserEvidence(grant, refs.trace_ref); if (trace.mime_type !== "application/json") throw new Error("Expected trace JSON");
      const expected = f.traces.find(item => item.viewport.id === refs.viewport_id)!;
      expect(JSON.parse(trace.text)).toEqual(expected);
      expect(refs.captures.map(capture => capture.page_id)).toEqual(["main", "peer", "audit"]);
      for (const capture of refs.captures) {
        const image = readBrowserEvidence(grant, capture.screenshot_ref); if (image.mime_type !== "image/png") throw new Error("Expected PNG");
        const measured = expected.captures.find(item => item.page_id === capture.page_id)!;
        expect(image.page_id).toBe(capture.page_id); expect(image.timing).toEqual(measured.timing);
        expect(image.checksum).toBe(measured.screenshot_digest); expect(image.viewport).toEqual(expected.viewport);
        const bytes = Buffer.from(image.data, "base64"); expect(bytes.readUInt32BE(16)).toBe(expected.viewport.width); expect(bytes.readUInt32BE(20)).toBe(expected.viewport.height);
      }
    }
    for (const changed of [{ scope: "final" as const }, { subjectDigest: sha("other") }, { requestId: "other" }, { profileId: "other" }, { checkId: "other" }]) {
      expect(() => readBrowserEvidence({ ...grant, ...changed }, bundle.case_refs[0]!.trace_ref)).toThrow();
    }
    expect(() => readBrowserEvidence(grant, "image_forged")).toThrow(/not granted/);
    expect(() => readBrowserEvidence(grant, browserCaptureV3Filename("shared-storage", "short", "peer"))).toThrow(/reference/);
  });

  it.each(["missing-capture", "extra-capture", "duplicate-page", "reordered-captures", "closed-at-end", "active-before-close", "wrong-close-index", "trace-report-mismatch"])("rejects self-consistent or mismatched capture substitution: %s", mode => {
    const f = fixture(), trace = f.traces[0]!;
    if (mode === "missing-capture") trace.captures.splice(1, 1);
    if (mode === "extra-capture") trace.captures.push({ ...structuredClone(trace.captures[0]!), page_id: "unknown" });
    if (mode === "duplicate-page") trace.captures[2]!.page_id = "peer";
    if (mode === "reordered-captures") [trace.captures[1], trace.captures[2]] = [trace.captures[2]!, trace.captures[1]!];
    if (mode === "closed-at-end") trace.captures[1]!.timing = { kind: "case-end" };
    if (mode === "active-before-close") trace.captures[2]!.timing = { kind: "before-close", step_index: 7 };
    if (mode === "wrong-close-index") trace.captures[1]!.timing = { kind: "before-close", step_index: 6 };
    if (mode === "trace-report-mismatch") trace.captures[1]!.screenshot_digest = sha("substituted");
    f.persistTrace(0, mode !== "trace-report-mismatch");
    expect(() => f.seal()).toThrow(); expect(existsSync(join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`))).toBe(false);
  });

  it.each(["closed-false", "closed-main", "after-close", "unknown-page", "reuse-name", "fourth-page", "operation-page", "step-digest", "program-digest", "index", "non-2xx", "missing-close", "reordered-close", "unsupported-action"])("rejects a tampered actual page lifecycle even with updated report digests: %s", mode => {
    const f = fixture(), trace = f.traces[0]!;
    if (mode === "closed-false") Object.assign(trace.operations[7]!.observation, { closed: false });
    if (mode === "closed-main") trace.operations[7]!.page_id = "main";
    if (mode === "after-close") trace.operations[8]!.page_id = "peer";
    if (mode === "unknown-page") trace.operations[5]!.page_id = "unknown";
    if (mode === "reuse-name") trace.operations[2]!.page_id = "peer";
    if (mode === "fourth-page") trace.operations.push({ index: 9, page_id: "fourth", action: "open_page", planned_step_digest: sha("fourth"), observation: { kind: "page-opened", status_code: 200 } });
    if (mode === "operation-page") trace.operations[5]!.page_id = "audit";
    if (mode === "step-digest") trace.operations[7]!.planned_step_digest = sha("wrong-close-step");
    if (mode === "program-digest") trace.program_digest = sha("wrong-program");
    if (mode === "index") trace.operations[3]!.index = 2;
    if (mode === "non-2xx") Object.assign(trace.operations[1]!.observation, { status_code: 500 });
    if (mode === "missing-close") { trace.operations.splice(7, 1); trace.operations.forEach((op, index) => { op.index = index; }); trace.captures[1]!.timing = { kind: "case-end" }; }
    if (mode === "reordered-close") {
      [trace.operations[6], trace.operations[7]] = [trace.operations[7]!, trace.operations[6]!]; trace.operations.forEach((op, index) => { op.index = index; });
      trace.captures[1]!.timing = { kind: "before-close", step_index: 6 };
    }
    if (mode === "unsupported-action") Object.assign(trace.operations[3]!, { action: "storage_fault" });
    f.persistTrace(); expect(() => f.seal()).toThrow();
  });

  it("requires a complete independent expected plan and exact counts and profile binding", () => {
    for (const mode of ["absent", "duplicate", "missing", "timing", "count", "assertions", "binding"]) {
      const f = fixture();
      if (mode === "absent") { expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report })).toThrow(/independently derived/); continue; }
      if (mode === "duplicate") f.expectedPrograms[1] = structuredClone(f.expectedPrograms[0]!);
      if (mode === "missing") f.expectedPrograms.pop();
      if (mode === "timing") f.expectedPrograms[0]!.captures[1]!.timing = { kind: "before-close", step_index: 6 };
      if (mode === "count") f.report.cases[0]!.operation_count++;
      if (mode === "assertions") f.report.cases[0]!.assertions++;
      if (mode === "binding") f.report.capability_binding.profile_digest = sha("unselected-profile");
      f.persistReport(); expect(() => f.seal()).toThrow();
    }
  });

  it.each(["width", "height", "exchanged-pages"])("checks actual PNG bytes rather than capture metadata: %s", mode => {
    const f = fixture(), trace = f.traces[0]!, viewport = trace.viewport;
    const path = join(f.directory, browserCaptureV3Filename(trace.case_id, viewport.id, "peer"));
    if (mode === "exchanged-pages") {
      const other = join(f.directory, browserCaptureV3Filename(trace.case_id, viewport.id, "audit")), first = readFileSync(path), second = readFileSync(other);
      writeFileSync(path, second); writeFileSync(other, first);
    } else {
      const image = png(viewport.width + (mode === "width" ? 1 : 0), viewport.height + (mode === "height" ? 1 : 0), 90);
      writeFileSync(path, image); trace.captures[1]!.screenshot_digest = sha(image); f.persistTrace();
    }
    expect(() => f.seal()).toThrow(/width or height|integrity/);
  });

  it("bounds trace bytes and rejects hard-linked trace files", () => {
    const f = fixture(), path = join(f.directory, browserTraceV3Filename("shared-storage", "short")), original = readFileSync(path);
    writeFileSync(path, Buffer.alloc(256 * 1024 + 1, " ")); expect(() => f.seal()).toThrow(/bounded browser evidence/);
    writeFileSync(path, original); linkSync(path, join(f.root, "linked.json")); expect(() => f.seal()).toThrow(/bounded browser evidence/);
  });

  it("pages the sealed trace and rejects both trace and capture reads after the trace changes", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!, grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const full = readBrowserEvidence(grant, refs.trace_ref); if (full.mime_type !== "application/json") throw new Error("Expected JSON");
    expect(full).not.toHaveProperty("offset");
    let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 128; index++) {
      const page = readBrowserEvidence(grant, refs.trace_ref, { offset, limit: 64, ...(offset ? { expected_checksum: sha(full.text) } : {}) });
      if (page.mime_type !== "application/json") throw new Error("Expected JSON page");
      expect(page.checksum).toBe(sha(full.text)); combined += page.text;
      if (page.eof) { finished = true; break; } offset = page.next_offset!;
    }
    expect(finished).toBe(true); expect(combined).toBe(full.text);
    expect(() => readBrowserEvidence(grant, refs.trace_ref, { offset: 64 })).toThrow(/expected_checksum/);
    expect(() => readBrowserEvidence(grant, refs.trace_ref, { offset: 64, expected_checksum: sha("stale") })).toThrow(/checksum changed/);
    const path = join(f.directory, browserTraceV3Filename("shared-storage", "short")); writeFileSync(path, full.text + " ");
    expect(() => readBrowserEvidence(grant, refs.trace_ref, { offset: 64, expected_checksum: sha(full.text) })).toThrow(/trace integrity/);
    expect(() => readBrowserEvidence(grant, refs.captures[1]!.screenshot_ref)).toThrow(/trace integrity/);
  });

  it("rejects image and result mutations after sealing", () => {
    const f = fixture(), bundle = f.seal(), refs = bundle.case_refs[0]!, grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const imagePath = join(f.directory, browserCaptureV3Filename("shared-storage", "short", "peer"));
    writeFileSync(imagePath, Buffer.concat([readFileSync(imagePath), Buffer.from("changed")]));
    expect(() => readBrowserEvidence(grant, refs.captures[1]!.screenshot_ref)).toThrow(/changed after sealing/);
    f.report.requirements++; f.persistReport(); expect(() => readBrowserEvidence(grant, refs.trace_ref)).toThrow(/report changed/);
  });

  it("seals research without inventing pages or browser captures", () => {
    const f = fixture(); f.report.stage = "research"; f.report.cases = []; f.expectedPrograms.length = 0; f.persistReport();
    const bundle = f.seal(), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(bundle.case_refs).toEqual([]);
    const evidence = readBrowserEvidence(grant, bundle.bundle_id); if (evidence.mime_type !== "application/json") throw new Error("Expected JSON");
    expect(JSON.parse(evidence.text)).toMatchObject({ version: 3, report: { stage: "research", cases: [] }, entries: [] });
  });
});
