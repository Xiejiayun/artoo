import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { assertCanonicalWindowsPath, assertNativeWindows, collectWindowsAclFacts, MAX_WINDOWS_AUDIT_PATHS,
  physicalWindowsDirectory, TRUSTED_WINDOWS_SYSTEM_SIDS, WINDOWS_ANCESTOR_REPLACEMENT_MASK, WINDOWS_MUTATION_MASK,
  windowsPathComponents, windowsPathKey, windowsPathsOverlap, type WindowsAclTarget } from "./windows-local-acl.js";

declare const installationBrand: unique symbol;
/** Local read-only installation facts. This grants no process, storage-write or publication authority. */
export interface PreparedWindowsCodeInstallation { readonly [installationBrand]: true }
export interface WindowsCodeInstallationInput { readonly directory: string; readonly writableWorkspaceRoots: readonly string[] }
interface Identity { path: string; dev: bigint; ino: bigint; directory: boolean; ctimeNs: bigint; mtimeNs: bigint; size: bigint }
interface InstallationState { directory: string; roots: readonly string[]; fixed: ReadonlyMap<string, Identity>;
  installed: ReadonlyMap<string, Identity>; sid?: string }
const installations = new WeakMap<object, InstallationState>();
function fail(reason: string): never { throw new Error(`Windows code installation: ${reason}`); }
function fact(path: string): Identity {
  assertCanonicalWindowsPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)
    || realpathSync.native(path) !== path) fail("linked, aliased or unsupported path");
  return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs, size: stat.size };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.directory === right.directory;
}
function sameInventory(left: ReadonlyMap<string, Identity>, right: ReadonlyMap<string, Identity>): boolean {
  return left.size === right.size && [...left].every(([key, item]) => {
    const now = right.get(key);
    return !!now && sameIdentity(item, now) && item.ctimeNs === now.ctimeNs && item.mtimeNs === now.mtimeNs && item.size === now.size;
  });
}
function inventory(directory: string): Map<string, Identity> {
  const result = new Map<string, Identity>();
  const visit = (path: string, depth: number): void => {
    if (depth > 64 || result.size >= MAX_WINDOWS_AUDIT_PATHS) fail("installation inventory exceeds its bound");
    const item = fact(path), key = windowsPathKey(path);
    if (result.has(key)) fail("case-aliased installation inventory");
    result.set(key, item);
    if (item.directory) for (const name of readdirSync(path).sort()) visit(win32.join(path, name), depth + 1);
  };
  visit(directory, 0); return result;
}
function state(token: PreparedWindowsCodeInstallation, directory: string): InstallationState {
  const saved = installations.get(token);
  if (!saved) fail("a locally prepared installation is required");
  if (saved.directory !== directory) fail("installation is bound to another directory");
  return saved;
}
function assertFixed(saved: InstallationState): void {
  assertNativeWindows();
  for (const expected of saved.fixed.values()) if (!sameIdentity(expected, fact(expected.path))) fail("fixed physical identity changed");
  for (const root of saved.roots) if (windowsPathsOverlap(saved.directory, root)) fail("installation overlaps an agent writable root");
}
/** Recheck the complete admitted immutable inventory. Callers separately pin executable bytes. */
export function assertWindowsCodeInstallation(token: PreparedWindowsCodeInstallation, directory: string): void {
  const saved = state(token, directory); assertFixed(saved);
  if (!sameInventory(saved.installed, inventory(directory))) fail("installation inventory or metadata changed");
}
/** Same current-object policy as the native process installation: an InheritOnly ACE
 * does not apply to this object, and each existing descendant is audited independently.
 * This policy must never be used for mutable release storage or future state files. */
export function auditWindowsCodeInstallation(token: PreparedWindowsCodeInstallation, directory: string): void {
  auditWindowsCodeInstallationBatch([{ code: token, directory }]);
}
/** Shares facts only within this synchronous boundary. Each original installation
 * retains its complete before/after inventory, fixed identities and own ACL policy. */
