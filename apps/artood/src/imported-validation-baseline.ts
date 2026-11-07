import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImportedValidationBaselineV1Schema, canonicalProductSourceTransferValueV1 as canonical, type ImportedValidationBaselineV1 } from "@artoo/domain";
import { captureProductSourceSnapshot, describeProductSourceSnapshot, encodeProductSourceSnapshot, type ProductSourceSnapshot } from "./product-source-snapshot.js";
import type { PreparedVerificationProfile } from "./verification.js";
import { MAX_BROWSER_EVIDENCE_PAGE_BYTES, type BrowserEvidenceContent, type BrowserEvidenceReadOptions } from "./browser-evidence.js";
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
declare const baselineBrand: unique symbol;
export interface PreparedValidationBaseline { readonly [baselineBrand]: true }
interface Retained {
  snapshot: ProductSourceSnapshot; descriptor: ImportedValidationBaselineV1; path: string; dev: number; ino: number;
  profileId: string; profileDigest: string; capsuleDigest: string; size: number;
  files: ReadonlyMap<string, { path: string; base64: string; checksum: string; size: number }>;
}
const retained = new WeakMap<PreparedValidationBaseline, Retained>();
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
/** Only this capture path issues a reviewer baseline token; decoding retained JSON cannot issue one. */
export function retainImportedValidationBaseline(profile: PreparedVerificationProfile, storeRoot: string, validationId: string,
  expectedSubject: string, assertCurrent: () => void): PreparedValidationBaseline {
  assertCurrent();
  const snapshot = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: expectedSubject });
  const described = describeProductSourceSnapshot(snapshot), bytes = encodeProductSourceSnapshot(snapshot);
  // These are content projections of our original captured token, not recovered execution authority.
  const capsule = JSON.parse(bytes.toString("utf8")) as { manifest: { entries: { kind: string; path: string; checksum?: string; size?: number }[] }; files: { path: string; base64: string }[] };
  const snapshotId = "validation-baseline-" + sha(canonical([validationId, described.capsule_digest])).slice(7);
  const files = new Map<string, { path: string; base64: string; checksum: string; size: number }>();
  const projected = capsule.manifest.entries.flatMap(entry => {
    if (entry.kind !== "file") return [];
    const content = capsule.files.find(file => file.path === entry.path);
    if (!content || entry.checksum === undefined || entry.size === undefined) throw Error("Captured validation baseline omitted source bytes");
    const reference = "validation-source-" + sha(canonical([snapshotId, entry.path, entry.checksum])).slice(7);
    files.set(reference, { path: entry.path, base64: content.base64, checksum: entry.checksum, size: entry.size });
    return [{ path: entry.path, checksum: entry.checksum, size: entry.size, reference }];
  });
  const directories = capsule.manifest.entries.filter(entry => entry.kind === "directory").map(entry => entry.path);
  const descriptor = freeze(ImportedValidationBaselineV1Schema.parse({ version: 1, snapshot_id: snapshotId,
    subject_digest: expectedSubject, manifest_digest: sha(canonical({ directories, files: projected })), directories, files: projected }));
  assertCurrent();
  const path = join(storeRoot, "attestations", snapshotId + ".json"), fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync.native(path) !== path) throw Error("Retained baseline physical identity is invalid");
  const token = Object.freeze({}) as PreparedValidationBaseline;
  retained.set(token, { snapshot, descriptor, path, dev: stat.dev, ino: stat.ino, profileId: profile.id, profileDigest: profile.digest,
    capsuleDigest: described.capsule_digest, size: bytes.length, files });
  assertCurrent(); assertImportedValidationBaseline(token); return token;
}
export function assertImportedValidationBaseline(token: PreparedValidationBaseline): ImportedValidationBaselineV1 {
  const saved = retained.get(token); if (!saved) throw Error("Original retained validation snapshot object is required");
  const stat = lstatSync(saved.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== saved.dev || stat.ino !== saved.ino
    || stat.size !== saved.size || stat.size > 12 * 1024 * 1024 || realpathSync.native(saved.path) !== saved.path)
    throw Error("Retained validation baseline identity changed");
  const bytes = readFileSync(saved.path), original = encodeProductSourceSnapshot(saved.snapshot);
  const after = lstatSync(saved.path);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== saved.dev || after.ino !== saved.ino
    || after.size !== saved.size || realpathSync.native(saved.path) !== saved.path || sha(bytes) !== saved.capsuleDigest || !bytes.equals(original))
    throw Error("Retained validation baseline no longer contains the original captured bytes");
  return saved.descriptor;
}
export function readImportedValidationBaseline(token: PreparedValidationBaseline, reference: string, requestId: string,
  options: BrowserEvidenceReadOptions = {}): BrowserEvidenceContent {
  const descriptor = assertImportedValidationBaseline(token), saved = retained.get(token)!;
  const file = saved.files.get(reference); if (!file) throw Error("Reference is outside the original retained validation snapshot");
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.length !== file.size || sha(bytes) !== file.checksum) throw Error("Original baseline content projection changed");
  let content: { encoding: "utf8" | "base64"; content: string };
  try { content = { encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { content = { encoding: "base64", content: file.base64 }; }
  const json = Buffer.from(JSON.stringify({ version: 1, kind: "retained-validation-baseline-file", subject_digest: descriptor.subject_digest,
    path: file.path, checksum: file.checksum, size: file.size, ...content })), checksum = sha(json);
  if (options.expected_checksum !== undefined && options.expected_checksum !== checksum) throw Error("Baseline page checksum changed");
  const offset = options.offset ?? 0, limit = options.limit ?? MAX_BROWSER_EVIDENCE_PAGE_BYTES;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > json.length || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BROWSER_EVIDENCE_PAGE_BYTES)
    throw Error("Baseline evidence pagination is outside the fixed bound");
  if (offset < json.length && (json[offset]! & 0xc0) === 0x80) throw Error("Baseline page must start at a UTF-8 boundary");
  let end = Math.min(json.length, offset + limit); while (end > offset && end < json.length && (json[end]! & 0xc0) === 0x80) end--;
  if (end === offset && offset < json.length) throw Error("Baseline page limit cannot contain the next UTF-8 character");
  return { reference, provenance: { requestId, profileId: saved.profileId, profileDigest: saved.profileDigest, subjectDigest: descriptor.subject_digest,
    checkId: "retained-validation-baseline", scope: "final", bundle_id: descriptor.snapshot_id, manifest_digest: descriptor.manifest_digest },
    mime_type: "application/json", text: json.subarray(offset, end).toString("utf8"), checksum, size: json.length,
    offset, next_offset: end < json.length ? end : null, eof: end === json.length };
}
