import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, writeSync, type Stats } from "node:fs";
import { join } from "node:path";
import { assertLocallyPreparedVerificationProfile, subjectManifest, type PreparedVerificationProfile } from "./verification.js";

const MAX_ENTRIES = 512, MAX_CONTENT_BYTES = 8 * 1024 * 1024, MAX_CAPSULE_BYTES = 12 * 1024 * 1024;
const SCOPES = [".artoo/product", "product"] as const;
const SCOPE = "immutable product bytes only; no accepted provenance, verification or execution authority" as const;
const sha = (bytes: string | Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
function fail(message: string): never { throw new Error(`Product source snapshot: ${message}`); }

type Entry = { path: string; kind: "directory" } | { path: string; kind: "file"; checksum: string; size: number };
export interface ProductSourceBindingV1 {
  readonly project_id: string;
  readonly profile_id: string;
  readonly profile_digest: string;
  readonly subject_digest: string;
}
export interface ProductSourceSnapshotDescriptorV1 {
  readonly version: 1;
  readonly capsule_digest: string;
  readonly manifest_digest: string;
  readonly source: ProductSourceBindingV1;
  readonly entries: number;
  readonly content_bytes: number;
  readonly scope: typeof SCOPE;
}
interface Capsule {
  version: 1;
  kind: "artoo.product-source.v1";
  source: ProductSourceBindingV1;
  manifest: { entries: Entry[] };
  manifest_digest: string;
  files: { path: string; base64: string }[];
}
declare const snapshotBrand: unique symbol;
/** Local content token only. It cannot grant a writer, server provenance or a verification outcome. */
export interface ProductSourceSnapshot { readonly [snapshotBrand]: true }
interface SnapshotState { bytes: Buffer; capsule: Capsule; descriptor: ProductSourceSnapshotDescriptorV1 }
const snapshots = new WeakMap<ProductSourceSnapshot, SnapshotState>();
function state(snapshot: ProductSourceSnapshot): SnapshotState {
  const found = snapshots.get(snapshot);
  if (!found) fail("an original locally captured or decoded content token is required");
  return found;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function issue(bytes: Buffer, capsule: Capsule): ProductSourceSnapshot {
  const token = Object.freeze({}) as ProductSourceSnapshot;
  const descriptor = freeze({ version: 1 as const, capsule_digest: sha(bytes), manifest_digest: capsule.manifest_digest,
    source: { ...capsule.source }, entries: capsule.manifest.entries.length,
    content_bytes: capsule.manifest.entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0), scope: SCOPE });
  snapshots.set(token, { bytes: Buffer.from(bytes), capsule: freeze(capsule), descriptor });
  return token;
}
function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) fail(`invalid ${label} fields`);
  return value as Record<string, unknown>;
}
function binding(value: unknown): ProductSourceBindingV1 {
  const raw = object(value, ["project_id", "profile_id", "profile_digest", "subject_digest"], "source binding");
  for (const key of ["project_id", "profile_id"] as const) {
    if (typeof raw[key] !== "string" || !raw[key] || raw[key].length > 128 || /[\u0000-\u001f\u007f]/u.test(raw[key])) fail("invalid source identity");
  }
  if (!digest(raw.profile_digest) || !digest(raw.subject_digest)) fail("invalid source digest");
  return { project_id: raw.project_id as string, profile_id: raw.profile_id as string,
    profile_digest: raw.profile_digest, subject_digest: raw.subject_digest };
}
function portablePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f\u007f<>:"|?*\\]/u.test(value)
    || !SCOPES.some(root => value === root || value.startsWith(`${root}/`))) fail("path is outside the portable product scope");
  for (const component of value.split("/")) {
    if (!component || component === "." || component === ".." || /[. ]$/.test(component) || component.toLowerCase() === ".git"
      || /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(component)) fail("unsupported portable path component");
  }
  return value;
}
function manifest(raw: unknown): { entries: Entry[] } {
  const value = object(raw, ["entries"], "manifest");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) fail("manifest exceeds its entry bound");
  let total = 0;
  const entries = value.entries.map((input: unknown): Entry => {
    const raw = input as { kind?: unknown } | null;
    const item = object(input, raw?.kind === "directory" ? ["path", "kind"] : ["path", "kind", "checksum", "size"], "entry");
    const path = portablePath(item.path);
    if (item.kind === "directory") return { path, kind: "directory" };
    if (item.kind !== "file" || !digest(item.checksum) || !Number.isSafeInteger(item.size) || (item.size as number) < 0
      || (item.size as number) > MAX_CONTENT_BYTES) fail("invalid file entry");
    total += item.size as number;
    if (total > MAX_CONTENT_BYTES) fail("content exceeds its byte bound");
    return { path, kind: "file", checksum: item.checksum, size: item.size as number };
  });
  const paths = new Map<string, Entry>(), folded = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const key = entry.path.normalize("NFC").toUpperCase();
    if (folded.has(key) || index && compare(entries[index - 1]!.path, entry.path) >= 0) fail("duplicate, case-colliding or unsorted manifest path");
    folded.add(key); paths.set(entry.path, entry);
  }
  for (const root of SCOPES) if (paths.get(root)?.kind !== "directory") fail("both complete product scopes must be directories");
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let count = 1; count < parts.length; count++) {
      const parent = parts.slice(0, count).join("/");
      if (parent !== ".artoo" && paths.get(parent)?.kind !== "directory") fail("manifest is missing a directory or places content below a file");
    }
  }
  return { entries };
}
function parseCapsule(bytes: Buffer): Capsule {
  if (bytes.length > MAX_CAPSULE_BYTES) fail("capsule exceeds its byte bound");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("capsule is not valid JSON"); }
  const raw = object(value, ["version", "kind", "source", "manifest", "manifest_digest", "files"], "capsule");
  if (raw.version !== 1 || raw.kind !== "artoo.product-source.v1") fail("unsupported capsule version");
  const source = binding(raw.source), parsedManifest = manifest(raw.manifest), manifestDigest = sha(JSON.stringify(parsedManifest));
  if (raw.manifest_digest !== manifestDigest) fail("manifest digest differs from its entries");
  const fileEntries = parsedManifest.entries.filter((entry): entry is Extract<Entry, { kind: "file" }> => entry.kind === "file");
  if (!Array.isArray(raw.files) || raw.files.length !== fileEntries.length) fail("file bytes do not exactly cover the manifest");
  const files = raw.files.map((input: unknown, index: number) => {
    const raw = object(input, ["path", "base64"], "file bytes"), expected = fileEntries[index]!;
    if (raw.path !== expected.path || typeof raw.base64 !== "string" || raw.base64.length > 4 * Math.ceil(expected.size / 3)) fail("file byte binding differs");
    const bytes = Buffer.from(raw.base64, "base64");
    if (bytes.length !== expected.size || bytes.toString("base64") !== raw.base64 || sha(bytes) !== expected.checksum) fail("file bytes differ from the manifest");
    return { path: expected.path, base64: raw.base64 };
  });
  const capsule: Capsule = { version: 1, kind: "artoo.product-source.v1", source, manifest: parsedManifest,
    manifest_digest: manifestDigest, files };
  if (!bytes.equals(Buffer.from(JSON.stringify(capsule)))) fail("capsule must use its exact canonical encoding");
  return capsule;
}
function assertProfile(profile: PreparedVerificationProfile, expectedDigest: string): void {
  if (!digest(expectedDigest) || profile.digest !== expectedDigest) fail("local profile digest differs from the expected binding");
  assertLocallyPreparedVerificationProfile(profile);
  if (profile.subject_paths.length !== SCOPES.length || [...profile.subject_paths].sort(compare).some((path, index) => path !== SCOPES[index])) {
    fail("transfer v1 requires exactly product and .artoo/product subject scopes");
  }
}
function observedManifest(profile: PreparedVerificationProfile) {
  const subject = subjectManifest(profile);
  return { subject, manifest: manifest({ entries: [
    ...subject.directories.map(path => ({ path, kind: "directory" as const })),
    ...[...subject.files.values()].map(file => ({ path: file.path, kind: "file" as const, checksum: file.checksum, size: file.size })),
  ].sort((a, b) => compare(a.path, b.path)) }) };
}
function directory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) fail("directory identity is not a physical path");
  return stat;
}
function sameDirectory(path: string, before: Stats): void {
  const now = directory(path);
  if (now.dev !== before.dev || now.ino !== before.ino || now.birthtimeMs !== before.birthtimeMs) fail("directory identity changed");
}
function ancestors(root: string, path: string): void {
  directory(root);
  const parts = path.split("/");
  for (let count = 1; count < parts.length; count++) directory(join(root, ...parts.slice(0, count)));
}
function readExactFile(root: string, entry: Extract<Entry, { kind: "file" }>): Buffer {
  ancestors(root, entry.path);
  const path = join(root, entry.path), before = lstatSync(path);
  const valid = (stat: Stats) => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === entry.size;
  if (!valid(before) || realpathSync.native(path) !== path) fail("source file is not an exact regular file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!valid(opened) || opened.dev !== before.dev || opened.ino !== before.ino) fail("source file changed before opening");
    const bytes = Buffer.alloc(entry.size + 1); let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, Math.min(64 * 1024, bytes.length - length), length);
      if (!count) break; length += count;
    }
    const named = lstatSync(path), finished = fstatSync(fd);
    ancestors(root, entry.path);
    if (realpathSync.native(path) !== path || [named, finished].some(stat => !valid(stat) || stat.dev !== before.dev || stat.ino !== before.ino
      || stat.mtimeMs !== before.mtimeMs) || length !== entry.size) fail("source file changed while reading");
    const result = bytes.subarray(0, length);
    // The exact expected content digest, followed by a full source remeasurement,
    // is the authority here. Windows first-open access metadata can alter ctime.
    if (sha(result) !== entry.checksum) fail("source bytes differ from the measured digest");
    return result;
  } finally { closeSync(fd); }
}

