import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareVerificationProfiles, subjectManifest, type PreparedVerificationProfile } from "./verification.js";
import { captureProductSourceSnapshot, decodeProductSourceSnapshot, describeProductSourceSnapshot, encodeProductSourceSnapshot,
  materializeProductSourceSnapshot, ProductSourceImportError, type ProductSourceSnapshot } from "./product-source-snapshot.js";

vi.mock("node:fs", async load => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync), closeSync: vi.fn(actual.closeSync), readSync: vi.fn(actual.readSync),
    mkdirSync: vi.fn(actual.mkdirSync), writeSync: vi.fn(actual.writeSync), fsyncSync: vi.fn(actual.fsyncSync) };
});
const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
const roots: string[] = [], sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
beforeEach(() => {
  vi.mocked(fs.openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync);
  vi.mocked(fs.mkdirSync).mockReset().mockImplementation(actual.mkdirSync);
  vi.mocked(fs.writeSync).mockReset().mockImplementation(actual.writeSync);
  vi.mocked(fs.fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
});
afterEach(() => { for (const root of roots.splice(0)) actual.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = actual.realpathSync.native(actual.mkdtempSync(join(tmpdir(), "artoo-source-content-"))); roots.push(root);
  const source = join(root, "source"), destination = join(root, "destination"), program = join(root, "fixture-verifier.cjs");
  actual.mkdirSync(source); actual.mkdirSync(destination);
  // Controlled local configuration only. These tests execute file IO, not a
  // verifier process, provider, server authorization or product acceptance run.
  actual.writeFileSync(program, "process.exit(0)\n");
  actual.mkdirSync(join(source, ".artoo", "product"), { recursive: true });
  actual.mkdirSync(join(source, "product", "empty-directory"), { recursive: true });
  actual.writeFileSync(join(source, ".artoo", "product", "research.json"), '{"fixture":"content-only"}\n');
  actual.writeFileSync(join(source, "product", "index.html"), "<h1>actual source bytes</h1>\n");
  actual.writeFileSync(join(source, "product", "empty.txt"), "");
  const profile = (workspace_root: string, id: string, project_id = "project_1") => prepareVerificationProfiles([{ id, project_id, workspace_root,
    commands: [{ id: "fixture", argv: [program], timeout_ms: 1000 }], required_files: [], subject_paths: ["product", ".artoo/product"] }])[0]!;
  const sourceProfile = profile(source, "source"), destinationProfile = profile(destination, "destination");
  const sourceDigest = subjectManifest(sourceProfile).digest;
  const capture = () => captureProductSourceSnapshot({ profile: sourceProfile, expectedProfileDigest: sourceProfile.digest, expectedSubjectDigest: sourceDigest });
  const importSnapshot = (snapshot: ProductSourceSnapshot, selected = destinationProfile) => materializeProductSourceSnapshot({ snapshot,
    expectedCapsuleDigest: describeProductSourceSnapshot(snapshot).capsule_digest, profile: selected, expectedProfileDigest: selected.digest });
  return { root, source, destination, program, sourceProfile, destinationProfile, sourceDigest, profile, capture, importSnapshot,
    sourceFile: join(source, "product", "index.html"), targetFile: join(destination, "product", "index.html") };
}
function decode(snapshot: ProductSourceSnapshot, bytes = encodeProductSourceSnapshot(snapshot)) {
  const descriptor = describeProductSourceSnapshot(snapshot);
  return decodeProductSourceSnapshot(bytes, { capsuleDigest: descriptor.capsule_digest, manifestDigest: descriptor.manifest_digest, source: descriptor.source });
}
function edited(snapshot: ProductSourceSnapshot, edit: (capsule: any) => void): { bytes: Buffer; expected: Parameters<typeof decodeProductSourceSnapshot>[1] } {
  const capsule = JSON.parse(encodeProductSourceSnapshot(snapshot).toString("utf8")); edit(capsule);
  capsule.manifest_digest = sha(JSON.stringify(capsule.manifest));
  const bytes = Buffer.from(JSON.stringify(capsule));
  return { bytes, expected: { capsuleDigest: sha(bytes), manifestDigest: capsule.manifest_digest, source: capsule.source } };
}

describe("bounded immutable product content capsules (no authorization)", () => {
  it("captures real files and empty directories and imports into a different exact local profile", () => {
    const f = fixture(), snapshot = f.capture(), received = decode(snapshot), receipt = f.importSnapshot(received);
    expect(actual.readFileSync(f.targetFile)).toEqual(actual.readFileSync(f.sourceFile));
    expect(actual.readdirSync(join(f.destination, "product", "empty-directory"))).toEqual([]);
    expect(actual.readFileSync(join(f.destination, "product", "empty.txt")).length).toBe(0);
    expect(receipt.source).toEqual({ project_id: "project_1", profile_id: "source", profile_digest: f.sourceProfile.digest, subject_digest: f.sourceDigest });
    expect(receipt.destination).toMatchObject({ profile_id: "destination", profile_digest: f.destinationProfile.digest,
      workspace_root: f.destination, subject_digest: subjectManifest(f.destinationProfile).digest });
    expect(receipt.scope).toContain("no accepted provenance, verification or execution authority");
    expect(Object.isFrozen(receipt.destination)).toBe(true);
  });

  it("keeps buffers and public descriptors detached from the immutable token", () => {
    const f = fixture(), snapshot = f.capture(), original = encodeProductSourceSnapshot(snapshot), exposed = encodeProductSourceSnapshot(snapshot);
    exposed.fill(0); const descriptor = describeProductSourceSnapshot(snapshot);
    (descriptor.source as { profile_id: string }).profile_id = "tampered";
    expect(encodeProductSourceSnapshot(snapshot)).toEqual(original);
    expect(describeProductSourceSnapshot(snapshot).source.profile_id).toBe("source");
    const imported = decode(snapshot, original); original.fill(0);
    expect(() => f.importSnapshot(imported)).not.toThrow();
  });

  it("rejects cloned tokens and cloned prepared profile metadata", () => {
    const f = fixture(), snapshot = f.capture();
    expect(() => encodeProductSourceSnapshot({} as ProductSourceSnapshot)).toThrow(/original locally/);
    expect(() => captureProductSourceSnapshot({ profile: structuredClone(f.sourceProfile), expectedProfileDigest: f.sourceProfile.digest,
      expectedSubjectDigest: f.sourceDigest })).toThrow(/locally prepared/);
    expect(() => f.importSnapshot(snapshot, structuredClone(f.destinationProfile))).toThrow(/locally prepared/);
    expect(actual.readdirSync(f.destination)).toEqual([]);
  });

  it.each(["source-profile", "source-subject", "capsule", "manifest", "destination-profile", "project"])("requires the exact %s binding", kind => {
    const f = fixture(), snapshot = f.capture(), descriptor = describeProductSourceSnapshot(snapshot), wrong = sha("wrong");
    if (kind === "source-profile" || kind === "source-subject") {
      expect(() => captureProductSourceSnapshot({ profile: f.sourceProfile,
        expectedProfileDigest: kind === "source-profile" ? wrong : f.sourceProfile.digest,
        expectedSubjectDigest: kind === "source-subject" ? wrong : f.sourceDigest })).toThrow(/binding/);
    } else if (kind === "capsule" || kind === "manifest") {
      expect(() => decodeProductSourceSnapshot(encodeProductSourceSnapshot(snapshot), { capsuleDigest: kind === "capsule" ? wrong : descriptor.capsule_digest,
        manifestDigest: kind === "manifest" ? wrong : descriptor.manifest_digest, source: descriptor.source })).toThrow(/binding/);
    } else if (kind === "destination-profile") {
      expect(() => materializeProductSourceSnapshot({ snapshot, expectedCapsuleDigest: descriptor.capsule_digest,
        profile: f.destinationProfile, expectedProfileDigest: wrong })).toThrow(/binding/);
    } else expect(() => f.importSnapshot(snapshot, f.profile(f.destination, "destination", "other_project"))).toThrow(/project/);
    expect(actual.readdirSync(f.destination)).toEqual([]);
  });

  it("compares decoded source identity and subject to the expected source binding", () => {
    const f = fixture(), snapshot = f.capture(), descriptor = describeProductSourceSnapshot(snapshot);
    for (const change of [{ profile_id: "other" }, { profile_digest: sha("other") }, { subject_digest: sha("other") }, { project_id: "other" }]) {
      expect(() => decodeProductSourceSnapshot(encodeProductSourceSnapshot(snapshot), { capsuleDigest: descriptor.capsule_digest,
        manifestDigest: descriptor.manifest_digest, source: { ...descriptor.source, ...change } })).toThrow(/expected binding/);
    }
  });

  it.each(["product/../outside", "product/CON.txt", "product/com1", "product/LPT².txt", "product/file:stream", "product/trailing.",
    "product/trailing ", "product/.git/config", "product/a\\b", "product/aux.data", "/product/outside"])("rejects unsafe Windows/portable path %s even with matching envelope hashes", path => {
    const f = fixture(), snapshot = f.capture(), changed = edited(snapshot, capsule => {
      const file = capsule.manifest.entries.find((entry: any) => entry.path === "product/index.html"); file.path = path;
      capsule.files.find((file: any) => file.path === "product/index.html").path = path;
    });
    expect(() => decodeProductSourceSnapshot(changed.bytes, changed.expected)).toThrow(/path|scope|component/);
  });

  it("rejects case collisions and missing or extra file bytes", () => {
    const f = fixture(), snapshot = f.capture();
    for (const edit of [
      (capsule: any) => capsule.manifest.entries.push({ path: "product/INDEX.html", kind: "file", size: 0, checksum: sha("") }),
      (capsule: any) => capsule.files.pop(),
      (capsule: any) => capsule.files.push({ path: "product/extra", base64: "" }),
    ]) { const changed = edited(snapshot, edit); expect(() => decodeProductSourceSnapshot(changed.bytes, changed.expected)).toThrow(); }
  });

  it("rejects file/directory conflicts, missing empty scopes, and noncanonical or altered byte encodings", () => {
    const f = fixture(), snapshot = f.capture();
    for (const edit of [
      (capsule: any) => { capsule.manifest.entries = capsule.manifest.entries.filter((entry: any) => entry.path !== "product"); },
      (capsule: any) => { capsule.manifest.entries.find((entry: any) => entry.path === "product").kind = "file"; },
      (capsule: any) => { capsule.files[0].base64 += "!"; },
      (capsule: any) => { capsule.files[0].base64 = Buffer.from("different bytes").toString("base64"); },
      (capsule: any) => { capsule.unexpected_authority = "passed"; },
    ]) { const changed = edited(snapshot, edit); expect(() => decodeProductSourceSnapshot(changed.bytes, changed.expected)).toThrow(); }
    const bytes = Buffer.concat([encodeProductSourceSnapshot(snapshot), Buffer.from("\n")]), descriptor = describeProductSourceSnapshot(snapshot);
    expect(() => decodeProductSourceSnapshot(bytes, { capsuleDigest: sha(bytes), manifestDigest: descriptor.manifest_digest, source: descriptor.source })).toThrow(/canonical/);
  });

  it("enforces bounded entries, raw bytes and envelope bytes", () => {
    const f = fixture(), snapshot = f.capture();
    for (const edit of [
      (capsule: any) => { capsule.manifest.entries = Array.from({ length: 513 }, (_, i) => ({ path: `product/p${i}`, kind: "directory" })); },
      (capsule: any) => { capsule.manifest.entries.find((entry: any) => entry.kind === "file").size = 8 * 1024 * 1024 + 1; },
    ]) { const changed = edited(snapshot, edit); expect(() => decodeProductSourceSnapshot(changed.bytes, changed.expected)).toThrow(/bound|entry/); }
    const descriptor = describeProductSourceSnapshot(snapshot);
    expect(() => decodeProductSourceSnapshot(new Uint8Array(12 * 1024 * 1024 + 1), { capsuleDigest: descriptor.capsule_digest,
      manifestDigest: descriptor.manifest_digest, source: descriptor.source })).toThrow(/bound/);
  });

  it("rejects links, hard links and a source with a changed measured version", () => {
    const f = fixture(); actual.writeFileSync(f.sourceFile, "changed");
    expect(f.capture).toThrow(/source subject/);
    const outside = join(f.root, "outside"); actual.mkdirSync(outside);
    actual.symlinkSync(outside, join(f.source, "product", "junction"), process.platform === "win32" ? "junction" : "dir");
    expect(f.capture).toThrow(); actual.rmSync(join(f.source, "product", "junction"));
    actual.linkSync(f.sourceFile, join(f.source, "product", "hardlink"));
    expect(f.capture).toThrow();
  });
});

describe("actual filesystem stability with explicitly injected mutation timing", () => {
  it.each(["growth", "replace-after-copy"])("refuses source %s during capture", mode => {
    const f = fixture(); let opens = 0, sourceDescriptor: number | undefined, changed = false;
    vi.mocked(fs.openSync).mockImplementation(((...args: unknown[]) => {
      const fd = Reflect.apply(actual.openSync, actual, args) as number;
      if (args[0] === f.sourceFile && ++opens === 2) sourceDescriptor = fd;
      return fd;
    }) as typeof fs.openSync);
    if (mode === "growth") vi.mocked(fs.readSync).mockImplementation(((...args: unknown[]) => {
      const count = Reflect.apply(actual.readSync, actual, args) as number;
      if (args[0] === sourceDescriptor && count && !changed) { changed = true; actual.appendFileSync(f.sourceFile, "growth"); }
      return count;
    }) as typeof fs.readSync);
    else vi.mocked(fs.closeSync).mockImplementation(fd => {
      actual.closeSync(fd);
      if (fd === sourceDescriptor && !changed) { changed = true; actual.writeFileSync(f.sourceFile, "replacement"); }
    });
    expect(f.capture).toThrow(/changed|differs/); expect(changed).toBe(true);
  });

  it("leaves a nonempty destination and an already imported workspace untouched", () => {
    const f = fixture(), snapshot = f.capture(), sentinel = join(f.destination, "user.txt"); actual.writeFileSync(sentinel, "keep");
    expect(() => f.importSnapshot(snapshot)).toThrow(ProductSourceImportError);
    expect(actual.readdirSync(f.destination)).toEqual(["user.txt"]); expect(actual.readFileSync(sentinel, "utf8")).toBe("keep");
    actual.unlinkSync(sentinel); f.importSnapshot(snapshot);
    const before = subjectManifest(f.destinationProfile).digest;
    expect(() => f.importSnapshot(snapshot)).toThrow(ProductSourceImportError);
    expect(subjectManifest(f.destinationProfile).digest).toBe(before);
  });

  it("retains partial bytes on a write failure and cannot silently retry over them", () => {
    const f = fixture(), snapshot = f.capture(); let writes = 0;
    vi.mocked(fs.writeSync).mockImplementation(((...args: unknown[]) => {
      if (++writes === 2) throw new Error("injected disk write failure");
      return Reflect.apply(actual.writeSync, actual, args);
    }) as typeof fs.writeSync);
    let error: unknown; try { f.importSnapshot(snapshot); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ProductSourceImportError);
    expect(error).toMatchObject({ destination_retained: true, execution_authorized: false, created_paths: expect.arrayContaining(["product"]) });
    expect(actual.readdirSync(f.destination)).toEqual(expect.arrayContaining([".artoo", "product"]));
    vi.mocked(fs.writeSync).mockImplementation(actual.writeSync);
    expect(() => f.importSnapshot(snapshot)).toThrow(ProductSourceImportError);
  });

  it.each(["directory", "bytes", "verifier", "outside-scope"])("refuses a receipt after destination %s mutation", mode => {
    const f = fixture(), snapshot = f.capture(); let changed = false;
    vi.mocked(fs.fsyncSync).mockImplementation(fd => {
      actual.fsyncSync(fd);
      if (changed) return; changed = true;
      if (mode === "directory") {
        actual.renameSync(join(f.destination, "product"), join(f.destination, "retained-product")); actual.mkdirSync(join(f.destination, "product"));
      } else if (mode === "bytes") actual.writeFileSync(join(f.destination, ".artoo", "product", "research.json"), "changed");
      else if (mode === "verifier") actual.writeFileSync(f.program, "changed verifier");
      else actual.writeFileSync(join(f.destination, "unexpected.txt"), "unknown content");
    });
    expect(() => f.importSnapshot(snapshot)).toThrow(ProductSourceImportError); expect(changed).toBe(true);
    expect(actual.readdirSync(f.destination).length).toBeGreaterThan(0);
  });

  it("checks a changed destination root before writes and a substituted local profile before import", () => {
    const f = fixture(), snapshot = f.capture(), outside = join(f.root, "outside"); actual.mkdirSync(outside);
    actual.renameSync(f.destination, join(f.root, "retained-destination"));
    actual.symlinkSync(outside, f.destination, process.platform === "win32" ? "junction" : "dir");
    expect(() => f.importSnapshot(snapshot)).toThrow(); expect(actual.readdirSync(outside)).toEqual([]);
    expect(() => materializeProductSourceSnapshot({ snapshot, expectedCapsuleDigest: sha("other capsule"),
      profile: f.destinationProfile, expectedProfileDigest: f.destinationProfile.digest })).toThrow(/exact selected/);
  });
});
