import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ProductSourceExportV1Schema, ProductSourceImportReadyV1Schema, ProductSourceTransferRequestV1Schema, canonicalProductSourceTransferValueV1,
  productSourceTransferRequestDigestV1, RunStartPayloadSchema, type ProductSourceExportV1, type ProductSourceTransferRequestV1,
  type ProductSourceImportReadyV1, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import { ProductSourceExportV2Schema, ProductSourceTransferRequestV2Schema, ProductResearchReportV1Schema, ProductResearchReportV2Schema,
  ReleaseCapabilitiesV1Schema, canonicalReleaseCapabilityContract,
  assertProductResearchProvenanceV1, assertProductResearchProvenanceV2, productSourceExportDigestV2, productSourceTransferRequestDigestV2,
  describeProductSourceMeasurementMappingV1, inspectProductSourceVerificationEnvelope,
  type ProductSourceVerificationEnvelope, type ProductSourceExportV2, type ProductSourceTransferRequestV2, type ReleaseCapabilitiesV1 } from "@artoo/domain";
import type { AgentInstanceHandle } from "@artoo/protocol";
import { captureProductSourceSnapshot, decodeProductSourceSnapshot, describeProductSourceSnapshot,
  encodeProductSourceSnapshot, materializeProductSourceSnapshot } from "./product-source-snapshot.js";
import { assertFinalVerificationExportBinding, assertLocallyPreparedVerificationProfile, prepareVerificationProfiles, subjectManifest,
  selectVerificationProfile, runTransferredResearchVerification, type PreparedVerificationProfile } from "./verification.js";
import { assertWindowsVerifiedExecutionExportBinding, type WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { runProtectedCommand } from "./protected-command.js";
// Reuse the exact shared mutable-directory qualifier. This grants physical storage facts,
// not publication authority; no release profile/executor is created by this module.
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage, auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { prepareResearchOptions, readResearchReceipt, type ResearchOptions } from "./research.js";
import { readProductFile } from "./product-stage.js";
import { readAuthenticatedProductSourceTransferV2, type AuthenticatedProductSourceTransferV2 } from "./product-source-semantic-client.js";
import { prepareReleaseCapabilityReaders, readReleaseCapabilitiesBatch, readPreparedProductReleaseRetry, type PreparedProductReleaseRetry, type PreparedReleaseProfile } from "./product-release.js";
import { assertReleaseCapabilityContext, type ReleaseCapabilityReader } from "./release-capability-authority.js";
import { readWindowsGuardianLocalRuntime, type PreparedWindowsGuardian } from "./owned/windows-runtime-guardian.js";
import { readRecoveryValidationResearch } from "./windows-source-recovery.js";
import { readCleanValidationResearch } from "./windows-clean-validation-runtime.js";
import { readCleanDaemonGuardian, readCleanDaemonQuarantine, type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation } from "./windows-code-installation.js";
import { recordWindowsStartupPhase } from "./windows-startup-diagnostics.js";
import { recordSourceCommandPhase, recordSourceCommandFailure } from "./source-command-diagnostics.js";
import { admitProductResearchRevision, assertProductResearchRevisionRun, assertResearchRevisionWorkspaceClosed, assertResearchRevisionWorkspaceBoundary, closeProductResearchRevision,
  readProductResearchRevision } from "./product-research-revision.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = canonicalProductSourceTransferValueV1;
const hash = (value: unknown) => sha(canonical(value));
const key = (value: string) => sha(value).slice(7);
const inside = (child: string, parent: string) => { const rest = relative(parent, child); return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest); };
const overlaps = (a: string, b: string) => inside(a, b) || inside(b, a);
function fail(message: string): never { throw new Error(`Product source runtime: ${message}`); }
function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || realpathSync.native(path) !== path || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) fail("linked or unsupported path");
  return { path, dev: String(stat.dev), ino: String(stat.ino), directory: stat.isDirectory() };
}
function sameIdentity(expected: ReturnType<typeof identity>) { if (!isDeepStrictEqual(expected, identity(expected.path))) fail("physical identity changed"); }
function boundedFile(path: string, maximum = 12 * 1024 * 1024) {
  const before = identity(path), stat = lstatSync(path);
  if (before.directory || stat.size > maximum) fail("state file exceeds its bound");
  const bytes = readFileSync(path); sameIdentity(before);
  if (bytes.length > maximum || bytes.length !== stat.size) fail("state file changed during read");
  return bytes;
}
function writeExclusive(path: string, bytes: Buffer | string) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1) fail("exclusive state file identity changed"); }
  finally { closeSync(fd); }
}

type Stage = "reserved" | "bytes_verified" | "git_initialized" | "materializing" | "ready" | "uncertain";
interface JournalEntry { version: 1; stage: Stage; request_digest: string; previous: string | null; details: unknown }
export type { ProductSourceImportReadyV1 } from "@artoo/domain";
interface ResearchMapping {
  sourceProfileDigest: string; destinationProfileId: string;
  commandPairs: readonly { source_command_id: string; destination_command_id: string }[];
}
export interface ProductSourceRuntimeOptions {
  nodeId: string; storeRoot: string; allowedRoots: readonly string[]; profiles: readonly PreparedVerificationProfile[];
  gitExecutable: string; windowsBackend: PreparedWindowsProcessBackend;
  /** Explicit protected local retrieval store enables only first-hop research exports. */
  sourceResearch?: ResearchOptions;
  /** Administrator-selected complete pairings. Remote requests cannot choose them. */
  destinationResearchMappings?: readonly ResearchMapping[];
  /** Explicit local v2 preparation only. JSON cannot install a release reader or opt in ordinary runner discovery. */
  measurementV2?: { version: 1; releaseProfiles: readonly PreparedReleaseProfile[];
    destinationResearchMappings?: readonly (ResearchMapping & { sourceRelease: ReleaseCapabilitiesV1 })[] };
}
declare const runtimeBrand: unique symbol;
export interface PreparedProductSourceRuntime { readonly [runtimeBrand]: true }
interface Runtime {
  options: ProductSourceRuntimeOptions; store: ReturnType<typeof prepareWindowsReleaseStorage>; gitStore: ReturnType<typeof prepareWindowsCodeInstallation>;
  fixed: ReturnType<typeof identity>[]; gitChecksum: string; active: Map<string, string>; ownerPath: string; ownerIdentity: ReturnType<typeof identity>;
  importing: boolean; closed: boolean;
  researchStore?: ReturnType<typeof prepareWindowsReleaseStorage>;
  releases: readonly { profile: PreparedReleaseProfile; capabilities: ReleaseCapabilitiesV1; readCapabilities: ReleaseCapabilityReader }[];
  guardian?: { permit: PreparedWindowsGuardian; epochId: string };
  clean?: PreparedCleanDaemonConfiguration;
}
const runtimes = new WeakMap<PreparedProductSourceRuntime, Runtime>();
const guardianPreparations = new WeakSet<PreparedWindowsGuardian>();
const revisionExports = new WeakMap<PreparedProductSourceRuntime, Map<string, string>>();
function state(token: PreparedProductSourceRuntime, clean?: PreparedCleanDaemonConfiguration) {
  const current = runtimes.get(token); if (!current || current.closed) fail("an original live local runtime is required");
  if (current.guardian) {
    const owner = readWindowsGuardianLocalRuntime(current.guardian.permit);
    if (owner.mode !== "active" || owner.epoch.epoch_id !== current.guardian.epochId || owner.backend !== current.options.windowsBackend)
      fail("source runtime no longer belongs to the current registered guardian epoch");
    if (readCleanDaemonGuardian(current.guardian.permit) !== current.clean)
      fail("source runtime clean lineage binding changed after preparation");
  }
  if (clean && clean !== current.clean) fail("clean reader requires this runtime's original native configuration");
  if (current.clean) {
    const lineage = readCleanDaemonQuarantine(current.clean);
    if (lineage.node_id !== current.options.nodeId || lineage.store_root !== current.options.storeRoot)
      fail("source runtime changed its original clean generation storage");
    if (lineage.expected_grant && clean !== current.clean)
      fail("clean successor requires its dedicated checkpoint, validation, review or release admission");
  }
  assertWindowsReleaseStorage(current.store, current.options.storeRoot);
  for (const fixed of current.fixed) sameIdentity(fixed);
  sameIdentity(current.ownerIdentity);
  for (const profile of current.options.profiles) assertLocallyPreparedVerificationProfile(profile);
  if (current.releases.length) {
    const capabilities = readReleaseCapabilitiesBatch(current.releases.map(release => release.profile));
    if (current.releases.some((release, index) => !isDeepStrictEqual(capabilities[index], release.capabilities))) fail("prepared release capability changed");
  }
  retainedDestinations(current); // A crash before claim-file creation still fences an admitted operation.
  return current;
}
function profileFor(current: Runtime, id: string, project: string) {
  const profile = current.options.profiles.find(item => item.id === id && item.project_id === project);
  if (!profile) fail("exact prepared destination profile is missing"); return profile;
}
function localRelease(current: Runtime, profile: PreparedVerificationProfile) {
  const release = current.releases.find(item => item.profile.verifier === profile);
  if (!release || !isDeepStrictEqual(release.readCapabilities(), release.capabilities)) fail("exact prepared research release association is absent or changed");
  return release;
}
function validCommandPairs(mapping: ResearchMapping, profile: PreparedVerificationProfile | undefined, version: 1 | 2): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(mapping.sourceProfileDigest) && !!profile?.capabilities
    && profile.capabilities.measurement_plan_policy?.version === version && mapping.commandPairs.length === profile.capabilities.checks.length
    && new Set(mapping.commandPairs.map(pair => pair.source_command_id)).size === mapping.commandPairs.length
    && new Set(mapping.commandPairs.map(pair => pair.destination_command_id)).size === mapping.commandPairs.length
    && mapping.commandPairs.every(pair => profile.capabilities!.checks.some(check => check.command_id === pair.destination_command_id));
}
function claimPath(current: Runtime, root: string) { return join(current.options.storeRoot, "attestations", `claim-${key(root)}.json`); }
function operationPath(current: Runtime, transferId: string) { return join(current.options.storeRoot, "operations", key(transferId)); }
function retainedDestinations(current: Runtime): string[] {
  const operations = join(current.options.storeRoot, "operations"), names = readdirSync(operations).filter(name => name !== "owner.lock");
  if (names.length > 128) fail("source operation inventory exceeds its bound");
  return names.map(name => {
    if (!/^[a-f0-9]{64}$/.test(name) || !identity(join(operations, name)).directory) fail("unknown operation retained; node admission is blocked");
    const first = JSON.parse(boundedFile(join(operations, name, "0000.json"), 1024 * 1024).toString("utf8")) as JournalEntry;
    const request = ProductSourceTransferRequestV1Schema.parse(first.details);
    if (first.version !== 1 || first.stage !== "reserved" || first.previous !== null || key(request.transfer_id) !== name
      || productSourceTransferRequestDigestV1(request, sha) !== first.request_digest || request.destination.node_id !== current.options.nodeId) {
      fail("retained operation has an invalid original binding");
    }
    return request.destination.workspace_root;
  });
}
function readJournal(operation: string, requestDigest: string): JournalEntry[] {
  const names = readdirSync(operation).filter(name => /^\d{4}\.json$/.test(name)).sort();
  if (!names.length || names.length > 16) fail("operation journal is missing or exceeds its bound; retained");
  const entries: JournalEntry[] = []; let previous: string | null = null;
  const expected: Stage[] = ["reserved", "bytes_verified", "git_initialized", "materializing", "ready"];
  for (const [index, name] of names.entries()) {
    if (name !== `${index}`.padStart(4, "0") + ".json") fail("journal sequence is incomplete; retained");
    const bytes = boundedFile(join(operation, name), 1024 * 1024), entry = JSON.parse(bytes.toString("utf8")) as JournalEntry;
    if (entry.version !== 1 || entry.request_digest !== requestDigest || entry.previous !== previous
      || !["reserved", "bytes_verified", "git_initialized", "materializing", "ready", "uncertain"].includes(entry.stage)
      || canonical(entry) !== bytes.toString("utf8")) fail("journal binding changed; retained");
    if (entry.stage !== expected[index] && (entry.stage !== "uncertain" || index === 0 || index !== names.length - 1)) fail("journal transition changed; retained");
    entries.push(entry); previous = sha(bytes);
  }
  return entries;
}
function appendJournal(operation: string, requestDigest: string, stage: Stage, details: unknown) {
  const names = readdirSync(operation).filter(name => /^\d{4}\.json$/.test(name)).sort();
  if (names.length >= 16) fail("journal capacity exhausted; retained");
  const previous = names.length ? sha(boundedFile(join(operation, names.at(-1)!))) : null;
  writeExclusive(join(operation, `${names.length}`.padStart(4, "0") + ".json"), canonical({ version: 1, stage, request_digest: requestDigest, previous, details }));
}
function gitMetadataDigest(root: string) {
  const entries: unknown[] = [];
  const visit = (path: string, relativePath: string) => {
    if (entries.length >= 256) fail("Git metadata exceeds its bound");
    const fact = identity(path);
    if (fact.directory) { entries.push({ path: relativePath, kind: "directory" }); for (const name of readdirSync(path).sort()) visit(join(path, name), `${relativePath}/${name}`); }
    else { const bytes = boundedFile(path, 1024 * 1024); entries.push({ path: relativePath, kind: "file", size: bytes.length, checksum: sha(bytes) }); }
  };
  visit(root, ".git"); return hash(entries);
}
async function fixedGit(current: Runtime, cwd: string, args: readonly string[], kind: "read" | "materialize", signal?: AbortSignal) {
  assertWindowsCodeInstallation(current.gitStore, dirname(current.options.gitExecutable));
  if (sha(boundedFile(current.options.gitExecutable, 256 * 1024 * 1024)) !== current.gitChecksum) fail("local Git executable changed");
  const result = await runProtectedCommand({ cwd, args, kind, signal }, { gitExecutable: current.options.gitExecutable,
    readTimeoutMs: 10000, materializeTimeoutMs: 10000, maxOutputBytes: 64 * 1024,
    environment: { PATH: process.env.PATH, LANG: "C.UTF-8" } }, current.options.windowsBackend);
  if (result.status !== 0) fail(`fixed local Git command exited ${result.status}; staging retained`);
  return result.stdout.toString("utf8");
}

/** Explicit native Windows local setup. It never creates or weakens directory ACLs. */
export function prepareProductSourceRuntime(input: ProductSourceRuntimeOptions): PreparedProductSourceRuntime {
  return prepareSourceRuntime(input);
}
/** Only a genuine locally registered guardian may retain its already-held source lock.
 * Old owner files alone cannot enter this path or construct a runtime. */
export function prepareGuardianProductSourceRuntime(input: ProductSourceRuntimeOptions, guardian: PreparedWindowsGuardian): PreparedProductSourceRuntime {
  const owner = readWindowsGuardianLocalRuntime(guardian);
  if (owner.mode !== "active" || owner.backend !== input.windowsBackend || owner.binding.node_id !== input.nodeId
    || owner.local.storeDirectory !== input.storeRoot || !input.profiles.some(profile => profile.workspace_root === owner.local.workspaceRoot))
    fail("guardian source runtime changed its original node, backend, store or fixed workspace");
  if (readCleanDaemonGuardian(guardian) && guardianPreparations.has(guardian))
    fail("clean Guardian already attempted its sole source runtime preparation");
  guardianPreparations.add(guardian); // A partial clean preparation remains fenced.
  return prepareSourceRuntime(input, guardian);
}
function prepareSourceRuntime(input: ProductSourceRuntimeOptions, guardian?: PreparedWindowsGuardian): PreparedProductSourceRuntime {
  if (process.platform !== "win32" || !input.nodeId || !input.allowedRoots.length || !input.profiles.length) fail("qualified native Windows configuration is required");
  if (input.measurementV2 && (input.measurementV2.version !== 1 || !input.measurementV2.releaseProfiles.length)) fail("explicit versioned local release preparation is required");
  const sourceResearch = input.sourceResearch ? prepareResearchOptions(input.sourceResearch, input.allowedRoots) : undefined;
  const options = Object.freeze({ ...input, ...(sourceResearch ? { sourceResearch } : {}),
    ...(input.destinationResearchMappings ? { destinationResearchMappings: freezeJson(structuredClone(input.destinationResearchMappings)) } : {}),
    ...(input.measurementV2 ? { measurementV2: Object.freeze({ version: 1 as const,
      releaseProfiles: Object.freeze([...input.measurementV2.releaseProfiles]),
      ...(input.measurementV2.destinationResearchMappings ? { destinationResearchMappings: freezeJson(structuredClone(input.measurementV2.destinationResearchMappings)) } : {}) }) } : {}),
    allowedRoots: Object.freeze([...input.allowedRoots]), profiles: Object.freeze([...input.profiles]) });
  recordWindowsStartupPhase("source_profiles");
  prepareVerificationProfiles(options.profiles, options.allowedRoots); // Recheck every program/config/evidence boundary against the full node policy.
  recordWindowsStartupPhase("source_backend");
  assertWindowsProcessBackend(options.windowsBackend);
  // Preserve original prepared profile identities. Only this trusted factory can
  // install the node reader; the serialized extension remains descriptive data.
  recordWindowsStartupPhase("source_releases");
  const releaseProfiles = options.measurementV2?.releaseProfiles ?? [];
  for (const profile of releaseProfiles) {
    if (!options.profiles.includes(profile.verifier) || profile.verifier.capabilities?.measurement_plan_policy?.version !== 2) {
      fail("release association requires an original prepared local v2 verifier");
    }
  }
  const readers = releaseProfiles.length ? prepareReleaseCapabilityReaders(releaseProfiles) : [];
  const releases = Object.freeze(releaseProfiles.map((profile, index) => {
    const prepared = readers[index]!, readCapabilities = prepared.readCapabilities;
    const capabilities = freezeJson(ReleaseCapabilitiesV1Schema.parse(prepared.capabilities));
    const binding = capabilities.binding;
    if (binding.release_profile_id !== profile.id || binding.release_profile_digest !== profile.digest || binding.project_id !== profile.project_id
      || binding.workspace_root !== profile.verifier.workspace_root || binding.verification_profile_id !== profile.verifier.id
      || binding.verification_profile_digest !== profile.verifier.digest || binding.contract_digest !== sha(canonicalReleaseCapabilityContract(capabilities.contract))) {
      fail("prepared release association differs from its exact verifier or contract");
    }
    return Object.freeze({ profile, readCapabilities, capabilities });
  }));
  if (new Set(releases.map(release => release.profile.verifier)).size !== releases.length) fail("research release associations are ambiguous");
  recordWindowsStartupPhase("source_storage");
  const store = prepareWindowsReleaseStorage({ directory: options.storeRoot, writableWorkspaceRoots: options.allowedRoots });
  recordWindowsStartupPhase("git_installation");
  const gitStore = prepareWindowsCodeInstallation({ directory: dirname(options.gitExecutable), writableWorkspaceRoots: options.allowedRoots });
  if (sourceResearch && options.profiles.some(profile => profile.capabilities?.measurement_plan_policy?.version !== 1
    && !releases.some(release => release.profile.verifier === profile))) {
    fail("first-hop research exports require local v1 profiles or explicit prepared v2 release associations");
  }
  recordWindowsStartupPhase("research_storage");
  const researchStore = sourceResearch ? prepareWindowsReleaseStorage({ directory: sourceResearch.receiptDirectory,
    writableWorkspaceRoots: options.allowedRoots }) : undefined;
  recordWindowsStartupPhase("source_bindings");
  for (const mapping of options.destinationResearchMappings ?? []) {
    const profile = options.profiles.find(item => item.id === mapping.destinationProfileId);
    if (!validCommandPairs(mapping, profile, 1)) fail("destination research mappings require complete unique local v1 checks");
  }
  if (new Set(options.destinationResearchMappings?.map(mapping => `${mapping.sourceProfileDigest}:${mapping.destinationProfileId}`)).size
    !== (options.destinationResearchMappings?.length ?? 0)) fail("destination research mappings are ambiguous");
  for (const mapping of options.measurementV2?.destinationResearchMappings ?? []) {
    const profile = options.profiles.find(item => item.id === mapping.destinationProfileId);
    const release = releases.find(item => item.profile.verifier === profile), source = ReleaseCapabilitiesV1Schema.parse(mapping.sourceRelease);
    if (!validCommandPairs(mapping, profile, 2) || !release || source.binding.verification_profile_digest !== mapping.sourceProfileDigest
      || source.binding.project_id !== profile!.project_id || source.binding.contract_digest !== sha(canonicalReleaseCapabilityContract(source.contract))
      || !isDeepStrictEqual(source.contract, release.capabilities.contract)) fail("destination v2 research mapping requires complete checks and exact prepared release contracts");
  }
  const v2Mappings = options.measurementV2?.destinationResearchMappings ?? [];
  if (new Set(v2Mappings.map(mapping => `${mapping.sourceProfileDigest}:${mapping.destinationProfileId}`)).size !== v2Mappings.length) fail("destination v2 research mappings are ambiguous");
  const fixed = [options.storeRoot, ...options.allowedRoots, ...options.profiles.map(profile => {
    assertLocallyPreparedVerificationProfile(profile);
    if (!options.allowedRoots.some(root => inside(profile.workspace_root, root)) || options.allowedRoots.some(root => overlaps(options.storeRoot, root))) fail("profile or store escapes all local write-root boundaries");
    return profile.workspace_root;
  })].map(identity);
  recordWindowsStartupPhase("source_layout");
  for (const directory of ["operations", "attestations", "artifacts"]) {
    const path = join(options.storeRoot, directory); if (!existsSync(path)) mkdirSync(path, { mode: 0o700 }); fixed.push(identity(path));
  }
  const storeBinding = canonical({ version: 1, node_id: options.nodeId, directory: identity(options.storeRoot) });
  const storeBindingPath = join(options.storeRoot, "attestations", "store.json");
  if (existsSync(storeBindingPath)) { if (boundedFile(storeBindingPath).toString("utf8") !== storeBinding) fail("source store belongs to another node or physical directory"); }
  else writeExclusive(storeBindingPath, storeBinding);
  const ownerPath = join(options.storeRoot, "operations", "owner.lock");
  // Never infer that a crashed owner's writer is gone from a PID, timestamp or lease age.
  if (guardian) {
    const live = readWindowsGuardianLocalRuntime(guardian), marker = JSON.parse(boundedFile(ownerPath, 65536).toString("utf8"));
    if (live.mode !== "active" || marker.version !== 1 || marker.capability !== "artoo.windows-runtime-guardian.v1"
      || marker.endpoint?.guardianInstanceId !== live.binding.guardian_instance_id || canonical(marker.binding) !== canonical(live.binding))
      fail("actual source owner lock differs from the original live guardian");
  } else writeExclusive(ownerPath, canonical({ version: 1, node_id: options.nodeId, nonce: randomUUID() }));
  const ownerIdentity = identity(ownerPath), token = Object.freeze({}) as PreparedProductSourceRuntime;
  const current: Runtime = { options, store, gitStore, fixed, gitChecksum: sha(boundedFile(options.gitExecutable, 256 * 1024 * 1024)), active: new Map(),
    ownerPath, ownerIdentity, importing: false, closed: false, researchStore, releases,
    ...(guardian ? { guardian: { permit: guardian, epochId: readWindowsGuardianLocalRuntime(guardian).epoch.epoch_id },
      clean: readCleanDaemonGuardian(guardian) } : {}) };
  runtimes.set(token, current);
  recordWindowsStartupPhase("source_store_audit");
  try {
    auditWindowsReleaseStorage(store, options.storeRoot);
    recordWindowsStartupPhase("source_retained_destinations");
    retainedDestinations(current);
  }
  catch (error) { current.closed = true; throw error; } // A failed setup retains the ownership fence.
  return token;
}

/** Recovery shares protected configuration and the current live store, never old author
 * or verifier brands. Every returned profile/release reader is an original local object. */
export function readGuardianProductSourceConfiguration(token: PreparedProductSourceRuntime, guardian: PreparedWindowsGuardian) {
  const current = state(token);
  if (current.guardian?.permit !== guardian) fail("source configuration is not owned by this guardian");
  return { options: current.options, store: current.store, releases: current.releases, active: current.active, importing: current.importing };
}

/** Dedicated clean consumers must hold the actual original native configuration
 * and Guardian together. Ordinary/export/semantic/H9 entry points use state()
 * without this configuration and remain fenced for the whole successor epoch. */
