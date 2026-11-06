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
import { createReleaseCapabilityReader, type PreparedReleaseProfile } from "./product-release.js";
import { assertReleaseCapabilityContext, type ReleaseCapabilityReader } from "./release-capability-authority.js";

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
  options: ProductSourceRuntimeOptions; store: ReturnType<typeof prepareWindowsReleaseStorage>; gitStore: ReturnType<typeof prepareWindowsReleaseStorage>;
  fixed: ReturnType<typeof identity>[]; gitChecksum: string; active: Map<string, string>; ownerPath: string; ownerIdentity: ReturnType<typeof identity>;
  importing: boolean; closed: boolean;
  researchStore?: ReturnType<typeof prepareWindowsReleaseStorage>;
  releases: readonly { profile: PreparedReleaseProfile; capabilities: ReleaseCapabilitiesV1; readCapabilities: ReleaseCapabilityReader }[];
}
const runtimes = new WeakMap<PreparedProductSourceRuntime, Runtime>();
function state(token: PreparedProductSourceRuntime) {
  const current = runtimes.get(token); if (!current || current.closed) fail("an original live local runtime is required");
  assertWindowsReleaseStorage(current.store, current.options.storeRoot);
  for (const fixed of current.fixed) sameIdentity(fixed);
  sameIdentity(current.ownerIdentity);
  for (const profile of current.options.profiles) assertLocallyPreparedVerificationProfile(profile);
  for (const release of current.releases) if (!isDeepStrictEqual(release.readCapabilities(), release.capabilities)) fail("prepared release capability changed");
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
  assertWindowsReleaseStorage(current.gitStore, dirname(current.options.gitExecutable));
  if (sha(boundedFile(current.options.gitExecutable, 256 * 1024 * 1024)) !== current.gitChecksum) fail("local Git executable changed");
  const result = await runProtectedCommand({ cwd, args, kind, signal }, { gitExecutable: current.options.gitExecutable,
    readTimeoutMs: 10000, materializeTimeoutMs: 10000, maxOutputBytes: 64 * 1024,
    environment: { PATH: process.env.PATH, LANG: "C.UTF-8" } }, current.options.windowsBackend);
  if (result.status !== 0) fail(`fixed local Git command exited ${result.status}; staging retained`);
  return result.stdout.toString("utf8");
}

