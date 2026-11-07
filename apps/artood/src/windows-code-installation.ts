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
  const saved = state(token, directory); assertWindowsCodeInstallation(token, directory);
  const before = inventory(directory), targets = new Map<string, WindowsAclTarget>();
  const ancestors = new Set(windowsPathComponents(directory).slice(0, -1).map(windowsPathKey));
  for (const expected of saved.fixed.values()) targets.set(windowsPathKey(expected.path), {
    path: expected.path, directory: true, readAcl: ancestors.has(windowsPathKey(expected.path)),
  });
  for (const item of before.values()) targets.set(windowsPathKey(item.path), { path: item.path, directory: item.directory, readAcl: true });
  if (targets.size > MAX_WINDOWS_AUDIT_PATHS) fail("installation and boundary inventory exceeds its bound");
  const report = collectWindowsAclFacts([...targets.values()]);
  if (saved.sid !== undefined && saved.sid !== report.currentSid) fail("node Windows identity changed");
  const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, report.currentSid]);
  for (const node of report.nodes) {
    if (!targets.get(windowsPathKey(node.path))!.readAcl) continue;
    if (!node.ownerSid || !trusted.has(node.ownerSid)) fail("untrusted owner");
    const mask = ancestors.has(windowsPathKey(node.path)) ? WINDOWS_ANCESTOR_REPLACEMENT_MASK : WINDOWS_MUTATION_MASK;
    for (const ace of node.aces) if (ace.qualifier === "AccessAllowed" && (ace.flags & 8) === 0
      && !trusted.has(ace.sid) && (ace.mask & mask) !== 0) fail("another principal can modify or replace the installation");
  }
  assertFixed(saved);
  if (!sameInventory(before, inventory(directory))) fail("installation changed during ACL audit");
  saved.sid = report.currentSid;
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