export function readCleanGuardianProductSourceConfiguration(token: PreparedProductSourceRuntime, guardian: PreparedWindowsGuardian,
  clean: PreparedCleanDaemonConfiguration) {
  const current = state(token, clean);
  if (current.guardian?.permit !== guardian || current.clean !== clean || readCleanDaemonGuardian(guardian) !== clean)
    fail("clean source reader requires the exact original native generation");
  return { options: current.options, store: current.store, releases: current.releases, active: current.active, importing: current.importing };
}

export function assertProductSourceRuntimeConfiguration(token: PreparedProductSourceRuntime, nodeId: string,
  allowedRoots: readonly string[] | undefined, profiles: readonly PreparedVerificationProfile[]): void {
  const current = state(token);
  if (current.options.nodeId !== nodeId || !allowedRoots || !isDeepStrictEqual([...allowedRoots].sort(), [...current.options.allowedRoots].sort())
    || profiles.length !== current.options.profiles.length || profiles.some(profile => !current.options.profiles.includes(profile))) {
    fail("node identity, complete write roots or original prepared profile set differs");
  }
}

/** Called at every run/release admission, including before duplicate acknowledgements. */
export function assertProductSourceWorkspaceBoundary(token: PreparedProductSourceRuntime, workspaceRoot: string): void {
  const current = state(token), root = realpathSync.native(workspaceRoot);
  assertResearchRevisionWorkspaceBoundary(current.options.storeRoot, root);
  if (overlaps(root, current.options.storeRoot)) fail("ordinary execution overlaps protected source storage");
  if (retainedDestinations(current).some(destination => overlaps(root, destination))) fail("workspace has a retained product source import");
  for (const profile of current.options.profiles) if (overlaps(root, profile.workspace_root) && existsSync(claimPath(current, profile.workspace_root))) {
    fail("workspace has a retained product source import; explicit semantic admission is not implemented");
  }
}
export function claimProductSourceRun(token: PreparedProductSourceRuntime, runId: string, workspaceRoot: string): void {
  assertProductSourceWorkspaceBoundary(token, workspaceRoot);
  const current = state(token), root = realpathSync.native(workspaceRoot);
  if (current.importing || [...current.active.entries()].some(([id, path]) => id !== runId && overlaps(path, root))) fail("workspace is already exclusively occupied");
  if (current.active.has(runId)) fail("run identity already retains a workspace claim");
  current.active.set(runId, root);
}
/** Node may call only after existing actual process/tool closure checks; uncertain runs keep this fence. */
export function releaseProductSourceRun(token: PreparedProductSourceRuntime, runId: string): void { state(token).active.delete(runId); }

export function captureProductSourceExport(token: PreparedProductSourceRuntime, input: { runStart: RunStartPayload; profile: PreparedVerificationProfile;
  evidence: RunVerificationPayload; admission: WindowsVerifiedExecutionAdmission; handle: AgentInstanceHandle }): ProductSourceExportV1 {
  const current = state(token), { runStart: start, profile, evidence } = input, context = start.context_pack.payload;
  RunStartPayloadSchema.parse(start);
  if (!context?.product_development || !context.goal_context?.plan || !start.verification || context.policy.execution_mode === "discussion"
    || context.project.id !== profile.project_id || context.task.id !== start.task_id || start.workspace.root !== profile.workspace_root
    || current.active.get(start.run_id) !== profile.workspace_root) fail("export requires its active exact product-stage run and current plan context");
  assertWindowsVerifiedExecutionExportBinding(input.admission, input.handle, profile, start);
  assertFinalVerificationExportBinding(profile, evidence, start.verification.request_id, context);
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  const snapshot = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: evidence.subject_digest! });
  const descriptor = describeProductSourceSnapshot(snapshot), bytes = encodeProductSourceSnapshot(snapshot);
  const capsulePath = join(current.options.storeRoot, "artifacts", `${descriptor.capsule_digest.slice(7)}.json`);
  if (existsSync(capsulePath)) { if (!boundedFile(capsulePath).equals(bytes)) fail("stored export bytes changed"); }
  else writeExclusive(capsulePath, bytes);
  const proof = ProductSourceExportV1Schema.parse({ version: 1, export_id: hash({ run_id: start.run_id, request_id: evidence.request_id, capsule_digest: descriptor.capsule_digest }),
    node_id: current.options.nodeId, run_id: start.run_id, task_id: start.task_id, project_id: profile.project_id,
    goal_id: context.goal_context.goal_id, plan_id: context.goal_context.plan.id,
    verification_request_id: evidence.request_id, profile_id: profile.id, profile_digest: profile.digest, subject_digest: evidence.subject_digest,
    context_digest: hash(context), verification_digest: hash(evidence), capsule_digest: descriptor.capsule_digest, manifest_digest: descriptor.manifest_digest,
    capsule_bytes: bytes.length, author_closure: "windows-job-and-tools-closed.v1", execution_authorized: false });
  const path = join(current.options.storeRoot, "attestations", `export-${proof.export_id.slice(7)}.json`);
  if (existsSync(path)) { if (boundedFile(path).toString("utf8") !== canonical(proof)) fail("immutable export identity changed"); }
  else writeExclusive(path, canonical(proof));
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  if (subjectManifest(profile).digest !== evidence.subject_digest || sha(boundedFile(capsulePath)) !== proof.capsule_digest) fail("source changed while sealing its export");
  return Object.freeze(proof);
}

export function productSourceSemanticExportEnabled(token: PreparedProductSourceRuntime): boolean { return state(token).researchStore !== undefined; }
/** Describes validated local roles, including destination-only nodes without a research store. */
export function readProductSourceRuntimeCapabilities(token: PreparedProductSourceRuntime) {
  const current = state(token), v1 = current.options.destinationResearchMappings ?? [],
    v2 = current.options.measurementV2?.destinationResearchMappings ?? [];
  return Object.freeze({ semantic: current.researchStore !== undefined || v1.length > 0 || v2.length > 0,
    researchRevision: current.researchStore !== undefined && current.releases.length > 0,
    measurementV2: current.researchStore !== undefined && current.releases.length > 0 || v2.length > 0,
    importedReview: v1.length > 0 || v2.length > 0, importedDesign: v2.length > 0,
    importedDesignReview: v2.some(mapping => { const profile = current.options.profiles.find(item => item.id === mapping.destinationProfileId);
      if (!profile) return false; try { assertImportedDesignReviewVerificationProfile(profile); return true; } catch { return false; } }),
    importedExecution: v2.some(mapping => { const profile = current.options.profiles.find(item => item.id === mapping.destinationProfileId);
      if (!profile) return false; try { assertImportedExecutionVerificationProfile(profile); return true; } catch { return false; } }),
    importedValidation: v2.some(mapping => { const profile = current.options.profiles.find(item => item.id === mapping.destinationProfileId);
      if (!profile) return false; try { assertImportedValidationVerificationProfile(profile); return true; } catch { return false; } }) });
}
export function productSourceMeasurementV2ExportEnabled(token: PreparedProductSourceRuntime, profile: PreparedVerificationProfile): boolean {
  const current = state(token);
  return current.researchStore !== undefined && current.releases.some(release => release.profile.verifier === profile);
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

/** First-hop only: every origin is read from this node's protected original retrieval store. */
export function captureProductSourceExportV2(token: PreparedProductSourceRuntime, input: Parameters<typeof captureProductSourceExport>[1]): ProductSourceExportV2 {
  const current = state(token), context = input.runStart.context_pack.payload, profile = input.profile, researchOptions = current.options.sourceResearch;
  const version = profile.capabilities?.measurement_plan_policy?.version;
  if (!researchOptions || !current.researchStore || !current.options.profiles.includes(profile) || context?.product_development?.stage !== "research"
    || context.review_subject || !context.goal_context?.plan || !profile.capabilities || version !== 1 && version !== 2) {
    fail("semantic export supports only first-hop local research with its original measurement profile");
  }
  const release = version === 2 ? localRelease(current, profile) : undefined;
  assertReleaseCapabilityContext(context, release?.readCapabilities);
  if (release ? !isDeepStrictEqual(input.runStart.verification?.release_capability_binding, release.capabilities.binding)
    : input.runStart.verification?.release_capability_binding !== undefined) fail("source release binding differs from its prepared research profile");
  const byteExport = captureProductSourceExport(token, input);
  auditWindowsReleaseStorage(current.researchStore, researchOptions.receiptDirectory);
  const bytes = readProductFile(profile.workspace_root, ".artoo/product/research.json");
  const report = (version === 2 ? ProductResearchReportV2Schema : ProductResearchReportV1Schema).parse(JSON.parse(bytes.toString("utf8")));
  const measured = input.evidence.required_files.find(file => file.path === ".artoo/product/research.json");
  const summary = input.evidence.measurement_plan;
  if (!measured || measured.size !== bytes.length || measured.checksum !== sha(bytes) || summary?.version !== version || summary.scope !== "final"
    || !isDeepStrictEqual(summary.policy, profile.capabilities.measurement_plan_policy) || !isDeepStrictEqual(summary.research, measured)
    || summary.version === 2 && summary.pending_release.some(criterion => !isDeepStrictEqual(criterion.release_binding, release?.capabilities.binding))) {
    fail("exported research differs from original final measurement");
  }
  const expectedReceiptKeys = ["version", "id", "url", "title", "retrieved_at", "content_digest", "media_type", "bytes", "binding", "text", "content_base64"].sort();
  const provenance = { version: 1, chain_depth: 0, research: measured, sources: report.sources.map(metadata => {
    const receipt = readResearchReceipt(researchOptions, metadata.id, { projectId: profile.project_id, goalId: context.goal_context!.goal_id,
      workspaceRoot: profile.workspace_root });
    if (!isDeepStrictEqual(Object.keys(receipt).sort(), expectedReceiptKeys) || receipt.version !== 1
      || receipt.bytes !== Buffer.from(receipt.content_base64, "base64").length) fail("foreign, incomplete or malformed retrieval receipt cannot be relabelled as local");
    const actual = { id: receipt.id, url: receipt.url, title: receipt.title, retrieved_at: receipt.retrieved_at, content_digest: receipt.content_digest };
    if (!isDeepStrictEqual(actual, metadata)) fail("report source differs from its original local receipt");
    return { metadata: actual, metadata_digest: hash(actual), content_bytes: receipt.bytes,
      origin: { node_id: current.options.nodeId, run_id: receipt.binding.runId, task_id: receipt.binding.taskId,
        project_id: receipt.binding.projectId, goal_id: receipt.binding.goalId, workspace_root: receipt.binding.workspaceRoot } };
  }).sort((left, right) => left.metadata.id.localeCompare(right.metadata.id)) };
  (version === 2 ? assertProductResearchProvenanceV2 : assertProductResearchProvenanceV1)(provenance, bytes, sha);
  const proof = ProductSourceExportV2Schema.parse({ version: 2, byte_export: byteExport, stage: "research", source_capabilities: profile.capabilities,
    research_provenance: provenance, research_provenance_digest: hash(provenance),
    ...(release ? { measurement_v2: { version: 1, source_release: release.capabilities } } : {}) });
  const proofDigest = productSourceExportDigestV2(proof, sha), path = join(current.options.storeRoot, "attestations", `semantic-export-${proofDigest.slice(7)}.json`);
  if (existsSync(path)) { if (boundedFile(path).toString("utf8") !== canonical(proof)) fail("immutable semantic export changed"); }
  else writeExclusive(path, canonical(proof));
  auditWindowsReleaseStorage(current.researchStore, researchOptions.receiptDirectory);
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  assertReleaseCapabilityContext(context, release?.readCapabilities);
  state(token);
  if (!readProductFile(profile.workspace_root, measured.path).equals(bytes) || subjectManifest(profile).digest !== input.evidence.subject_digest) {
    fail("source changed while sealing original retrieval provenance");
  }
  if (readProductResearchRevision(context)) {
    const exports = revisionExports.get(token) ?? new Map<string, string>();
    exports.set(input.runStart.run_id, input.evidence.subject_digest!); revisionExports.set(token, exports);
  }
  return freezeJson(proof);
}

/** Old research is checked against node-private sealed bytes, never a remote reconstructed export. */
export function claimProductResearchRevisionRun(token: PreparedProductSourceRuntime, start: RunStartPayload,
  profile: PreparedVerificationProfile): void {
  const current = state(token), context = start.context_pack.payload!, revision = readProductResearchRevision(context);
  assertProductResearchRevisionRun(start, current.options.nodeId);
  if (!revision || !productSourceMeasurementV2ExportEnabled(token, profile) || !current.options.profiles.includes(profile)) fail("revision requires the original prepared source research runtime");
  const baseline = revision.baseline;
  if (baseline.computer_id !== current.options.nodeId || baseline.workspace_root !== profile.workspace_root
    || baseline.profile_id !== profile.id || baseline.profile_digest !== profile.digest) fail("revision source profile changed");
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  const proof = ProductSourceExportV2Schema.parse(JSON.parse(boundedFile(join(current.options.storeRoot, "attestations",
    `semantic-export-${baseline.export_digest.slice(7)}.json`)).toString("utf8"))), original = proof.byte_export;
  if (productSourceExportDigestV2(proof, sha) !== baseline.export_digest || proof.research_provenance_digest !== baseline.provenance_digest
    || hash(proof.research_provenance) !== baseline.provenance_digest || !isDeepStrictEqual(proof.research_provenance.research, baseline.research)
    || !isDeepStrictEqual(proof.source_capabilities, profile.capabilities) || !isDeepStrictEqual(proof.measurement_v2?.source_release, localRelease(current, profile).capabilities)
    || original.node_id !== current.options.nodeId || original.project_id !== context.project.id || original.goal_id !== revision.goal_id
    || original.plan_id !== revision.plan_id || original.task_id !== baseline.source_task_id || original.run_id !== baseline.source_run_id
    || original.profile_id !== profile.id || original.profile_digest !== profile.digest || original.subject_digest !== baseline.subject_digest
    || original.capsule_digest !== baseline.capsule_digest || original.capsule_bytes !== baseline.capsule_bytes
    || original.export_id !== hash({ run_id: original.run_id, request_id: original.verification_request_id, capsule_digest: original.capsule_digest })) {
    fail("revision baseline differs from its retained semantic export");
  }
  const byteProof = boundedFile(join(current.options.storeRoot, "attestations", `export-${original.export_id.slice(7)}.json`));
  if (byteProof.toString("utf8") !== canonical(original)) fail("revision byte export differs from its retained author closure");
  const capsule = boundedFile(join(current.options.storeRoot, "artifacts", `${baseline.capsule_digest.slice(7)}.json`));
  if (capsule.length !== baseline.capsule_bytes || sha(capsule) !== baseline.capsule_digest) fail("revision retained capsule changed");
  decodeProductSourceSnapshot(capsule, { capsuleDigest: baseline.capsule_digest, manifestDigest: original.manifest_digest,
    source: { project_id: context.project.id, profile_id: profile.id, profile_digest: profile.digest, subject_digest: baseline.subject_digest } });
  const file = (JSON.parse(capsule.toString("utf8")) as { files: { path: string; base64: string }[] }).files.find(item => item.path === baseline.research.path);
  if (!file) fail("revision capsule lacks its research file");
  const research = Buffer.from(file.base64, "base64");
  if (research.length !== baseline.research.size || sha(research) !== baseline.research.checksum) fail("revision research differs from its retained capsule");
  assertProductResearchProvenanceV2(proof.research_provenance, research, sha);
  // The ordinary source claim checks all live writers and imported-workspace fences first.
  claimProductSourceRun(token, start.run_id, profile.workspace_root);
  try {
    admitProductResearchRevision({ store: current.options.storeRoot, start, subjectDigest: subjectManifest(profile).digest,
      assertBaseline() {
        if (subjectManifest(profile).digest !== baseline.subject_digest || !readProductFile(profile.workspace_root, baseline.research.path).equals(research)) {
          fail("first revision author must start from the exact retained source subject");
        }
      } });
  } catch (error) {
    // A partially persisted admission remains fenced; only a proven absent admission can release.
    assertResearchRevisionWorkspaceClosed(current.options.storeRoot, profile.workspace_root);
    current.active.delete(start.run_id); throw error;
  }
}

/** Unknown native/tool closure never records a retry checkpoint, even if an adapter exited. */
export function closeProductResearchRevisionRun(token: PreparedProductSourceRuntime, start: RunStartPayload,
  profile: PreparedVerificationProfile, execution?: { admission: WindowsVerifiedExecutionAdmission; handle: AgentInstanceHandle }): void {
  if (!readProductResearchRevision(start.context_pack.payload)) return;
  const current = state(token);
  if (current.active.get(start.run_id) !== profile.workspace_root || !current.options.profiles.includes(profile)) fail("revision lost its original workspace claim");
  if (execution) assertWindowsVerifiedExecutionExportBinding(execution.admission, execution.handle, profile, start);
  const subject = subjectManifest(profile).digest;
  closeProductResearchRevision({ store: current.options.storeRoot, start, subjectDigest: subject,
    unstarted: execution === undefined,
    authorVerified: revisionExports.get(token)?.get(start.run_id) === subject,
    assertClosed() {
      if (execution) assertWindowsVerifiedExecutionExportBinding(execution.admission, execution.handle, profile, start);
      // The absent execution case is called solely before any adapter/workspace producer invocation;
      // the journal also requires the exact admitted bytes to remain unchanged.
    } });
  revisionExports.get(token)?.delete(start.run_id);
}

export function readProductSourceExportBytesV2(token: PreparedProductSourceRuntime, input: unknown, requestDigest: string): Buffer {
  const current = state(token), request = ProductSourceTransferRequestV2Schema.parse(input);
  if (productSourceTransferRequestDigestV2(request, sha) !== requestDigest) fail("full semantic request digest differs");
  const sourceRelease = request.source_export.measurement_v2?.source_release;
  const release = sourceRelease ? localRelease(current, profileFor(current, request.byte_request.source.profile_id, request.byte_request.project_id)) : undefined;
  if (release && !isDeepStrictEqual(release.capabilities, sourceRelease)) fail("exported source release differs from current local configuration");
  const path = join(current.options.storeRoot, "attestations", `semantic-export-${request.source_export_digest.slice(7)}.json`);
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  if (boundedFile(path).toString("utf8") !== canonical(request.source_export)) fail("semantic export does not match the locally sealed original provenance");
  const bytes = readProductSourceExportBytes(token, request.byte_request, productSourceTransferRequestDigestV1(request.byte_request, sha));
  state(token);
  return bytes;
}

/** Fixed transport can upload only bytes already sealed by the real local export path. */
export function readProductSourceExportBytes(token: PreparedProductSourceRuntime, input: unknown, requestDigest: string): Buffer {
  const current = state(token), request = ProductSourceTransferRequestV1Schema.parse(input), source = request.source;
  if (source.node_id !== current.options.nodeId || productSourceTransferRequestDigestV1(request, sha) !== requestDigest) fail("upload node or immutable request differs");
  const exportId = hash({ run_id: source.run_id, request_id: source.verification_request_id, capsule_digest: source.capsule_digest });
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  const proof = ProductSourceExportV1Schema.parse(JSON.parse(boundedFile(join(current.options.storeRoot, "attestations", `export-${exportId.slice(7)}.json`)).toString("utf8")));
  if (proof.export_id !== exportId || proof.node_id !== source.node_id || proof.run_id !== source.run_id || proof.task_id !== source.task_id
    || proof.project_id !== request.project_id || proof.goal_id !== request.goal_id || proof.plan_id !== request.plan_id
    || proof.verification_request_id !== source.verification_request_id || proof.profile_id !== source.profile_id || proof.profile_digest !== source.profile_digest
    || proof.subject_digest !== source.subject_digest || proof.capsule_digest !== source.capsule_digest || proof.manifest_digest !== source.manifest_digest
    || proof.capsule_bytes !== source.capsule_bytes) fail("stored export proof differs from complete transfer source binding");
  const bytes = boundedFile(join(current.options.storeRoot, "artifacts", `${proof.capsule_digest.slice(7)}.json`));
  if (bytes.length !== proof.capsule_bytes || sha(bytes) !== proof.capsule_digest) fail("sealed export bytes changed");
  decodeProductSourceSnapshot(bytes, { capsuleDigest: source.capsule_digest, manifestDigest: source.manifest_digest,
    source: { project_id: request.project_id, profile_id: source.profile_id, profile_digest: source.profile_digest, subject_digest: source.subject_digest } });
  return bytes;
}

function destination(current: Runtime, request: ProductSourceTransferRequestV1, requestDigest: string) {
  if (request.destination.node_id !== current.options.nodeId || productSourceTransferRequestDigestV1(request, sha) !== requestDigest) fail("transfer node or complete request digest differs");
  const profile = profileFor(current, request.destination.profile_id, request.project_id);
  if (profile.workspace_root !== request.destination.workspace_root || profile.digest !== request.destination.capabilities.profile_digest
    || hash(request.destination.capabilities) !== request.destination.capability_digest) fail("destination's exact local profile binding differs");
  // Even a physical import must bind an explicitly advertised local profile. It does
  // not approve foreign measurement equivalence or grant a verifier pass.
  if (!profile.capabilities || !isDeepStrictEqual(profile.capabilities, request.destination.capabilities)) fail("destination capability snapshot is absent or changed");
  return profile;
}
export function readProductSourceImportReady(token: PreparedProductSourceRuntime, input: unknown, requestDigest: string): ProductSourceImportReadyV1 {
  const current = state(token), request = ProductSourceTransferRequestV1Schema.parse(input), profile = destination(current, request, requestDigest);
  const journal = readJournal(operationPath(current, request.transfer_id), requestDigest), final = journal.at(-1)!;
  if (final.stage !== "ready") fail("import is pending or uncertain; retained without execution authority");
  if (!isDeepStrictEqual(journal[0]!.details, request)) fail("original import request changed");
  const claim = JSON.parse(boundedFile(claimPath(current, profile.workspace_root)).toString("utf8"));
  if (!isDeepStrictEqual(claim, { version: 1, transfer_id: request.transfer_id, request_digest: requestDigest,
    destination: identity(profile.workspace_root) })) fail("exclusive destination claim changed");
  const ready = ProductSourceImportReadyV1Schema.parse(final.details);
  if (ready.version !== 1 || ready.transfer_id !== request.transfer_id || ready.request_digest !== requestDigest || ready.execution_authorized !== false
    || ready.verification_passed !== false || ready.semantic_mapping_accepted !== false || ready.destination?.profile_digest !== profile.digest
    || ready.destination.project_id !== request.project_id || ready.destination.profile_id !== profile.id || ready.destination.node_id !== current.options.nodeId || ready.destination.workspace_root !== profile.workspace_root
    || ready.git_processes_closed !== true || ready.capsule_digest !== request.source.capsule_digest || ready.manifest_digest !== request.source.manifest_digest) fail("ready receipt binding changed");
  if (gitMetadataDigest(join(profile.workspace_root, ".git")) !== ready.git_metadata_digest) fail("imported local Git metadata changed");
  const currentSnapshot = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: ready.destination.subject_digest });
  if (describeProductSourceSnapshot(currentSnapshot).manifest_digest !== ready.manifest_digest) fail("imported product bytes changed");
  const bytes = boundedFile(join(current.options.storeRoot, "artifacts", `${ready.capsule_digest.slice(7)}.json`));
  if (sha(bytes) !== ready.capsule_digest) fail("retained imported capsule changed");
  return structuredClone(ready);
}

/** Downloads are supplied only by the fixed paired-node HTTP client. This function validates
 * bytes and retains a durable physical import; it deliberately cannot start any product task. */