/** Captures actual measured bytes; declared run/evidence provenance belongs to the future authenticated connection layer. */
export function captureProductSourceSnapshot(input: { profile: PreparedVerificationProfile; expectedProfileDigest: string;
  expectedSubjectDigest: string }): ProductSourceSnapshot {
  const { profile, expectedProfileDigest, expectedSubjectDigest } = input;
  assertProfile(profile, expectedProfileDigest);
  if (!digest(expectedSubjectDigest)) fail("an exact source subject digest is required");
  const rootIdentity = directory(profile.workspace_root), before = observedManifest(profile);
  if (before.subject.digest !== expectedSubjectDigest) fail("source subject differs from the expected binding");
  const capsule: Capsule = { version: 1, kind: "artoo.product-source.v1", source: { project_id: profile.project_id, profile_id: profile.id,
    profile_digest: profile.digest, subject_digest: expectedSubjectDigest }, manifest: before.manifest,
    manifest_digest: sha(JSON.stringify(before.manifest)), files: before.manifest.entries.flatMap(entry => entry.kind === "file"
      ? [{ path: entry.path, base64: readExactFile(profile.workspace_root, entry).toString("base64") }] : []) };
  assertProfile(profile, expectedProfileDigest); sameDirectory(profile.workspace_root, rootIdentity);
  if (observedManifest(profile).subject.digest !== expectedSubjectDigest) fail("source changed while capturing the snapshot");
  const bytes = Buffer.from(JSON.stringify(capsule));
  return issue(bytes, parseCapsule(bytes));
}

