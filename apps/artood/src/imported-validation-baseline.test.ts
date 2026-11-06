// Actual bounded file IO only. These tests do not launch a verifier, provider or product.
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareVerificationProfiles, subjectManifest } from "./verification.js";
import { retainImportedValidationBaseline, assertImportedValidationBaseline, readImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(root) !== realpathSync.native(tmpdir()) || !root.split(/[\\/]/).at(-1)!.startsWith("artoo-validation-baseline-")) throw Error("Unexpected fixture cleanup root");
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-validation-baseline-"))); roots.push(root);
  const source = join(root, "source"), store = join(root, "store"), verifier = join(root, "verifier.cjs");
  mkdirSync(join(source, ".artoo", "product"), { recursive: true }); mkdirSync(join(source, "product", "empty"), { recursive: true });
  mkdirSync(join(store, "attestations"), { recursive: true }); writeFileSync(verifier, "process.exit(0)\n");
  writeFileSync(join(source, ".artoo", "product", "research.json"), '{"controlled":"content only"}');
  writeFileSync(join(source, "product", "index.html"), "<h1>原始产品</h1>");
  const profile = prepareVerificationProfiles([{ id: "baseline-profile", project_id: "project", workspace_root: source,
    commands: [{ id: "fixture", argv: [verifier], timeout_ms: 1000 }], required_files: [], subject_paths: ["product", ".artoo/product"] }])[0]!;
  const expected = subjectManifest(profile).digest;
  const token = retainImportedValidationBaseline(profile, store, "validation", expected, () => {});
  return { root, source, store, profile, expected, token, descriptor: assertImportedValidationBaseline(token) };
}
describe("original retained validation baseline", () => {
  it("keeps actual initial bytes and empty directories after the product changes", () => {
    const f = fixture(), file = f.descriptor.files.find(item => item.path === "product/index.html")!;
    expect(f.descriptor.directories).toContain("product/empty");
    writeFileSync(join(f.source, "product", "index.html"), "<h1>New product</h1>");
    const content = readImportedValidationBaseline(f.token, file.reference, "review-before");
    expect(content.mime_type).toBe("application/json");
    if (content.mime_type !== "application/json") throw Error("Expected JSON baseline");
    expect(JSON.parse(content.text)).toMatchObject({ path: file.path, content: "<h1>原始产品</h1>", subject_digest: f.expected });
    expect(content.provenance.manifest_digest).toBe(f.descriptor.manifest_digest);
  });
  it("does not grant reads from a cloned token, public descriptor, path or unknown reference", () => {
    const f = fixture();
    expect(() => assertImportedValidationBaseline({} as PreparedValidationBaseline)).toThrow("Original retained");
    expect(() => readImportedValidationBaseline(f.descriptor as unknown as PreparedValidationBaseline, f.descriptor.files[0]!.reference, "review")).toThrow();
    for (const ref of ["product/index.html", join(f.source, "product", "index.html"), "../secret", "unknown"])
      expect(() => readImportedValidationBaseline(f.token, ref, "review")).toThrow("outside");
  });
  it("rejects corrupted retained capsule bytes and does not recover authority from JSON", () => {
    const f = fixture(), path = join(f.store, "attestations", readdirSync(join(f.store, "attestations"))[0]!);
    const bytes = readFileSync(path); bytes[bytes.length - 2] = bytes[bytes.length - 2] === 32 ? 33 : 32; writeFileSync(path, bytes);
    expect(() => assertImportedValidationBaseline(f.token)).toThrow("original captured bytes");
    expect(() => readImportedValidationBaseline(f.token, f.descriptor.files[0]!.reference, "review")).toThrow();
  });
  it("returns bounded checksum-bound UTF-8 pages and rejects invalid offsets", () => {
    const f = fixture(), reference = f.descriptor.files.find(item => item.path === "product/index.html")!.reference;
    let offset = 0, text = "", checksum: string | undefined;
    for (;;) {
      const page = readImportedValidationBaseline(f.token, reference, "review", { offset, limit: 13, expected_checksum: checksum });
      if (page.mime_type !== "application/json") throw Error("Expected JSON baseline");
      checksum ??= page.checksum; text += page.text;
      if (page.eof) break; offset = page.next_offset!;
    }
    expect(JSON.parse(text).content).toBe("<h1>原始产品</h1>");
    expect(() => readImportedValidationBaseline(f.token, reference, "review", { offset: -1 })).toThrow("pagination");
    expect(() => readImportedValidationBaseline(f.token, reference, "review", { expected_checksum: "sha256:" + "0".repeat(64) })).toThrow("checksum");
  });
});