export function auditWindowsCodeInstallationBatch(entries: readonly {
  code: PreparedWindowsCodeInstallation; directory: string;
}[]): void {
  if (!Array.isArray(entries) || entries.length === 0) fail("an explicit nonempty local code batch is required");
  const prepared = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => key !== "code" && key !== "directory"))
      fail("an exact local code binding is required");
    const { code, directory } = entry, saved = state(code, directory);
    assertFixed(saved);
    // The same complete inventory binds both the admitted baseline and the
    // closing observation; no intervening inventory can become a new baseline.
    const before = inventory(directory);
    if (!sameInventory(saved.installed, before)) fail("installation inventory or metadata changed");
    const targets = new Map<string, WindowsAclTarget>();
    const ancestors = new Set(windowsPathComponents(directory).slice(0, -1).map(windowsPathKey));
    for (const expected of saved.fixed.values()) targets.set(windowsPathKey(expected.path), {
      path: expected.path, directory: true, readAcl: ancestors.has(windowsPathKey(expected.path)),
    });
    for (const item of before.values()) targets.set(windowsPathKey(item.path), { path: item.path, directory: item.directory, readAcl: true });
    if (targets.size > MAX_WINDOWS_AUDIT_PATHS) fail("installation and boundary inventory exceeds its bound");
    return { saved, before, targets, ancestors };
  });
  type Group = { targets: Map<string, WindowsAclTarget>; installations: typeof prepared };
  const groups: Group[] = []; let shared: Group | undefined;
  // Only small unsealed requests are combined. Per node, reserve 24 KiB for a
  // 4096-character fully escaped path, 80 KiB for 256 ACEs (320 bytes each with
  // 184-character SIDs), and 4 KiB for all other fixed fields. At 512 targets,
  // 54 MiB plus the envelope stays below the collector's 64 MiB response limit.
  // A larger legal original request stays intact in its own collector: no new
  // single-installation limit, retry, timeout extension or fallback after failure.
  const maximumSharedTargets = Math.min(512, MAX_WINDOWS_AUDIT_PATHS);
  const shareable = (targets: ReadonlyMap<string, WindowsAclTarget>): boolean =>
    targets.size <= maximumSharedTargets
      && Buffer.byteLength(JSON.stringify({ version: 1, paths: [...targets.values()] })) <= 16 * 1024 * 1024;
  for (const installation of prepared) {
    if (!shareable(installation.targets)) {
      groups.push({ targets: installation.targets, installations: [installation] }); continue;
    }
    const combined = new Map(shared?.targets);
    for (const [key, target] of installation.targets) {
      const previous = combined.get(key);
      if (previous && (previous.path !== target.path || previous.directory !== target.directory)) fail("shared code audit target changed");
      combined.set(key, { ...target, readAcl: target.readAcl || previous?.readAcl === true });
    }
    if (!shared || !shareable(combined)) {
      shared = { targets: new Map(installation.targets), installations: [installation] }; groups.push(shared);
    } else { shared.targets = combined; shared.installations.push(installation); }
  }
  let sid: string | undefined;
  for (const group of groups) {
    const report = collectWindowsAclFacts([...group.targets.values()]);
    if (sid !== undefined && sid !== report.currentSid) fail("node Windows identity changed");
    sid = report.currentSid;
    const facts = new Map(report.nodes.map(node => [windowsPathKey(node.path), node]));
    const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, sid]);
    for (const { saved, targets, ancestors } of group.installations) {
      if (saved.sid !== undefined && saved.sid !== sid) fail("node Windows identity changed");
      for (const [key, target] of targets) {
        const node = facts.get(key); if (!node) fail("code audit facts are incomplete");
        if (!target.readAcl) continue;
        if (!node.ownerSid || !trusted.has(node.ownerSid)) fail("untrusted owner");
        // A shared path can be an ancestor for one token and code for another.
        const mask = ancestors.has(key) ? WINDOWS_ANCESTOR_REPLACEMENT_MASK : WINDOWS_MUTATION_MASK;
        for (const ace of node.aces) if (ace.qualifier === "AccessAllowed" && (ace.flags & 8) === 0
          && !trusted.has(ace.sid) && (ace.mask & mask) !== 0) fail("another principal can modify or replace the installation");
      }
    }
  }
  for (const { saved, before } of prepared) {
    assertFixed(saved);
    if (!sameInventory(before, inventory(saved.directory))) fail("installation changed during ACL audit");
  }
  // Do not partially update any token when another group or final inventory fails.
  if (sid === undefined) fail("code audit facts are incomplete");
  for (const { saved } of prepared) saved.sid = sid;
}
/** Fixed local admission; callers cannot select an ACL policy, SID or bypass callback. */
export function prepareWindowsCodeInstallation(input: WindowsCodeInstallationInput): PreparedWindowsCodeInstallation {
  assertNativeWindows();
  if (!input || typeof input !== "object" || Object.keys(input).some(name => !["directory", "writableWorkspaceRoots"].includes(name))
    || !Array.isArray(input.writableWorkspaceRoots) || input.writableWorkspaceRoots.length === 0 || input.writableWorkspaceRoots.length > 128)
    fail("an explicit local directory and all agent write roots are required");
  const directory = physicalWindowsDirectory(input.directory);
  const roots = Object.freeze([...new Set(input.writableWorkspaceRoots.map(physicalWindowsDirectory))]);
  for (const root of roots) if (windowsPathsOverlap(directory, root)) fail("installation overlaps an agent writable root");
  const fixed = new Map<string, Identity>();
  for (const path of [directory, ...roots].flatMap(windowsPathComponents)) fixed.set(windowsPathKey(path), fact(path));
  const token = Object.freeze({}) as PreparedWindowsCodeInstallation;
  installations.set(token, { directory, roots, fixed, installed: inventory(directory) });
  try { auditWindowsCodeInstallation(token, directory); }
  catch (error) { installations.delete(token); throw error; }
  return token;
}