export async function importProductSourceTransfer(token: PreparedProductSourceRuntime, input: unknown, requestDigest: string,
  capsule: Uint8Array, signal?: AbortSignal): Promise<ProductSourceImportReadyV1> {
  const current = state(token), request = ProductSourceTransferRequestV1Schema.parse(input), profile = destination(current, request, requestDigest);
  const operation = operationPath(current, request.transfer_id);
  if (existsSync(operation)) {
    const first = readJournal(operation, requestDigest)[0]!;
    if (!isDeepStrictEqual(first.details, request)) fail("operation ID is already bound to another request");
    return readProductSourceImportReady(token, request, requestDigest); // Incomplete states never rerun Git or overwrite partial source.
  }
  if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("destination is occupied by a live run or import");
  if (readdirSync(profile.workspace_root).length || existsSync(claimPath(current, profile.workspace_root))) fail("destination must be fresh and unclaimed");
  if (!(capsule instanceof Uint8Array) || capsule.byteLength > 12 * 1024 * 1024) fail("downloaded capsule exceeds its bound");
  const bytes = Buffer.from(capsule);
  if (bytes.length !== request.source.capsule_bytes) fail("downloaded capsule size differs");
  const snapshot = decodeProductSourceSnapshot(bytes, { capsuleDigest: request.source.capsule_digest, manifestDigest: request.source.manifest_digest,
    source: { project_id: request.project_id, profile_id: request.source.profile_id, profile_digest: request.source.profile_digest, subject_digest: request.source.subject_digest } });
  signal?.throwIfAborted(); auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  current.importing = true;
  let journalStarted = false;
  try {
    mkdirSync(operation, { mode: 0o700 });
    appendJournal(operation, requestDigest, "reserved", request); journalStarted = true;
    writeExclusive(claimPath(current, profile.workspace_root), canonical({ version: 1, transfer_id: request.transfer_id, request_digest: requestDigest,
      destination: identity(profile.workspace_root) }));
    const capsulePath = join(current.options.storeRoot, "artifacts", `${request.source.capsule_digest.slice(7)}.json`);
    if (existsSync(capsulePath)) { if (!boundedFile(capsulePath).equals(bytes)) fail("existing capsule bytes differ"); }
    else writeExclusive(capsulePath, bytes);
    appendJournal(operation, requestDigest, "bytes_verified", { capsule_digest: request.source.capsule_digest });
    const staging = join(operation, "git-staging"); mkdirSync(staging, { mode: 0o700 });
    // Guardian admits launches from the registered workspace; an explicit target keeps
    // Git metadata in protected staging and the destination empty until materialization.
    await fixedGit(current, profile.workspace_root, ["-c", "init.templateDir=", "init", "--initial-branch=main", staging], "materialize", signal);
    state(token); signal?.throwIfAborted();
    const metadataDigest = gitMetadataDigest(join(staging, ".git"));
    appendJournal(operation, requestDigest, "git_initialized", { git_metadata_digest: metadataDigest, processes_closed: true });
    appendJournal(operation, requestDigest, "materializing", { destination: identity(profile.workspace_root) });
    const imported = materializeProductSourceSnapshot({ snapshot, expectedCapsuleDigest: request.source.capsule_digest,
      profile, expectedProfileDigest: profile.digest });
    if (existsSync(join(profile.workspace_root, ".git"))) fail("destination Git metadata appeared; retained");
    renameSync(join(staging, ".git"), join(profile.workspace_root, ".git"));
    writeExclusive(join(profile.workspace_root, ".gitignore"), "context_pack.md\nchanges.patch\nnode_modules/\n.artoo/product/research-receipts.json\n");
    const roots = (await fixedGit(current, profile.workspace_root, ["rev-parse", "--show-toplevel", "--absolute-git-dir"], "read", signal)).trim().split(/\r?\n/);
    if (roots.length !== 2 || realpathSync.native(roots[0]!) !== profile.workspace_root
      || realpathSync.native(roots[1]!) !== join(profile.workspace_root, ".git") || gitMetadataDigest(join(profile.workspace_root, ".git")) !== metadataDigest) {
      fail("new Git metadata does not describe the exact destination");
    }
    const measured = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: imported.destination.subject_digest });
    if (describeProductSourceSnapshot(measured).manifest_digest !== request.source.manifest_digest) fail("product changed during local Git setup");
    state(token); auditWindowsReleaseStorage(current.store, current.options.storeRoot); signal?.throwIfAborted();
    const ready: ProductSourceImportReadyV1 = { version: 1, transfer_id: request.transfer_id, request_digest: requestDigest,
      capsule_digest: request.source.capsule_digest, manifest_digest: request.source.manifest_digest,
      destination: { node_id: current.options.nodeId, ...imported.destination }, git_metadata_digest: metadataDigest, git_processes_closed: true,
      verification_passed: false, execution_authorized: false, semantic_mapping_accepted: false };
    appendJournal(operation, requestDigest, "ready", ready);
    const result = readProductSourceImportReady(token, request, requestDigest);
    current.importing = false;
    return result;
  } catch (error) {
    if (journalStarted) {
      try { appendJournal(operation, requestDigest, "uncertain", { retained: true, execution_authorized: false }); }
      catch { /* The earlier durable claim remains authoritative even if the failure record cannot flush. */ }
    }
    throw new Error("Product source import incomplete; all claims, staging and destination contents retained", { cause: error });
  } // Any failed operation keeps the current owner fenced, including uncertain process closure.
}

export function closeProductSourceRuntime(token: PreparedProductSourceRuntime): void {
  const current = state(token);
  if (current.importing || current.active.size || retainedImportedDesigns.get(token)?.size || retainedImportedExecutions.get(token)?.size
    || retainedImplementationWork.get(token)?.size || retainedValidationWork.get(token)?.size) fail("live or uncertain work still owns the source runtime");
  sameIdentity(current.ownerIdentity); unlinkSync(current.ownerPath); current.closed = true;
  // Persistent workspace claims and journals remain. Reopening cannot authorize a writer.
}

declare const semanticAdmissionBrand: unique symbol;
export interface PreparedProductSourceVerificationAdmission { readonly [semanticAdmissionBrand]: true }
interface SemanticAdmission {
  runtime: PreparedProductSourceRuntime; authenticated: AuthenticatedProductSourceTransferV2;
  profile: PreparedVerificationProfile; start: RunStartPayload; startDigest: string;
  envelope: ProductSourceVerificationEnvelope; digest: string; path: string;
  readReleaseCapabilities?: ReleaseCapabilityReader;
}
const semanticAdmissions = new WeakMap<PreparedProductSourceVerificationAdmission, SemanticAdmission>();

function localResearchMapping(current: Runtime, request: ProductSourceTransferRequestV2) {
  const ordered = (pairs: readonly { source_command_id: string; destination_command_id: string }[]) => [...pairs].sort((a, b) => a.source_command_id.localeCompare(b.source_command_id));
  const sourceProfile = request.source_export.byte_export.profile_digest, destinationId = request.byte_request.destination.profile_id;
  if (request.measurement_v2) {
    const configured = current.options.measurementV2?.destinationResearchMappings?.find(mapping => mapping.sourceProfileDigest === sourceProfile
      && mapping.destinationProfileId === destinationId);
    const profile = destination(current, request.byte_request, productSourceTransferRequestDigestV1(request.byte_request, sha));
    const release = localRelease(current, profile);
    if (!configured || !isDeepStrictEqual(ordered(configured.commandPairs), ordered(request.command_pairs))
      || !isDeepStrictEqual(configured.sourceRelease, request.source_export.measurement_v2?.source_release)
      || !isDeepStrictEqual(release.capabilities, request.measurement_v2.destination_release)) {
      fail("foreign v2 research mapping or complete release configuration is not explicitly prepared locally");
    }
    return release;
  }
  const configured = current.options.destinationResearchMappings?.find(mapping => mapping.sourceProfileDigest === sourceProfile
    && mapping.destinationProfileId === destinationId);
  if (!configured || !isDeepStrictEqual(ordered(configured.commandPairs), ordered(request.command_pairs))) fail("foreign research mapping is not explicitly configured locally");
  return undefined;
}

/** Fixed paired-node response plus explicit local mapping; byte-ready remains non-executable. */
export async function importProductSourceSemanticTransfer(token: PreparedProductSourceRuntime, authenticated: AuthenticatedProductSourceTransferV2,
  signal?: AbortSignal): Promise<ProductSourceImportReadyV1> {
  const current = state(token), saved = readAuthenticatedProductSourceTransferV2(authenticated);
  if (saved.nodeId !== current.options.nodeId || productSourceTransferRequestDigestV2(saved.request, sha) !== saved.requestDigest) fail("authenticated response belongs to another node or request");
  localResearchMapping(current, saved.request);
  const ready = await importProductSourceTransfer(token, saved.request.byte_request, productSourceTransferRequestDigestV1(saved.request.byte_request, sha), saved.bytes, signal);
  localResearchMapping(state(token), saved.request);
  return ready;
}

/** Only this process's active original admission can supply a private verifier envelope. */
export function readProductSourceVerificationAdmission(token: PreparedProductSourceVerificationAdmission, profile: PreparedVerificationProfile,
  requestId: string, context: RunStartPayload["context_pack"]["payload"]) {
  const saved = semanticAdmissions.get(token); if (!saved) fail("original live semantic verifier admission is required");
  const current = state(saved.runtime), authenticated = readAuthenticatedProductSourceTransferV2(saved.authenticated), request = authenticated.request;
  if (profile !== saved.profile || requestId !== saved.start.verification?.request_id || context !== saved.start.context_pack.payload
    || hash(saved.start) !== saved.startDigest || current.active.get(saved.start.run_id) !== profile.workspace_root
    || authenticated.nodeId !== current.options.nodeId || authenticated.requestDigest !== saved.envelope.request_digest
    || !isDeepStrictEqual(request, saved.envelope.request)) fail("semantic verifier admission binding changed");
  const release = localResearchMapping(current, request);
  if (release?.readCapabilities !== saved.readReleaseCapabilities
    || selectVerificationProfile(saved.start, [profile], false, saved.readReleaseCapabilities) !== profile) fail("semantic verifier local profile or release reader differs");
  const ready = readProductSourceImportReady(saved.runtime, request.byte_request, productSourceTransferRequestDigestV1(request.byte_request, sha));
  if (!isDeepStrictEqual(ready, saved.envelope.ready) || boundedFile(saved.path, 2 * 1024 * 1024).toString("utf8") !== canonical(saved.envelope)) {
    fail("protected semantic admission or byte-ready receipt changed");
  }
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  const inspected = inspectProductSourceVerificationEnvelope(saved.envelope, readProductFile(profile.workspace_root, ".artoo/product/research.json"), sha);
  if (inspected.admission_digest !== saved.digest) fail("semantic admission digest changed");
  // This function returns a node-owned reader only from the original opaque
  // admission. It is never a member of the serialized private envelope.
  return freezeJson({ ...inspected, readReleaseCapabilities: saved.readReleaseCapabilities });
}



export type { ProductSourceFreshVerificationV1 } from "@artoo/domain";
import type { ProductSourceFreshVerificationV1 } from "@artoo/domain";
const completedSourceOperations = new WeakMap<ProductSourceFreshVerificationV1, {runtime:PreparedProductSourceRuntime; envelope:ProductSourceVerificationEnvelope;
  authenticated:AuthenticatedProductSourceTransferV2;profile:PreparedVerificationProfile}>();
/** Only the original completed local result can expose its bound admission for node transport. */
export function readCompletedProductSourceAdmission(runtime:PreparedProductSourceRuntime,result:ProductSourceFreshVerificationV1):ProductSourceVerificationEnvelope {
  const saved=completedSourceOperations.get(result);if(!saved||saved.runtime!==runtime)fail("original completed semantic operation result is required");
  state(runtime);return saved.envelope;
}
/** Standalone protected verifier slice. It never schedules a writer or emits an ordinary run.verification frame. */
export async function verifyProductSourceSemanticTransfer(token: PreparedProductSourceRuntime, authenticated: AuthenticatedProductSourceTransferV2,
  start: RunStartPayload, signal: AbortSignal, importedReview?:PreparedImportedProductReview): Promise<ProductSourceFreshVerificationV1> {
  const current = state(token), response = readAuthenticatedProductSourceTransferV2(authenticated), request = response.request;
  RunStartPayloadSchema.parse(start); const release = localResearchMapping(current, request);
  if (response.nodeId !== current.options.nodeId) fail("semantic verifier response belongs to another node");
  const profile = destination(current, request.byte_request, productSourceTransferRequestDigestV1(request.byte_request, sha));
  const parent=importedReview?readImportedProductReview(importedReview,token):undefined;
  if(parent&&(parent.authenticated!==authenticated||parent.profile!==profile||start!==(parent.phase==="before"?parent.request.before_start:parent.phase==="after"?parent.request.after_start:undefined)))fail("Imported review verifier phase or identity differs");
  if (current.importing || current.active.has(start.run_id) || [...current.active.entries()].some(([id,root]) => id!==parent?.request.review_start.run_id&&overlaps(root, profile.workspace_root))) fail("semantic verifier destination is occupied");
  const ready = readProductSourceImportReady(token, request.byte_request, productSourceTransferRequestDigestV1(request.byte_request, sha));
  if (selectVerificationProfile(start, [profile], false, release?.readCapabilities) !== profile) fail("semantic verifier local profile differs");
  const bytes = readProductFile(profile.workspace_root, ".artoo/product/research.json");
  const described = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: response.requestDigest, capsule_digest: ready.capsule_digest,
    source_subject_digest: request.byte_request.source.subject_digest, destination_subject_digest: ready.destination.subject_digest },
    researchPin: request.source_export.research_provenance.research, researchBytes: bytes, sourceCapabilities: request.source_export.source_capabilities,
    destinationCapabilities: profile.capabilities, commandPairs: request.command_pairs,
    ...(release ? { sourceRelease: request.source_export.measurement_v2!.source_release, destinationRelease: release.readCapabilities() } : {}), sha256: sha });
  const inspected = inspectProductSourceVerificationEnvelope({ version: request.measurement_v2 ? 2 : 1, request, request_digest: response.requestDigest, ready,
    run_start: start, mapping: described.mapping }, bytes, sha);
  const admissionPath = join(current.options.storeRoot, "attestations", `semantic-admission-${key(start.run_id)}.json`);
  // A reused run ID cannot repeat execution, including after a graceful reopen.
  writeExclusive(admissionPath, canonical(inspected.envelope));
  const admission = Object.freeze({}) as PreparedProductSourceVerificationAdmission;
  semanticAdmissions.set(admission, { runtime: token, authenticated, profile, start, startDigest: hash(start),
    envelope: freezeJson(inspected.envelope), digest: inspected.admission_digest, path: admissionPath,
    ...(release ? { readReleaseCapabilities: release.readCapabilities } : {}) });
  current.active.set(start.run_id, profile.workspace_root);
  // An exception with uncertain process closure retains this claim. Known failed/cancelled
  // verifier results can release the live claim while the persistent import stays fenced.
  const verification = await runTransferredResearchVerification(profile, start.verification!.request_id, signal,
    start.context_pack.payload!, ready.destination.subject_digest, admission);
  readProductSourceVerificationAdmission(admission, profile, start.verification!.request_id, start.context_pack.payload);
  const result: ProductSourceFreshVerificationV1 = { version: 1, claim: "fresh-destination-research-verification", request_digest: response.requestDigest,
    source_export_digest: request.source_export_digest, admission_digest: inspected.admission_digest, mapping_digest: hash(described.mapping),
    research_provenance_digest: request.source_export.research_provenance_digest, destination_run_id: start.run_id, verification,
    execution_authorized: false, automatic_review_authorized: false };
  writeExclusive(join(current.options.storeRoot, "attestations", `semantic-verification-${key(start.run_id)}.json`), canonical(result));
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  current.active.delete(start.run_id); semanticAdmissions.delete(admission);
  const frozen=freezeJson(result); completedSourceOperations.set(frozen,{runtime:token,envelope:freezeJson(inspected.envelope),authenticated,profile});
  return frozen;
}

import {ProductSourceOperationResultV1Schema,type ProductSourceOperationResultV1} from "@artoo/domain";
declare const sourceOperationBrand:unique symbol;
export interface PreparedProductSourceOperation {readonly [sourceOperationBrand]:true}
const sourceOperationOwners=new WeakMap<PreparedProductSourceOperation,{runtime:PreparedProductSourceRuntime;operationId:string;digest:string;action:"start"|"stop";settled:boolean}>();
export function reserveProductSourceOperation(runtime:PreparedProductSourceRuntime,operationId:string,digest:string,action:"start"|"stop"):PreparedProductSourceOperation {
  const current=state(runtime);if(!operationId||operationId.length>128||!/^sha256:[a-f0-9]{64}$/.test(digest))fail("Invalid operation ownership binding");
  writeExclusive(join(current.options.storeRoot,"attestations","dispatch-"+key(operationId)+".json"),canonical({version:1,operation_id:operationId,payload_digest:digest,action}));
  const permit=Object.freeze({}) as PreparedProductSourceOperation;sourceOperationOwners.set(permit,{runtime,operationId,digest,action,settled:false});return permit;
}
export function persistProductSourceOperationResult(runtime:PreparedProductSourceRuntime,permit:PreparedProductSourceOperation,input:ProductSourceOperationResultV1):void {
  const owner=sourceOperationOwners.get(permit),current=state(runtime),result=ProductSourceOperationResultV1Schema.parse(input);
  if(!owner||owner.runtime!==runtime||owner.settled||owner.operationId!==result.operation_id||owner.digest!==result.payload_digest)fail("Original unsettled operation owner is required");
  if((owner.action==="stop")!==(result.outcome==="cancelled_before_start"))fail("Result differs from the original start/stop ownership");
  if(result.outcome==="verified"){
    // Parsing clones JSON; qualify against the original fresh object before writing the frozen result.
    if(input.outcome!=="verified"||canonical(readCompletedProductSourceAdmission(runtime,input.fresh))!==canonical(result.admission))fail("Operation admission differs");
  }
  writeExclusive(join(current.options.storeRoot,"attestations","dispatch-result-"+key(owner.operationId)+".json"),canonical(result));owner.settled=true;
}

import {ImportedProductReviewRequestV1Schema,ImportedProductReviewResultV1Schema,ImportedProductReviewVerdictV1Schema,
  importedProductReviewRequestDigestV1,inspectImportedProductReviewRequestV1,inspectImportedProductReviewResultV1,
  type ImportedProductReviewRequestV1,type ImportedProductReviewResultV1} from "@artoo/domain";
import type {AgentInstanceConfig,RuntimeAdapter} from "@artoo/protocol";
import {bindWindowsVerifiedExecution,assertWindowsVerifiedExecutionClosed,supportsWorkspaceReadOnlyTools} from "./process-adapter.js";
import {createImportedReviewClosure,finishImportedReviewFailure} from "./imported-review-closure.js";
import {bindWorkspaceReadOnlyTools} from "./workspace-readonly.js";
import {bindWorkspaceToolCapabilities,bindWorkspaceToolReleaseCapabilities} from "./workspace-tools.js";

declare const importedReviewBrand:unique symbol;
export interface PreparedImportedProductReview {readonly [importedReviewBrand]:true}
interface ImportedReviewOwner {
  runtime:PreparedProductSourceRuntime;reviewId:string;digest:string;action:"start"|"stop";claimed:boolean;settled:boolean;
  active?:{request:ImportedProductReviewRequestV1;original:ProductSourceFreshVerificationV1;profile:PreparedVerificationProfile;
    authenticated:AuthenticatedProductSourceTransferV2;assertSession:()=>void;phase:"before"|"review"|"after"|"done"};
}
const importedReviewOwners=new WeakMap<PreparedImportedProductReview,ImportedReviewOwner>();
const completedImportedReviews=new WeakMap<ImportedProductReviewResultV1,{runtime:PreparedProductSourceRuntime;permit:PreparedImportedProductReview;request:ImportedProductReviewRequestV1}>();
export function reserveImportedProductReview(runtime:PreparedProductSourceRuntime,reviewId:string,digest:string,action:"start"|"stop"):PreparedImportedProductReview {
  const current=state(runtime);
  if(!reviewId||reviewId.length>128||!/^sha256:[a-f0-9]{64}$/.test(digest))fail("Invalid imported review identity");
  writeExclusive(join(current.options.storeRoot,"attestations","imported-review-"+key(reviewId)+".json"),canonical({version:1,review_id:reviewId,request_digest:digest,action}));
  const permit=Object.freeze({}) as PreparedImportedProductReview;
  importedReviewOwners.set(permit,{runtime,reviewId,digest,action,claimed:false,settled:false});return permit;
}
function readImportedProductReview(permit:PreparedImportedProductReview,runtime:PreparedProductSourceRuntime){
  const owner=importedReviewOwners.get(permit),current=state(runtime),active=owner?.active;
  if(!owner||owner.runtime!==runtime||!owner.claimed||owner.settled||!active||active.phase==="done"
    ||current.active.get(active.request.review_start.run_id)!==active.profile.workspace_root
    ||importedProductReviewRequestDigestV1(active.request,sha)!==owner.digest)fail("Original live imported-review owner is required");
  const sessionResult:unknown=active.assertSession();
  if(sessionResult!==undefined){void Promise.resolve(sessionResult).catch(()=>{});fail("Imported review session must be checked synchronously");}
  const original=completedSourceOperations.get(active.original);
  if(!original||original.runtime!==runtime||original.profile!==active.profile||original.authenticated!==active.authenticated)fail("Imported review lost its original completed transfer");
  const saved=readAuthenticatedProductSourceTransferV2(active.authenticated);
  const ready=readProductSourceImportReady(runtime,saved.request.byte_request,productSourceTransferRequestDigestV1(saved.request.byte_request,sha));
  if(canonical(ready)!==canonical(original.envelope.ready)||subjectManifest(active.profile).digest!==ready.destination.subject_digest)fail("Imported review source changed");
  return active;
}
/** Dedicated node-owned lifecycle; ordinary run.start and serialized review data cannot call this with a valid owner. */
export async function runImportedProductReview(runtime:PreparedProductSourceRuntime,permit:PreparedImportedProductReview,
  original:ProductSourceFreshVerificationV1,input:unknown,adapter:RuntimeAdapter,signal:AbortSignal,assertSession:()=>void):Promise<ImportedProductReviewResultV1>{
  recordSourceCommandPhase("request");
  const owner=importedReviewOwners.get(permit),current=state(runtime),completed=completedSourceOperations.get(original);
  const request=freezeJson(ImportedProductReviewRequestV1Schema.parse(input)),requestDigest=importedProductReviewRequestDigestV1(request,sha);
  if(!owner||owner.runtime!==runtime||owner.claimed||owner.settled||owner.action!=="start"||owner.reviewId!==request.review_id||owner.digest!==requestDigest
    ||!completed||completed.runtime!==runtime||request.result.outcome!=="verified"||canonical(original)!==canonical(request.result.fresh)
    ||canonical(completed.envelope)!==canonical(request.result.admission)||original.verification.outcome!=="passed")fail("Original fresh transfer and unused review owner are required");
  if(process.platform!=="win32"||!supportsWorkspaceReadOnlyTools(adapter)||adapter.runtimeId!==request.review_start.runtime||typeof assertSession!=="function")fail("Imported review requires an installed native read-only Windows adapter and session binding");
  const profile=completed.profile,bytes=readProductFile(profile.workspace_root,".artoo/product/research.json");
  inspectImportedProductReviewRequestV1(request,bytes,sha);
  if(current.importing||[...current.active.values()].some(root=>overlaps(root,profile.workspace_root)))fail("Imported review destination is occupied");
  owner.claimed=true;owner.active={request,original,profile,authenticated:completed.authenticated,assertSession,phase:"before"};
  writeExclusive(join(current.options.storeRoot,"attestations","imported-review-request-"+key(request.review_id)+".json"),canonical(request));
  current.active.set(request.review_start.run_id,profile.workspace_root);
  const base={version:1 as const,review_id:request.review_id,request_digest:requestDigest,execution_authorized:false as const};
  const closure=createImportedReviewClosure();
  let handle:AgentInstanceHandle|undefined,windowsAdmission:WindowsVerifiedExecutionAdmission|undefined,stopWork:Promise<void>|undefined,stopError:unknown;
  const stop=()=>{if(handle&&!stopWork)stopWork=adapter.stop(handle,"user_cancelled").catch(error=>{stopError=error;});};
  try{
    recordSourceCommandPhase("before_verification");
    signal.throwIfAborted();readImportedProductReview(permit,runtime);closure.begin("before-verifier");
    const before=await verifyProductSourceSemanticTransfer(runtime,completed.authenticated,request.before_start,signal,permit);closure.confirm("before-verifier");
    if(before.verification.outcome!=="passed")fail("Imported review pre-verification failed");
    const beforeMeasurement={admission:readCompletedProductSourceAdmission(runtime,before),fresh:before};
    recordSourceCommandPhase("reviewer");signal.throwIfAborted();owner.active.phase="review";readImportedProductReview(permit,runtime);
    const start=request.review_start,config:AgentInstanceConfig={runId:start.run_id,taskId:start.task_id,agentInstanceId:start.agent_instance_id,
      runtime:start.runtime,workspaceRoot:profile.workspace_root,runStart:start};
    const assertCurrent=()=>{signal.throwIfAborted();readImportedProductReview(permit,runtime);};
    bindWorkspaceReadOnlyTools(config,{projectId:profile.project_id,workspaceRoot:profile.workspace_root,
      source:{profile,subjectDigest:original.verification.subject_digest!,importedReviewId:request.review_id},assertCurrent});
    bindWorkspaceToolCapabilities(config,()=>{assertCurrent();if(!profile.capabilities)fail("Imported review capabilities unavailable");return {...profile.capabilities,profile_id:profile.id};});
    const release=localResearchMapping(current,request.operation.intent.request);
    if(release)bindWorkspaceToolReleaseCapabilities(config,release.readCapabilities);
    Object.freeze(config);
    const admission=bindWindowsVerifiedExecution(adapter,config,profile,signal,assertCurrent);windowsAdmission=admission;
    closure.begin("reviewer");handle=await adapter.start(config);signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();
    let answer:string|undefined,terminal:string|undefined,answers=0;
    for await(const event of adapter.streamEvents(handle)){
      if(event.type==="run.answer"){if(++answers>1)fail("Imported review returned multiple terminal answers");answer=event.payload.text;}
      if(event.type==="run.lifecycle"&&["completed","failed","cancelled"].includes(event.payload.phase))terminal=event.payload.phase;
    }
    await stopWork;if(stopError)throw stopError;
    assertWindowsVerifiedExecutionClosed(admission,handle);closure.confirm("reviewer");
    if(terminal!=="completed"||!answer)fail("Imported reviewer did not complete with one answer");
    signal.throwIfAborted();readImportedProductReview(permit,runtime);
    const verdict=ImportedProductReviewVerdictV1Schema.parse(JSON.parse(answer));
    recordSourceCommandPhase("after_verification");owner.active.phase="after";closure.begin("after-verifier");
    const after=await verifyProductSourceSemanticTransfer(runtime,completed.authenticated,request.after_start,signal,permit);closure.confirm("after-verifier");
    if(after.verification.outcome!=="passed")fail("Imported review post-verification failed");
    const result:ImportedProductReviewResultV1={...base,outcome:"reviewed",closed:true,before:beforeMeasurement,
      after:{admission:readCompletedProductSourceAdmission(runtime,after),fresh:after},
      reviewer:{run_id:start.run_id,config_digest:sha(canonical(start)),closure:"windows-job-and-tools-closed.v1"},verdict};
    inspectImportedProductReviewResultV1(request,result,readProductFile(profile.workspace_root,".artoo/product/research.json"),sha);
    signal.throwIfAborted();readImportedProductReview(permit,runtime);
    const frozen=freezeJson(result);completedImportedReviews.set(frozen,{runtime,permit,request});return frozen;
  }catch(error){
    recordSourceCommandFailure(error);
    const failure=await finishImportedReviewFailure(closure,error,handle&&windowsAdmission?async()=>{
      if(stopWork)await stopWork;else await adapter.stop(handle!,"shutdown");if(stopError)throw stopError;
      assertWindowsVerifiedExecutionClosed(windowsAdmission!,handle!);
    }:undefined);
    return freezeJson({...base,...failure});
  }finally{
    signal.removeEventListener("abort",stop);
    if(closure.closed){current.active.delete(request.review_start.run_id);owner.active.phase="done";}
    // Unknown closure keeps both the live owner and durable imported workspace claim.
  }
}
export function persistImportedProductReviewResult(runtime:PreparedProductSourceRuntime,permit:PreparedImportedProductReview,input:ImportedProductReviewResultV1):void{
  const current=state(runtime),owner=importedReviewOwners.get(permit),result=ImportedProductReviewResultV1Schema.parse(input);
  if(!owner||owner.runtime!==runtime||owner.settled||owner.reviewId!==result.review_id||owner.digest!==result.request_digest
    ||(owner.action==="stop")!==(result.outcome==="cancelled_before_start"))fail("Imported review result differs from original ownership");
  if(result.outcome==="reviewed"){
    const completed=completedImportedReviews.get(input);
    if(!completed||completed.runtime!==runtime||completed.permit!==permit)fail("Original locally closed imported review is required");
  }
  writeExclusive(join(current.options.storeRoot,"attestations","imported-review-result-"+key(owner.reviewId)+".json"),canonical(result));owner.settled=true;
}
/** Read-only preparation for the later exact-run writer transition. This function grants no writer permit. */
export function readCompletedImportedProductReview(runtime:PreparedProductSourceRuntime,result:ImportedProductReviewResultV1):ImportedProductReviewRequestV1{
  state(runtime);const completed=completedImportedReviews.get(result),owner=completed?importedReviewOwners.get(completed.permit):undefined;
  if(!completed||completed.runtime!==runtime||!owner?.settled||result.outcome!=="reviewed"||result.verdict.outcome!=="accepted")fail("Original accepted and persisted imported review is required");
  return completed.request;
}

