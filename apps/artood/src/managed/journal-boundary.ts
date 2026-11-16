import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalLocation } from "./journal-types.js";
import { inspectWindowsJournalBoundary } from "./windows-journal-boundary.js";
import { createWindowsJournalDirectory, flushWindowsJournalDirectory } from "./windows-journal-native.js";

export interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface Marker extends JournalLocation {
  readonly version: 1;
  readonly namespace: string;
  readonly directoryIdentity: FileIdentity;
  readonly databaseIdentity: FileIdentity;
}
export interface Boundary {
  readonly marker: Marker;
  readonly markerIdentity: FileIdentity;
  readonly databasePath: string;
}
const identity = (s: { dev: bigint; ino: bigint }): FileIdentity => ({ dev: String(s.dev), ino: String(s.ino) });
const same = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

export function nonempty(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    !value.isWellFormed() ||
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new Error(`Invalid local journal ${name}`);
  }
}
function localAncestry(directory: string): void {
  if (process.platform === "win32") {
    inspectWindowsJournalBoundary(directory, [], false);
    return;
  }
  // The macOS candidate retains its original filesystem qualification. A
  // Windows branch uses native NTFS/ACL/flush evidence, never these mode bits.
  if (
    process.platform !== "darwin" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === sep
  ) {
    throw new Error("Journal requires a canonical absolute local macOS directory");
  }
  let current: string = sep;
  for (const part of directory.split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(current) !== current) {
      throw new Error("Journal ancestry is not a plain physical directory");
    }
    if (statfsSync(current).type !== statfsSync(sep).type)
      throw new Error("Journal filesystem has not been locally qualified");
  }
}
function privateDirectory(directory: string): FileIdentity {
  if (process.platform === "win32") return inspectWindowsJournalBoundary(directory).directoryIdentity;
  localAncestry(directory);
  const stat = lstatSync(directory, { bigint: true });
  if (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n)
    throw new Error("Journal directory must be owned and mode 0700");
  return identity(stat);
}
function privateFile(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o777n) !== 0o600n ||
    realpathSync.native(path) !== path
  ) {
    throw new Error("Journal file must be an owned private single-link regular file");
  }
  return identity(stat);
}
function inspect(directory: string, files: readonly string[]) {
  if (process.platform === "win32") return inspectWindowsJournalBoundary(directory, files);
  return {
    directoryIdentity: privateDirectory(directory),
    files: new Map(files.map((name) => [name, privateFile(join(directory, name))])),
  };
}
export function syncDirectory(directory: string): void {
  if (process.platform === "win32") {
    const before = lstatSync(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync.native(directory) !== directory)
      throw new Error("Journal sync directory is not physical");
    flushWindowsJournalDirectory(directory, identity(before));
    if (
      !same(identity(lstatSync(directory, { bigint: true })), identity(before)) ||
      realpathSync.native(directory) !== directory
    ) {
      throw new Error("Journal directory changed during durability confirmation");
    }
    return;
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function syncDatabase(path: string): void {
  const expected =
    process.platform === "win32"
      ? (() => {
          if (basename(path) !== "journal.sqlite") throw new Error("Invalid journal database path");
          return inspect(dirname(path), ["journal.sqlite"]).files.get("journal.sqlite")!;
        })()
      : undefined;
  const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    if (expected && !same(identity(fstatSync(fd, { bigint: true })), expected))
      throw new Error("Journal database handle identity changed");
    fsyncSync(fd);
    if (expected && !same(identity(lstatSync(path, { bigint: true })), expected))
      throw new Error("Journal database name identity changed");
  } finally {
    closeSync(fd);
  }
}
export function beginProvision(location: JournalLocation): Marker {
  nonempty(location.directory, "directory");
  nonempty(location.controllerScope, "controller scope");
  nonempty(location.nodeId, "node ID");
  localAncestry(dirname(location.directory));
  if (process.platform === "win32") {
    createWindowsJournalDirectory(location.directory);
    // Namespace creation must survive power loss as well as its child entries.
    // A failed native flush leaves a private, unqualified directory to inspect;
    // it never adopts, deletes or resets that uncertain namespace automatically.
    syncDirectory(dirname(location.directory));
  } else mkdirSync(location.directory, { mode: 0o700 }); // Exclusive leaf: never adopts/reset an existing namespace.
  const directoryIdentity = privateDirectory(location.directory);
  const databasePath = join(location.directory, "journal.sqlite");
  const fd = openSync(
    databasePath,
    constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const completed = inspect(location.directory, ["journal.sqlite"]);
  if (!same(completed.directoryIdentity, directoryIdentity))
    throw new Error("Provisioned journal directory identity changed");
  return {
    version: 1,
    namespace: randomUUID(),
    ...location,
    directoryIdentity,
    databaseIdentity: completed.files.get("journal.sqlite")!,
  };
}
export function finishProvision(marker: Marker): Boundary {
  const before = inspect(marker.directory, ["journal.sqlite"]);
  if (
    !same(before.directoryIdentity, marker.directoryIdentity) ||
    !same(before.files.get("journal.sqlite")!, marker.databaseIdentity)
  )
    throw new Error("Provisioned journal identity changed");
  const path = join(marker.directory, "namespace.json");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(marker) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(marker.directory);
  const completed = inspect(marker.directory, ["journal.sqlite", "namespace.json"]);
  if (
    !same(completed.directoryIdentity, marker.directoryIdentity) ||
    !same(completed.files.get("journal.sqlite")!, marker.databaseIdentity)
  ) {
    throw new Error("Provisioned journal identity changed while writing its marker");
  }
  return {
    marker,
    markerIdentity: completed.files.get("namespace.json")!,
    databasePath: join(marker.directory, "journal.sqlite"),
  };
}
export function openBoundary(location: JournalLocation, expectedNamespace: string): Boundary {
  nonempty(expectedNamespace, "expected namespace");
  const current = inspect(location.directory, ["journal.sqlite", "namespace.json"]),
    directoryIdentity = current.directoryIdentity;
  const path = join(location.directory, "namespace.json"),
    markerIdentity = current.files.get("namespace.json")!;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: Marker;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!same(identity(stat), markerIdentity) || stat.size > 8192n)
      throw new Error("Journal marker changed or is too large");
    parsed = JSON.parse(readFileSync(fd, "utf8")) as Marker;
  } finally {
    closeSync(fd);
  }
  if (
    parsed.version !== 1 ||
    parsed.namespace !== expectedNamespace ||
    parsed.controllerScope !== location.controllerScope ||
    parsed.nodeId !== location.nodeId ||
    parsed.directory !== location.directory ||
    !same(directoryIdentity, parsed.directoryIdentity)
  )
    throw new Error("Journal namespace/scope continuity failed");
  const boundary = { marker: parsed, markerIdentity, databasePath: join(location.directory, "journal.sqlite") };
  assertBoundary(boundary);
  return boundary;
}
export function assertBoundary(boundary: Boundary): void {
  const { marker } = boundary;
  if (boundary.databasePath !== join(marker.directory, "journal.sqlite"))
    throw new Error("Journal database path binding changed");
  const current = inspect(marker.directory, ["journal.sqlite", "namespace.json"]);
  if (
    !same(current.directoryIdentity, marker.directoryIdentity) ||
    !same(current.files.get("journal.sqlite")!, marker.databaseIdentity) ||
    !same(current.files.get("namespace.json")!, boundary.markerIdentity)
  ) {
    throw new Error("Journal namespace path identity changed; continuity is unknown");
  }
  // Identity alone does not detect an in-place marker edit.
  if (readFileSync(join(marker.directory, "namespace.json"), "utf8") !== JSON.stringify(marker) + "\n") {
    throw new Error("Journal namespace marker content changed");
  }
}
