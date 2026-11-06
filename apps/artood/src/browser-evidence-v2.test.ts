import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserOperationTraceV2, BrowserOperationV2, StaticWebAcceptanceReportV2 } from "@artoo/domain";
import { browserCaptureV2Filename, browserTraceV2Filename, readBrowserEvidence, sealBrowserEvidence, type ExpectedBrowserProgramV2 } from "./browser-evidence.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
/** Valid deterministic PNG bytes test sealing, not actual browser rendering. */
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
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-browser-evidence-v2-"))); roots.push(root);
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
  const binding = { requestId: "v2_fixture", profileId: "profile", profileDigest: sha("profile"), subjectDigest: sha("subject"), checkId: "keyboard", scope: "preview" as const };
  const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
  const report: StaticWebAcceptanceReportV2 = { version: 2, format: "static-web-acceptance.v2", stage: "design", passed: true,
    requirements: 1, device_scale_factor: 1, capability_binding: { version: 1, command_id: binding.checkId, profile_digest: binding.profileDigest,
      config_digest: sha("config"), contract_digest: sha("contract") }, cases: [] };
  const expectedPrograms: ExpectedBrowserProgramV2[] = [], traces: BrowserOperationTraceV2[] = [];
  for (const viewport of [{ id: "short", width: 320, height: 240 }, { id: "tall", width: 320, height: 480 }]) {
    const operations: BrowserOperationV2[] = [
      { index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate"), observation: { kind: "navigation", status_code: 200 } },
      { index: 1, page_id: "main", action: "focus", planned_step_digest: sha("focus"), observation: { kind: "programmatic-focus", focused: true } },
      { index: 2, page_id: "main", action: "press", planned_step_digest: sha("press-tab"), observation: { kind: "key-press", key: "Tab" } },
      { index: 3, page_id: "main", action: "type_text", planned_step_digest: sha("type-text"), observation: { kind: "keyboard-input", text_length: 3 } },
      { index: 4, page_id: "main", action: "assert_focused", planned_step_digest: sha("assert-focused"), observation: { kind: "focus-assertion", passed: true } },
    ];
    const trace: BrowserOperationTraceV2 = { version: 2, format: "static-web-trace.v2", case_id: "keyboard", page_id: "main", viewport,
      device_scale_factor: 1, program_digest: sha("fixed-source-program"), operations };
    traces.push(trace);
    expectedPrograms.push({ case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest,
      steps: operations.map(({ index, action, page_id, planned_step_digest, observation }) => ({ index, action, page_id, planned_step_digest,
        expected_observation: structuredClone(observation.kind === "navigation" ? { kind: "navigation" as const } : observation) })), captures: [{ page_id: "main" }] });
    const bytes = Buffer.from(JSON.stringify(trace)), image = png(viewport.width, viewport.height);
    writeFileSync(join(directory, browserTraceV2Filename(trace.case_id, viewport.id)), bytes);
    writeFileSync(join(directory, browserCaptureV2Filename(trace.case_id, viewport.id)), image);
    report.cases.push({ case_id: trace.case_id, viewport: { ...viewport }, program_digest: trace.program_digest, operation_count: operations.length,
      assertions: 1, trace_digest: sha(bytes), trace_size: bytes.length, captures: [{ page_id: "main", screenshot_digest: sha(image) }] });
  }
  const persistReport = () => writeFileSync(join(directory, "result.json"), JSON.stringify(report));
  persistReport();
  const persistTrace = (index = 0) => {
    const trace = traces[index]!, item = report.cases[index]!, bytes = Buffer.from(JSON.stringify(trace));
    item.trace_digest = sha(bytes); item.trace_size = bytes.length; item.operation_count = trace.operations.length;
    item.assertions = trace.operations.filter(operation => operation.action.startsWith("assert_")).length;
    item.program_digest = trace.program_digest; item.viewport = { ...trace.viewport };
    writeFileSync(join(directory, browserTraceV2Filename(item.case_id, item.viewport.id)), bytes); persistReport();
  };
  return { root, evidenceRoot, binding, directory, report, traces, expectedPrograms, persistTrace, persistReport,
    seal: () => sealBrowserEvidence({ ...binding, evidenceRoot, report, expectedPrograms }) };
}

