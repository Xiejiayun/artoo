import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { parseDeviceToken, ReleaseCapabilitiesV1Schema } from "@artoo/domain";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage, auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { assertImportedDesignVerificationProfile, type PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
import type { ResearchOptions } from "./research.js";
import { prepareProductSourceRuntime, assertProductSourceRuntimeConfiguration, closeProductSourceRuntime,
  readProductSourceRuntimeCapabilities } from "./product-source-runtime.js";
import { createProductSourceSemanticClient } from "./product-source-semantic-client.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const localPath = z.string().min(1).max(32760).refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value), "absolute local path required");
const mapping = z.object({ sourceProfileDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/), destinationProfileId: z.string().min(1).max(128),
  commandPairs: z.array(z.object({ source_command_id: z.string().min(1).max(128), destination_command_id: z.string().min(1).max(128) }).strict()).min(1).max(32) }).strict();
const configurationSchema = z.object({ version: z.literal(1), storeRoot: localPath, gitExecutable: localPath,
  sourceResearch: z.boolean().optional(), destinationResearchMappings: z.array(mapping).max(64).optional(),
  measurementV2: z.object({ version: z.literal(1), releaseProfileIds: z.array(z.string().min(1).max(128)).min(1).max(64),
    destinationResearchMappings: z.array(mapping.extend({ sourceRelease: ReleaseCapabilitiesV1Schema }).strict()).max(64).optional() }).strict().optional(),
  operations: z.object({ version: z.literal(1), importedReview: z.boolean().optional(), importedDesign: z.boolean().optional() }).strict().optional(),
}).strict();

/** The credential is reused only inside this node; no task or source file supplies an endpoint. */
function pairedConnection(nodeUrl: string, nodeId: string) {
  const url = new URL(nodeUrl), tokens = url.searchParams.getAll("token");
  if (!nodeId || !["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash
    || url.pathname !== "/api/v1/node" || tokens.length !== 1 || !parseDeviceToken(tokens[0]!)
    || [...url.searchParams.keys()].some(key => key !== "token")
    || url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Product source startup requires an exact paired node endpoint using WSS or loopback WS");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return { serverOrigin: url.origin, nodeId, nodeToken: tokens[0]! };
}

/** Runs before any hello. The configuration directory must be dedicated protected local storage. */
export function prepareProductSourceNode(options: { file: string; url: string; nodeId: string; allowedRoots: readonly string[];
  windowsBackend: PreparedWindowsProcessBackend; profiles: readonly PreparedVerificationProfile[];
  releaseProfiles: readonly PreparedReleaseProfile[]; research?: ResearchOptions; acknowledgeRunEvents: boolean }) {
  if (process.platform !== "win32" || !options.allowedRoots.length || !options.profiles.length) {
    throw new Error("Product source startup requires native Windows, complete write roots and prepared verification profiles");
  }
  assertWindowsProcessBackend(options.windowsBackend);
  const connection = pairedConnection(options.url, options.nodeId);
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
  if (config.sourceResearch && !options.research) throw new Error("Source research must reuse this node's configured research receipt store");
  if (config.operations?.importedDesign && (!config.operations.importedReview || !options.acknowledgeRunEvents)) {
    throw new Error("Imported design requires imported review and committed run-event receipts");
  }
  const v1Mappings = config.destinationResearchMappings ?? [], v2Mappings = config.measurementV2?.destinationResearchMappings ?? [];
  if (config.operations && !config.sourceResearch && !v1Mappings.length && !v2Mappings.length) {
    throw new Error("Source operations require a local semantic export or destination mapping");
  }
  if (config.operations?.importedReview && !v1Mappings.length && !v2Mappings.length) throw new Error("Imported review requires a local destination mapping");
  if (config.operations?.importedDesign && !v2Mappings.length) throw new Error("Imported design requires a local policy-v2 destination mapping");
  const ids = config.measurementV2?.releaseProfileIds ?? [];
  if (new Set(ids).size !== ids.length) throw new Error("Product source release profile selections must be unique");
  const releases = ids.map(id => {
    const matches = options.releaseProfiles.filter(profile => profile.id === id);
    if (matches.length !== 1) throw new Error("Product source release profile selection is absent or ambiguous");
    return matches[0]!;
  });
  if (config.operations?.importedDesign) for (const entry of v2Mappings) {
    const profile = options.profiles.find(profile => profile.id === entry.destinationProfileId);
    if (!profile) throw new Error("Imported design verifier selection is absent");
    assertImportedDesignVerificationProfile(profile);
  }
  const semanticClient = config.operations ? createProductSourceSemanticClient(connection) : undefined;
  // Preserve the exact profiles prepared by the runner. Parsing a second copy
  // would lose the private Windows backend and release reader associations.
  const runtime = prepareProductSourceRuntime({ nodeId: options.nodeId, storeRoot: config.storeRoot, gitExecutable: config.gitExecutable,
    allowedRoots: options.allowedRoots, windowsBackend: options.windowsBackend, profiles: options.profiles,
    ...(config.sourceResearch ? { sourceResearch: options.research! } : {}),
    ...(config.destinationResearchMappings ? { destinationResearchMappings: config.destinationResearchMappings } : {}),
    ...(config.measurementV2 ? { measurementV2: { version: 1, releaseProfiles: releases, destinationResearchMappings: v2Mappings } } : {}),
  });
  // After this point failure retains the runtime's durable owner fence; callers
  // may close only after controller settlement proves that no writer remains.
  function assertCurrent() {
    if (read().identity !== original.identity) throw new Error("Product source configuration changed after preparation");
    assertWindowsProcessBackend(options.windowsBackend);
    assertProductSourceRuntimeConfiguration(runtime, options.nodeId, options.allowedRoots, options.profiles);
  }
  function assertDiscovery() {
    // The cheap physical check used during a session is not an ACL audit.
    // Re-audit the complete protected configuration at startup/discovery.
    auditWindowsReleaseStorage(storage, directory);
    assertCurrent();
  }
  assertDiscovery();
  const roles = readProductSourceRuntimeCapabilities(runtime);
  if (config.operations && !roles.semantic) throw new Error("Prepared source runtime has no semantic role");
  return Object.freeze({ runtime, semanticClient, importedReview: config.operations?.importedReview === true,
    importedDesign: config.operations?.importedDesign === true, assertCurrent, assertDiscovery,
    close() { closeProductSourceRuntime(runtime); } });
}
