import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { ReleaseCapabilitiesV1Schema } from "@artoo/domain";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage } from "./windows-release-storage.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const localPath = z.string().min(1).max(32760).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value), "absolute local path required");
const mapping = z.object({ sourceProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), destinationProfileId: z.string().min(1).max(128),
  commandPairs: z.array(z.object({ source_command_id: z.string().min(1).max(128), destination_command_id: z.string().min(1).max(128) }).strict()).min(1).max(32) }).strict();
const configurationSchema = z.object({ version: z.literal(1), storeRoot: localPath, gitExecutable: localPath,
  recovery: z.object({ version: z.literal(1), deviceId: z.string().min(1).max(128),
    workspaceRoot: localPath, controlDirectory: localPath }).strict().optional(),
  sourceResearch: z.boolean().optional(), destinationResearchMappings: z.array(mapping).max(64).optional(),
  measurementV2: z.object({ version: z.literal(1), releaseProfileIds: z.array(z.string().min(1).max(128)).min(1).max(64),
    destinationResearchMappings: z.array(mapping.extend({ sourceRelease: ReleaseCapabilitiesV1Schema }).strict()).max(64).optional() }).strict().optional(),
  operations: z.object({ version: z.literal(1), importedReview: z.boolean().optional(), importedDesign: z.boolean().optional(), importedDesignReview: z.boolean().optional(),
    importedExecution: z.boolean().optional(), importedExecutionReview: z.boolean().optional(), importedValidation: z.boolean().optional() }).strict().optional(),
}).strict();

/** Protected configuration inspection only: never opens a source runtime or owner fence. */
export function prepareProductSourceConfiguration(options: { file: string; allowedRoots: readonly string[] }) {
  const file = localPath.parse(options.file), directory = dirname(file);
  const storage = prepareWindowsReleaseStorage({ directory, writableWorkspaceRoots: options.allowedRoots });
  function read() {
    assertWindowsReleaseStorage(storage, directory);
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n || realpathSync.native(file) !== file) {
      throw new Error("Product source configuration must be a bounded physical file outside all write roots");
    }
    const bytes = readFileSync(file), after = lstatSync(file, { bigint: true });
    const sameContentFacts = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino
      && left.size === right.size && left.mtimeNs === right.mtimeNs && right.nlink === 1n && right.isFile() && !right.isSymbolicLink();
    if (!sameContentFacts(before, after) || BigInt(bytes.length) !== after.size || realpathSync.native(file) !== file) {
      throw new Error("Product source configuration changed during read");
    }
    // NTFS can commit access metadata on first open. Only that first ctime
    // change is allowed: a second complete read must keep ctime and bytes stable.
    const repeated = readFileSync(file), stable = lstatSync(file, { bigint: true });
    if (!sameContentFacts(after, stable) || after.ctimeNs !== stable.ctimeNs || !repeated.equals(bytes)
      || realpathSync.native(file) !== file) throw new Error("Product source configuration did not stabilize during read");
    return { bytes, identity: `${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}:${digest(bytes)}` };
  }
  const original = read(), config = configurationSchema.parse(JSON.parse(original.bytes.toString("utf8")));
  return { file, directory, storage, original, config, read };
}