/** Decoding establishes content integrity only. Expected bindings must later come from authenticated server provenance. */
export function decodeProductSourceSnapshot(bytes: Uint8Array, expected: {
  capsuleDigest: string; manifestDigest: string; source: ProductSourceBindingV1;
}): ProductSourceSnapshot {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CAPSULE_BYTES) fail("capsule exceeds its byte bound");
  const copy = Buffer.from(bytes), source = binding(expected.source);
  if (!digest(expected.capsuleDigest) || !digest(expected.manifestDigest) || sha(copy) !== expected.capsuleDigest) fail("capsule digest differs from the expected binding");
  const capsule = parseCapsule(copy);
  if (capsule.manifest_digest !== expected.manifestDigest || JSON.stringify(capsule.source) !== JSON.stringify(source)) fail("source or manifest differs from the expected binding");
  return issue(copy, capsule);
}
export function encodeProductSourceSnapshot(snapshot: ProductSourceSnapshot): Buffer { return Buffer.from(state(snapshot).bytes); }
export function describeProductSourceSnapshot(snapshot: ProductSourceSnapshot): ProductSourceSnapshotDescriptorV1 {
  return structuredClone(state(snapshot).descriptor);
}
export interface ProductSourceImportReceiptV1 {
  readonly version: 1;
  readonly capsule_digest: string;
  readonly manifest_digest: string;
  readonly source: ProductSourceBindingV1;
  readonly destination: ProductSourceBindingV1 & { readonly workspace_root: string };
  readonly scope: typeof SCOPE;
}
export class ProductSourceImportError extends Error {
  readonly execution_authorized = false;
  readonly destination_retained = true;
  constructor(cause: unknown, readonly created_paths: readonly string[]) {
    super("Product source import is incomplete; destination contents are retained and no execution is authorized", { cause });
    this.name = "ProductSourceImportError";
  }
}