describe("version-2 browser trace sealing", () => {
  it("seals same-width viewports by distinct IDs and exact heights with trace and image grants", () => {
    const f = fixture(), bundle = f.seal(), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(bundle.version).toBe(2); expect(bundle.case_refs.map(item => item.viewport_id)).toEqual(["short", "tall"]);
    expect(new Set(bundle.case_refs.flatMap(item => [item.trace_ref, ...item.captures.map(capture => capture.screenshot_ref)])).size).toBe(4);
    for (const refs of bundle.case_refs) {
      const trace = readBrowserEvidence(grant, refs.trace_ref);
      if (trace.mime_type !== "application/json") throw new Error("Expected trace JSON");
      const expected = f.traces.find(item => item.viewport.id === refs.viewport_id)!;
      expect(JSON.parse(trace.text)).toEqual(expected);
      expect(trace.provenance.scope).toBe("preview");
      const image = readBrowserEvidence(grant, refs.captures[0]!.screenshot_ref);
      if (image.mime_type !== "image/png") throw new Error("Expected PNG");
      const bytes = Buffer.from(image.data, "base64"); expect(bytes.readUInt32BE(16)).toBe(expected.viewport.width); expect(bytes.readUInt32BE(20)).toBe(expected.viewport.height);
      expect(image.page_id).toBe("main"); expect(image.viewport).toEqual(expected.viewport);
    }
    expect(() => readBrowserEvidence({ ...grant, scope: "final" }, bundle.case_refs[0]!.trace_ref)).toThrow(/binding/);
    expect(() => readBrowserEvidence(grant, "trace_forged")).toThrow(/not granted/);
    expect(() => readBrowserEvidence(grant, browserTraceV2Filename("keyboard", "short"))).toThrow(/reference/);
  });

  it.each(["missing", "reordered", "step-digest", "program-digest", "key", "text-length", "focus-failed", "page", "viewport", "index", "observation-kind"])("rejects a self-consistent report with substituted actual trace: %s", mode => {
    const f = fixture(), trace = f.traces[0]!;
    if (mode === "missing") { trace.operations.splice(1, 1); trace.operations.forEach((operation, index) => { operation.index = index; }); }
    if (mode === "reordered") { [trace.operations[1], trace.operations[2]] = [trace.operations[2]!, trace.operations[1]!]; trace.operations.forEach((operation, index) => { operation.index = index; }); }
    if (mode === "step-digest") trace.operations[1]!.planned_step_digest = sha("substituted");
    if (mode === "program-digest") trace.program_digest = sha("substituted");
    if (mode === "key") Object.assign(trace.operations[2]!.observation, { key: "Escape" });
    if (mode === "text-length") Object.assign(trace.operations[3]!.observation, { text_length: 4 });
    if (mode === "focus-failed") Object.assign(trace.operations[1]!.observation, { focused: false });
    if (mode === "page") Object.assign(trace, { page_id: "other" });
    if (mode === "viewport") trace.viewport.height += 1;
    if (mode === "index") trace.operations[2]!.index = 1;
    if (mode === "observation-kind") Object.assign(trace.operations[2]!, { observation: { kind: "action-completed" } });
    f.persistTrace();
    expect(() => f.seal()).toThrow();
    expect(existsSync(join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`))).toBe(false);
  });

  it("requires the complete independent expected plan and exact measured counts", () => {
    for (const mode of ["absent", "duplicate", "extra-report", "count", "assertions", "binding"]) {
      const f = fixture();
      if (mode === "absent") { expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report })).toThrow(/independently derived/); continue; }
      if (mode === "duplicate") f.expectedPrograms[1] = structuredClone(f.expectedPrograms[0]!);
      if (mode === "extra-report") f.expectedPrograms.pop();
      if (mode === "count") f.report.cases[0]!.operation_count++;
      if (mode === "assertions") f.report.cases[0]!.assertions++;
      if (mode === "binding") f.report.capability_binding.command_id = "other";
      f.persistReport(); expect(() => f.seal()).toThrow();
    }
  });

  it.each(["width", "height"])("checks actual PNG %s independently of a self-reported checksum", dimension => {
    const f = fixture(), item = f.report.cases[0]!;
    const image = png(item.viewport.width + (dimension === "width" ? 1 : 0), item.viewport.height + (dimension === "height" ? 1 : 0));
    writeFileSync(join(f.directory, browserCaptureV2Filename(item.case_id, item.viewport.id)), image);
    item.captures[0]!.screenshot_digest = sha(image); f.persistReport();
    expect(() => f.seal()).toThrow(/width or height/);
  });

  it("bounds trace files and rejects linked evidence", () => {
    const f = fixture(), path = join(f.directory, browserTraceV2Filename("keyboard", "short")), original = readFileSync(path);
    writeFileSync(path, Buffer.alloc(256 * 1024 + 1, " "));
    expect(() => f.seal()).toThrow(/bounded browser evidence/);
    writeFileSync(path, original); linkSync(path, join(f.root, "linked.json"));
    expect(() => f.seal()).toThrow(/bounded browser evidence/);
  });

  it("seals an explicitly empty research plan without inventing browser operations", () => {
    const f = fixture(); f.report.stage = "research"; f.report.cases = []; f.expectedPrograms.length = 0; f.persistReport();
    const bundle = f.seal(), grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(bundle.case_refs).toEqual([]);
    const evidence = readBrowserEvidence(grant, bundle.bundle_id); if (evidence.mime_type !== "application/json") throw new Error("Expected bundle JSON");
    expect(JSON.parse(evidence.text)).toMatchObject({ version: 2, report: { stage: "research", cases: [] }, entries: [] });
    expect(() => readBrowserEvidence(grant, "trace_forged")).toThrow(/not granted/);
  });

  it.each(["width", "height", "bytes"])("revalidates sealed PNG %s when an image reference is opened", dimension => {
    const f = fixture(), bundle = f.seal(), item = f.report.cases[0]!;
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const path = join(f.directory, browserCaptureV2Filename(item.case_id, item.viewport.id));
    const image = dimension === "bytes" ? Buffer.concat([readFileSync(path), Buffer.from("changed")])
      : png(item.viewport.width + (dimension === "width" ? 1 : 0), item.viewport.height + (dimension === "height" ? 1 : 0));
    writeFileSync(path, image);
    expect(() => readBrowserEvidence(grant, bundle.case_refs[0]!.captures[0]!.screenshot_ref)).toThrow(/changed after sealing/);
  });

  it("pages the actual sealed trace and rejects mutations between pages", () => {
    const f = fixture(), bundle = f.seal(), reference = bundle.case_refs[0]!.trace_ref;
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const full = readBrowserEvidence(grant, reference); if (full.mime_type !== "application/json") throw new Error("Expected JSON");
    let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 64; index++) {
      const page = readBrowserEvidence(grant, reference, { offset, limit: 64, ...(offset ? { expected_checksum: sha(full.text) } : {}) });
      if (page.mime_type !== "application/json") throw new Error("Expected JSON page");
      expect(page.checksum).toBe(sha(full.text)); combined += page.text;
      if (page.eof) { finished = true; break; } offset = page.next_offset!;
    }
    expect(finished).toBe(true); expect(combined).toBe(full.text);
    Object.assign(f.traces[0]!.operations[2]!.observation, { key: "Escape" });
    writeFileSync(join(f.directory, browserTraceV2Filename("keyboard", "short")), JSON.stringify(f.traces[0]));
    expect(() => readBrowserEvidence(grant, reference, { offset: 64, expected_checksum: sha(full.text) })).toThrow(/trace integrity/);
  });
});