import { ImportedDesignContinuationControlV1Schema, ImportedDesignContinuationResultV1Schema,
  importedDesignContinuationRequestDigestV1, inspectImportedDesignContinuationRequestV1,
  ProductResearchReportSchema, type ImportedDesignContinuationControlV1, type ImportedDesignContinuationRequestV1,
  type ImportedDesignContinuationResultV1, type ContextPack, type ProductResearchReport } from "@artoo/domain";
import { adapterRunEventBodySchema, type RunEventMessage } from "@artoo/protocol";
type ImportedDesignEvent = RunEventMessage["event"];
import { runTransferredDesignVerification, runTransferredDesignVerificationPreview, assertImportedDesignVerificationProfile } from "./verification.js";
import { importedDesignVerificationScope, assertImportedFinalVerificationBinding, assertImportedDesignReviewVerificationProfile,
  runImportedDesignReviewVerification } from "./verification.js";
import { inspectImportedCompletedDesignV1, type ImportedCompletedDesignV1, ImportedDesignReviewControlV1Schema,
  ImportedDesignReviewResultV1Schema, ImportedDesignReviewVerdictV1Schema, inspectImportedDesignReviewRequestV1,
  inspectImportedDesignReviewResultV1, importedDesignReviewRequestDigestV1,
  type ImportedDesignReviewRequestV1, type ImportedDesignReviewResultV1, type ImportedDesignReviewControlV1 } from "@artoo/domain";
import { bindWorkspaceToolVerifier, bindWorkspaceToolEvidenceReader } from "./workspace-tools.js";
import { createImportedDesignReviewEvidence } from "./imported-design-review-evidence.js";
import { createImportedAuthorExecution } from "./imported-author-execution.js";

declare const importedDesignBrand: unique symbol;
export interface PreparedImportedDesignContinuation { readonly [importedDesignBrand]: true }
interface ImportedDesignOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedDesignContinuationControlV1; action: "start" | "stop";
  claimed: boolean; settled: boolean; executed: boolean; nativeAttempted: boolean;
  active?: { request: ImportedDesignContinuationRequestV1; original: ImportedProductReviewResultV1;
    profile: PreparedVerificationProfile; config: AgentInstanceConfig; adapter: RuntimeAdapter;
    methods: Record<string, unknown>; assertSession: () => void; claim: string; claimPath: string;
    history: readonly { path: string; digest: string }[];
    research: Buffer; effectivePlan: ReturnType<typeof inspectProductSourceVerificationEnvelope>["effective_plan"];
    readReleaseCapabilities?: ReleaseCapabilityReader; phase: "author" | "final" | "done";
    previewRequest?: string; finalEvidence?: RunVerificationPayload };
}
const importedDesignOwners = new WeakMap<PreparedImportedDesignContinuation, ImportedDesignOwner>();
const importedDesignContexts = new WeakMap<ContextPack, PreparedImportedDesignContinuation>();
const consumedImportedReviews = new WeakSet<ImportedProductReviewResultV1>();
const completedImportedDesigns = new WeakMap<ImportedDesignContinuationResultV1, PreparedImportedDesignContinuation>();
const retainedImportedDesigns = new WeakMap<PreparedProductSourceRuntime, Set<PreparedImportedDesignContinuation>>();
const completedVerifiedImportedDesigns = new WeakMap<ImportedDesignContinuationResultV1,
  { runtime: PreparedProductSourceRuntime; permit: PreparedImportedDesignContinuation; active: NonNullable<ImportedDesignOwner["active"]> }>();

/** The exclusive reservation is also the restart fence. Disk data cannot recreate this token. */
export function reserveImportedDesignContinuation(runtime: PreparedProductSourceRuntime,
  input: ImportedDesignContinuationControlV1, action: "start" | "stop"): PreparedImportedDesignContinuation {
  const current = state(runtime), control = freezeJson(ImportedDesignContinuationControlV1Schema.parse(input));
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-" + key(control.continuation_id) + ".json"), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedDesignContinuation;
  importedDesignOwners.set(permit, { runtime, control, action, claimed: false, settled: false, executed: false, nativeAttempted: false });
  const retained = retainedImportedDesigns.get(runtime) ?? new Set<PreparedImportedDesignContinuation>();
  retained.add(permit); retainedImportedDesigns.set(runtime, retained); return permit;
}

function readImportedDesignOwner(permit: PreparedImportedDesignContinuation) {
  const owner = importedDesignOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active imported-design owner is required");
  const current = state(owner.runtime), request = active.request, start = request.run_start;
  if (current.active.get(start.run_id) !== active.profile.workspace_root || !consumedImportedReviews.has(active.original)
    || importedDesignContinuationRequestDigestV1(request, sha) !== owner.control.request_digest
    || start.run_id !== owner.control.run_id || active.config.runStart !== start
    || active.adapter.runtimeId !== start.runtime
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim
    || active.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Imported-design owner, configuration or durable history changed");
  const checked: unknown = active.assertSession();
  if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); fail("Imported-design session must be checked synchronously"); }
  if (!readProductFile(active.profile.workspace_root, ".artoo/product/research.json").equals(active.research)) fail("Accepted imported research bytes changed");
  assertLocallyPreparedVerificationProfile(active.profile);
  if (active.readReleaseCapabilities) assertReleaseCapabilityContext(start.context_pack.payload, active.readReleaseCapabilities);
  return active;
}

/** Only the original executing context has access to the imported research projection. */
export function readImportedDesignResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport {
  if (context.imported_clean_validation || context.imported_clean_validation_review_subject) return readCleanValidationResearch(root, context, bytes);
  if (context.imported_recovery_validation || context.imported_recovery_validation_review_subject) return readRecoveryValidationResearch(root, context, bytes);
  if (context.imported_validation || context.imported_validation_review_subject) return readValidationResearch(root, context, bytes);
  if (context.imported_execution_review_subject) return readImplementationReviewResearch(root, context, bytes);
  if (context.imported_execution_repair) return readImplementationRepairResearch(root, context, bytes);
  if (context.imported_execution) return readImportedExecutionResearch(root, context, bytes);
  if (context.imported_design_review_subject) return readImportedDesignReviewResearch(root, context, bytes);
  const permit = importedDesignContexts.get(context);
  if (!permit) fail("Original imported-design context admission is required");
  const active = readImportedDesignOwner(permit);
  if (context !== active.config.runStart.context_pack.payload || root !== active.profile.workspace_root
    || realpathSync.native(root) !== root || !(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(active.research)) {
    fail("Imported-design research context, root or bytes differ");
  }
  const report = ProductResearchReportSchema.parse(JSON.parse(active.research.toString("utf8")));
  report.measurement_plan = structuredClone(active.effectivePlan); return report;
}

/** Node-owned verification admission; no descriptor, callback or cloned token grants access. */
export function readImportedDesignVerificationAdmission(permit: PreparedImportedDesignContinuation,
  profile: PreparedVerificationProfile, requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readImportedDesignOwner(permit), start = active.request.run_start;
  if (active.profile !== profile || start.context_pack.payload !== context
    || (scope === "final" ? active.phase !== "final" || requestId !== start.verification!.request_id
      : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification!.request_id)) {
    fail("Imported-design verifier differs from the exact registered invocation");
  }
  return { request: active.request, request_digest: importedDesignContinuationRequestDigestV1(active.request, sha),
    readReleaseCapabilities: active.readReleaseCapabilities };
}

/** Dedicated one-use writer path. It never delegates authority through ordinary run.start. */
export async function failUnstartedImportedDesignContinuation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignContinuation,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedDesignContinuationResultV1> {
  const owner = importedDesignOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Only an original unstarted design reservation can confirm precondition failure");
  owner.executed = true;
  const reason = (error instanceof Error ? error.message : "Imported-design admission failed").slice(0, 2000) || "Imported-design admission failed";
  let closed = true;
  try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Design was not started: " + reason.slice(0, 1900) } }); }
  catch { closed = false; }
  const result: ImportedDesignContinuationResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) {
    state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done";
    importedDesignContexts.delete(owner.active.request.run_start.context_pack.payload);
  }
  completedImportedDesigns.set(result, permit); return result;
}

export async function runImportedDesignContinuation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignContinuation,
  original: ImportedProductReviewResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal,
  assertSession: () => void, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedDesignContinuationResultV1> {
  const reservation = importedDesignOwners.get(permit);
  if (!reservation || reservation.runtime !== runtime || reservation.action !== "start" || reservation.executed || reservation.settled) fail("Original unused imported-design reservation is required");
  reservation.executed = true;
  try { return await executeImportedDesignContinuation(runtime, permit, original, input, adapter, signal, assertSession, emit); }
  catch (error) {
    const owner = importedDesignOwners.get(permit);
    if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled) throw error;
    if (!owner.nativeAttempted) return failUnstartedImportedDesignContinuation(runtime, permit, error, emit);
    const reason = (error instanceof Error ? error.message : "Imported-design admission failed").slice(0, 2000) || "Imported-design admission failed";
    const result: ImportedDesignContinuationResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false, reason });
    completedImportedDesigns.set(result, permit); return result;
  }
}

async function executeImportedDesignContinuation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignContinuation,
  original: ImportedProductReviewResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal,
  assertSession: () => void, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedDesignContinuationResultV1> {
  const current = state(runtime), owner = importedDesignOwners.get(permit), reviewed = readCompletedImportedProductReview(runtime, original);
  const request = freezeJson(inspectImportedDesignContinuationRequestV1(input,
    readProductFile(reviewed.operation.intent.request.byte_request.destination.workspace_root, ".artoo/product/research.json"), sha));
  const digest = importedDesignContinuationRequestDigestV1(request, sha), start = request.run_start;
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.claimed || owner.settled
    || owner.control.continuation_id !== request.continuation_id || owner.control.request_digest !== digest || owner.control.run_id !== start.run_id
    || canonical(original) !== canonical(request.review_result) || canonical(reviewed) !== canonical(request.review_request)
    || consumedImportedReviews.has(original)) fail("Original accepted review and unused exact design reservation are required");
  if (process.platform !== "win32" || adapter.runtimeId !== start.runtime || typeof assertSession !== "function") fail("Imported design requires its installed native Windows adapter and session");
  const transfer = request.review_request.operation.intent.request, profile = profileFor(current, transfer.byte_request.destination.profile_id, transfer.byte_request.project_id);
  const release = localResearchMapping(current, transfer);
  assertImportedDesignVerificationProfile(profile);
  if (selectVerificationProfile(start, [profile], false, release?.readCapabilities) !== profile) fail("Imported-design local verifier differs");
  const ready = readProductSourceImportReady(runtime, transfer.byte_request, productSourceTransferRequestDigestV1(transfer.byte_request, sha));
  if (original.outcome !== "reviewed" || canonical(ready) !== canonical(original.after.admission.ready)
    || subjectManifest(profile).digest !== start.context_pack.payload.transferred_product_input.initial_subject_digest) fail("Imported-design initial subject changed");
  if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("Imported-design destination is occupied");
  const research = readProductFile(profile.workspace_root, ".artoo/product/research.json");
  const inspected = inspectProductSourceVerificationEnvelope(original.after.admission, research, sha);
  const reviewResultPath = join(current.options.storeRoot, "attestations", "imported-review-result-" + key(reviewed.review_id) + ".json");
  const reviewRequestPath = join(current.options.storeRoot, "attestations", "imported-review-request-" + key(reviewed.review_id) + ".json");
  if (boundedFile(reviewResultPath).toString("utf8") !== canonical(original)
    || boundedFile(reviewRequestPath).toString("utf8") !== canonical(reviewed)) fail("Original persisted imported-review history changed");
  const history = [claimPath(current, profile.workspace_root), reviewResultPath, reviewRequestPath].map(path => ({ path, digest: sha(boundedFile(path)) }));
  const config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
    runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
  const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
  if (Object.values(methods).some(method => typeof method !== "function")) fail("Imported-design adapter methods must be stable local functions");
  const writerClaimPath = join(current.options.storeRoot, "attestations", "imported-design-owner-" + key(profile.workspace_root) + ".json");
  const claim = canonical({ ...owner.control, transfer_id: transfer.byte_request.transfer_id,
    imported_review_id: reviewed.review_id, original_claim_digest: sha(boundedFile(claimPath(current, profile.workspace_root))),
    initial_subject_digest: ready.destination.subject_digest, request });
  // One exclusive append converts the retained import into this exact writer.
  // The import claim and all review history remain intact across closure/restart.
  signal.throwIfAborted(); const session: unknown = assertSession();
  if (session !== undefined) { void Promise.resolve(session).catch(() => {}); fail("Imported-design session must be synchronous"); }
  consumedImportedReviews.add(original); owner.claimed = true;
  writeExclusive(writerClaimPath, claim); current.active.set(start.run_id, profile.workspace_root);
  const active: NonNullable<ImportedDesignOwner["active"]> = { request, original, profile, config, adapter, methods, assertSession,
    claim, claimPath: writerClaimPath, history, research, effectivePlan: inspected.effective_plan, phase: "author",
    ...(release ? { readReleaseCapabilities: release.readCapabilities } : {}) };
  owner.active = active; importedDesignContexts.set(start.context_pack.payload, permit);
  const base = { version: 1 as const, continuation_id: request.continuation_id, request_digest: digest, run_id: start.run_id };
  const assertCurrent = () => { signal.throwIfAborted(); readImportedDesignOwner(permit); };
  const author = createImportedAuthorExecution({ stage: "design", adapter, config, profile, signal, assertCurrent,
    markNativeAttempted: () => { owner.nativeAttempted = true; },
    prepareFinal: () => { active.phase = "final"; readImportedDesignOwner(permit); },
    verify: () => runTransferredDesignVerification(profile, start.verification!.request_id, signal, start.context_pack.payload, permit), emit });
  let result: ImportedDesignContinuationResultV1;
  try {
    bindWorkspaceToolCapabilities(config, () => { assertCurrent(); if (!profile.capabilities) fail("Imported-design capabilities are unavailable"); return { ...profile.capabilities, profile_id: profile.id }; });
    if (release) bindWorkspaceToolReleaseCapabilities(config, release.readCapabilities);
    bindWorkspaceToolVerifier(config, async previewSignal => {
      assertCurrent(); if (active.previewRequest) fail("Imported-design preview is already active");
      const requestId = "preview-" + randomUUID(); active.previewRequest = requestId;
      try { return await runTransferredDesignVerificationPreview(profile, requestId, previewSignal, start.context_pack.payload, permit); }
      finally { active.previewRequest = undefined; }
    });
    Object.freeze(config);
    const evidence = await author.run(); if (evidence) active.finalEvidence = evidence;
    let verifiedDesign: ImportedCompletedDesignV1 | undefined;
    if (active.finalEvidence && !signal.aborted) {
      readImportedDesignOwner(permit); author.assertClosed();
      assertImportedFinalVerificationBinding(profile, active.finalEvidence, permit, start.verification!.request_id, start.context_pack.payload, "author");
      const mapped = start.context_pack.payload.transferred_product_input, destination = transfer.byte_request.destination;
      verifiedDesign = inspectImportedCompletedDesignV1(request, { version: 1, continuation_id: request.continuation_id,
        request_digest: digest, run_id: start.run_id, run_start_digest: sha(canonical(start)), author: request.writer,
        destination: { node_id: destination.node_id, workspace_root: destination.workspace_root, profile_id: destination.profile_id,
          profile_digest: profile.digest }, subject_digest: subjectManifest(profile).digest,
        transfer_id: transfer.byte_request.transfer_id, source_export_digest: transfer.source_export_digest,
        mapping_digest: mapped.mapping_digest, research_provenance_digest: mapped.research_provenance_digest,
        scope: importedDesignVerificationScope(profile), closure: "windows-job-and-tools-closed.v1", verification: active.finalEvidence }, sha);
    }
    result = freezeJson({ ...base, outcome: "finished", closed: true, ...(verifiedDesign ? { verified_design: verifiedDesign } : {}) });
  } catch (error) { result = freezeJson({ ...base, ...await author.failure(error) }); }
  finally { author.dispose(); }
  if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; importedDesignContexts.delete(start.context_pack.payload); }
  completedImportedDesigns.set(result, permit); return result;
}

export function persistImportedDesignContinuationResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignContinuation,
  input: ImportedDesignContinuationResultV1): void {
  const current = state(runtime), owner = importedDesignOwners.get(permit), result = ImportedDesignContinuationResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.continuation_id !== owner.control.continuation_id
    || result.request_digest !== owner.control.request_digest || result.run_id !== owner.control.run_id
    || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")) fail("Imported-design result differs from its original reservation");
  if (owner.action === "start" && result.closed && completedImportedDesigns.get(input) !== permit) fail("Original completed imported-design execution is required");
  const active = owner.active;
  if (input.outcome === "finished" && input.verified_design) {
    if (!active?.finalEvidence || active.phase !== "done") fail("Original completed author verification is required");
    assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification!.request_id,
      active.request.run_start.context_pack.payload, "author");
    if (canonical(input.verified_design.verification) !== canonical(active.finalEvidence)) fail("Completed design evidence was replaced");
    inspectImportedCompletedDesignV1(active.request, input.verified_design, sha);
  }
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-result-" + key(result.continuation_id) + ".json"), canonical(result));
  owner.settled = true; if (result.closed) retainedImportedDesigns.get(runtime)?.delete(permit);
  if (input.outcome === "finished" && input.verified_design && active) completedVerifiedImportedDesigns.set(input, { runtime, permit, active });
}

/** Original in-memory completion only; disk recovery and lifecycle status cannot mint this authority. */
export function readCompletedVerifiedImportedDesign(runtime: PreparedProductSourceRuntime, input: ImportedDesignContinuationResultV1) {
  const saved = completedVerifiedImportedDesigns.get(input), current = state(runtime), active = saved?.active;
  const owner = saved ? importedDesignOwners.get(saved.permit) : undefined;
  if (!saved || saved.runtime !== runtime || !owner?.settled || !active || active.phase !== "done"
    || input.outcome !== "finished" || !input.verified_design) fail("Original persisted completed verified design is required");
  const session: unknown = active.assertSession();
  if (session !== undefined) { void Promise.resolve(session).catch(() => {}); fail("Completed design session check must be synchronous"); }
  if (boundedFile(join(current.options.storeRoot, "attestations", "imported-design-result-" + key(input.continuation_id) + ".json")).toString("utf8") !== canonical(input)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest)
    || !readProductFile(active.profile.workspace_root, ".artoo/product/research.json").equals(active.research)
    || subjectManifest(active.profile).digest !== input.verified_design.subject_digest) fail("Completed design history or source changed");
  assertImportedFinalVerificationBinding(active.profile, active.finalEvidence!, saved.permit, active.request.run_start.verification!.request_id,
    active.request.run_start.context_pack.payload, "author");
  inspectImportedCompletedDesignV1(active.request, input.verified_design, sha);
  if (active.readReleaseCapabilities) assertReleaseCapabilityContext(active.request.run_start.context_pack.payload, active.readReleaseCapabilities);
  return { request: active.request, provenance: input.verified_design };
}

declare const importedDesignReviewBrand: unique symbol;
export interface PreparedImportedDesignReview { readonly [importedDesignReviewBrand]: true }
interface ImportedDesignReviewOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedDesignReviewControlV1; action: "start" | "stop"; claimed: boolean; settled: boolean;
  active?: { request: ImportedDesignReviewRequestV1; original: ImportedDesignContinuationResultV1; profile: PreparedVerificationProfile;
    assertSession: () => void; phase: "before" | "review" | "after" | "done"; adapter: RuntimeAdapter; methods: Record<string, unknown> };
}
const importedDesignReviewOwners = new WeakMap<PreparedImportedDesignReview, ImportedDesignReviewOwner>();
const importedDesignReviewContexts = new WeakMap<ContextPack, PreparedImportedDesignReview>();
const completedImportedDesignReviews = new WeakMap<ImportedDesignReviewResultV1, { runtime: PreparedProductSourceRuntime; permit: PreparedImportedDesignReview }>();
const consumedCompletedDesigns = new WeakSet<ImportedDesignContinuationResultV1>();

