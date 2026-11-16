import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { win32 } from "node:path";
import {
  assertCanonicalWindowsPath,
  assertNativeWindows,
  collectWindowsAclFacts,
  physicalWindowsDirectory,
  TRUSTED_WINDOWS_SYSTEM_SIDS,
  WINDOWS_ANCESTOR_REPLACEMENT_MASK,
  WINDOWS_MUTATION_MASK,
  windowsPathComponents,
} from "../windows-local-acl.js";
import { assertWindowsJournalProtectedDirectory } from "./windows-journal-native.js";
import type { FileIdentity } from "./journal-boundary.js";

const PRIVATE_ACCESS_MASK = WINDOWS_MUTATION_MASK | 0x80000001;
export interface WindowsJournalBoundarySnapshot {
  readonly directoryIdentity: FileIdentity;
  readonly files: ReadonlyMap<string, FileIdentity>;
}
function snapshot(path: string, directory: boolean): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    realpathSync.native(path) !== path
  )
    throw new Error("Windows journal path is linked, aliased or has changed kind");
  return stat;
}
const identity = (stat: BigIntStats): FileIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });

/** A fresh whole-path audit for each call. Facts are not cached across journal
 * transactions; POSIX uid/mode are never used as Windows permission evidence. */
export function inspectWindowsJournalBoundary(
  directory: string,
  files: readonly string[] = [],
  privateLeaf = true,
): WindowsJournalBoundarySnapshot {
  assertNativeWindows();
  assertCanonicalWindowsPath(directory);
  physicalWindowsDirectory(directory);
  if (
    directory === win32.parse(directory).root ||
    (!privateLeaf && files.length !== 0) ||
    files.length > 2 ||
    new Set(files).size !== files.length ||
    files.some((name) => name !== "journal.sqlite" && name !== "namespace.json")
  )
    throw new Error("Invalid Windows journal boundary inventory");
  const components = windowsPathComponents(directory),
    paths = [...components, ...files.map((name) => win32.join(directory, name))];
  const before = new Map(paths.map((path) => [path, snapshot(path, components.includes(path))]));
  const report = collectWindowsAclFacts(
    paths.map((path) => ({ path, directory: components.includes(path), readAcl: true })),
    2500,
  );
  const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, report.currentSid]);
  for (const node of report.nodes) {
    const isPrivate = privateLeaf && (node.path === directory || !node.directory);
    if (!node.ownerSid || !trusted.has(node.ownerSid)) throw new Error("Windows journal has an untrusted path owner");
    for (const ace of node.aces) {
      if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
      const effective = (ace.flags & 8) === 0,
        inheritedByChild = node.directory && (ace.flags & 3) !== 0;
      if (
        (effective && (ace.mask & (isPrivate ? PRIVATE_ACCESS_MASK : WINDOWS_ANCESTOR_REPLACEMENT_MASK)) !== 0) ||
        (isPrivate && inheritedByChild && (ace.mask & PRIVATE_ACCESS_MASK) !== 0)
      ) {
        throw new Error("Another Windows principal can read, modify or replace the journal boundary");
      }
    }
  }
  // SQLite's Windows VFS does not supply the Unix directory-sync path. The
  // worker already asserts this boundary after COMMIT, so perform the real
  // directory flush here before it can return a durable receipt.
  if (privateLeaf)
    assertWindowsJournalProtectedDirectory(directory, report.currentSid, identity(before.get(directory)!));
  for (const [path, expected] of before) {
    const after = snapshot(path, components.includes(path));
    if (expected.dev !== after.dev || expected.ino !== after.ino)
      throw new Error("Windows journal identity changed during ACL audit");
  }
  return {
    directoryIdentity: identity(before.get(directory)!),
    files: new Map(files.map((name) => [name, identity(before.get(win32.join(directory, name))!)])),
  };
}
