import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { ApplicationBrokerConfigurationSchema } from "./application-broker-control.js";
import { parseApplicationDataSchema } from "./application-data-contract.js";
import { prepareApplicationBrokerProcess, type ApplicationBrokerFilePin } from "./application-broker-process.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsCodeInstallation, auditWindowsCodeInstallation } from "./windows-code-installation.js";
import { prepareWindowsReleaseStorage, auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";

const maximumFileBytes = 512 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const pathSchema = z.string().min(1).max(4096);
const pinSchema = z.object({ path: pathSchema, bytes: z.number().int().positive().max(maximumFileBytes),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();
const profileSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-broker-profile.v1"),
  node_id: id, writable_workspace_roots: z.array(pathSchema).min(1).max(128),
  node: pinSchema, entry: pinSchema, configuration: pinSchema, storage_directory: pathSchema,
}).strict();

interface Options {
  readonly file: string;
  readonly nodeId: string;
  /** Exact declared local node roots, not an inference about every model's actual write access. */
  readonly allowedRoots: readonly string[];
  readonly backend: PreparedWindowsProcessBackend;
}
type Facts = ReturnType<typeof fileFacts>;
function fail(reason: string): never { throw Error(`Application broker profile check: ${reason}`); }
function fileFacts(path: string) {
  assertCanonicalWindowsPath(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || realpathSync.native(path) !== path)
    fail("a physical single-link regular file is required");
  return stat;
}
function sameFacts(left: Facts, right: Facts, ctime = true): boolean {
  return right.isFile() && !right.isSymbolicLink() && right.nlink === 1n
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && (!ctime || left.ctimeNs === right.ctimeNs);
}

/** Bounded handle reads retain exact bigint identity. A first NTFS access-metadata
 * update is allowed only before a second complete stable pass, including both closes. */
function readFixedFile(path: string, maximum: number, retainBytes = false) {
  const before = fileFacts(path);
  if (before.size < 1n || before.size > BigInt(maximum)) fail("file exceeds its fixed bound");
  const pass = (expected: Facts, ctime: boolean) => {
    const fd = openSync(path, "r");
    let result: { sha256: string; bytes: Buffer | undefined };
    try {
      const check = () => {
        if (!sameFacts(expected, fstatSync(fd, { bigint: true }), ctime) || !sameFacts(expected, fileFacts(path), ctime))
          fail("file changed while reading");
      };
      check();
      const buffer = Buffer.alloc(Math.min(65_536, Number(before.size) + 1)), digest = createHash("sha256"), parts: Buffer[] = [];
      let length = 0;
      while (length <= Number(before.size)) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) + 1 - length), length);
        if (!count) break;
        digest.update(buffer.subarray(0, count));
        if (retainBytes) parts.push(Buffer.from(buffer.subarray(0, count)));
        length += count;
      }
      if (BigInt(length) !== before.size) fail("file changed while reading");
      check();
      result = { sha256: `sha256:${digest.digest("hex")}`, bytes: retainBytes ? Buffer.concat(parts) : undefined };
    } finally { closeSync(fd); }
    // NTFS can defer the first access-metadata update until the original handle
    // closes. No identity, size or content-mtime change is ever accepted here.
    const facts = fileFacts(path);
    if (!sameFacts(expected, facts, ctime)) fail("file changed while closing");
    return { ...result, facts };
  };
  const first = pass(before, false), repeated = pass(first.facts, true);
  if (first.sha256 !== repeated.sha256) fail("file bytes did not stabilize");
  const pin = Object.freeze({ path, bytes: Number(before.size), sha256: first.sha256 });
  return { bytes: first.bytes, facts: repeated.facts, pin };
}
function matchesPin(actual: ApplicationBrokerFilePin, expected: ApplicationBrokerFilePin): boolean {
  return actual.path === expected.path && actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}
function roots(values: readonly string[]): readonly string[] {
  const result = values.map(physicalWindowsDirectory).sort();
  if (new Set(result.map(value => value.toLowerCase())).size !== result.length) fail("duplicate declared write roots");
  return Object.freeze(result);
}
function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Offline inspection only. No database is opened and no process token escapes.
 * This cannot qualify source/artifact provenance, a compiler, LPAC or product execution. */