/** Fresh empty workspaces only. The caller must own the workspace exclusively.
 * This primitive neither journals recovery nor activates execution. Its connecting
 * layer must use qualified protected storage and durable admission before launch. */
export function materializeProductSourceSnapshot(input: { snapshot: ProductSourceSnapshot; expectedCapsuleDigest: string;
  profile: PreparedVerificationProfile; expectedProfileDigest: string }): ProductSourceImportReceiptV1 {
  const original = state(input.snapshot), { profile } = input;
  if (!digest(input.expectedCapsuleDigest) || original.descriptor.capsule_digest !== input.expectedCapsuleDigest) fail("import capsule differs from the exact selected input");
  assertProfile(profile, input.expectedProfileDigest);
  if (profile.project_id !== original.capsule.source.project_id) fail("destination project differs from the source binding");
  const root = profile.workspace_root, rootIdentity = directory(root), created: string[] = [];
  const directories = new Map<string, Stats>([[root, rootIdentity]]);
  const assertDirectories = () => { for (const [path, identity] of directories) sameDirectory(path, identity); };
  try {
    if (readdirSync(root).length) fail("destination must be empty; prior or unknown content is never overwritten");
    for (const entry of original.capsule.manifest.entries.filter(entry => entry.kind === "directory")) {
      const parts = entry.path.split("/");
      for (let count = 1; count <= parts.length; count++) {
        const relative = parts.slice(0, count).join("/"), target = join(root, ...parts.slice(0, count));
        if (directories.has(target)) continue;
        assertDirectories(); mkdirSync(target, { mode: 0o700 }); created.push(relative);
        directories.set(target, directory(target)); assertDirectories();
      }
    }
    for (const file of original.capsule.files) {
      const target = join(root, file.path), bytes = Buffer.from(file.base64, "base64");
      assertDirectories(); ancestors(root, file.path);
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created.push(file.path);
      try {
        const opened = fstatSync(fd);
        const assertFile = () => {
          assertDirectories();
          const named = lstatSync(target), handle = fstatSync(fd);
          if (realpathSync.native(target) !== target || [named, handle].some(stat => !stat.isFile() || stat.isSymbolicLink()
            || stat.nlink !== 1 || stat.dev !== opened.dev || stat.ino !== opened.ino)) fail("destination file identity changed");
        };
        assertFile(); let offset = 0;
        while (offset < bytes.length) {
          assertFile(); const written = writeSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
          if (!written) fail("destination write made no progress"); offset += written;
        }
        fsyncSync(fd); assertFile();
      } finally { closeSync(fd); }
    }
    assertDirectories(); assertProfile(profile, input.expectedProfileDigest);
    if (JSON.stringify(readdirSync(root).sort(compare)) !== JSON.stringify([".artoo", "product"])
      || JSON.stringify(readdirSync(join(root, ".artoo"))) !== JSON.stringify(["product"])) fail("unexpected unmeasured destination content");
    const after = observedManifest(profile);
    if (sha(JSON.stringify(after.manifest)) !== original.descriptor.manifest_digest) fail("materialized source differs from the exact selected manifest");
    assertDirectories();
    return freeze({ version: 1 as const, capsule_digest: original.descriptor.capsule_digest, manifest_digest: original.descriptor.manifest_digest,
      source: { ...original.capsule.source }, destination: { project_id: profile.project_id, profile_id: profile.id,
        profile_digest: profile.digest, subject_digest: after.subject.digest, workspace_root: root }, scope: SCOPE });
  } catch (error) { throw new ProductSourceImportError(error, Object.freeze([...created])); }
}