export function reserveImportedDesignReview(runtime: PreparedProductSourceRuntime, input: ImportedDesignReviewControlV1,
  action: "start" | "stop"): PreparedImportedDesignReview {
  const current = state(runtime), control = freezeJson(ImportedDesignReviewControlV1Schema.parse(input));
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-review-" + key(control.review_id) + ".json"), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedDesignReview;
  importedDesignReviewOwners.set(permit, { runtime, control, action, claimed: false, settled: false }); return permit;
}
function readImportedDesignReviewOwner(permit: PreparedImportedDesignReview) {
  const owner = importedDesignReviewOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active H4 read-only owner is required");
  const current = state(owner.runtime), request = active.request;
  const checked: unknown = active.assertSession();
  if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); fail("H4 current session must be checked synchronously"); }
  if (current.active.get(request.review_start.run_id) !== active.profile.workspace_root
    || importedDesignReviewRequestDigestV1(request, sha) !== owner.control.request_digest
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("H4 ownership or adapter changed");
  const completed = readCompletedVerifiedImportedDesign(owner.runtime, active.original);
  if (canonical(completed.request) !== canonical(request.continuation_request)
    || canonical(active.original) !== canonical(request.continuation_result)) fail("H4 lost its original completed design");
  assertImportedDesignReviewVerificationProfile(active.profile);
  return active;
}
export function readImportedDesignReviewVerificationAdmission(permit: PreparedImportedDesignReview, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, phase: "before" | "after") {
  const active = readImportedDesignReviewOwner(permit), start = phase === "before" ? active.request.before_start : active.request.after_start;
  if (active.phase !== phase || active.profile !== profile || start.context_pack.payload !== context || start.verification?.request_id !== requestId) {
    fail("H4 verification requires its original phase-specific context and request");
  }
  const completed = completedVerifiedImportedDesigns.get(active.original)!;
  return { request: active.request, request_digest: importedDesignReviewRequestDigestV1(active.request, sha), phase, start,
    readReleaseCapabilities: completed.active.readReleaseCapabilities };
}
function readImportedDesignReviewResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport {
  const permit = importedDesignReviewContexts.get(context);
  if (!permit) fail("Original H4 verification context is required");
  const active = readImportedDesignReviewOwner(permit), completed = completedVerifiedImportedDesigns.get(active.original)!;
  const start = active.phase === "before" ? active.request.before_start : active.phase === "after" ? active.request.after_start : undefined;
  if (root !== active.profile.workspace_root || realpathSync.native(root) !== root || start?.context_pack.payload !== context
    || !Buffer.from(bytes).equals(completed.active.research)) fail("H4 research projection differs from its exact phase or accepted bytes");
  return ProductResearchReportSchema.parse({ ...JSON.parse(completed.active.research.toString("utf8")), measurement_plan: completed.active.effectivePlan });
}

/** Exclusive read-only H4 path. It never reopens the settled H3 writer. */
export async function runImportedDesignReview(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignReview,
  original: ImportedDesignContinuationResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal,
  assertSession: () => void): Promise<ImportedDesignReviewResultV1> {
  const owner = importedDesignReviewOwners.get(permit), current = state(runtime);
  const completed = readCompletedVerifiedImportedDesign(runtime, original), saved = completedVerifiedImportedDesigns.get(original)!;
  const profile = saved.active.profile, request = freezeJson(inspectImportedDesignReviewRequestV1(input,
    readProductFile(profile.workspace_root, ".artoo/product/research.json"), sha));
  const requestDigest = importedDesignReviewRequestDigestV1(request, sha);
  if (!owner || owner.runtime !== runtime || owner.claimed || owner.settled || owner.action !== "start"
    || owner.control.review_id !== request.review_id || owner.control.request_digest !== requestDigest
    || canonical(completed.request) !== canonical(request.continuation_request) || canonical(original) !== canonical(request.continuation_result)
    || consumedCompletedDesigns.has(original)) fail("Original completed design and unused H4 reservation are required");
  assertImportedDesignReviewVerificationProfile(profile);
  if (process.platform !== "win32" || !supportsWorkspaceReadOnlyTools(adapter) || adapter.runtimeId !== request.review_start.runtime
    || typeof assertSession !== "function") fail("H4 requires an installed native Windows read-only reviewer");
  if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("H4 destination is occupied");
  const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
  if (Object.values(methods).some(method => typeof method !== "function")) fail("H4 adapter methods must be stable local functions");
  signal.throwIfAborted();
  const session: unknown = assertSession();
  if (session !== undefined) { void Promise.resolve(session).catch(() => {}); fail("H4 session must be synchronous"); }
  owner.claimed = true; consumedCompletedDesigns.add(original);
  owner.active = { request, original, profile, assertSession, phase: "before", adapter, methods };
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-review-request-" + key(request.review_id) + ".json"), canonical(request));
  current.active.set(request.review_start.run_id, profile.workspace_root);
  for (const start of [request.before_start, request.after_start]) importedDesignReviewContexts.set(start.context_pack.payload!, permit);
  const base = { version: 1 as const, review_id: request.review_id, request_digest: requestDigest, execution_authorized: false as const };
  const closure = createImportedReviewClosure();
  let handle: AgentInstanceHandle | undefined, admission: WindowsVerifiedExecutionAdmission | undefined, stopWork: Promise<void> | undefined, stopError: unknown;
  const stop = () => { if (handle && !stopWork) stopWork = adapter.stop(handle, "user_cancelled").catch(error => { stopError = error; }); };
  try {
    const assertCurrent = () => { signal.throwIfAborted(); readImportedDesignReviewOwner(permit); };
    assertCurrent(); closure.begin("before-verifier");
    const before = await runImportedDesignReviewVerification(profile, request.before_start.verification!.request_id, signal, request.before_start.context_pack.payload!, permit, "before");
    closure.confirm("before-verifier");
    if (before.outcome !== "passed") fail("H4 before-verification failed");
    assertImportedFinalVerificationBinding(profile, before, permit, request.before_start.verification!.request_id, request.before_start.context_pack.payload!, "before");
    owner.active.phase = "review"; assertCurrent();
    const start = request.review_start, config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id,
      agentInstanceId: start.agent_instance_id, runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const evidence = createImportedDesignReviewEvidence(profile, before, { requestId: request.before_start.verification!.request_id,
      subjectDigest: completed.provenance.subject_digest }, () => {
      assertCurrent(); if (owner.active?.phase !== "review") fail("H4 evidence is available only during its original reviewer phase");
    });
    bindWorkspaceReadOnlyTools(config, { projectId: profile.project_id, workspaceRoot: profile.workspace_root, assertCurrent,
      source: { profile, subjectDigest: completed.provenance.subject_digest, importedDesignReviewId: request.review_id }, readEvidenceIndex: evidence.readEvidenceIndex });
    bindWorkspaceToolEvidenceReader(config, evidence.read);
    bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
    if (saved.active.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, saved.active.readReleaseCapabilities);
    Object.freeze(config); admission = bindWindowsVerifiedExecution(adapter, config, profile, signal, assertCurrent);
    closure.begin("reviewer"); handle = await adapter.start(config); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    let answer: string | undefined, terminal: string | undefined, answers = 0;
    for await (const raw of adapter.streamEvents(handle)) {
      const event = adapterRunEventBodySchema.parse(raw);
      if (event.type === "run.answer") { if (++answers > 1) fail("H4 reviewer returned multiple answers"); answer = event.payload.text; }
      if (event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase)) {
        if (terminal) fail("H4 reviewer returned multiple terminal events"); terminal = event.payload.phase;
      }
    }
    await stopWork; if (stopError) throw stopError;
    assertWindowsVerifiedExecutionClosed(admission, handle); closure.confirm("reviewer");
    if (terminal !== "completed" || !answer) fail("H4 reviewer did not complete with one substantive answer");
    assertCurrent(); const verdict = ImportedDesignReviewVerdictV1Schema.parse(JSON.parse(answer));
    owner.active.phase = "after"; assertCurrent(); closure.begin("after-verifier");
    const after = await runImportedDesignReviewVerification(profile, request.after_start.verification!.request_id, signal, request.after_start.context_pack.payload!, permit, "after");
    closure.confirm("after-verifier");
    if (after.outcome !== "passed") fail("H4 after-verification failed");
    assertImportedFinalVerificationBinding(profile, after, permit, request.after_start.verification!.request_id, request.after_start.context_pack.payload!, "after");
    const measured = (phaseStart: RunStartPayload, verification: RunVerificationPayload) => ({ run_id: phaseStart.run_id,
      config_digest: sha(canonical(phaseStart)), closure: "windows-job-and-tools-closed.v1" as const,
      scope: "all-declared-workspace-design-cases" as const, verification });
    const result: ImportedDesignReviewResultV1 = { ...base, outcome: "reviewed", closed: true,
      before: measured(request.before_start, before), after: measured(request.after_start, after),
      reviewer: { run_id: start.run_id, config_digest: sha(canonical(start)), closure: "windows-job-and-tools-closed.v1" }, verdict };
    inspectImportedDesignReviewResultV1(request, result, readProductFile(profile.workspace_root, ".artoo/product/research.json"), sha);
    assertCurrent(); const frozen = freezeJson(result); completedImportedDesignReviews.set(frozen, { runtime, permit }); return frozen;
  } catch (error) {
    const failure = await finishImportedReviewFailure(closure, error, handle && admission ? async () => {
      if (stopWork) await stopWork; else await adapter.stop(handle!, "shutdown"); if (stopError) throw stopError;
      assertWindowsVerifiedExecutionClosed(admission!, handle!);
    } : undefined);
    return freezeJson({ ...base, ...failure });
  } finally {
    signal.removeEventListener("abort", stop);
    if (closure.closed) {
      current.active.delete(request.review_start.run_id); owner.active.phase = "done";
      for (const start of [request.before_start, request.after_start]) importedDesignReviewContexts.delete(start.context_pack.payload!);
    }
  }
}
export function persistImportedDesignReviewResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedDesignReview,
  input: ImportedDesignReviewResultV1): void {
  const current = state(runtime), owner = importedDesignReviewOwners.get(permit), result = ImportedDesignReviewResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.review_id !== owner.control.review_id
    || result.request_digest !== owner.control.request_digest || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")) fail("H4 result differs from its original reservation");
  if (result.outcome === "reviewed") {
    const completed = completedImportedDesignReviews.get(input);
    if (!completed || completed.runtime !== runtime || completed.permit !== permit) fail("Original locally closed H4 result is required");
  }
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-review-result-" + key(result.review_id) + ".json"), canonical(result)); owner.settled = true;
}

/** Only an original persisted H4 completion can be consumed before implementation changes its subject. */
export function readCompletedAcceptedImportedDesignReview(runtime: PreparedProductSourceRuntime, input: ImportedDesignReviewResultV1) {
  const saved = completedImportedDesignReviews.get(input), owner = saved ? importedDesignReviewOwners.get(saved.permit) : undefined;
  if (!saved || saved.runtime !== runtime || !owner?.settled || !owner.active || owner.active.phase !== "done"
    || input.outcome !== "reviewed" || !input.closed || input.verdict.outcome !== "accepted") fail("Original persisted accepted H4 completion is required");
  const current = state(runtime), active = owner.active;
  const checked: unknown = active.assertSession();
  if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); fail("H4 completion session must be synchronous"); }
  readCompletedVerifiedImportedDesign(runtime, active.original);
  const requestPath = join(current.options.storeRoot, "attestations", "imported-design-review-request-" + key(input.review_id) + ".json");
  const resultPath = join(current.options.storeRoot, "attestations", "imported-design-review-result-" + key(input.review_id) + ".json");
  if (boundedFile(requestPath).toString("utf8") !== canonical(active.request) || boundedFile(resultPath).toString("utf8") !== canonical(input)) fail("Persisted H4 history changed");
  for (const [phase, result] of [["before", input.before], ["after", input.after]] as const) {
    const start = phase === "before" ? active.request.before_start : active.request.after_start;
    assertImportedFinalVerificationBinding(active.profile, result.verification, saved.permit, start.verification!.request_id, start.context_pack.payload!, phase);
  }
  inspectImportedDesignReviewResultV1(active.request, input, readProductFile(active.profile.workspace_root, ".artoo/product/research.json"), sha);
  return active.request;
}

import { ImportedExecutionControlV1Schema, ImportedExecutionResultV1Schema, importedExecutionRequestDigestV1,
  inspectImportedExecutionRequestV1, inspectImportedCompletedExecutionV1,
  type ImportedExecutionControlV1, type ImportedExecutionRequestV1, type ImportedExecutionResultV1, type ImportedCompletedExecutionV1 } from "@artoo/domain";
import { assertImportedExecutionVerificationProfile, runImportedExecutionVerification, runImportedExecutionVerificationPreview } from "./verification.js";
import { assertAcceptedProductInputs } from "./product-stage.js";

declare const importedExecutionBrand: unique symbol;
export interface PreparedImportedExecution { readonly [importedExecutionBrand]: true }
interface ImportedExecutionOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedExecutionControlV1; action: "start" | "stop";
  executed: boolean; claimed: boolean; nativeAttempted: boolean; settled: boolean;
  active?: { request: ImportedExecutionRequestV1; original: ImportedDesignReviewResultV1; profile: PreparedVerificationProfile;
    config: AgentInstanceConfig; adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void;
    history: readonly { path: string; digest: string }[]; claimPath: string; claim: string; research: Buffer; design: Buffer;
    effectivePlan: ReturnType<typeof inspectProductSourceVerificationEnvelope>["effective_plan"]; readReleaseCapabilities?: ReleaseCapabilityReader;
    phase: "author" | "final" | "done"; previewRequest?: string; finalEvidence?: RunVerificationPayload; assertAuthorClosed?: () => void };
}
const importedExecutionOwners = new WeakMap<PreparedImportedExecution, ImportedExecutionOwner>();
const importedExecutionContexts = new WeakMap<ContextPack, PreparedImportedExecution>();
const consumedImportedDesignReviews = new WeakSet<ImportedDesignReviewResultV1>();
const completedImportedExecutions = new WeakMap<ImportedExecutionResultV1, PreparedImportedExecution>();
const retainedImportedExecutions = new WeakMap<PreparedProductSourceRuntime, Set<PreparedImportedExecution>>();
export function reserveImportedExecution(runtime: PreparedProductSourceRuntime, input: ImportedExecutionControlV1, action: "start" | "stop"): PreparedImportedExecution {
  const current = state(runtime), control = freezeJson(ImportedExecutionControlV1Schema.parse(input));
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-execution-" + key(control.execution_id) + ".json"), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedExecution;
  importedExecutionOwners.set(permit, { runtime, control, action, executed: false, claimed: false, nativeAttempted: false, settled: false });
  const retained = retainedImportedExecutions.get(runtime) ?? new Set<PreparedImportedExecution>(); retained.add(permit); retainedImportedExecutions.set(runtime, retained);
  return permit;
}
function readImportedExecutionOwner(permit: PreparedImportedExecution) {
  const owner = importedExecutionOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active H5 writer is required");
  const current = state(owner.runtime), start = active.request.run_start;
  if (current.active.get(start.run_id) !== active.profile.workspace_root || !consumedImportedDesignReviews.has(active.original)
    || importedExecutionRequestDigestV1(active.request, sha) !== owner.control.request_digest || start.run_id !== owner.control.run_id
    || active.config.runStart !== start || active.adapter.runtimeId !== start.runtime
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("H5 owner, adapter or imported history changed");
  const checked: unknown = active.assertSession();
  if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); fail("H5 session check must be synchronous"); }
  // The product may change after admission. Accepted specifications and foreign provenance may not.
  if (!readProductFile(active.profile.workspace_root, ".artoo/product/research.json").equals(active.research)
    || !readProductFile(active.profile.workspace_root, ".artoo/product/design.json").equals(active.design)) fail("H5 accepted research/design bytes changed");
  assertAcceptedProductInputs(active.profile.workspace_root, start.context_pack.payload);
  assertImportedExecutionVerificationProfile(active.profile);
  if (active.readReleaseCapabilities) assertReleaseCapabilityContext(start.context_pack.payload, active.readReleaseCapabilities);
  return active;
}
export function readImportedExecutionResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport {
  const permit = importedExecutionContexts.get(context); if (!permit) fail("Original H5 context admission is required");
  const active = readImportedExecutionOwner(permit);
  if (context !== active.config.runStart.context_pack.payload || root !== active.profile.workspace_root || realpathSync.native(root) !== root
    || !(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(active.research)) fail("H5 research projection differs from its exact author context");
  return ProductResearchReportSchema.parse({ ...JSON.parse(active.research.toString("utf8")), measurement_plan: active.effectivePlan });
}
export function readImportedExecutionVerificationAdmission(permit: PreparedImportedExecution, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readImportedExecutionOwner(permit), start = active.request.run_start;
  if (active.profile !== profile || start.context_pack.payload !== context || (scope === "final"
    ? active.phase !== "final" || requestId !== start.verification!.request_id
    : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification!.request_id)) fail("H5 verifier differs from its exact registered invocation");
  return { request: active.request, request_digest: importedExecutionRequestDigestV1(active.request, sha), readReleaseCapabilities: active.readReleaseCapabilities };
}
export async function failUnstartedImportedExecution(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecution,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedExecutionResultV1> {
  const owner = importedExecutionOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Original unstarted H5 reservation is required");
  owner.executed = true;
  const reason = (error instanceof Error ? error.message : "H5 admission failed").slice(0, 2000) || "H5 admission failed";
  let closed = true; try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Implementation was not started: " + reason.slice(0, 1900) } }); } catch { closed = false; }
  const result: ImportedExecutionResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) { state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done"; importedExecutionContexts.delete(owner.active.request.run_start.context_pack.payload); }
  completedImportedExecutions.set(result, permit); return result;
}
export async function runImportedExecution(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecution, original: ImportedDesignReviewResultV1,
  input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedExecutionResultV1> {
  const owner = importedExecutionOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.executed || owner.settled) fail("Original unused H5 reservation is required");
  owner.executed = true;
  try {
    const reviewed = readCompletedAcceptedImportedDesignReview(runtime, original);
    const h4Owner = importedDesignReviewOwners.get(completedImportedDesignReviews.get(original)!.permit)!;
    const h3 = completedVerifiedImportedDesigns.get(h4Owner.active!.original)!;
    const profile = h3.active.profile, current = state(runtime), research = readProductFile(profile.workspace_root, ".artoo/product/research.json"), design = readProductFile(profile.workspace_root, ".artoo/product/design.json");
    const request = freezeJson(inspectImportedExecutionRequestV1(input, research, sha)), start = request.run_start, digest = importedExecutionRequestDigestV1(request, sha);
    if (owner.claimed || owner.control.execution_id !== request.execution_id || owner.control.request_digest !== digest || owner.control.run_id !== start.run_id
      || canonical(original) !== canonical(request.review_result) || canonical(reviewed) !== canonical(request.review_request)
      || consumedImportedDesignReviews.has(original)) fail("H5 requires original accepted H4 and its unused exact reservation");
    if (process.platform !== "win32" || adapter.runtimeId !== start.runtime || typeof assertSession !== "function") fail("H5 requires its installed native Windows adapter and session");
    assertImportedExecutionVerificationProfile(profile); assertAcceptedProductInputs(profile.workspace_root, start.context_pack.payload);
    if (selectVerificationProfile(start, [profile], false, h3.active.readReleaseCapabilities) !== profile
      || subjectManifest(profile).digest !== start.context_pack.payload.imported_execution.initial_subject_digest) fail("H5 initial subject or protected verifier changed");
    if (current.importing || current.active.has(start.run_id) || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("H5 destination is occupied");
    const historyPaths = [...h3.active.history.map(item => item.path), h3.active.claimPath,
      join(current.options.storeRoot, "attestations", "imported-design-result-" + key(reviewed.continuation_request.continuation_id) + ".json"),
      join(current.options.storeRoot, "attestations", "imported-design-review-request-" + key(reviewed.review_id) + ".json"),
      join(current.options.storeRoot, "attestations", "imported-design-review-result-" + key(reviewed.review_id) + ".json")];
    const history = historyPaths.map(path => ({ path, digest: sha(boundedFile(path)) }));
    const config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
    if (Object.values(methods).some(method => typeof method !== "function")) fail("H5 adapter methods must be stable local functions");
    const writerClaimPath = join(current.options.storeRoot, "attestations", "imported-execution-owner-" + key(profile.workspace_root) + ".json");
    const claim = canonical({ ...owner.control, request, original_claim_digest: sha(boundedFile(claimPath(current, profile.workspace_root))) });
    signal.throwIfAborted(); const checked: unknown = assertSession();
    if (checked !== undefined) { void Promise.resolve(checked).catch(() => {}); fail("H5 session must be synchronous"); }
    // The complete baseline was checked above. Consume and persist before any await or native launch.
    consumedImportedDesignReviews.add(original); owner.claimed = true; writeExclusive(writerClaimPath, claim); current.active.set(start.run_id, profile.workspace_root);
    const active: NonNullable<ImportedExecutionOwner["active"]> = { request, original, profile, config, adapter, methods, assertSession,
      history, claimPath: writerClaimPath, claim, research, design, effectivePlan: h3.active.effectivePlan, phase: "author", readReleaseCapabilities: h3.active.readReleaseCapabilities };
    owner.active = active; importedExecutionContexts.set(start.context_pack.payload, permit);
    const assertCurrent = () => { signal.throwIfAborted(); readImportedExecutionOwner(permit); };
    let verified: ImportedCompletedExecutionV1 | undefined;
    const author = createImportedAuthorExecution({ stage: "implementation", adapter, config, profile, signal, assertCurrent, emit,
      markNativeAttempted: () => { owner.nativeAttempted = true; }, prepareFinal: () => { active.phase = "final"; readImportedExecutionOwner(permit); },
      verify: () => runImportedExecutionVerification(profile, start.verification!.request_id, signal, start.context_pack.payload, permit),
      beforeCompleted: evidence => {
        assertCurrent(); author.assertClosed(); active.finalEvidence = evidence;
        assertImportedFinalVerificationBinding(profile, evidence, permit, start.verification!.request_id, start.context_pack.payload, "implementation");
        const mapped = start.context_pack.payload.transferred_product_input, h4 = start.context_pack.payload.imported_execution;
        const destination = request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
        verified = inspectImportedCompletedExecutionV1(request, { ...owner.control, stage: "implementation", run_start_digest: sha(canonical(start)), author: request.writer,
          destination: { node_id: destination.node_id, workspace_root: profile.workspace_root, profile_id: profile.id, profile_digest: profile.digest },
          initial_subject_digest: h4.initial_subject_digest, subject_digest: subjectManifest(profile).digest, h4_review_id: h4.h4_review_id,
          h4_result_digest: h4.h4_result_digest, acceptance_event_id: request.acceptance_event_id, transfer_id: mapped.transfer_id,
          source_export_digest: mapped.source_export_digest, mapping_digest: mapped.mapping_digest, research_provenance_digest: mapped.research_provenance_digest,
          scope: "all-declared-workspace-implementation-cases", closure: "windows-job-and-tools-closed.v1", verification: evidence }, sha);
      } });
    active.assertAuthorClosed = () => author.assertClosed();
    let result: ImportedExecutionResultV1;
    try {
      bindWorkspaceToolCapabilities(config, () => { assertCurrent(); if (!profile.capabilities) fail("H5 capabilities unavailable"); return { ...profile.capabilities, profile_id: profile.id }; });
      if (active.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, active.readReleaseCapabilities);
      bindWorkspaceToolVerifier(config, async previewSignal => {
        assertCurrent(); if (active.previewRequest) fail("H5 preview is already active"); active.previewRequest = "preview-" + randomUUID();
        try { return await runImportedExecutionVerificationPreview(profile, active.previewRequest, previewSignal, start.context_pack.payload, permit); }
        finally { active.previewRequest = undefined; }
      });
      Object.freeze(config); await author.run();
      if (verified) {
        // Terminal delivery awaits a committed receipt. Recheck every local binding after that await.
        assertCurrent(); author.assertClosed();
        assertImportedFinalVerificationBinding(profile, active.finalEvidence!, permit, start.verification!.request_id, start.context_pack.payload, "implementation");
        if (subjectManifest(profile).digest !== verified.subject_digest) fail("H5 verified subject changed while awaiting its terminal receipt");
      }
      result = freezeJson({ ...owner.control, outcome: "finished", closed: true, ...(verified && !signal.aborted ? { verified_execution: verified } : {}) });
    } catch (error) { result = freezeJson({ ...owner.control, ...await author.failure(error) }); }
    finally { author.dispose(); }
    if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; importedExecutionContexts.delete(start.context_pack.payload); }
    completedImportedExecutions.set(result, permit); return result;
  } catch (error) {
    if (!owner.nativeAttempted) return failUnstartedImportedExecution(runtime, permit, error, emit);
    const result: ImportedExecutionResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false,
      reason: (error instanceof Error ? error.message : "H5 execution uncertain").slice(0, 2000) || "H5 execution uncertain" });
    completedImportedExecutions.set(result, permit); return result;
  }
}
export function persistImportedExecutionResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecution, input: ImportedExecutionResultV1): void {
  const owner = importedExecutionOwners.get(permit), current = state(runtime), result = ImportedExecutionResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.execution_id !== owner.control.execution_id || result.request_digest !== owner.control.request_digest
    || result.run_id !== owner.control.run_id || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")) fail("H5 result differs from its original reservation");
  if (owner.action === "start" && result.closed && completedImportedExecutions.get(input) !== permit) fail("Original H5 author result is required");
  if (input.outcome === "finished" && input.verified_execution) {
    const active = owner.active;
    if (!active?.finalEvidence || active.phase !== "done") fail("Original H5 final verification is required");
    assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification!.request_id, active.request.run_start.context_pack.payload, "implementation");
    if (canonical(input.verified_execution.verification) !== canonical(active.finalEvidence)) fail("H5 final verification was replaced");
    inspectImportedCompletedExecutionV1(active.request, input.verified_execution, sha);
  }
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-execution-result-" + key(result.execution_id) + ".json"), canonical(result));
  owner.settled = true; if (result.closed) retainedImportedExecutions.get(runtime)?.delete(permit);
}

