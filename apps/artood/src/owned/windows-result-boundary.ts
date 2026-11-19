import { lstatSync, realpathSync } from "node:fs";
import {
  assertCanonicalWindowsPath,
  assertNativeWindows,
  collectWindowsAclFacts,
  TRUSTED_WINDOWS_SYSTEM_SIDS,
  WINDOWS_ANCESTOR_REPLACEMENT_MASK,
  WINDOWS_MUTATION_MASK,
  windowsPathComponents,
  windowsPathKey,
} from "../windows-local-acl.js";
import { createWindowsJournalDirectory, flushWindowsJournalDirectory } from "../managed/windows-journal-native.js";
import { assertWindowsOwnedWorkspacePaths } from "./windows-workspace-boundary.js";

const PRIVATE_ACCESS_MASK = WINDOWS_MUTATION_MASK | 0x80000001;

/** Verifies a private file or directory on Windows using NTFS ACLs (equivalent to POSIX 0700/0600). */
export function assertWindowsPrivateResultPath(path: string, directory: boolean): void {
  if (process.platform !== "win32") return;
  assertNativeWindows();
  assertCanonicalWindowsPath(path);
  const components = windowsPathComponents(path);
  const leafKey = windowsPathKey(path);
  const targets = components.map((item) => ({
    path: item,
    directory: windowsPathKey(item) === leafKey ? directory : true,
    readAcl: true,
  }));
  const report = collectWindowsAclFacts(targets, 10000);
  const trusted = new Set([report.currentSid, ...TRUSTED_WINDOWS_SYSTEM_SIDS]);
  for (const node of report.nodes) {
    if (!node.ownerSid || !trusted.has(node.ownerSid)) {
      throw new Error("Worktree results: Windows protected path has an untrusted owner");
    }
    const isLeaf = windowsPathKey(node.path) === leafKey;
    for (const ace of node.aces) {
      if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
      const effective = (ace.flags & 8) === 0;
      const inheritedByChild = node.directory && (ace.flags & 3) !== 0;
      if (
        (effective && (ace.mask & (isLeaf ? PRIVATE_ACCESS_MASK : WINDOWS_ANCESTOR_REPLACEMENT_MASK)) !== 0) ||
        (isLeaf && inheritedByChild && (ace.mask & PRIVATE_ACCESS_MASK) !== 0)
      ) {
        throw new Error("Worktree results: Windows protected path permits foreign read, mutation or replacement");
      }
    }
  }
}

export function createWindowsPrivateResultDirectory(path: string): void {
  assertNativeWindows();
  assertCanonicalWindowsPath(path);
  createWindowsJournalDirectory(path, 10000);
}

export function syncWindowsResultDirectory(path: string): void {
  assertNativeWindows();
  assertCanonicalWindowsPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) {
    throw new Error("Worktree results: physical directory identity required for Windows sync");
  }
  flushWindowsJournalDirectory(path, { dev: String(stat.dev), ino: String(stat.ino) }, 10000);
}

export function assertWindowsResultWorkspacePaths(paths: readonly { path: string; directory: boolean }[]): void {
  if (process.platform !== "win32" || paths.length === 0) return;
  assertWindowsOwnedWorkspacePaths(paths);
}

/** Single-batch ACL audit for both private state paths and owned repository paths.
 * Keeps every check fresh with zero cross-call caching while avoiding redundant PowerShell spawns. */
export function assertWindowsResultStateBatch(input: {
  privatePaths: readonly { path: string; directory: boolean }[];
  workspacePaths: readonly { path: string; directory: boolean }[];
}): void {
  if (process.platform !== "win32") return;
  if (input.privatePaths.length === 0 && input.workspacePaths.length === 0) return;
  assertNativeWindows();
  const privateKeys = new Set<string>();
  const workspaceKeys = new Set<string>();
  const targets = new Map<string, { path: string; directory: boolean; readAcl: boolean }>();
  const addWithAncestors = (item: { path: string; directory: boolean }, bucket: Set<string>) => {
    assertCanonicalWindowsPath(item.path);
    const leafKey = windowsPathKey(item.path);
    bucket.add(leafKey);
    for (const ancestor of windowsPathComponents(item.path).slice(0, -1)) {
      const key = windowsPathKey(ancestor);
      if (!targets.has(key)) targets.set(key, { path: ancestor, directory: true, readAcl: true });
    }
    targets.set(leafKey, { path: item.path, directory: item.directory, readAcl: true });
  };
  for (const item of input.privatePaths) addWithAncestors(item, privateKeys);
  for (const item of input.workspacePaths) addWithAncestors(item, workspaceKeys);
  const report = collectWindowsAclFacts([...targets.values()], 15000);
  const trusted = new Set([report.currentSid, ...TRUSTED_WINDOWS_SYSTEM_SIDS]);
  for (const node of report.nodes) {
    if (!node.ownerSid || !trusted.has(node.ownerSid)) {
      throw new Error("Worktree results: Windows protected path has an untrusted owner");
    }
    const key = windowsPathKey(node.path);
    const isPrivate = privateKeys.has(key);
    const isWorkspace = workspaceKeys.has(key);
    for (const ace of node.aces) {
      if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
      const effective = (ace.flags & 8) === 0;
      const inheritedByChild = node.directory && (ace.flags & 3) !== 0;
      const mask = isPrivate
        ? PRIVATE_ACCESS_MASK
        : isWorkspace
          ? WINDOWS_MUTATION_MASK
          : WINDOWS_ANCESTOR_REPLACEMENT_MASK;
      if (
        (effective && (ace.mask & mask) !== 0) ||
        (isPrivate && inheritedByChild && (ace.mask & PRIVATE_ACCESS_MASK) !== 0)
      ) {
        throw new Error("Worktree results: Windows protected path permits foreign read, mutation or replacement");
      }
    }
  }
}
