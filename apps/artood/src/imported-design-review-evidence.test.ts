// Real sealed files and evidence reads; the image, trace, profile and verifier receipt are controlled fixtures.
// No browser, native helper or model is executed.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { RunVerificationPayloadSchema, type BrowserOperationTraceV3, type StaticWebAcceptanceReportV3 } from "@artoo/domain";
import { browserCaptureV3Filename, browserTraceV3Filename, sealBrowserEvidence, type ExpectedBrowserProgramV3 } from "./browser-evidence.js";
import { createImportedDesignReviewEvidence } from "./imported-design-review-evidence.js";
import { createImportedImplementationReviewEvidence } from "./imported-implementation-review-evidence.js";
import { importedDesignReviewRequestFixture } from "./test-fixtures/imported-design-review-request.js";
import type { PreparedVerificationProfile } from "./verification.js";

const roots: string[] = [], prefix = "artoo-h4-evidence-";
afterEach(() => { for (const root of roots.splice(0)) {
  // Windows TEMP can use an 8.3 alias while the retained root uses its long path.
  const parent = realpathSync.native(tmpdir()), canonicalRoot = realpathSync.native(root);
  if (canonicalRoot !== root || dirname(canonicalRoot) !== parent || !basename(canonicalRoot).startsWith(prefix)) throw Error("Unexpected controlled fixture root");
  rmSync(root, { recursive: true, force: true });
} });
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const header = Buffer.alloc(4), footer = Buffer.alloc(4); header.writeUInt32BE(data.length); footer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, body, footer]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(320); header.writeUInt32BE(240, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((320 * 4 + 1) * 240))), chunk("IEND", Buffer.alloc(0))]);
}
function fixture(stage: "design" | "implementation" = "design") {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, prefix))); roots.push(root);
  const evidenceRoot = join(root, "evidence"); mkdirSync(evidenceRoot);
  const { request } = importedDesignReviewRequestFixture();
  if (request.continuation_result.outcome !== "finished" || !request.continuation_result.verified_design) throw Error("Controlled completion missing");
  const receipt = structuredClone(request.continuation_result.verified_design.verification);
  receipt.request_id = request.before_start.verification!.request_id;
  const check = receipt.checks[0]!;
  const directory = join(evidenceRoot, sha(receipt.request_id).slice(7)); mkdirSync(directory);
  const image = png(), viewport = { id: "controlled", width: 320, height: 240 };
  const trace: BrowserOperationTraceV3 = { version: 3, format: "static-web-trace.v3", case_id: "controlled-design", viewport,
    device_scale_factor: 1, program_digest: sha("program"), operations: [
      { index: 0, page_id: "main", action: "navigate", planned_step_digest: sha("navigate"), observation: { kind: "navigation", status_code: 200 } },
      { index: 1, page_id: "main", action: "assert_text", planned_step_digest: sha("assert"), observation: { kind: "assertion", passed: true } },
    ], captures: [{ page_id: "main", timing: { kind: "case-end" }, screenshot_digest: sha(image) }] };
  const traceBytes = Buffer.from(JSON.stringify(trace));
  const screenshot = join(directory, browserCaptureV3Filename(trace.case_id, viewport.id, "main")); writeFileSync(screenshot, image);
  writeFileSync(join(directory, browserTraceV3Filename(trace.case_id, viewport.id)), traceBytes);
  const report: StaticWebAcceptanceReportV3 = { version: 3, format: "static-web-acceptance.v3", stage, passed: true,
    requirements: 1, device_scale_factor: 1, capability_binding: { ...check.observation!.capability_binding! }, cases: [{ case_id: trace.case_id,
      viewport, program_digest: trace.program_digest, assertions: 1, operation_count: 2, trace_digest: sha(traceBytes), trace_size: traceBytes.length,
      captures: structuredClone(trace.captures) }] };
  writeFileSync(join(directory, "result.json"), JSON.stringify(report));
  const expectedPrograms: ExpectedBrowserProgramV3[] = [{ case_id: trace.case_id, viewport, program_digest: trace.program_digest,
    steps: trace.operations.map(({ observation, ...step }) => ({ ...step,
      expected_observation: observation.kind === "navigation" ? { kind: "navigation" } : observation })),
    captures: trace.captures.map(({ page_id, timing }) => ({ page_id, timing })) }];
  const sealed = sealBrowserEvidence({ evidenceRoot, requestId: receipt.request_id, profileId: receipt.profile_id,
    profileDigest: receipt.profile_digest, subjectDigest: receipt.subject_digest!, checkId: check.id, scope: "final", report, expectedPrograms });
  const { passed: _passed, requirements: _requirements, ...observed } = report;
  check.observation = { ...observed, scope: "final", evidence_bundle: { bundle_id: sealed.bundle_id, manifest_digest: sealed.manifest_digest },
    cases: report.cases.map((item, index) => ({ ...item, trace_ref: sealed.case_refs[index]!.trace_ref,
      captures: item.captures.map((capture, captureIndex) => ({ ...capture, screenshot_ref: sealed.case_refs[index]!.captures[captureIndex]!.screenshot_ref })) })) };
  // Every negative case starts from a strict valid receipt, including the retained plan bindings.
  RunVerificationPayloadSchema.parse(receipt);
  const profile = { id: receipt.profile_id, digest: receipt.profile_digest, commands: [{ id: check.id,
    observation: { format: "static-web-acceptance.v3", evidence_root: evidenceRoot } }] } as unknown as PreparedVerificationProfile;
  let live = true;
  const create = () => createImportedDesignReviewEvidence(profile, receipt, { requestId: request.before_start.verification!.request_id,
    subjectDigest: request.continuation_result.outcome === "finished" ? request.continuation_result.verified_design!.subject_digest : "" },
  () => { if (!live) throw Error("Controlled reviewer is closed"); });
  return { root, directory, screenshot, image, receipt, profile, sealed, create, stop: () => { live = false; } };
}
describe("H4 scoped sealed evidence access", () => {
  it("allows implementation review only its sealed before evidence and revokes reads after the phase", async () => {
    const f = fixture("implementation");
    expect(() => f.create()).toThrow();
    let live = true;
    const reader = createImportedImplementationReviewEvidence(f.profile, f.receipt, { requestId: f.receipt.request_id, subjectDigest: f.receipt.subject_digest! },
      () => { if (!live) throw Error("Controlled H6 phase ended"); });
    expect(await reader.read(f.sealed.case_refs[0]!.captures[0]!.screenshot_ref)).toMatchObject({ mime_type: "image/png", checksum: sha(f.image) });
    await expect(reader.read("ungranted_after_evidence")).rejects.toThrow("not granted");
    live = false; expect(() => reader.readEvidenceIndex()).toThrow("phase ended");
    await expect(reader.read(f.sealed.bundle_id)).rejects.toThrow("phase ended");
  });
  it("discovers only the before bundle and reads its measured trace, image and paginated manifest", async () => {
    const f = fixture(), reader = f.create(), index = reader.readEvidenceIndex();
    expect(index).toEqual({ version: 1, bundles: [{ reference: f.sealed.bundle_id, request_id: f.receipt.request_id, check_id: f.receipt.checks[0]!.id, scope: "final" }] });
    expect(JSON.stringify(index)).not.toContain(f.root);
    expect(await reader.read(index.bundles[0]!.reference, { offset: 0, limit: 128 })).toMatchObject({ mime_type: "application/json", offset: 0, eof: false });
    expect(await reader.read(f.sealed.case_refs[0]!.trace_ref)).toMatchObject({ mime_type: "application/json", provenance: { requestId: f.receipt.request_id, scope: "final" } });
    expect(await reader.read(f.sealed.case_refs[0]!.captures[0]!.screenshot_ref)).toMatchObject({ mime_type: "image/png", checksum: sha(f.image) });
    await expect(reader.read("ungranted_author_or_after_evidence")).rejects.toThrow("not granted");
  });
  it("revokes both discovery and reads when the reviewer leaves its original phase", async () => {
    const f = fixture(), reader = f.create(); f.stop();
    expect(() => reader.readEvidenceIndex()).toThrow("closed"); await expect(reader.read(f.sealed.bundle_id)).rejects.toThrow("closed");
  });
  it("rechecks sealed manifest bytes during discovery and reads", async () => {
    const f = fixture(), reader = f.create(), manifest = join(f.directory, `sealed-${sha(f.receipt.checks[0]!.id).slice(7)}.json`);
    chmodSync(manifest, 0o600); writeFileSync(manifest, readFileSync(manifest, "utf8") + " ");
    expect(() => reader.readEvidenceIndex()).toThrow(); await expect(reader.read(f.sealed.bundle_id)).rejects.toThrow();
  });
  it("rejects substituted screenshot bytes", async () => {
    const f = fixture(), reader = f.create(); writeFileSync(f.screenshot, Buffer.concat([f.image, Buffer.from("changed")]));
    await expect(reader.read(f.sealed.case_refs[0]!.captures[0]!.screenshot_ref)).rejects.toThrow();
  });
  for (const mode of ["request", "subject", "profile", "scope", "bundle", "manifest", "root", "duplicate", "failed"] as const) {
    it(`rejects a substituted ${mode} before exposing an evidence reader`, () => {
      const f = fixture(), observation = f.receipt.checks[0]!.observation!;
      if (mode === "request") f.receipt.request_id = "other-request";
      if (mode === "subject") f.receipt.subject_digest = sha("other-subject");
      if (mode === "profile") f.receipt.profile_digest = sha("other-profile");
      if (mode === "scope") observation.scope = "preview";
      if (mode === "bundle") delete observation.evidence_bundle;
      if (mode === "manifest") observation.evidence_bundle!.manifest_digest = sha("other-manifest");
      if (mode === "root") f.profile.commands[0]!.observation!.evidence_root = f.root;
      if (mode === "duplicate") f.receipt.checks.push(structuredClone(f.receipt.checks[0]!));
      if (mode === "failed") f.receipt.outcome = "failed";
      expect(f.create).toThrow();
    });
  }
});