import { ImportedExecutionReviewControlV1Schema, ImportedExecutionReviewResultV1Schema, ImportedExecutionReviewVerdictV1Schema,
  importedExecutionReviewRequestDigestV1, inspectImportedExecutionReviewRequestV1, inspectImportedExecutionReviewResultV1,
  ImportedExecutionRepairControlV1Schema, ImportedExecutionRepairResultV1Schema, importedExecutionRepairRequestDigestV1,
  inspectImportedExecutionRepairRequestV1, inspectImportedExecutionRepairResultV1, inspectImportedCompletedExecutionRepairV1,
  inspectImportedImplementationSourceV1, importedImplementationSourceDigestV1,
  type ImportedExecutionReviewControlV1, type ImportedExecutionReviewRequestV1, type ImportedExecutionReviewResultV1,
  type ImportedExecutionRepairControlV1, type ImportedExecutionRepairRequestV1, type ImportedExecutionRepairResultV1,
  type ImportedCompletedExecutionRepairV1, type ImportedImplementationSourceV1 } from "@artoo/domain";
import { runImportedExecutionReviewVerification, runImportedExecutionRepairVerification, runImportedExecutionRepairVerificationPreview } from "./verification.js";
import { createImportedImplementationReviewEvidence } from "./imported-implementation-review-evidence.js";

type ImplementationOriginal = ImportedExecutionResultV1 | ImportedExecutionRepairResultV1;
interface ImplementationSourceState {
  runtime: PreparedProductSourceRuntime; original: ImplementationOriginal; source: ImportedImplementationSourceV1; execution: ImportedExecutionRequestV1;
  profile: PreparedVerificationProfile; research: Buffer; design: Buffer; history: readonly { path: string; digest: string }[];
  effectivePlan: ReturnType<typeof inspectProductSourceVerificationEnvelope>["effective_plan"];
  readReleaseCapabilities?: ReleaseCapabilityReader; assertSession: () => void; assertClosed: () => void;
}
function synchronousSession(check: () => void) {
  const value: unknown = check(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); fail("Implementation session must be synchronous"); }
}
function assertImplementationFiles(source: ImplementationSourceState, completeSubject: boolean) {
  state(source.runtime); synchronousSession(source.assertSession); source.assertClosed();
  if (source.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Implementation source history changed");
  if (!readProductFile(source.profile.workspace_root, ".artoo/product/research.json").equals(source.research)
    || !readProductFile(source.profile.workspace_root, ".artoo/product/design.json").equals(source.design)) fail("Implementation accepted input bytes changed");
  assertAcceptedProductInputs(source.profile.workspace_root, source.source.run_start.context_pack.payload);
  assertImportedExecutionVerificationProfile(source.profile);
  if (source.readReleaseCapabilities) assertReleaseCapabilityContext(source.source.run_start.context_pack.payload, source.readReleaseCapabilities);
  if (completeSubject && subjectManifest(source.profile).digest !== source.source.subject_digest) fail("Completed implementation subject changed");
}
function readSettledH5(runtime: PreparedProductSourceRuntime, input: ImportedExecutionResultV1): ImplementationSourceState {
  const permit = completedImportedExecutions.get(input), owner = permit && importedExecutionOwners.get(permit), active = owner?.active;
  if (!permit || owner?.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.finalEvidence || !active.assertAuthorClosed
    || input.outcome !== "finished" || !input.closed || !input.verified_execution) fail("Original persisted verified H5 completion is required");
  const current = state(runtime), resultPath = join(current.options.storeRoot, "attestations", "imported-execution-result-" + key(input.execution_id) + ".json");
  if (boundedFile(resultPath).toString("utf8") !== canonical(input) || boundedFile(active.claimPath).toString("utf8") !== active.claim
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("H5 completed owner or persisted result changed");
  const source = inspectImportedImplementationSourceV1(active.request, { version: 1, kind: "execution", operation_id: input.execution_id,
    request_digest: input.request_digest, result_digest: hash(input), author: active.request.writer, run_start: active.request.run_start,
    subject_digest: input.verified_execution.subject_digest, verification: input.verified_execution.verification }, active.research, sha);
  const saved: ImplementationSourceState = { runtime, original: input, source, execution: active.request, profile: active.profile,
    research: active.research, design: active.design, effectivePlan: active.effectivePlan, readReleaseCapabilities: active.readReleaseCapabilities,
    assertSession: active.assertSession, history: [...active.history, { path: active.claimPath, digest: sha(active.claim) }, { path: resultPath, digest: hash(input) }],
    assertClosed: () => {
      active.assertAuthorClosed!(); assertImportedFinalVerificationBinding(active.profile, active.finalEvidence!, permit,
        active.request.run_start.verification!.request_id, active.request.run_start.context_pack.payload, "implementation");
      if (canonical(active.finalEvidence) !== canonical(input.verified_execution!.verification)
        || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method))
        fail("Original H5 final verification or author methods were replaced");
    } };
  assertImplementationFiles(saved, true); return saved;
}
/** Completion facts only. The controller separately requires its current-session exact result receipt. */
export function readCompletedVerifiedImportedExecution(runtime: PreparedProductSourceRuntime, input: ImportedExecutionResultV1) {
  return readSettledH5(runtime, input).source;
}

declare const implementationReviewBrand: unique symbol, implementationRepairBrand: unique symbol;
export interface PreparedImportedExecutionReview { readonly [implementationReviewBrand]: true }
export interface PreparedImportedExecutionRepair { readonly [implementationRepairBrand]: true }
interface ImplementationReviewOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedExecutionReviewControlV1; action: "start" | "stop"; claimed: boolean; settled: boolean;
  active?: { request: ImportedExecutionReviewRequestV1; original: ImplementationOriginal; source: ImplementationSourceState;
    adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void; phase: "before" | "review" | "after" | "done";
    before?: RunVerificationPayload; after?: RunVerificationPayload; assertReviewerClosed?: () => void; closure: ReturnType<typeof createImportedReviewClosure> };
}
interface ImplementationRepairOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedExecutionRepairControlV1; action: "start" | "stop";
  claimed: boolean; executed: boolean; nativeAttempted: boolean; settled: boolean;
  active?: { request: ImportedExecutionRepairRequestV1; original: ImportedExecutionReviewResultV1; source: ImplementationSourceState;
    profile: PreparedVerificationProfile; config: AgentInstanceConfig; adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void;
    history: readonly { path: string; digest: string }[]; claimPath: string; claim: string; phase: "author" | "final" | "done";
    finalEvidence?: RunVerificationPayload; previewRequest?: string; assertAuthorClosed?: () => void; assertRejectedClosed: () => void };
}
const implementationReviewOwners = new WeakMap<PreparedImportedExecutionReview, ImplementationReviewOwner>();
const implementationRepairOwners = new WeakMap<PreparedImportedExecutionRepair, ImplementationRepairOwner>();
const implementationReviewContexts = new WeakMap<ContextPack, PreparedImportedExecutionReview>();
const implementationRepairContexts = new WeakMap<ContextPack, PreparedImportedExecutionRepair>();
const completedImplementationReviews = new WeakMap<ImportedExecutionReviewResultV1, PreparedImportedExecutionReview>();
const completedImplementationRepairs = new WeakMap<ImportedExecutionRepairResultV1, PreparedImportedExecutionRepair>();
const consumedImplementationSources = new WeakSet<ImplementationOriginal>(), consumedRejectedImplementationReviews = new WeakSet<ImportedExecutionReviewResultV1>();
const retainedImplementationWork = new WeakMap<PreparedProductSourceRuntime, Set<PreparedImportedExecutionReview | PreparedImportedExecutionRepair>>();
function retainImplementation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionReview | PreparedImportedExecutionRepair) {
  const retained = retainedImplementationWork.get(runtime) ?? new Set(); retained.add(permit); retainedImplementationWork.set(runtime, retained);
}
export function reserveImportedExecutionReview(runtime: PreparedProductSourceRuntime, input: ImportedExecutionReviewControlV1, action: "start" | "stop"): PreparedImportedExecutionReview {
  const current = state(runtime), control = freezeJson(ImportedExecutionReviewControlV1Schema.parse(input));
  writeExclusive(join(current.options.storeRoot, "attestations", "implementation-review-" + key(control.review_id) + ".json"), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedExecutionReview;
  implementationReviewOwners.set(permit, { runtime, control, action, claimed: false, settled: false }); retainImplementation(runtime, permit); return permit;
}
export function reserveImportedExecutionRepair(runtime: PreparedProductSourceRuntime, input: ImportedExecutionRepairControlV1, action: "start" | "stop"): PreparedImportedExecutionRepair {
  const current = state(runtime), control = freezeJson(ImportedExecutionRepairControlV1Schema.parse(input));
  writeExclusive(join(current.options.storeRoot, "attestations", "implementation-repair-" + key(control.repair_id) + ".json"), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedExecutionRepair;
  implementationRepairOwners.set(permit, { runtime, control, action, claimed: false, executed: false, nativeAttempted: false, settled: false }); retainImplementation(runtime, permit); return permit;
}
function readImplementationSource(runtime: PreparedProductSourceRuntime, input: ImplementationOriginal): ImplementationSourceState {
  return "execution_id" in input ? readSettledH5(runtime, input) : readSettledImplementationRepair(runtime, input);
}
function readImplementationReviewOwner(permit: PreparedImportedExecutionReview) {
  const owner = implementationReviewOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active H6 review owner is required");
  const current = state(owner.runtime);
  if (current.active.get(active.request.review_start.run_id) !== active.source.profile.workspace_root
    || !consumedImplementationSources.has(active.original) || importedExecutionReviewRequestDigestV1(active.request, sha) !== owner.control.request_digest
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(join(current.options.storeRoot, "attestations", "implementation-review-request-" + key(owner.control.review_id) + ".json")).toString("utf8") !== canonical(active.request)) fail("H6 review ownership, adapter or request changed");
  synchronousSession(active.assertSession); assertImplementationFiles(active.source, true); return active;
}
export function readImportedExecutionReviewVerificationAdmission(permit: PreparedImportedExecutionReview, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, phase: "before" | "after") {
  const active = readImplementationReviewOwner(permit), start = phase === "before" ? active.request.before_start : active.request.after_start;
  if (active.phase !== phase || profile !== active.source.profile || context !== start.context_pack.payload || requestId !== start.verification!.request_id)
    fail("H6 verifier differs from its original registered phase");
  return { request: active.request, request_digest: importedExecutionReviewRequestDigestV1(active.request, sha), phase, start,
    readReleaseCapabilities: active.source.readReleaseCapabilities };
}
function readImplementationReviewResearch(root: string, context: ContextPack, bytes: Uint8Array) {
  const permit = implementationReviewContexts.get(context); if (!permit) fail("Original H6 verification context is required");
  const active = readImplementationReviewOwner(permit), start = active.phase === "before" ? active.request.before_start : active.phase === "after" ? active.request.after_start : undefined;
  if (root !== active.source.profile.workspace_root || realpathSync.native(root) !== root || start?.context_pack.payload !== context
    || !Buffer.from(bytes).equals(active.source.research)) fail("H6 research differs from its exact phase and accepted bytes");
  return ProductResearchReportSchema.parse({ ...JSON.parse(active.source.research.toString("utf8")), measurement_plan: active.source.effectivePlan });
}
export async function runImportedExecutionReview(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionReview,
  original: ImplementationOriginal, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void): Promise<ImportedExecutionReviewResultV1> {
  const owner = implementationReviewOwners.get(permit), current = state(runtime), source = readImplementationSource(runtime, original);
  const request = freezeJson(inspectImportedExecutionReviewRequestV1(input, source.research, sha));
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.claimed || owner.settled
    || owner.control.review_id !== request.review_id || owner.control.request_digest !== importedExecutionReviewRequestDigestV1(request, sha)
    || canonical(request.execution_request) !== canonical(source.execution) || canonical(request.source) !== canonical(source.source)
    || request.source.result_digest !== hash(original) || consumedImplementationSources.has(original)) fail("H6 requires its original unused receipt-qualified implementation source");
  const profile = source.profile;
  if (process.platform !== "win32" || !supportsWorkspaceReadOnlyTools(adapter) || adapter.runtimeId !== request.review_start.runtime)
    fail("H6 requires a native Windows read-only reviewer");
  if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("H6 destination is occupied");
  const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
  if (Object.values(methods).some(method => typeof method !== "function")) fail("H6 adapter methods must be stable local functions");
  signal.throwIfAborted(); synchronousSession(assertSession); owner.claimed = true; consumedImplementationSources.add(original);
  const closure = createImportedReviewClosure();
  owner.active = { request, original, source, adapter, methods, assertSession, phase: "before", closure };
  writeExclusive(join(current.options.storeRoot, "attestations", "implementation-review-request-" + key(request.review_id) + ".json"), canonical(request));
  current.active.set(request.review_start.run_id, profile.workspace_root);
  for (const start of [request.before_start, request.after_start]) implementationReviewContexts.set(start.context_pack.payload, permit);
  const base = { ...owner.control, execution_authorized: false as const };
  let handle: AgentInstanceHandle | undefined, admission: WindowsVerifiedExecutionAdmission | undefined, stopWork: Promise<void> | undefined, stopError: unknown;
  const stop = () => { if (handle && !stopWork) stopWork = adapter.stop(handle, "user_cancelled").catch(error => { stopError = error; }); };
  try {
    const assertCurrent = () => { signal.throwIfAborted(); readImplementationReviewOwner(permit); };
    assertCurrent(); closure.begin("before-verifier");
    const before = await runImportedExecutionReviewVerification(profile, request.before_start.verification!.request_id, signal, request.before_start.context_pack.payload, permit, "before");
    closure.confirm("before-verifier"); if (before.outcome !== "passed") fail("H6 before verification failed");
    assertImportedFinalVerificationBinding(profile, before, permit, request.before_start.verification!.request_id, request.before_start.context_pack.payload, "implementation-review-before");
    owner.active.before = before; owner.active.phase = "review"; assertCurrent();
    const start = request.review_start, config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id,
      agentInstanceId: start.agent_instance_id, runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const evidence = createImportedImplementationReviewEvidence(profile, before, { requestId: request.before_start.verification!.request_id,
      subjectDigest: source.source.subject_digest }, () => { assertCurrent(); if (owner.active?.phase !== "review") fail("H6 evidence is only available to the original active reviewer"); });
    bindWorkspaceReadOnlyTools(config, { projectId: profile.project_id, workspaceRoot: profile.workspace_root, assertCurrent,
      source: { profile, subjectDigest: source.source.subject_digest, importedExecutionReviewId: request.review_id }, readEvidenceIndex: evidence.readEvidenceIndex });
    bindWorkspaceToolEvidenceReader(config, evidence.read);
    bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
    if (source.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.readReleaseCapabilities);
    Object.freeze(config); admission = bindWindowsVerifiedExecution(adapter, config, profile, signal, assertCurrent);
    closure.begin("reviewer"); handle = await adapter.start(config); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    let answer: string | undefined, terminal: string | undefined, answers = 0;
    for await (const raw of adapter.streamEvents(handle)) {
      const event = adapterRunEventBodySchema.parse(raw);
      if (event.type === "run.answer") { if (++answers !== 1) fail("H6 reviewer returned multiple answers"); answer = event.payload.text; }
      if (event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase)) {
        if (terminal) fail("H6 reviewer returned multiple terminal events"); terminal = event.payload.phase;
      }
    }
    await stopWork; if (stopError) throw stopError;
    assertWindowsVerifiedExecutionClosed(admission, handle); closure.confirm("reviewer");
    owner.active.assertReviewerClosed = () => assertWindowsVerifiedExecutionClosed(admission!, handle!);
    if (terminal !== "completed" || !answer) fail("H6 reviewer did not complete with one substantive answer");
    assertCurrent(); const verdict = ImportedExecutionReviewVerdictV1Schema.parse(JSON.parse(answer));
    // Rejected judgments also require a separately closed, unchanged after measurement.
    owner.active.phase = "after"; assertCurrent(); closure.begin("after-verifier");
    const after = await runImportedExecutionReviewVerification(profile, request.after_start.verification!.request_id, signal, request.after_start.context_pack.payload, permit, "after");
    closure.confirm("after-verifier"); if (after.outcome !== "passed") fail("H6 after verification failed");
    assertImportedFinalVerificationBinding(profile, after, permit, request.after_start.verification!.request_id, request.after_start.context_pack.payload, "implementation-review-after");
    owner.active.after = after;
    const measured = (phaseStart: RunStartPayload, verification: RunVerificationPayload) => ({ run_id: phaseStart.run_id, config_digest: hash(phaseStart),
      closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-implementation-cases" as const, verification });
    const result: ImportedExecutionReviewResultV1 = { ...base, outcome: "reviewed", closed: true, before: measured(request.before_start, before),
      after: measured(request.after_start, after), reviewer: { run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1" }, verdict };
    inspectImportedExecutionReviewResultV1(request, result, source.research, sha); assertCurrent();
    const frozen = freezeJson(result); completedImplementationReviews.set(frozen, permit); return frozen;
  } catch (error) {
    const failed = await finishImportedReviewFailure(closure, error, handle && admission ? async () => {
      if (stopWork) await stopWork; else await adapter.stop(handle!, "shutdown"); if (stopError) throw stopError;
      assertWindowsVerifiedExecutionClosed(admission!, handle!);
    } : undefined);
    return freezeJson({ ...base, ...failed });
  } finally {
    signal.removeEventListener("abort", stop);
    if (closure.closed) { current.active.delete(request.review_start.run_id); owner.active.phase = "done";
      for (const start of [request.before_start, request.after_start]) implementationReviewContexts.delete(start.context_pack.payload); }
  }
}
export function persistImportedExecutionReviewResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionReview, input: ImportedExecutionReviewResultV1) {
  const owner = implementationReviewOwners.get(permit), current = state(runtime), result = ImportedExecutionReviewResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.review_id !== owner.control.review_id || result.request_digest !== owner.control.request_digest
    || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")) fail("H6 result differs from its original reservation");
  if (result.outcome === "reviewed" && completedImplementationReviews.get(input) !== permit) fail("Original H6 reviewed completion is required");
  writeExclusive(join(current.options.storeRoot, "attestations", "implementation-review-result-" + key(result.review_id) + ".json"), canonical(result));
  owner.settled = true; if (result.closed) retainedImplementationWork.get(runtime)?.delete(permit);
}
function readSettledImplementationReview(runtime: PreparedProductSourceRuntime, input: ImportedExecutionReviewResultV1) {
  const permit = completedImplementationReviews.get(input), owner = permit && implementationReviewOwners.get(permit), active = owner?.active;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.closure.closed
    || !active.before || !active.after || !active.assertReviewerClosed || input.outcome !== "reviewed" || !input.closed) fail("Original persisted closed H6 review is required");
  const current = state(runtime), history = [
    { path: join(current.options.storeRoot, "attestations", "implementation-review-request-" + key(input.review_id) + ".json"), digest: hash(active.request) },
    { path: join(current.options.storeRoot, "attestations", "implementation-review-result-" + key(input.review_id) + ".json"), digest: hash(input) }];
  const assertClosed = () => {
    synchronousSession(active.assertSession);
    active.source.assertClosed(); active.assertReviewerClosed!();
    assertImportedFinalVerificationBinding(active.source.profile, active.before!, permit, active.request.before_start.verification!.request_id,
      active.request.before_start.context_pack.payload, "implementation-review-before");
    assertImportedFinalVerificationBinding(active.source.profile, active.after!, permit, active.request.after_start.verification!.request_id,
      active.request.after_start.context_pack.payload, "implementation-review-after");
    if (canonical(input.before.verification) !== canonical(active.before) || canonical(input.after.verification) !== canonical(active.after)
      || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("H6 original closure or final evidence changed");
  };
  synchronousSession(active.assertSession); assertClosed(); assertImplementationFiles(active.source, true);
  if (history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Persisted H6 review history changed");
  inspectImportedExecutionReviewResultV1(active.request, input, active.source.research, sha);
  return { owner, active, history, assertClosed };
}
/** Also used after the explicit result receipt arrives: no await-window drift can grant repair authority. */
export function readCompletedImportedExecutionReview(runtime: PreparedProductSourceRuntime, input: ImportedExecutionReviewResultV1) {
  return readSettledImplementationReview(runtime, input).active.request;
}
function readImplementationRepairOwner(permit: PreparedImportedExecutionRepair) {
  const owner = implementationRepairOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active repair writer is required");
  const current = state(owner.runtime), start = active.request.run_start;
  if (current.active.get(start.run_id) !== active.profile.workspace_root || !consumedRejectedImplementationReviews.has(active.original)
    || importedExecutionRepairRequestDigestV1(active.request, sha) !== owner.control.request_digest || start.run_id !== owner.control.run_id
    || active.config.runStart !== start || active.adapter.runtimeId !== start.runtime
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest))
    fail("Repair ownership, history or adapter changed");
  synchronousSession(active.assertSession); active.assertRejectedClosed(); assertImplementationFiles(active.source, false);
  assertAcceptedProductInputs(active.profile.workspace_root, start.context_pack.payload);
  return active;
}
function readImplementationRepairResearch(root: string, context: ContextPack, bytes: Uint8Array) {
  const permit = implementationRepairContexts.get(context); if (!permit) fail("Original repair author context is required");
  const active = readImplementationRepairOwner(permit);
  if (root !== active.profile.workspace_root || realpathSync.native(root) !== root || context !== active.config.runStart.context_pack.payload
    || !Buffer.from(bytes).equals(active.source.research)) fail("Repair research differs from its registered author and accepted bytes");
  return ProductResearchReportSchema.parse({ ...JSON.parse(active.source.research.toString("utf8")), measurement_plan: active.source.effectivePlan });
}
export function readImportedExecutionRepairVerificationAdmission(permit: PreparedImportedExecutionRepair, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readImplementationRepairOwner(permit), start = active.request.run_start;
  if (active.profile !== profile || start.context_pack.payload !== context || (scope === "final"
    ? active.phase !== "final" || requestId !== start.verification!.request_id
    : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification!.request_id)) fail("Repair verifier differs from its original invocation");
  return { request: active.request, request_digest: importedExecutionRepairRequestDigestV1(active.request, sha), readReleaseCapabilities: active.source.readReleaseCapabilities };
}
export async function failUnstartedImportedExecutionRepair(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionRepair,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedExecutionRepairResultV1> {
  const owner = implementationRepairOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Original unstarted repair reservation is required");
  owner.executed = true; const reason = (error instanceof Error ? error.message : "Repair admission failed").slice(0, 2000) || "Repair admission failed";
  let closed = true;
  try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Repair was not started: " + reason.slice(0, 1900) } }); } catch { closed = false; }
  const result: ImportedExecutionRepairResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) { state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done";
    implementationRepairContexts.delete(owner.active.request.run_start.context_pack.payload); }
  completedImplementationRepairs.set(result, permit); return result;
}
export async function runImportedExecutionRepair(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionRepair,
  original: ImportedExecutionReviewResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal,
  assertSession: () => void, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedExecutionRepairResultV1> {
  const owner = implementationRepairOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.executed || owner.settled) fail("Original unused repair reservation is required");
  owner.executed = true;
  try {
    const reviewed = readSettledImplementationReview(runtime, original), source = reviewed.active.source;
    const request = freezeJson(inspectImportedExecutionRepairRequestV1(input, source.research, sha)), start = request.run_start;
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected" || consumedRejectedImplementationReviews.has(original)
      || owner.claimed || owner.control.repair_id !== request.repair_id || owner.control.request_digest !== importedExecutionRepairRequestDigestV1(request, sha)
      || owner.control.run_id !== start.run_id || request.review_id !== original.review_id || request.review_request_digest !== original.request_digest
      || request.review_result_digest !== hash(original) || canonical(request.execution_request) !== canonical(source.execution)
      || canonical(request.source) !== canonical(reviewed.active.request.source)) fail("Repair requires its original rejected H6 and independent exact authorization binding");
    const profile = source.profile, current = state(runtime);
    if (process.platform !== "win32" || adapter.runtimeId !== start.runtime) fail("Repair requires its original native Windows destination");
    assertAcceptedProductInputs(profile.workspace_root, start.context_pack.payload); assertImportedExecutionVerificationProfile(profile);
    if (selectVerificationProfile(start, [profile], false, source.readReleaseCapabilities) !== profile
      || subjectManifest(profile).digest !== request.source.subject_digest) fail("Repair initial subject or protected profile changed");
    if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("Repair destination is occupied");
    const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
    if (Object.values(methods).some(method => typeof method !== "function")) fail("Repair adapter methods must be stable local functions");
    const config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const claimPath = join(current.options.storeRoot, "attestations", "implementation-repair-owner-" + key(request.repair_id) + ".json");
    const authorizationPath = join(current.options.storeRoot, "attestations", "implementation-repair-authorization-" + key(request.authorization.event_id) + ".json");
    const claim = canonical({ ...owner.control, request }); signal.throwIfAborted(); synchronousSession(assertSession);
    // Both the original rejected result and the independent authorization event are single-use.
    consumedRejectedImplementationReviews.add(original); owner.claimed = true;
    writeExclusive(authorizationPath, claim); writeExclusive(claimPath, claim); current.active.set(start.run_id, profile.workspace_root);
    const active: NonNullable<ImplementationRepairOwner["active"]> = { request, original, source, profile, config, adapter, methods, assertSession,
      history: [...source.history, ...reviewed.history, { path: authorizationPath, digest: sha(claim) }], claimPath, claim, phase: "author", assertRejectedClosed: reviewed.assertClosed };
    owner.active = active; implementationRepairContexts.set(start.context_pack.payload, permit);
    const assertCurrent = () => { signal.throwIfAborted(); readImplementationRepairOwner(permit); };
    let verified: ImportedCompletedExecutionRepairV1 | undefined;
    const author = createImportedAuthorExecution({ stage: "implementation", adapter, config, profile, signal, assertCurrent, emit,
      markNativeAttempted: () => { owner.nativeAttempted = true; }, prepareFinal: () => { active.phase = "final"; assertCurrent(); },
      verify: () => runImportedExecutionRepairVerification(profile, start.verification!.request_id, signal, start.context_pack.payload, permit),
      beforeCompleted: evidence => {
        assertCurrent(); author.assertClosed(); active.finalEvidence = evidence;
        assertImportedFinalVerificationBinding(profile, evidence, permit, start.verification!.request_id, start.context_pack.payload, "implementation-repair");
        const mapped = start.context_pack.payload.transferred_product_input!, destination = source.execution.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
        verified = inspectImportedCompletedExecutionRepairV1(request, { ...owner.control, stage: "implementation", run_start_digest: hash(start), author: request.writer,
          destination: { node_id: destination.node_id, workspace_root: profile.workspace_root, profile_id: profile.id, profile_digest: profile.digest },
          initial_subject_digest: request.source.subject_digest, subject_digest: subjectManifest(profile).digest, base_execution_id: source.execution.execution_id,
          review_id: request.review_id, review_request_digest: request.review_request_digest, review_result_digest: request.review_result_digest,
          authorization_event_id: request.authorization.event_id, attempt_index: request.authorization.attempt_index, transfer_id: mapped.transfer_id,
          source_export_digest: mapped.source_export_digest, mapping_digest: mapped.mapping_digest, research_provenance_digest: mapped.research_provenance_digest,
          closure: "windows-job-and-tools-closed.v1", scope: "all-declared-workspace-implementation-cases", verification: evidence }, sha);
      } });
    active.assertAuthorClosed = () => author.assertClosed(); let result: ImportedExecutionRepairResultV1;
    try {
      bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
      if (source.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.readReleaseCapabilities);
      bindWorkspaceToolVerifier(config, async previewSignal => {
        assertCurrent(); if (active.previewRequest) fail("Repair preview is already active"); active.previewRequest = "preview-" + randomUUID();
        try { return await runImportedExecutionRepairVerificationPreview(profile, active.previewRequest, previewSignal, start.context_pack.payload, permit); }
        finally { active.previewRequest = undefined; }
      });
      Object.freeze(config); await author.run();
      if (verified) {
        // Awaited terminal event commit cannot freeze an earlier set of mutable ownership facts.
        assertCurrent(); author.assertClosed();
        assertImportedFinalVerificationBinding(profile, active.finalEvidence!, permit, start.verification!.request_id, start.context_pack.payload, "implementation-repair");
        if (subjectManifest(profile).digest !== verified.subject_digest) fail("Repair subject changed while awaiting terminal commit");
        inspectImportedCompletedExecutionRepairV1(request, verified, sha);
      }
      result = freezeJson({ ...owner.control, outcome: "finished", closed: true, ...(verified && !signal.aborted ? { verified_repair: verified } : {}) });
    } catch (error) { result = freezeJson({ ...owner.control, ...await author.failure(error) }); }
    finally { author.dispose(); }
    if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; implementationRepairContexts.delete(start.context_pack.payload); }
    completedImplementationRepairs.set(result, permit); return result;
  } catch (error) {
    if (!owner.nativeAttempted) return failUnstartedImportedExecutionRepair(runtime, permit, error, emit);
    const result: ImportedExecutionRepairResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false,
      reason: (error instanceof Error ? error.message : "Repair execution uncertain").slice(0, 2000) || "Repair execution uncertain" });
    completedImplementationRepairs.set(result, permit); return result;
  }
}
export function persistImportedExecutionRepairResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedExecutionRepair, input: ImportedExecutionRepairResultV1) {
  const owner = implementationRepairOwners.get(permit), current = state(runtime), result = ImportedExecutionRepairResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.repair_id !== owner.control.repair_id || result.request_digest !== owner.control.request_digest
    || result.run_id !== owner.control.run_id || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")) fail("Repair result differs from its original reservation");
  if (owner.action === "start" && result.closed && completedImplementationRepairs.get(input) !== permit) fail("Original repair author result is required");
  if (input.outcome === "finished" && input.verified_repair) {
    const active = owner.active;
    if (!active?.finalEvidence || active.phase !== "done") fail("Original repair final evidence is required");
    assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification!.request_id,
      active.request.run_start.context_pack.payload, "implementation-repair");
    if (canonical(input.verified_repair.verification) !== canonical(active.finalEvidence)) fail("Repair final evidence was replaced");
    inspectImportedCompletedExecutionRepairV1(active.request, input.verified_repair, sha);
  }
  writeExclusive(join(current.options.storeRoot, "attestations", "implementation-repair-result-" + key(result.repair_id) + ".json"), canonical(result));
  owner.settled = true; if (result.closed) retainedImplementationWork.get(runtime)?.delete(permit);
}
function readSettledImplementationRepair(runtime: PreparedProductSourceRuntime, input: ImportedExecutionRepairResultV1): ImplementationSourceState {
  const permit = completedImplementationRepairs.get(input), owner = permit && implementationRepairOwners.get(permit), active = owner?.active;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.finalEvidence || !active.assertAuthorClosed
    || input.outcome !== "finished" || !input.closed || !input.verified_repair) fail("Original persisted verified repair completion is required");
  const resultPath = join(state(runtime).options.storeRoot, "attestations", "implementation-repair-result-" + key(input.repair_id) + ".json");
  if (boundedFile(resultPath).toString("utf8") !== canonical(input) || boundedFile(active.claimPath).toString("utf8") !== active.claim)
    fail("Completed repair history changed");
  const source = inspectImportedImplementationSourceV1(active.request.execution_request, { version: 1, kind: "repair", operation_id: input.repair_id,
    request_digest: input.request_digest, result_digest: hash(input), author: active.request.writer, run_start: active.request.run_start,
    subject_digest: input.verified_repair.subject_digest, verification: input.verified_repair.verification }, active.source.research, sha);
  const saved: ImplementationSourceState = { ...active.source, original: input, source,
    history: [...active.history, { path: active.claimPath, digest: sha(active.claim) }, { path: resultPath, digest: hash(input) }],
    assertSession: () => { synchronousSession(active.source.assertSession); synchronousSession(active.assertSession); },
    assertClosed: () => {
      active.source.assertClosed(); active.assertRejectedClosed(); active.assertAuthorClosed!();
      assertImportedFinalVerificationBinding(active.profile, active.finalEvidence!, permit, active.request.run_start.verification!.request_id,
        active.request.run_start.context_pack.payload, "implementation-repair");
      if (canonical(active.finalEvidence) !== canonical(input.verified_repair!.verification)
        || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("Original repair closure or verifier changed");
      inspectImportedExecutionRepairResultV1(active.request, input, active.source.research, sha);
    } };
  assertImplementationFiles(saved, true); return saved;
}
export function readCompletedVerifiedImportedExecutionRepair(runtime: PreparedProductSourceRuntime, input: ImportedExecutionRepairResultV1) {
  return readSettledImplementationRepair(runtime, input).source;
}