export function checkApplicationBrokerProfileFile(input: Options): void {
  assertNativeWindows();
  if (!input || typeof input !== "object" || Object.keys(input).some(key => !["file", "nodeId", "allowedRoots", "backend"].includes(key))
    || !Array.isArray(input.allowedRoots) || input.allowedRoots.length < 1 || input.allowedRoots.length > 128
    || !id.safeParse(input.nodeId).success) fail("fixed local node settings are required");
  const file = input.file, nodeId = input.nodeId, backend = input.backend;
  assertCanonicalWindowsPath(file);
  const allowedRoots = roots(input.allowedRoots), profileDirectory = physicalWindowsDirectory(win32.dirname(file));
  // Use mutable-storage admission before the first read, matching the protected
  // source-config reader. Immutable inventories are captured after input warmup.
  const profileStorage = prepareWindowsReleaseStorage({ directory: profileDirectory, writableWorkspaceRoots: allowedRoots });
  const original = readFixedFile(file, 65_536, true), profile = profileSchema.parse(JSON.parse(original.bytes!.toString("utf8")));
  if (profile.node_id !== nodeId || !sameRoots(roots(profile.writable_workspace_roots), allowedRoots))
    fail("profile differs from the declared local node or write roots");
  const native = describeWindowsProcessInstallation(backend);
  if (!sameRoots(roots(native.writableWorkspaceRoots), allowedRoots)) fail("native installation has different declared write roots");
  if (win32.basename(profile.node.path).toLowerCase() !== "node.exe" || win32.basename(profile.entry.path) !== "application-broker.mjs")
    fail("fixed native Node and trusted broker entry names are required");
  const storageDirectory = physicalWindowsDirectory(profile.storage_directory);
  const codeDirectories = [...new Set([profileDirectory, ...[profile.node, profile.entry, profile.configuration]
    .map(pin => physicalWindowsDirectory(win32.dirname(pin.path)))])];
  if ([...codeDirectories, native.directory].some(directory => windowsPathsOverlap(directory, storageDirectory)))
    fail("broker storage must be separate from installation and configuration directories");
  const pinned = [profile.node, profile.entry, profile.configuration].map((expected, index) => {
    const value = readFixedFile(expected.path, index === 2 ? 65_536 : maximumFileBytes, index === 2);
    if (!matchesPin(value.pin, expected)) fail("installed bytes differ from the protected profile");
    return value;
  });
  const config = ApplicationBrokerConfigurationSchema.parse(JSON.parse(pinned[2]!.bytes!.toString("utf8")));
  if (config.mode !== "open" || config.maximumAccess !== "read") fail("only an existing store with read access can be checked");
  parseApplicationDataSchema(config.schemaJson);
  assertCanonicalWindowsPath(config.databasePath);
  if (win32.dirname(config.databasePath) !== storageDirectory) fail("database must be a direct child of the exact storage directory");
  const database = fileFacts(config.databasePath); // Metadata only; never read or open the database.
  const storage = prepareWindowsReleaseStorage({ directory: storageDirectory, writableWorkspaceRoots: allowedRoots });
  const code = codeDirectories.map(directory => ({ directory,
    authority: prepareWindowsCodeInstallation({ directory, writableWorkspaceRoots: allowedRoots }) }));
  const assertLocalAdmission = (): void => {
    for (const entry of code) auditWindowsCodeInstallation(entry.authority, entry.directory);
    auditWindowsReleaseStorage(profileStorage, profileDirectory);
    auditWindowsReleaseStorage(storage, storageDirectory);
    for (const [index, saved] of [original, ...pinned].entries()) {
      const now = readFixedFile(saved.pin.path, saved.pin.bytes);
      if (!matchesPin(now.pin, saved.pin) || !sameFacts(saved.facts, now.facts)) {
        const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const;
        const changed: string[] = fields.filter(field => saved.facts[field] !== now.facts[field]);
        if (now.pin.sha256 !== saved.pin.sha256) changed.push("sha256");
        if (now.pin.path !== saved.pin.path) changed.push("path");
        fail(`fixed local ${["profile", "node", "entry", "configuration"][index]} changed (${[...new Set(changed)].join(",")})`);
      }
    }
    if (!sameFacts(database, fileFacts(config.databasePath))) fail("database identity or metadata changed during inspection");
  };
  // Existing low-level preparation rechecks native manifest, capability and file
  // pins. Its callback is exclusively this module's fixed local policy, never input.
  // Discard the opaque preparation: an inspection result cannot start a broker.
  prepareApplicationBrokerProcess({ native: { directory: native.directory, manifestSha256: native.manifestSha256,
    assertLocalInstallation: () => { assertWindowsProcessBackend(backend); } },
    node: profile.node, entry: profile.entry, configuration: profile.configuration, assertLocalAdmission });
}
