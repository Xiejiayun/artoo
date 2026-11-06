import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync, type BigIntStats } from "node:fs";
import { performance } from "node:perf_hooks";
import { win32 } from "node:path";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { assertCanonicalWindowsPath, assertNativeWindows, collectWindowsAclFacts, physicalWindowsDirectory,
  TRUSTED_WINDOWS_SYSTEM_SIDS, WINDOWS_ANCESTOR_REPLACEMENT_MASK, WINDOWS_MUTATION_MASK,
  windowsPathComponents, windowsPathKey, windowsPathsOverlap } from "./windows-local-acl.js";

const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
// Private files and their parent must not expose data/listing or mutation to another principal.
const PRIVATE_ACCESS_MASK = WINDOWS_MUTATION_MASK | 0x80000001;
const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fail(reason: string): never { throw new Error(`Windows browser private context: ${reason}`); }
function remaining(deadline: number): number {
  const value = Math.floor(deadline - performance.now());
  if (!Number.isFinite(deadline) || value < 1) fail("original operation deadline elapsed");
  return Math.min(value, 60000);
}
function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.isDirectory() === after.isDirectory();
}
function sameFile(before: BigIntStats, after: BigIntStats, checkCtime = true): boolean {
  return sameIdentity(before, after) && after.isFile() && !after.isSymbolicLink() && after.nlink === 1n
    && (!checkCtime || before.ctimeNs === after.ctimeNs) && before.mtimeNs === after.mtimeNs && before.size === after.size;
}
function identity(path: string, directory: boolean): BigIntStats {
  const value = lstatSync(path, { bigint: true });
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n)
    || realpathSync.native(path) !== path) fail("path is linked, aliased or not a regular private file/directory");
  if (!directory && (value.size < 1n || value.size > BigInt(MAX_CONTEXT_BYTES))) fail("context file exceeds its byte bound");
  return value;
}
type Audit = { sid: string; identities: Map<string, BigIntStats> };
function audit(directory: string, file: string | undefined, deadline: number, previous?: Audit): Audit {
  remaining(deadline); assertNativeWindows(); assertCanonicalWindowsPath(directory);
  if (file !== undefined) assertCanonicalWindowsPath(file);
  const paths = [...windowsPathComponents(directory), ...(file ? [file] : [])];
  const before = new Map(paths.map(path => [path, identity(path, path !== file)]));
  if (previous) for (const [path, expected] of previous.identities) {
    const actual = before.get(path);
    if (!actual || !sameIdentity(expected, actual)) fail("private path identity changed");
  }
  const report = collectWindowsAclFacts(paths.map(path => ({ path, directory: path !== file, readAcl: true })), remaining(deadline));
  remaining(deadline);
  if (previous && report.currentSid !== previous.sid) fail("node Windows identity changed");
  const trusted = new Set([...TRUSTED_WINDOWS_SYSTEM_SIDS, report.currentSid]);
  for (const node of report.nodes) {
    const isPrivate = windowsPathKey(node.path) === windowsPathKey(directory) || node.path === file;
    if (!node.ownerSid || !trusted.has(node.ownerSid)) fail("untrusted private path owner");
    for (const ace of node.aces) {
      if (ace.qualifier !== "AccessAllowed" || trusted.has(ace.sid)) continue;
      const effective = (ace.flags & 8) === 0, futureChild = node.directory && (ace.flags & 3) !== 0;
      if (effective && (ace.mask & (isPrivate ? PRIVATE_ACCESS_MASK : WINDOWS_ANCESTOR_REPLACEMENT_MASK)) !== 0
        || isPrivate && futureChild && (ace.mask & PRIVATE_ACCESS_MASK) !== 0) fail("another principal can read, modify or replace private context");
    }
  }
  for (const [path, expected] of before) {
    const after = identity(path, path !== file);
    if (path === file ? !sameFile(expected, after) : !sameIdentity(expected, after)) fail("private path changed during ACL audit");
  }
  return { sid: report.currentSid, identities: before };
}

/** SHA binding comes from the parent-owned process environment, never from this file's JSON. */
function readPrivateContext(file: string, expectedSha256: string,
  deadline = performance.now() + 60000, previous?: Audit): Buffer {
  if (typeof expectedSha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedSha256)) fail("missing independent context SHA-256 binding");
  assertCanonicalWindowsPath(file);
  const directory = win32.dirname(file), before = audit(directory, file, deadline, previous);
  const expected = before.identities.get(file)!;
  let handle: number | undefined;
  try {
    handle = openSync(file, constants.O_RDONLY);
    const checkIdentity = (reason: string, stableCtime?: bigint): void => {
      const opened = fstatSync(handle!, { bigint: true }), named = lstatSync(file, { bigint: true });
      if (!sameFile(expected, opened, false) || !sameFile(expected, named, false)
        || stableCtime !== undefined && (opened.ctimeNs !== stableCtime || named.ctimeNs !== stableCtime)) fail(reason);
    };
    // NTFS may commit deferred change metadata on open/first read. Retain the
    // audited inode, name, kind, link count, size and mtime across that boundary;
    // independent parent SHA-256 and a stable second read bind the actual bytes.
    checkIdentity("opened file differs from its audited identity");
    const read = (stableCtime?: bigint): Buffer => {
      const bytes = Buffer.alloc(Number(expected.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        remaining(deadline);
        const count = readSync(handle!, bytes, offset, bytes.length - offset, offset);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== Number(expected.size)) fail("private context size changed while reading");
      checkIdentity("private context identity changed while reading", stableCtime);
      return bytes.subarray(0, offset);
    };
    const first = read(), stableCtime = fstatSync(handle, { bigint: true }).ctimeNs;
    checkIdentity("private context identity changed before its second read", stableCtime);
    const second = read(stableCtime);
    if (!first.equals(second) || sha(first) !== expectedSha256) fail("private context bytes differ from the parent binding");
    audit(directory, file, deadline, before);
    checkIdentity("private context handle or path changed after audit", stableCtime);
    return first;
  } finally { if (handle !== undefined) closeSync(handle); }
}

export function readWindowsBrowserPrivateContext(file: string, expectedSha256: string,
  deadline = performance.now() + 60000): Buffer {
  return readPrivateContext(file, expectedSha256, deadline);
}

/** Parent-only writer: the complete write scope is recovered from genuine WeakMap authority. */
export function writeWindowsBrowserPrivateContext(backend: PreparedWindowsProcessBackend, file: string,
  envelope: unknown, deadline: number): string {
  remaining(deadline); assertNativeWindows(); assertCanonicalWindowsPath(file);
  const directory = win32.dirname(file), installation = describeWindowsProcessInstallation(backend);
  remaining(deadline);
  for (const configured of installation.writableWorkspaceRoots) {
    const root = physicalWindowsDirectory(configured);
    if (windowsPathsOverlap(directory, root) || windowsPathsOverlap(file, root)) fail("private context overlaps an agent writable root");
  }
  const before = audit(directory, undefined, deadline);
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (!bytes.length || bytes.length > MAX_CONTEXT_BYTES) fail("context file exceeds its byte bound");
  const checksum = sha(bytes);
  remaining(deadline);
  writeFileSync(file, bytes, { flag: "wx", mode: 0o400 });
  readPrivateContext(file, checksum, deadline, before);
  return checksum;
}