import { ImportedValidationControlV1Schema, ImportedValidationRequestV1Schema, ImportedValidationResultV1Schema, ImportedValidationReviewControlV1Schema,
  ImportedValidationReviewResultV1Schema, ImportedValidationReviewVerdictV1Schema, inspectImportedValidationRequestV1,
  inspectImportedValidationResultV1, inspectImportedValidationSourceV1, inspectImportedValidationReviewRequestV1, inspectImportedValidationReviewResultV1,
  importedValidationOriginDigestV1, importedValidationRequestDigestV1, importedValidationReviewRequestDigestV1,
  type ImportedValidationControlV1, type ImportedValidationRequestV1, type ImportedValidationResultV1, type ImportedValidationSourceV1,
  type ImportedValidationOriginV1, type ImportedValidationReviewControlV1, type ImportedValidationReviewRequestV1, type ImportedValidationReviewResultV1,
  ProductReleaseRequestSchema, type ImportedCompletedValidationV1, type ImportedClosedValidationFailureV1, type ProductReleaseRequest } from "@artoo/domain";
import { assertImportedValidationVerificationProfile, assertImportedValidationFailedVerificationBinding,
  runImportedValidationVerification, runImportedValidationVerificationPreview, runImportedValidationReviewVerification } from "./verification.js";
import { retainImportedValidationBaseline, assertImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
import { createImportedValidationReviewEvidence } from "./imported-validation-review-evidence.js";

declare const validationBrand: unique symbol, validationReviewBrand: unique symbol;
export interface PreparedImportedValidation { readonly [validationBrand]: true }
export interface PreparedImportedValidationReview { readonly [validationReviewBrand]: true }
type ValidationPredecessor = ImportedExecutionReviewResultV1 | ImportedValidationResultV1 | ImportedValidationReviewResultV1;
interface ValidationAncestors {
  implementation: ImplementationSourceState; origin: ImportedValidationOriginV1; history: readonly { path: string; digest: string }[];
  assertClosed: () => void; assertSession: () => void;
}
interface ValidationAuthorOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedValidationControlV1; action: "start" | "stop";
  claimed: boolean; executed: boolean; nativeAttempted: boolean; settled: boolean;
  active?: { request: ImportedValidationRequestV1; original: ValidationPredecessor; ancestors: ValidationAncestors;
    baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile; config: AgentInstanceConfig; adapter: RuntimeAdapter;
    methods: Record<string, unknown>; assertSession: () => void; claimPath: string; claim: string; history: readonly { path: string; digest: string }[];
    phase: "author" | "final" | "done"; previewRequest?: string; finalEvidence?: RunVerificationPayload; failedEvidence?: RunVerificationPayload;
    assertAuthorClosed?: () => void; failedSubject?: string; retainedFailure?: ReturnType<typeof captureProductSourceSnapshot> };
}
interface ValidationSourceState {
  runtime: PreparedProductSourceRuntime; permit: PreparedImportedValidation; original: ImportedValidationResultV1; source: ImportedValidationSourceV1;
  ancestors: ValidationAncestors; baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile;
  history: readonly { path: string; digest: string }[]; assertClosed: () => void; assertSession: () => void;
}
interface ValidationReviewOwner {
  runtime: PreparedProductSourceRuntime; control: ImportedValidationReviewControlV1; action: "start" | "stop"; claimed: boolean; settled: boolean;
  active?: { request: ImportedValidationReviewRequestV1; original: ImportedValidationResultV1; source: ValidationSourceState;
    adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void; phase: "before" | "review" | "after" | "done";
    before?: RunVerificationPayload; after?: RunVerificationPayload; assertReviewerClosed?: () => void; retryableFailure?: boolean; closure: ReturnType<typeof createImportedReviewClosure> };
}
const validationOwners = new WeakMap<PreparedImportedValidation, ValidationAuthorOwner>();
const validationReviewOwners = new WeakMap<PreparedImportedValidationReview, ValidationReviewOwner>();
const validationContexts = new WeakMap<ContextPack, PreparedImportedValidation>(), validationReviewContexts = new WeakMap<ContextPack, PreparedImportedValidationReview>();
const completedValidations = new WeakMap<ImportedValidationResultV1, PreparedImportedValidation>();
const completedValidationReviews = new WeakMap<ImportedValidationReviewResultV1, PreparedImportedValidationReview>();
const consumedValidationPredecessors = new WeakSet<ValidationPredecessor>(), consumedValidationSources = new WeakSet<ImportedValidationResultV1>();
const consumedFailedValidationReviews = new WeakSet<ImportedValidationReviewResultV1>();
const retainedValidationWork = new WeakMap<PreparedProductSourceRuntime, Set<PreparedImportedValidation | PreparedImportedValidationReview>>();
const validationLineages = new WeakMap<PreparedProductSourceRuntime, Map<string, { author: PreparedImportedValidation; review?: PreparedImportedValidationReview }>>();
function validationPath(runtime: PreparedProductSourceRuntime, kind: string, id: string) { return join(state(runtime).options.storeRoot, "attestations", "validation-" + kind + "-" + key(id) + ".json"); }
function retainValidation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidation | PreparedImportedValidationReview) {
  const retained = retainedValidationWork.get(runtime) ?? new Set(); retained.add(permit); retainedValidationWork.set(runtime, retained);
}
function validationLineage(runtime: PreparedProductSourceRuntime, root: string) { return validationLineages.get(runtime)?.get(root); }
function assertValidationAncestors(ancestors: ValidationAncestors) {
  synchronousSession(ancestors.assertSession); ancestors.assertClosed(); assertImplementationFiles(ancestors.implementation, false);
  if (ancestors.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation ancestor history changed");
}
export function reserveImportedValidation(runtime: PreparedProductSourceRuntime, input: ImportedValidationControlV1, action: "start" | "stop"): PreparedImportedValidation {
  const control = freezeJson(ImportedValidationControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "reservation", control.validation_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedValidation;
  validationOwners.set(permit, { runtime, control, action, claimed: false, executed: false, nativeAttempted: false, settled: false }); retainValidation(runtime, permit); return permit;
}
export function reserveImportedValidationReview(runtime: PreparedProductSourceRuntime, input: ImportedValidationReviewControlV1, action: "start" | "stop"): PreparedImportedValidationReview {
  const control = freezeJson(ImportedValidationReviewControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "review-reservation", control.review_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedValidationReview;
  validationReviewOwners.set(permit, { runtime, control, action, claimed: false, settled: false }); retainValidation(runtime, permit); return permit;
}
function readValidationAuthorOwner(permit: PreparedImportedValidation) {
  const owner = validationOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation author is required");
  const current = state(owner.runtime), start = active.request.run_start;
  if (validationLineage(owner.runtime, active.request.root_validation_id)?.author !== permit || current.active.get(start.run_id) !== active.profile.workspace_root
    || !consumedValidationPredecessors.has(active.original) || active.config.runStart !== start || active.adapter.runtimeId !== start.runtime
    || importedValidationRequestDigestV1(active.request, sha) !== owner.control.request_digest || start.run_id !== owner.control.run_id
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest))
    fail("Validation author ownership, lineage, adapter or history changed");
  synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors); assertImportedValidationBaseline(active.baseline);
  assertAcceptedProductInputs(active.profile.workspace_root, start.context_pack.payload); assertImportedValidationVerificationProfile(active.profile); return active;
}
export function readImportedValidationVerificationAdmission(permit: PreparedImportedValidation, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readValidationAuthorOwner(permit), start = active.request.run_start;
  if (profile !== active.profile || context !== start.context_pack.payload || (scope === "final"
    ? active.phase !== "final" || requestId !== start.verification.request_id
    : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification.request_id)) fail("Validation verifier changed its original author invocation");
  return { request: active.request, request_digest: importedValidationRequestDigestV1(active.request, sha), readReleaseCapabilities: active.ancestors.implementation.readReleaseCapabilities };
}
function readValidationResearch(root: string, context: ContextPack, bytes: Uint8Array) {
  const authorPermit = validationContexts.get(context), reviewPermit = validationReviewContexts.get(context);
  const author = authorPermit ? readValidationAuthorOwner(authorPermit) : undefined, review = reviewPermit ? readValidationReviewOwner(reviewPermit) : undefined;
  const source = author?.ancestors.implementation ?? review?.source.ancestors.implementation;
  const expected = author?.request.run_start.context_pack.payload ?? (review?.phase === "before" ? review.request.before_start.context_pack.payload
    : review?.phase === "after" ? review.request.after_start.context_pack.payload : undefined);
  if (!source || expected !== context || root !== source.profile.workspace_root || realpathSync.native(root) !== root || !Buffer.from(bytes).equals(source.research))
    fail("Original validation phase and accepted research bytes are required");
  return ProductResearchReportSchema.parse({ ...JSON.parse(source.research.toString("utf8")), measurement_plan: source.effectivePlan });
}
function validationPredecessor(runtime: PreparedProductSourceRuntime, original: ValidationPredecessor, request: ImportedValidationRequestV1): ValidationAncestors {
  if (request.kind === "initial") {
    if (!("review_id" in original)) fail("Initial validation requires an original accepted H6 review");
    const reviewed = readSettledImplementationReview(runtime, original as ImportedExecutionReviewResultV1);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted" || original.review_id !== request.origin.review_id
      || original.request_digest !== request.origin.request_digest || hash(original) !== request.origin.result_digest
      || canonical(reviewed.active.request.source) !== canonical(request.origin.implementation_source)
      || canonical(reviewed.active.request.execution_request) !== canonical(request.origin.execution_request)
      || validationLineage(runtime, request.root_validation_id)) fail("Initial validation changed its original accepted implementation");
    return { implementation: reviewed.active.source, origin: request.origin, history: [...reviewed.active.source.history, ...reviewed.history],
      assertClosed: reviewed.assertClosed, assertSession: reviewed.active.assertSession };
  }
  let source: ValidationSourceState, history: readonly { path: string; digest: string }[], assertClosed: () => void;
  if (request.predecessor?.kind === "review") {
    if (!("review_id" in original)) fail("Validation repair requires an original rejected final review");
    const reviewed = readSettledValidationReview(runtime, original as ImportedValidationReviewResultV1);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected" || canonical(request.predecessor.review) !== canonical({
      review_id: original.review_id, request_digest: original.request_digest, result_digest: hash(original) })) fail("Validation repair changed its exact rejected predecessor");
    source = reviewed.active.source; history = [...source.history, ...reviewed.history]; assertClosed = reviewed.assertClosed;
    if (request.authorization.attempt_index <= reviewed.active.request.authorization.attempt_index) fail("Repair must consume a fresh cumulative retry after its rejected review");
  } else {
    if (!("validation_id" in original) || request.predecessor?.kind !== "failure") fail("Validation repair requires an original typed closed failure");
    source = readSettledValidation(runtime, original);
    if (source.source.outcome !== "closed-failure") fail("Generic validation failure cannot grant repair authority");
    history = source.history; assertClosed = source.assertClosed;
  }
  if (canonical(request.source) !== canonical(source.source) || canonical(request.origin) !== canonical(source.ancestors.origin)
    || validationLineage(runtime, request.root_validation_id)?.author !== source.permit) fail("Validation repair must continue the latest original source");
  return { implementation: source.ancestors.implementation, origin: source.ancestors.origin, history,
    assertClosed, assertSession: source.assertSession };
}
export async function failUnstartedImportedValidation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidation,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Original unstarted validation reservation is required");
  owner.executed = true; const reason = (error instanceof Error ? error.message : "Validation admission failed").slice(0, 2000) || "Validation admission failed";
  let closed = true;
  try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Validation was not started: " + reason.slice(0, 1900) } }); } catch { closed = false; }
  const result: ImportedValidationResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) { state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done"; validationContexts.delete(owner.active.request.run_start.context_pack.payload); }
  completedValidations.set(result, permit); return result;
}
export async function runImportedValidation(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidation, original: ValidationPredecessor,
  input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.executed || owner.settled) fail("Original unused validation reservation is required");
  owner.executed = true;
  try {
    const shape = ImportedValidationRequestV1Schema.parse(input);
    const ancestors = validationPredecessor(runtime, original, shape), source = ancestors.implementation;
    const request = freezeJson(inspectImportedValidationRequestV1(shape, source.research, sha)), start = request.run_start, profile = source.profile, current = state(runtime);
    if (owner.claimed || owner.control.validation_id !== request.validation_id || owner.control.run_id !== start.run_id
      || owner.control.request_digest !== importedValidationRequestDigestV1(request, sha) || consumedValidationPredecessors.has(original)) fail("Validation predecessor or reservation already consumed or changed");
    if (process.platform !== "win32" || adapter.runtimeId !== start.runtime) fail("Validation requires its original native Windows destination");
    assertImportedValidationVerificationProfile(profile); assertValidationAncestors(ancestors);
    if (selectVerificationProfile(start, [profile], false, source.readReleaseCapabilities) !== profile || subjectManifest(profile).digest !== request.source.subject_digest)
      fail("Validation initial subject or protected configuration changed");
    if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("Validation destination is occupied");
    const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
    if (Object.values(methods).some(method => typeof method !== "function")) fail("Validation adapter methods must be stable local functions");
    const assertBefore = () => { signal.throwIfAborted(); synchronousSession(assertSession); assertValidationAncestors(ancestors);
      if (subjectManifest(profile).digest !== request.source.subject_digest) fail("Validation source changed before baseline capture"); };
    auditWindowsReleaseStorage(current.store, current.options.storeRoot);
    const baseline = retainImportedValidationBaseline(profile, current.options.storeRoot, request.validation_id, request.source.subject_digest, assertBefore);
    auditWindowsReleaseStorage(current.store, current.options.storeRoot);
    const config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const claimPath = validationPath(runtime, "owner", request.validation_id), authorizationPath = validationPath(runtime, "authorization", request.authorization.event_id);
    const claim = canonical({ ...owner.control, request }); assertBefore(); consumedValidationPredecessors.add(original); owner.claimed = true;
    // Replace the latest owner before any writer can start; a prior acceptance cannot publish S0 after this point.
    const lineages = validationLineages.get(runtime) ?? new Map(); lineages.set(request.root_validation_id, { author: permit }); validationLineages.set(runtime, lineages);
    writeExclusive(authorizationPath, claim); writeExclusive(claimPath, claim); current.active.set(start.run_id, profile.workspace_root);
    const active: NonNullable<ValidationAuthorOwner["active"]> = { request, original, ancestors, baseline, profile, config, adapter, methods, assertSession,
      claimPath, claim, history: [...ancestors.history, { path: authorizationPath, digest: sha(claim) }], phase: "author" };
    owner.active = active; validationContexts.set(start.context_pack.payload, permit);
    const assertCurrent = () => { signal.throwIfAborted(); readValidationAuthorOwner(permit); };
    let verified: ImportedCompletedValidationV1 | undefined, closedFailure: ImportedClosedValidationFailureV1 | undefined;
    const completion = () => { const destination = request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
      return { ...owner.control, root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
        author: request.writer, run_start_digest: hash(start), destination: { node_id: destination.node_id, workspace_root: profile.workspace_root, profile_id: profile.id, profile_digest: profile.digest },
        initial_subject_digest: request.source.subject_digest, subject_digest: subjectManifest(profile).digest, authorization_event_id: request.authorization.event_id,
        attempt_index: request.authorization.attempt_index, baseline: assertImportedValidationBaseline(baseline), closure: "windows-job-and-tools-closed.v1" as const }; };
    const author = createImportedAuthorExecution({ stage: "validation", adapter, config, profile, signal, assertCurrent, emit,
      markNativeAttempted: () => { owner.nativeAttempted = true; }, prepareFinal: () => { active.phase = "final"; assertCurrent(); },
      verify: () => runImportedValidationVerification(profile, start.verification.request_id, signal, start.context_pack.payload, permit),
      beforeCompleted: evidence => {
        assertCurrent(); author.assertClosed(); assertImportedFinalVerificationBinding(profile, evidence, permit, start.verification.request_id, start.context_pack.payload, "validation");
        active.finalEvidence = evidence; verified = { ...completion(), stage: "validation", scope: "all-declared-workspace-validation-cases", verification: evidence };
        inspectImportedValidationResultV1(request, { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }, source.research, sha);
      },
      beforeFailed: failure => {
        assertCurrent(); author.assertClosed();
        if (failure.kind === "verification-failed") {
          // Only the original failed verifier with a real exit is repairable. All
          // other failures remain generic even when the author itself has closed.
          try { assertImportedValidationFailedVerificationBinding(profile, failure.verification, permit, start.verification.request_id, start.context_pack.payload); }
          catch { return; }
          active.failedEvidence = failure.verification;
        }
        const value = completion(); active.failedSubject = value.subject_digest;
        active.retainedFailure = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: value.subject_digest });
        closedFailure = { ...value, failure_kind: failure.kind, reason: failure.reason.slice(0, 2000),
          ...(failure.kind === "verification-failed" ? { verification: failure.verification } : {}) };
        inspectImportedValidationResultV1(request, { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }, source.research, sha);
      } });
    active.assertAuthorClosed = () => author.assertClosed(); let result: ImportedValidationResultV1;
    try {
      bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
      if (source.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.readReleaseCapabilities);
      bindWorkspaceToolVerifier(config, async previewSignal => {
        assertCurrent(); if (active.previewRequest) fail("Validation preview is already active"); active.previewRequest = "preview-" + randomUUID();
        try { return await runImportedValidationVerificationPreview(profile, active.previewRequest, previewSignal, start.context_pack.payload, permit); }
        finally { active.previewRequest = undefined; }
      });
      Object.freeze(config); await author.run();
      if (!signal.aborted && (verified || closedFailure)) {
        assertCurrent(); author.assertClosed();
        if (subjectManifest(profile).digest !== (verified ?? closedFailure)!.subject_digest) fail("Validation subject changed while awaiting terminal commit");
        if (verified) assertImportedFinalVerificationBinding(profile, active.finalEvidence!, permit, start.verification.request_id, start.context_pack.payload, "validation");
        else if (active.failedEvidence) assertImportedValidationFailedVerificationBinding(profile, active.failedEvidence, permit, start.verification.request_id, start.context_pack.payload);
      }
      result = freezeJson(verified && !signal.aborted ? { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }
        : closedFailure && !signal.aborted ? { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }
          : { ...owner.control, outcome: "failed", closed: true, reason: signal.aborted ? "Validation cancelled" : "Validation did not produce verified completion or a typed closed product failure" });
    } catch (error) { result = freezeJson({ ...owner.control, ...await author.failure(error) }); }
    finally { author.dispose(); }
    if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; validationContexts.delete(start.context_pack.payload); }
    completedValidations.set(result, permit); return result;
  } catch (error) {
    if (!owner.nativeAttempted) return failUnstartedImportedValidation(runtime, permit, error, emit);
    const result: ImportedValidationResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false,
      reason: (error instanceof Error ? error.message : "Validation execution uncertain").slice(0, 2000) || "Validation execution uncertain" });
    completedValidations.set(result, permit); return result;
  }
}
export function persistImportedValidationResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidation, input: ImportedValidationResultV1) {
  const owner = validationOwners.get(permit), result = ImportedValidationResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.validation_id !== owner.control.validation_id || result.request_digest !== owner.control.request_digest
    || result.run_id !== owner.control.run_id || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidations.get(input) !== permit) fail("Validation result differs from its original reservation or process");
  if (owner.active) inspectImportedValidationResultV1(owner.active.request, input, owner.active.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "result", result.validation_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function assertValidationFiles(source: ValidationSourceState, currentSubject: boolean) {
  state(source.runtime); synchronousSession(source.assertSession); assertValidationAncestors(source.ancestors); source.assertClosed();
  assertImportedValidationBaseline(source.baseline);
  if (source.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation persisted history changed");
  if (currentSubject && subjectManifest(source.profile).digest !== source.source.subject_digest) fail("Validation current product subject changed");
}
function readSettledValidation(runtime: PreparedProductSourceRuntime, input: ImportedValidationResultV1): ValidationSourceState {
  const permit = completedValidations.get(input), owner = permit && validationOwners.get(permit), active = owner?.active;
  const value = input.outcome === "finished" ? input.verified_validation : input.outcome === "failed" ? input.closed_failure : undefined;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.assertAuthorClosed || !value
    || validationLineage(runtime, active.request.root_validation_id)?.author !== permit) fail("Original latest persisted validation completion is required");
  const source = inspectImportedValidationSourceV1(active.request.origin, { version: 1, kind: "validation", outcome: input.outcome === "finished" ? "verified" : "closed-failure",
    validation_id: input.validation_id, root_validation_id: active.request.root_validation_id, generation: active.request.generation,
    request_digest: input.request_digest, result_digest: hash(input), origin_digest: value.origin_digest, author: active.request.writer, run_start: active.request.run_start,
    initial_subject_digest: value.initial_subject_digest, subject_digest: value.subject_digest, baseline: value.baseline,
    ...(value.verification ? { verification: value.verification } : {}), ...("failure_kind" in value ? { failure_kind: value.failure_kind, failure_reason: value.reason } : {}) }, active.ancestors.implementation.research, sha);
  const saved: ValidationSourceState = { runtime, permit, original: input, source, profile: active.profile, ancestors: active.ancestors, baseline: active.baseline,
    history: [...active.history, { path: active.claimPath, digest: sha(active.claim) }, { path: validationPath(runtime, "result", input.validation_id), digest: hash(input) }],
    assertSession: active.assertSession, assertClosed: () => {
      synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors);
      active.assertAuthorClosed!();
      if (input.outcome === "finished") {
        if (!active.finalEvidence || canonical(active.finalEvidence) !== canonical(input.verified_validation.verification)) fail("Validation original passed evidence changed");
        assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload, "validation");
      } else {
        if (!active.retainedFailure || active.failedSubject !== value.subject_digest
          || describeProductSourceSnapshot(active.retainedFailure).source.subject_digest !== value.subject_digest) fail("Validation original failed product bytes are unavailable");
        if (source.failure_kind === "verification-failed") {
          if (!active.failedEvidence || canonical(active.failedEvidence) !== canonical(value.verification)) fail("Validation original failed evidence changed");
          assertImportedValidationFailedVerificationBinding(active.profile, active.failedEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload);
        }
      }
      if (Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("Validation author methods changed after closure");
      inspectImportedValidationResultV1(active.request, input, active.ancestors.implementation.research, sha);
    } };
  assertValidationFiles(saved, true); return saved;
}
/** Strict getter for a new continuation or initial receipt; writes must retain separate ancestor liveness. */
export function readCompletedImportedValidation(runtime: PreparedProductSourceRuntime, input: ImportedValidationResultV1) { return readSettledValidation(runtime, input).source; }

