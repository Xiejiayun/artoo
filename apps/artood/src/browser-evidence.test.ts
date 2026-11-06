import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { StaticWebAcceptanceReport } from "@artoo/domain";
import { readBrowserEvidence, sealBrowserEvidence, validateBrowserEvidenceRoot } from "./browser-evidence.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a54cAAAAASUVORK5CYII=", "base64");
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-browser-evidence-"))); roots.push(root);
  const evidenceRoot = join(root, "evidence"), workspace = join(root, "workspace"); mkdirSync(evidenceRoot); mkdirSync(workspace);
  const binding = { requestId: "preview_fixture", profileId: "protected", profileDigest: sha("profile"), subjectDigest: sha("source"), checkId: "browser", scope: "preview" as const };
  const directory = join(evidenceRoot, sha(binding.requestId).slice(7)); mkdirSync(directory);
  const report: StaticWebAcceptanceReport = { version: 1, format: "static-web-acceptance.v1", stage: "design", passed: true,
    requirements: 1, cases: [{ case_id: "prototype", viewport: 1, assertions: 0, screenshot_digest: sha(image) }] };
  writeFileSync(join(directory, "result.json"), JSON.stringify(report)); writeFileSync(join(directory, "prototype-1.png"), image);
  return { root, workspace, directory, evidenceRoot, binding, report };
}
describe("node-owned browser evidence", () => {
  it("pages JSON evidence with a whole-document checksum and UTF-8 boundaries while preserving full reads", () => {
    const f = fixture(); f.binding.profileId = "配置😀检查";
    const bundle = sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report });
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    const full = readBrowserEvidence(grant, bundle.bundle_id);
    expect(full.mime_type).toBe("application/json"); if (full.mime_type !== "application/json") throw new Error("Expected JSON fixture");
    expect(full).not.toHaveProperty("offset"); expect(full).not.toHaveProperty("checksum");
    const checksum = sha(full.text), bytes = Buffer.from(full.text, "utf8");
    let offset = 0, combined = "", finished = false;
    for (let index = 0; index < 256; index++) {
      const page = readBrowserEvidence(grant, bundle.bundle_id, { offset, limit: 16, ...(offset ? { expected_checksum: checksum } : {}) });
      if (page.mime_type !== "application/json") throw new Error("Expected JSON page");
      expect(page.checksum).toBe(checksum); expect(page.offset).toBe(offset); expect(page.size).toBe(bytes.length);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(16); combined += page.text;
      if (page.eof) { expect(page.next_offset).toBeNull(); finished = true; break; }
      expect(page.next_offset).toBe(offset + Buffer.byteLength(page.text)); offset = page.next_offset!;
    }
    expect(finished).toBe(true); expect(combined).toBe(full.text);
    const emoji = bytes.indexOf(Buffer.from("😀"));
    expect(() => readBrowserEvidence(grant, bundle.bundle_id, { offset: emoji + 1, expected_checksum: checksum })).toThrow(/UTF-8 character boundary/);
    expect(() => readBrowserEvidence(grant, bundle.bundle_id, { offset: 1 })).toThrow(/expected_checksum/);
    expect(() => readBrowserEvidence(grant, bundle.bundle_id, { offset: 0, expected_checksum: sha("different") })).toThrow(/checksum changed/);
    expect(() => readBrowserEvidence(grant, bundle.bundle_id, { offset: bytes.length + 1, expected_checksum: checksum })).toThrow(/beyond/);
    for (const options of [{ limit: 3 }, { limit: 16385 }, { offset: -1 }, { offset: Number.NaN }, { expected_checksum: "invalid" }]) {
      expect(() => readBrowserEvidence(grant, bundle.bundle_id, options)).toThrow(/pagination/);
    }
    expect(() => readBrowserEvidence(grant, bundle.case_refs[0]!.screenshot_ref, { offset: 0, limit: 4096 })).toThrow(/only for JSON/);
    const manifest = join(f.directory, `sealed-${sha(f.binding.checkId).slice(7)}.json`);
    chmodSync(manifest, 0o600);
    writeFileSync(manifest, readFileSync(manifest, "utf8") + " ");
    expect(() => readBrowserEvidence(grant, bundle.bundle_id, { offset: 16, expected_checksum: checksum })).toThrow(/manifest checksum/);
  });
  it("seals actual bytes and reopens only a matching request/source grant", () => {
    const f = fixture(), bundle = sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report });
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    expect(readBrowserEvidence(grant, bundle.bundle_id)).toMatchObject({ mime_type: "application/json", provenance: { scope: "preview", subjectDigest: f.binding.subjectDigest } });
    const actual = readBrowserEvidence(grant, bundle.case_refs[0]!.screenshot_ref);
    expect(actual.mime_type).toBe("image/png");
    if (actual.mime_type === "image/png") expect(Buffer.from(actual.data, "base64")).toEqual(image);
    for (const binding of [{ subjectDigest: sha("another source") }, { requestId: "another_request" }, { scope: "final" as const }]) expect(() => readBrowserEvidence({ ...grant, ...binding }, bundle.bundle_id)).toThrow();
    expect(() => readBrowserEvidence(grant, "../../result.json")).toThrow();
    expect(() => readBrowserEvidence(grant, "image_unknown")).toThrow();
    expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report })).toThrow();
    expect(validateBrowserEvidenceRoot(f.evidenceRoot, [f.workspace])).toBe(f.evidenceRoot);
    expect(() => validateBrowserEvidenceRoot(f.root, [f.workspace])).toThrow(/outside/);
    expect(() => validateBrowserEvidenceRoot(f.workspace, [f.workspace])).toThrow(/outside/);
  });
  it("rejects output mismatch, image tampering and hard links", () => {
    const f = fixture();
    expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: { ...f.report, stage: "implementation" } })).toThrow(/differs/);
    const screenshot = join(f.directory, "prototype-1.png"); linkSync(screenshot, join(f.root, "linked.png"));
    expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report })).toThrow(/file/); rmSync(join(f.root, "linked.png"));
    const bundle = sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report: f.report });
    const grant = { ...f.binding, evidenceRoot: f.evidenceRoot, bundle_id: bundle.bundle_id, manifest_digest: bundle.manifest_digest };
    writeFileSync(screenshot, Buffer.concat([image, Buffer.from("changed")]));
    expect(() => readBrowserEvidence(grant, bundle.case_refs[0]!.screenshot_ref)).toThrow(/changed/);
    writeFileSync(join(f.directory, "result.json"), JSON.stringify({ ...f.report, requirements: 2 }));
    expect(() => readBrowserEvidence(grant, bundle.bundle_id)).toThrow(/changed/);
  });
  it("rejects a screenshot whose actual width differs from the declared viewport", () => {
    const f = fixture();
    const report = { ...f.report, cases: [{ ...f.report.cases[0]!, viewport: 320 }] };
    writeFileSync(join(f.directory, "result.json"), JSON.stringify(report));
    writeFileSync(join(f.directory, "prototype-320.png"), image);
    expect(() => sealBrowserEvidence({ ...f.binding, evidenceRoot: f.evidenceRoot, report })).toThrow(/width differs/);
  });
});
