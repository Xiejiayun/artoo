import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { assertCanonicalWindowsPath, assertNativeWindows, collectWindowsAclFacts, MAX_WINDOWS_AUDIT_PATHS,
  physicalWindowsDirectory, TRUSTED_WINDOWS_SYSTEM_SIDS, WINDOWS_ANCESTOR_REPLACEMENT_MASK, WINDOWS_MUTATION_MASK,
  windowsPathComponents, windowsPathKey, windowsPathsOverlap, type WindowsAclTarget } from "./windows-local-acl.js";

declare const storageBrand: unique symbol;
export interface PreparedWindowsReleaseStorage { readonly [storageBrand]: true }
export interface WindowsReleaseStorageInput {
  readonly directory: string;
  /** Complete fixed node write scope, never just the release verifier's workspace. */
  readonly writableWorkspaceRoots: readonly string[];
}
interface Identity { path: string; dev: bigint; ino: bigint; directory: boolean; ctimeNs: bigint; mtimeNs: bigint; size: bigint }
interface StorageState {
  directory: string; roots: readonly string[]; fixed: ReadonlyMap<string, Identity>; sid?: string;
  /** Stable existing layout directories. Artifact staging and files legitimately change across writes. */
  layout: Map<string, Identity>;
}
const authorities = new WeakMap<object, StorageState>();
const LAYOUT = ["operations", "attestations", "artifacts", "health"] as const;
function fail(reason: string): never { throw new Error(`Windows release storage: ${reason}`); }
function fact(path: string): Identity {
  assertCanonicalWindowsPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)
    || realpathSync.native(path) !== path) fail(`linked, aliased or unsupported path: ${path}`);
  return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
}
function identityEqual(left: Identity, right: Identity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.directory === right.directory;
}
function state(authority: PreparedWindowsReleaseStorage): StorageState {
  const saved = authorities.get(authority);
  if (!saved) fail("a locally prepared storage authority is required");
  return saved;
}
function inventory(saved: StorageState): Map<string, Identity> {
  const result = new Map<string, Identity>();
  const visit = (path: string, depth: number): void => {
    if (depth > 64 || result.size >= MAX_WINDOWS_AUDIT_PATHS) fail("storage inventory exceeds the Windows bound");
    const item = fact(path), key = windowsPathKey(path);
    if (result.has(key)) fail("case-aliased storage inventory");
    result.set(key, item);
    if (item.directory) for (const name of readdirSync(path).sort()) visit(win32.join(path, name), depth + 1);
  };
  visit(saved.directory, 0); return result;
}
function assertFixed(saved: StorageState): void {
  assertNativeWindows();
  for (const expected of saved.fixed.values()) if (!identityEqual(expected, fact(expected.path))) fail(`fixed physical identity changed: ${expected.path}`);
  for (const expected of saved.layout.values()) if (!identityEqual(expected, fact(expected.path))) fail(`storage layout identity changed: ${expected.path}`);
  for (const root of saved.roots) if (windowsPathsOverlap(saved.directory, root)) fail("storage overlaps an agent writable root");
}

/** Cheap serving check. This does not claim to re-audit ACLs; the current node user is trusted. */
export function assertWindowsReleaseStorage(authority: PreparedWindowsReleaseStorage, expectedDirectory: string): void {
  const saved = state(authority);
  if (saved.directory !== expectedDirectory) fail("storage authority is bound to another directory");
  assertFixed(saved);
}

/** Execute at preparation and serialized startup/publication/monitor write boundaries, never per HTTP file. */
export function auditWindowsReleaseStorage(authority: PreparedWindowsReleaseStorage, expectedDirectory: string): void {
  const saved = state(authority);
  assertWindowsReleaseStorage(authority, expectedDirectory);
  const before = inventory(saved), targets = new Map<string, WindowsAclTarget>();
  const ancestors = new Set(windowsPathComponents(saved.directory).slice(0, -1).map(windowsPathKey));
  for (const expected of saved.fixed.values()) targets.set(windowsPathKey(expected.path), {
    path: expected.path, directory: true, readAcl: ancestors.has(windowsPathKey(expected.path)),
  });
  for (const item of before.values()) targets.set(windowsPathKey(item.path), { path: item.path, directory: item.directory, readAcl: true });
  if (targets.size > MAX_WINDOWS_AUDIT_PATHS) fail("storage and boundary inventory exceeds the Windows bound");
  const report = collectWindowsAclFacts([...targets.values()]);
  if (saved.sid !== undefined && saved.sid !== report.currentSid) fail("node Windows identity changed");
  const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, report.currentSid]);
  for (const node of report.nodes) {
    const target = targets.get(windowsPathKey(node.path))!;
    if (!target.readAcl) continue;
    if (!node.ownerSid || !trusted.has(node.ownerSid)) fail(`untrusted owner: ${node.path}`);
    const ancestor = ancestors.has(windowsPathKey(node.path));
    for (const ace of node.aces) {
      if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
      // InheritOnly is bit 3. OI/CI bits 0/1 can authorize future children in mutable storage.
      const effective = (ace.flags & 8) === 0, inheritedByFutureChild = node.directory && (ace.flags & 3) !== 0;
      if (effective && (ace.mask & (ancestor ? WINDOWS_ANCESTOR_REPLACEMENT_MASK : WINDOWS_MUTATION_MASK)) !== 0
        || !ancestor && inheritedByFutureChild && (ace.mask & WINDOWS_MUTATION_MASK) !== 0) {
        fail(`another principal can modify storage or its future children: ${node.path}`);
      }
    }
  }
  assertFixed(saved);
  const after = inventory(saved);
  if (before.size !== after.size || [...before].some(([key, item]) => {
    const now = after.get(key);
    return !now || !identityEqual(item, now) || item.ctimeNs !== now.ctimeNs || item.mtimeNs !== now.mtimeNs || item.size !== now.size;
  })) fail("storage changed during ACL audit");
  for (const name of LAYOUT) {
    const path = win32.join(saved.directory, name), entry = after.get(windowsPathKey(path));
    if (entry) {
      if (!entry.directory) fail(`invalid release layout directory: ${path}`);
      saved.layout.set(windowsPathKey(path), entry);
    }
  }
  saved.sid = report.currentSid;
}

/** Trusted-team local admission. No caller-supplied SID, policy or callback can authorize storage. */
export function prepareWindowsReleaseStorage(input: WindowsReleaseStorageInput): PreparedWindowsReleaseStorage {
  assertNativeWindows();
  if (!input || typeof input !== "object" || Object.keys(input).some(name => !["directory", "writableWorkspaceRoots"].includes(name))
    || !Array.isArray(input.writableWorkspaceRoots) || input.writableWorkspaceRoots.length === 0 || input.writableWorkspaceRoots.length > 128) {
    fail("an explicit local directory and all agent write roots are required");
  }
  const directory = physicalWindowsDirectory(input.directory);
  const roots = Object.freeze([...new Set(input.writableWorkspaceRoots.map(physicalWindowsDirectory))]);
  for (const root of roots) if (windowsPathsOverlap(directory, root)) fail("storage overlaps an agent writable root");
  const fixed = new Map<string, Identity>();
  for (const path of [directory, ...roots].flatMap(windowsPathComponents)) fixed.set(windowsPathKey(path), fact(path));
  const prepared = Object.freeze({}) as PreparedWindowsReleaseStorage;
  authorities.set(prepared, { directory, roots, fixed, layout: new Map() });
  try { auditWindowsReleaseStorage(prepared, directory); }
  catch (error) { authorities.delete(prepared); throw error; }
  return prepared;
}