/** Explicit native Windows local setup. It never creates or weakens directory ACLs. */
export function prepareProductSourceRuntime(input: ProductSourceRuntimeOptions): PreparedProductSourceRuntime {
  if (process.platform !== "win32" || !input.nodeId || !input.allowedRoots.length || !input.profiles.length) fail("qualified native Windows configuration is required");
  if (input.measurementV2 && (input.measurementV2.version !== 1 || !input.measurementV2.releaseProfiles.length)) fail("explicit versioned local release preparation is required");
  const sourceResearch = input.sourceResearch ? prepareResearchOptions(input.sourceResearch, input.allowedRoots) : undefined;
  const options = Object.freeze({ ...input, ...(sourceResearch ? { sourceResearch } : {}),
    ...(input.destinationResearchMappings ? { destinationResearchMappings: freezeJson(structuredClone(input.destinationResearchMappings)) } : {}),
    ...(input.measurementV2 ? { measurementV2: Object.freeze({ version: 1 as const,
      releaseProfiles: Object.freeze([...input.measurementV2.releaseProfiles]),
      ...(input.measurementV2.destinationResearchMappings ? { destinationResearchMappings: freezeJson(structuredClone(input.measurementV2.destinationResearchMappings)) } : {}) }) } : {}),
    allowedRoots: Object.freeze([...input.allowedRoots]), profiles: Object.freeze([...input.profiles]) });
  prepareVerificationProfiles(options.profiles, options.allowedRoots); // Recheck every program/config/evidence boundary against the full node policy.
  assertWindowsProcessBackend(options.windowsBackend);
  // Preserve original prepared profile identities. Only this trusted factory can
  // install the node reader; the serialized extension remains descriptive data.
  const releases = Object.freeze((options.measurementV2?.releaseProfiles ?? []).map(profile => {
    if (!options.profiles.includes(profile.verifier) || profile.verifier.capabilities?.measurement_plan_policy?.version !== 2) {
      fail("release association requires an original prepared local v2 verifier");
    }
    const readCapabilities = createReleaseCapabilityReader(profile), capabilities = freezeJson(ReleaseCapabilitiesV1Schema.parse(readCapabilities()));
    const binding = capabilities.binding;
    if (binding.release_profile_id !== profile.id || binding.release_profile_digest !== profile.digest || binding.project_id !== profile.project_id
      || binding.workspace_root !== profile.verifier.workspace_root || binding.verification_profile_id !== profile.verifier.id
      || binding.verification_profile_digest !== profile.verifier.digest || binding.contract_digest !== sha(canonicalReleaseCapabilityContract(capabilities.contract))) {
      fail("prepared release association differs from its exact verifier or contract");
    }
    return Object.freeze({ profile, readCapabilities, capabilities });
  }));
  if (new Set(releases.map(release => release.profile.verifier)).size !== releases.length) fail("research release associations are ambiguous");
  const store = prepareWindowsReleaseStorage({ directory: options.storeRoot, writableWorkspaceRoots: options.allowedRoots });
  const gitStore = prepareWindowsReleaseStorage({ directory: dirname(options.gitExecutable), writableWorkspaceRoots: options.allowedRoots });
  if (sourceResearch && options.profiles.some(profile => profile.capabilities?.measurement_plan_policy?.version !== 1
    && !releases.some(release => release.profile.verifier === profile))) {
    fail("first-hop research exports require local v1 profiles or explicit prepared v2 release associations");
  }
  const researchStore = sourceResearch ? prepareWindowsReleaseStorage({ directory: sourceResearch.receiptDirectory,
    writableWorkspaceRoots: options.allowedRoots }) : undefined;
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
  for (const directory of ["operations", "attestations", "artifacts"]) {
    const path = join(options.storeRoot, directory); if (!existsSync(path)) mkdirSync(path, { mode: 0o700 }); fixed.push(identity(path));
  }
  const storeBinding = canonical({ version: 1, node_id: options.nodeId, directory: identity(options.storeRoot) });
  const storeBindingPath = join(options.storeRoot, "attestations", "store.json");
  if (existsSync(storeBindingPath)) { if (boundedFile(storeBindingPath).toString("utf8") !== storeBinding) fail("source store belongs to another node or physical directory"); }
  else writeExclusive(storeBindingPath, storeBinding);
  const ownerPath = join(options.storeRoot, "operations", "owner.lock");
  // Never infer that a crashed owner's writer is gone from a PID, timestamp or lease age.
  writeExclusive(ownerPath, canonical({ version: 1, node_id: options.nodeId, nonce: randomUUID() }));
  const ownerIdentity = identity(ownerPath), token = Object.freeze({}) as PreparedProductSourceRuntime;
  const current: Runtime = { options, store, gitStore, fixed, gitChecksum: sha(boundedFile(options.gitExecutable, 256 * 1024 * 1024)), active: new Map(),
    ownerPath, ownerIdentity, importing: false, closed: false, researchStore, releases };
  runtimes.set(token, current);
  try { auditWindowsReleaseStorage(store, options.storeRoot); retainedDestinations(current); }
  catch (error) { current.closed = true; throw error; } // A failed setup retains the ownership fence.
  return token;
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
    measurementV2: current.researchStore !== undefined && current.releases.length > 0 || v2.length > 0,
    importedReview: v1.length > 0 || v2.length > 0, importedDesign: v2.length > 0 });
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
  return freezeJson(proof);
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
    await fixedGit(current, staging, ["-c", "init.templateDir=", "init", "--initial-branch=main", "."], "materialize", signal);
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
  if (current.importing || current.active.size || retainedImportedDesigns.get(token)?.size) fail("live or uncertain work still owns the source runtime");
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
    signal.throwIfAborted();readImportedProductReview(permit,runtime);closure.begin("before-verifier");
    const before=await verifyProductSourceSemanticTransfer(runtime,completed.authenticated,request.before_start,signal,permit);closure.confirm("before-verifier");
    if(before.verification.outcome!=="passed")fail("Imported review pre-verification failed");
    const beforeMeasurement={admission:readCompletedProductSourceAdmission(runtime,before),fresh:before};
    signal.throwIfAborted();owner.active.phase="review";readImportedProductReview(permit,runtime);
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
    owner.active.phase="after";closure.begin("after-verifier");
    const after=await verifyProductSourceSemanticTransfer(runtime,completed.authenticated,request.after_start,signal,permit);closure.confirm("after-verifier");
    if(after.verification.outcome!=="passed")fail("Imported review post-verification failed");
    const result:ImportedProductReviewResultV1={...base,outcome:"reviewed",closed:true,before:beforeMeasurement,
      after:{admission:readCompletedProductSourceAdmission(runtime,after),fresh:after},
      reviewer:{run_id:start.run_id,config_digest:sha(canonical(start)),closure:"windows-job-and-tools-closed.v1"},verdict};
    inspectImportedProductReviewResultV1(request,result,readProductFile(profile.workspace_root,".artoo/product/research.json"),sha);
    signal.throwIfAborted();readImportedProductReview(permit,runtime);
    const frozen=freezeJson(result);completedImportedReviews.set(frozen,{runtime,permit,request});return frozen;
  }catch(error){
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
import { bindWorkspaceToolVerifier } from "./workspace-tools.js";

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
    previewRequest?: string };
}
const importedDesignOwners = new WeakMap<PreparedImportedDesignContinuation, ImportedDesignOwner>();
const importedDesignContexts = new WeakMap<ContextPack, PreparedImportedDesignContinuation>();
const consumedImportedReviews = new WeakSet<ImportedProductReviewResultV1>();
const completedImportedDesigns = new WeakMap<ImportedDesignContinuationResultV1, PreparedImportedDesignContinuation>();
const retainedImportedDesigns = new WeakMap<PreparedProductSourceRuntime, Set<PreparedImportedDesignContinuation>>();

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
  let handle: AgentInstanceHandle | undefined, admission: WindowsVerifiedExecutionAdmission | undefined;
  let pending: "author" | "verifier" | undefined, stopWork: Promise<void> | undefined, stopError: unknown, deliveryUncertain = false;
  const stop = () => { if (handle && !stopWork) stopWork = adapter.stop(handle, "user_cancelled").catch(error => { stopError = error; }); };
  const send = async (event: ImportedDesignEvent) => { try { await emit(event); } catch (error) { deliveryUncertain = true; throw error; } };
  let result: ImportedDesignContinuationResultV1;
  try {
    const assertCurrent = () => { signal.throwIfAborted(); readImportedDesignOwner(permit); };
    bindWorkspaceToolCapabilities(config, () => { assertCurrent(); if (!profile.capabilities) fail("Imported-design capabilities are unavailable"); return { ...profile.capabilities, profile_id: profile.id }; });
    if (release) bindWorkspaceToolReleaseCapabilities(config, release.readCapabilities);
    bindWorkspaceToolVerifier(config, async previewSignal => {
      assertCurrent(); if (active.previewRequest) fail("Imported-design preview is already active");
      const requestId = "preview-" + randomUUID(); active.previewRequest = requestId;
      try { return await runTransferredDesignVerificationPreview(profile, requestId, previewSignal, start.context_pack.payload, permit); }
      finally { active.previewRequest = undefined; }
    });
    Object.freeze(config); admission = bindWindowsVerifiedExecution(adapter, config, profile, signal, assertCurrent);
    pending = "author"; owner.nativeAttempted = true; handle = await adapter.start(config);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    let terminal = false;
    for await (const yielded of adapter.streamEvents(handle)) {
      const event = adapterRunEventBodySchema.parse(yielded);
      if (event.type === "run.lifecycle" && ["completed", "failed", "cancelled"].includes(event.payload.phase)) {
        await stopWork; if (stopError) throw stopError;
        assertWindowsVerifiedExecutionClosed(admission, handle); pending = undefined;
        if (event.payload.phase === "completed" && !signal.aborted) {
          active.phase = "final"; readImportedDesignOwner(permit); pending = "verifier";
          const evidence = await runTransferredDesignVerification(profile, start.verification!.request_id, signal, start.context_pack.payload, permit);
          pending = undefined;
          await send({ type: "run.verification", payload: evidence });
        }
        if (signal.aborted) event.payload = { phase: "cancelled", reason: "user_cancelled" };
        await send(event); terminal = true; break;
      }
      await send(event);
    }
    if (!terminal) fail("Imported-design writer did not emit a terminal lifecycle");
    result = freezeJson({ ...base, outcome: "finished", closed: true });
  } catch (error) {
    let reason = error instanceof Error ? error.message : "Imported-design execution failed";
    // Never reuse author closure to confirm an uncertain final verifier.
    if (pending === "author" && handle && admission) {
      try { if (stopWork) await stopWork; else await adapter.stop(handle, "shutdown"); if (stopError) throw stopError;
        assertWindowsVerifiedExecutionClosed(admission, handle); pending = undefined; }
      catch (closureError) { reason += "; author closure unconfirmed: " + (closureError instanceof Error ? closureError.message : String(closureError)); }
    }
    if (!pending && !deliveryUncertain) {
      try { await send({ type: "run.lifecycle", payload: { phase: "failed", reason: reason.slice(0, 2000) } }); }
      catch { /* The original delivery failure remains fenced below. */ }
    }
    result = freezeJson(pending || deliveryUncertain ? { ...base, outcome: "uncertain", closed: false, reason: reason.slice(0, 2000) || "Imported-design closure is uncertain" }
      : { ...base, outcome: "failed", closed: true, reason: reason.slice(0, 2000) || "Imported-design execution failed" });
  } finally { signal.removeEventListener("abort", stop); }
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
  writeExclusive(join(current.options.storeRoot, "attestations", "imported-design-result-" + key(result.continuation_id) + ".json"), canonical(result));
  owner.settled = true; if (result.closed) retainedImportedDesigns.get(runtime)?.delete(permit);
}
