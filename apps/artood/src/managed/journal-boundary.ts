import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalLocation } from "./journal-types.js";

export interface FileIdentity { readonly dev: string; readonly ino: string }
export interface Marker extends JournalLocation {
  readonly version: 1; readonly namespace: string;
  readonly directoryIdentity: FileIdentity; readonly databaseIdentity: FileIdentity;
}
export interface Boundary { readonly marker: Marker; readonly markerIdentity: FileIdentity; readonly databasePath: string }
const identity = (s: { dev: bigint; ino: bigint }): FileIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

export function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 512 || !value.isWellFormed() || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`Invalid local journal ${name}`);
  }
}
function localAncestry(directory: string): void {
  // This first candidate qualifies only the local macOS filesystem kind hosting
  // the trusted system root. Other filesystems/platforms require separate work.
  if (process.platform !== "darwin" || !isAbsolute(directory) || resolve(directory) !== directory || directory === sep) {
    throw new Error("Journal requires a canonical absolute local macOS directory");
  }
  let current: string = sep;
  for (const part of directory.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(current) !== current) {
      throw new Error("Journal ancestry is not a plain physical directory");
    }
    if (statfsSync(current).type !== statfsSync(sep).type) throw new Error("Journal filesystem has not been locally qualified");
  }
}
function privateDirectory(directory: string): FileIdentity {
  localAncestry(directory);
  const stat = lstatSync(directory, { bigint: true });
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n) throw new Error("Journal directory must be owned and mode 0700");
  return identity(stat);
}
function privateFile(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
    || (stat.mode & 0o777n) !== 0o600n || realpathSync.native(path) !== path) {
    throw new Error("Journal file must be an owned private single-link regular file");
  }
  return identity(stat);
}
export function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDatabase(path: string): void {
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function beginProvision(location: JournalLocation): Marker {
  nonempty(location.directory, "directory"); nonempty(location.controllerScope, "controller scope"); nonempty(location.nodeId, "node ID");
  localAncestry(dirname(location.directory));
  mkdirSync(location.directory, { mode: 0o700 }); // Exclusive leaf: never adopts/reset an existing namespace.
  const directoryIdentity = privateDirectory(location.directory);
  const databasePath = join(location.directory, "journal.sqlite");
  const fd = openSync(databasePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return { version: 1, namespace: randomUUID(), ...location, directoryIdentity, databaseIdentity: privateFile(databasePath) };
}
export function finishProvision(marker: Marker): Boundary {
  if (!same(privateDirectory(marker.directory), marker.directoryIdentity)
    || !same(privateFile(join(marker.directory, "journal.sqlite")), marker.databaseIdentity)) throw new Error("Provisioned journal identity changed");
  const path = join(marker.directory, "namespace.json");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(marker) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(marker.directory);
  return { marker, markerIdentity: privateFile(path), databasePath: join(marker.directory, "journal.sqlite") };
}
export function openBoundary(location: JournalLocation, expectedNamespace: string): Boundary {
  nonempty(expectedNamespace, "expected namespace");
  const directoryIdentity = privateDirectory(location.directory), path = join(location.directory, "namespace.json");
  const markerIdentity = privateFile(path), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: Marker;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!same(identity(stat), markerIdentity) || stat.size > 8192n) throw new Error("Journal marker changed or is too large");
    parsed = JSON.parse(readFileSync(fd, "utf8")) as Marker;
  } finally { closeSync(fd); }
  if (parsed.version !== 1 || parsed.namespace !== expectedNamespace || parsed.controllerScope !== location.controllerScope
    || parsed.nodeId !== location.nodeId || parsed.directory !== location.directory
    || !same(directoryIdentity, parsed.directoryIdentity)) throw new Error("Journal namespace/scope continuity failed");
  const boundary = { marker: parsed, markerIdentity, databasePath: join(location.directory, "journal.sqlite") };
  assertBoundary(boundary); return boundary;
}
export function assertBoundary(boundary: Boundary): void {
  const { marker } = boundary;
  if (!same(privateDirectory(marker.directory), marker.directoryIdentity)
    || !same(privateFile(boundary.databasePath), marker.databaseIdentity)
    || !same(privateFile(join(marker.directory, "namespace.json")), boundary.markerIdentity)) {
    throw new Error("Journal namespace path identity changed; continuity is unknown");
  }
  // Identity alone does not detect an in-place marker edit.
  if (readFileSync(join(marker.directory, "namespace.json"), "utf8") !== JSON.stringify(marker) + "\n") {
    throw new Error("Journal namespace marker content changed");
  }
}