function readValidationReviewOwner(permit: PreparedImportedValidationReview) {
  const owner = validationReviewOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation reviewer is required");
  const current = state(owner.runtime), latest = validationLineage(owner.runtime, active.request.source.root_validation_id);
  if (latest?.author !== active.source.permit || latest.review !== permit || current.active.get(active.request.review_start.run_id) !== active.source.profile.workspace_root
    || !consumedValidationSources.has(active.original) || importedValidationReviewRequestDigestV1(active.request, sha) !== owner.control.request_digest
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(validationPath(owner.runtime, "review-request", active.request.review_id)).toString("utf8") !== canonical(active.request))
    fail("Validation review ownership, source, request or adapter changed");
  synchronousSession(active.assertSession); assertValidationFiles(active.source, true); return active;
}
export function readImportedValidationReviewVerificationAdmission(permit: PreparedImportedValidationReview, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, phase: "before" | "after") {
  const active = readValidationReviewOwner(permit), start = phase === "before" ? active.request.before_start : active.request.after_start;
  if (active.phase !== phase || profile !== active.source.profile || context !== start.context_pack.payload || requestId !== start.verification.request_id)
    fail("Validation review verifier differs from its registered phase");
  return { request: active.request, request_digest: importedValidationReviewRequestDigestV1(active.request, sha), phase, start,
    readReleaseCapabilities: active.source.ancestors.implementation.readReleaseCapabilities };
}
export async function runImportedValidationReview(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidationReview,
  original: ImportedValidationResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  retryOriginal?: ImportedValidationReviewResultV1): Promise<ImportedValidationReviewResultV1> {
  const owner = validationReviewOwners.get(permit), current = state(runtime), source = readSettledValidation(runtime, original);
  const request = freezeJson(inspectImportedValidationReviewRequestV1(input, source.ancestors.implementation.research, sha));
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.claimed || owner.settled
    || owner.control.review_id !== request.review_id || owner.control.request_digest !== importedValidationReviewRequestDigestV1(request, sha)
    || canonical(request.source) !== canonical(source.source) || canonical(request.origin) !== canonical(source.ancestors.origin)
    || source.source.outcome !== "verified") fail("Validation review requires the latest original verified author source");
  if (request.retry_of) {
    if (!retryOriginal || consumedFailedValidationReviews.has(retryOriginal)) fail("Validation review retry requires an unused original closed failure");
    const prior = readSettledValidationReview(runtime, retryOriginal);
    if (retryOriginal.outcome !== "failed" || !retryOriginal.closed || !prior.active.retryableFailure || prior.active.original !== original
      || canonical(request.retry_of) !== canonical({ review_id: retryOriginal.review_id, request_digest: retryOriginal.request_digest, result_digest: hash(retryOriginal) })
      || request.authorization.attempt_index <= prior.active.request.authorization.attempt_index
      || request.authorization.event_id === prior.active.request.authorization.event_id
      || [request.before_start, request.review_start, request.after_start].some(start => [prior.active.request.before_start, prior.active.request.review_start, prior.active.request.after_start]
        .some(old => start.run_id === old.run_id || start.context_pack.id === old.context_pack.id || start.verification.request_id === old.verification.request_id)))
      fail("Validation review retry changed its source or reused failed authorization and run identity");
  } else if (retryOriginal || consumedValidationSources.has(original)) fail("Validation source already has an original review");
  const profile = source.profile;
  if (process.platform !== "win32" || !supportsWorkspaceReadOnlyTools(adapter) || adapter.runtimeId !== request.review_start.runtime)
    fail("Validation review requires a native Windows read-only reviewer");
  auditWindowsReleaseStorage(current.store, current.options.storeRoot);
  if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("Validation review destination is occupied");
  const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
  if (Object.values(methods).some(method => typeof method !== "function")) fail("Validation reviewer methods must be stable local functions");
  signal.throwIfAborted(); synchronousSession(assertSession);
  const authorizationPath = validationPath(runtime, "review-authorization", request.authorization.event_id);
  writeExclusive(authorizationPath, canonical(request));
  owner.claimed = true; consumedValidationSources.add(original); if (retryOriginal) consumedFailedValidationReviews.add(retryOriginal);
  const latest = validationLineage(runtime, source.source.root_validation_id); if (!latest || latest.author !== source.permit) fail("Validation author changed before review claim");
  latest.review = permit; const closure = createImportedReviewClosure();
  owner.active = { request, original, source, adapter, methods, assertSession, phase: "before", closure };
  writeExclusive(validationPath(runtime, "review-request", request.review_id), canonical(request)); current.active.set(request.review_start.run_id, profile.workspace_root);
  for (const start of [request.before_start, request.after_start]) validationReviewContexts.set(start.context_pack.payload, permit);
  const base = { ...owner.control, execution_authorized: false as const };
  let handle: AgentInstanceHandle | undefined, admission: WindowsVerifiedExecutionAdmission | undefined, stopWork: Promise<void> | undefined, stopError: unknown;
  const stop = () => { if (handle && !stopWork) stopWork = adapter.stop(handle, "user_cancelled").catch(error => { stopError = error; }); };
  try {
    const assertCurrent = () => { signal.throwIfAborted(); readValidationReviewOwner(permit); };
    assertCurrent(); closure.begin("before-verifier");
    const before = await runImportedValidationReviewVerification(profile, request.before_start.verification.request_id, signal, request.before_start.context_pack.payload, permit, "before");
    closure.confirm("before-verifier"); if (before.outcome !== "passed") fail("Validation review before verification failed");
    assertImportedFinalVerificationBinding(profile, before, permit, request.before_start.verification.request_id, request.before_start.context_pack.payload, "validation-review-before");
    owner.active.before = before; owner.active.phase = "review"; assertCurrent();
    const start = request.review_start, config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const evidence = createImportedValidationReviewEvidence(profile, before, { requestId: request.before_start.verification.request_id,
      subjectDigest: source.source.subject_digest }, source.baseline, () => { assertCurrent(); if (owner.active?.phase !== "review") fail("Validation evidence is only available to its original active reviewer"); });
    bindWorkspaceReadOnlyTools(config, { projectId: profile.project_id, workspaceRoot: profile.workspace_root, assertCurrent,
      source: { profile, subjectDigest: source.source.subject_digest, importedValidationReviewId: request.review_id }, readEvidenceIndex: evidence.readEvidenceIndex });
    bindWorkspaceToolEvidenceReader(config, evidence.read);
    bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
    if (source.ancestors.implementation.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.ancestors.implementation.readReleaseCapabilities);
    Object.freeze(config); admission = bindWindowsVerifiedExecution(adapter, config, profile, signal, assertCurrent);
    closure.begin("reviewer"); handle = await adapter.start(config); signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    let answer: string | undefined, terminal: string | undefined, answers = 0;
    for await (const raw of adapter.streamEvents(handle)) {
      const event = adapterRunEventBodySchema.parse(raw);
      if (event.type === "run.answer") { if (++answers !== 1) fail("Validation reviewer returned multiple answers"); answer = event.payload.text; }
      if (event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase)) {
        if (terminal) fail("Validation reviewer returned multiple terminal events"); terminal = event.payload.phase;
      }
    }
    await stopWork; if (stopError) throw stopError;
    assertWindowsVerifiedExecutionClosed(admission, handle); closure.confirm("reviewer"); owner.active.assertReviewerClosed = () => assertWindowsVerifiedExecutionClosed(admission!, handle!);
    if (terminal !== "completed" || !answer) fail("Validation reviewer did not complete with one substantive product verdict");
    assertCurrent(); const verdict = ImportedValidationReviewVerdictV1Schema.parse(JSON.parse(answer));
    owner.active.phase = "after"; assertCurrent(); closure.begin("after-verifier");
    const after = await runImportedValidationReviewVerification(profile, request.after_start.verification.request_id, signal, request.after_start.context_pack.payload, permit, "after");
    closure.confirm("after-verifier"); if (after.outcome !== "passed") fail("Validation review after verification failed");
    assertImportedFinalVerificationBinding(profile, after, permit, request.after_start.verification.request_id, request.after_start.context_pack.payload, "validation-review-after");
    owner.active.after = after;
    const measured = (start: RunStartPayload, verification: RunVerificationPayload) => ({ run_id: start.run_id, config_digest: hash(start),
      closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-validation-cases" as const, verification });
    const result: ImportedValidationReviewResultV1 = { ...base, outcome: "reviewed", closed: true, before: measured(request.before_start, before), after: measured(request.after_start, after),
      reviewer: { run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1" }, verdict };
    inspectImportedValidationReviewResultV1(request, result, source.ancestors.implementation.research, sha); assertCurrent();
    const frozen = freezeJson(result); completedValidationReviews.set(frozen, permit); return frozen;
  } catch (error) {
    const failed = await finishImportedReviewFailure(closure, error, handle && admission ? async () => {
      if (stopWork) await stopWork; else await adapter.stop(handle!, "shutdown"); if (stopError) throw stopError;
      assertWindowsVerifiedExecutionClosed(admission!, handle!); owner.active!.assertReviewerClosed = () => assertWindowsVerifiedExecutionClosed(admission!, handle!);
    } : undefined);
    owner.active.retryableFailure = failed.closed && !signal.aborted;
    const result = freezeJson({ ...base, ...failed }); completedValidationReviews.set(result, permit); return result;
  } finally {
    signal.removeEventListener("abort", stop);
    if (closure.closed) { current.active.delete(request.review_start.run_id); owner.active.phase = "done";
      for (const start of [request.before_start, request.after_start]) validationReviewContexts.delete(start.context_pack.payload); }
  }
}
export function persistImportedValidationReviewResult(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidationReview, input: ImportedValidationReviewResultV1) {
  const owner = validationReviewOwners.get(permit), result = ImportedValidationReviewResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.review_id !== owner.control.review_id || result.request_digest !== owner.control.request_digest
    || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidationReviews.get(input) !== permit) fail("Validation review result differs from its original operation");
  if (owner.active) inspectImportedValidationReviewResultV1(owner.active.request, result, owner.active.source.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "review-result", result.review_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function readSettledValidationReview(runtime: PreparedProductSourceRuntime, input: ImportedValidationReviewResultV1) {
  const permit = completedValidationReviews.get(input), owner = permit && validationReviewOwners.get(permit), active = owner?.active;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.closure.closed || !input.closed
    || input.outcome !== "reviewed" && input.outcome !== "failed") fail("Original persisted closed validation review is required");
  const latest = validationLineage(runtime, active.source.source.root_validation_id);
  if (latest?.author !== active.source.permit || latest.review !== permit) fail("Validation review is no longer the latest source owner");
  const history = [ { path: validationPath(runtime, "review-request", input.review_id), digest: hash(active.request) },
    { path: validationPath(runtime, "review-result", input.review_id), digest: hash(input) },
    { path: validationPath(runtime, "review-authorization", active.request.authorization.event_id), digest: hash(active.request) } ];
  const assertClosed = () => {
    synchronousSession(active.assertSession); assertValidationFiles(active.source, false);
    if (!active.closure.closed || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("Validation original review closure changed");
    active.assertReviewerClosed?.();
    if (active.before) assertImportedFinalVerificationBinding(active.source.profile, active.before, permit, active.request.before_start.verification.request_id, active.request.before_start.context_pack.payload, "validation-review-before");
    if (active.after) assertImportedFinalVerificationBinding(active.source.profile, active.after, permit, active.request.after_start.verification.request_id, active.request.after_start.context_pack.payload, "validation-review-after");
    if (input.outcome === "reviewed" && (!active.assertReviewerClosed || !active.before || !active.after
      || canonical(input.before.verification) !== canonical(active.before) || canonical(input.after.verification) !== canonical(active.after))) fail("Validation original reviewed phase evidence changed");
  };
  assertClosed(); assertValidationFiles(active.source, true);
  if (history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation review persisted history changed");
  inspectImportedValidationReviewResultV1(active.request, input, active.source.ancestors.implementation.research, sha);
  return { owner, active, history, assertClosed };
}
export function readCompletedImportedValidationReview(runtime: PreparedProductSourceRuntime, input: ImportedValidationReviewResultV1) {
  return readSettledValidationReview(runtime, input).active.request;
}
/** Release requires the original final author verifier; neither review JSON nor a cloned result can mint publication evidence. */
export function readImportedValidationRelease(runtime: PreparedProductSourceRuntime, original: ImportedValidationReviewResultV1, request: ProductReleaseRequest) {
  const reviewed = readSettledValidationReview(runtime, original), source = reviewed.active.source;
  const author = validationOwners.get(source.permit)?.active, release = request.imported_validation;
  if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted" || source.source.outcome !== "verified"
    || !author?.finalEvidence || !release || release.validation_id !== source.source.validation_id
    || release.request_digest !== source.source.request_digest || release.result_digest !== source.source.result_digest
    || release.review_id !== original.review_id || release.review_request_digest !== original.request_digest || release.review_result_digest !== hash(original)
    || release.subject_digest !== source.source.subject_digest || request.subject_digest !== source.source.subject_digest
    || request.run_id !== author.request.run_start.run_id || request.verification_request_id !== author.request.run_start.verification.request_id
    || request.verification_profile_id !== source.profile.id || request.verification_profile_digest !== source.profile.digest
    || request.project_id !== source.profile.project_id || request.goal_id !== author.request.authorization.goal_id) fail("Publication requires exact latest original accepted validation and author verification");
  assertImportedFinalVerificationBinding(source.profile, author.finalEvidence, source.permit, author.request.run_start.verification.request_id,
    author.request.run_start.context_pack.payload, "validation");
  return { profile: source.profile, start: author.request.run_start, verification: author.finalEvidence,
    effectivePlan: source.ancestors.implementation.effectivePlan, readReleaseCapabilities: source.ancestors.implementation.readReleaseCapabilities,
    assertCurrent: () => { readSettledValidationReview(runtime, original); } };
}

declare const validationReleaseBrand: unique symbol;
export interface PreparedImportedValidationRelease { readonly [validationReleaseBrand]: true }
const validationReleases = new WeakMap<PreparedImportedValidationRelease, { runtime: PreparedProductSourceRuntime;
  original: ImportedValidationReviewResultV1; request: ProductReleaseRequest; assertReceipt: () => void;
  retry?: PreparedProductReleaseRetry; predecessor?: PreparedImportedValidationRelease }>();
const validationPublicationClaims = new WeakMap<ImportedValidationReviewResultV1, PreparedImportedValidationRelease>();
/** Each accepted validation has one current immutable attempt; a retry retains its original predecessor permit. */
export function prepareImportedValidationRelease(runtime: PreparedProductSourceRuntime, original: ImportedValidationReviewResultV1,
  request: ProductReleaseRequest, assertReceipt: () => void, retry?: PreparedProductReleaseRetry): PreparedImportedValidationRelease {
  request = ProductReleaseRequestSchema.parse(request);
  synchronousSession(assertReceipt); readImportedValidationRelease(runtime, original, request);
  const prior = validationPublicationClaims.get(original);
  if (prior && canonical(validationReleases.get(prior)!.request) === canonical(request)) { if (retry) readPreparedProductReleaseRetry(retry, request); return prior; }
  if (prior) {
    if (!retry || !request.retry) fail("Accepted validation is already bound to another publication request");
    const previous = validationReleases.get(prior)!, prepared = readPreparedProductReleaseRetry(retry, request);
    if (previous.original !== original || canonical(previous.request) !== canonical(prepared.previousRequest)
      || request.retry.previous_release_id !== previous.request.release_id
      || request.retry.authorization.attempt_index <= readSettledValidationReview(runtime, original).active.request.authorization.attempt_index)
      fail("Validation retry requires the original preceding publication permit and cumulative goal attempt");
  } else if (retry || request.retry) fail("Validation retry cannot replace its missing original publication owner");
  const permit = Object.freeze({}) as PreparedImportedValidationRelease;
  validationReleases.set(permit, { runtime, original, request: freezeJson(structuredClone(request)), assertReceipt,
    ...(retry ? { retry, predecessor: prior! } : {}) }); validationPublicationClaims.set(original, permit);
  return permit;
}
export function readPreparedImportedValidationRelease(permit: PreparedImportedValidationRelease, request?: ProductReleaseRequest, root?: string) {
  const saved = validationReleases.get(permit);
  if (!saved || validationPublicationClaims.get(saved.original) !== permit || request && canonical(request) !== canonical(saved.request)) fail("Original exact validation publication permit is required");
  synchronousSession(saved.assertReceipt);
  if (saved.retry) readPreparedProductReleaseRetry(saved.retry, saved.request);
  const current = readImportedValidationRelease(saved.runtime, saved.original, saved.request);
  if (root && subjectManifest({ ...current.profile, workspace_root: root }).digest !== saved.request.subject_digest) fail("Publication copy differs from the original accepted validation subject");
  return { ...current, request: saved.request };
}
export function claimImportedValidationRelease(runtime: PreparedProductSourceRuntime, permit: PreparedImportedValidationRelease, claimId: string) {
  const saved = validationReleases.get(permit), admitted = readPreparedImportedValidationRelease(permit);
  if (!saved || saved.runtime !== runtime || claimId !== "product-release:" + saved.request.release_id) fail("Validation publication workspace claim changed");
  const current = state(runtime), root = admitted.profile.workspace_root;
  if (current.importing || current.active.has(claimId) || [...current.active.values()].some(path => overlaps(path, root))) fail("Validation publication workspace is occupied");
  current.active.set(claimId, root);
}
