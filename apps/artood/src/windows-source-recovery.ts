import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalProductSourceTransferValueV1 as canonical, inspectProductSourceRecoveryRequestV1, inspectProductSourceRecoveryResultV1,
  ProductSourceRecoveryCheckpointV1Schema, productSourceRecoveryRequestDigestV1, productSourceRecoveryCheckpointDigestV1,
  importedExecutionAcceptedInputsV1, inspectProductSourceVerificationEnvelope,
  type ProductSourceRecoveryRequestV1, type ProductSourceRecoveryCheckpointV1, type ProductSourceRecoveryResultV1,
  type ImportedValidationOriginV1, type ProductResearchReport, type ProductReleaseRequest,
} from "@artoo/domain";
import { assertLocallyPreparedVerificationProfile, subjectManifest, type PreparedVerificationProfile } from "./verification.js";
import { readProductFile, assertAcceptedProductInputs } from "./product-stage.js";
import { retainImportedValidationBaseline, assertImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage } from "./windows-release-storage.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareGuardianProductSourceRuntime, readGuardianProductSourceConfiguration, readCleanGuardianProductSourceConfiguration,
  type ProductSourceRuntimeOptions, type PreparedProductSourceRuntime } from "./product-source-runtime.js";
import { readWindowsGuardianLocalRuntime, consumeWindowsRecoveryFence,
  type PreparedWindowsGuardian, type WindowsRecoveryFence, type WindowsGuardianLocalConfiguration } from "./owned/windows-runtime-guardian.js";
import { withWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";
import { physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { prepareReleaseCapabilityReader } from "./product-release.js";
import type { ReleaseCapabilityReader } from "./release-capability-authority.js";
import { ImportedRecoveryValidationControlV1Schema, ImportedRecoveryValidationRequestV1Schema, ImportedRecoveryValidationResultV1Schema,
  ImportedRecoveryValidationReviewControlV1Schema, ImportedRecoveryValidationReviewResultV1Schema, ImportedValidationReviewVerdictV1Schema,
  inspectImportedRecoveryValidationRequestV1, inspectImportedRecoveryValidationResultV1, inspectImportedRecoveryValidationCompletionV1,
  inspectImportedRecoveryValidationReviewRequestV1, inspectImportedRecoveryValidationReviewResultV1,
  importedRecoveryValidationRequestDigestV1, importedRecoveryValidationReviewRequestDigestV1, importedValidationOriginDigestV1,
  ProductReleaseRequestSchema, ProductResearchReportSchema,
  type ImportedRecoveryValidationControlV1, type ImportedRecoveryValidationRequestV1, type ImportedRecoveryValidationResultV1,
  type ImportedRecoveryValidationSourceV1, type ImportedRecoveryValidationReviewControlV1, type ImportedRecoveryValidationReviewRequestV1,
  type ImportedRecoveryValidationReviewResultV1, type ImportedRecoveryCompletedValidationV1, type ImportedRecoveryClosedValidationFailureV1,
  type ContextPack, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import { adapterRunEventBodySchema, type AgentInstanceConfig, type AgentInstanceHandle, type RuntimeAdapter, type RunEventMessage } from "@artoo/protocol";
import { selectVerificationProfile, assertImportedValidationVerificationProfile, assertImportedFinalVerificationBinding,
  assertImportedRecoveryValidationFailedVerificationBinding, runImportedRecoveryValidationVerification,
  runImportedRecoveryValidationVerificationPreview, runImportedRecoveryValidationReviewVerification } from "./verification.js";
import { captureProductSourceSnapshot, describeProductSourceSnapshot } from "./product-source-snapshot.js";
import { auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { bindWorkspaceReadOnlyTools } from "./workspace-readonly.js";
import { bindWorkspaceToolCapabilities, bindWorkspaceToolReleaseCapabilities, bindWorkspaceToolVerifier, bindWorkspaceToolEvidenceReader } from "./workspace-tools.js";
import { bindWindowsVerifiedExecution, assertWindowsVerifiedExecutionClosed, supportsWorkspaceReadOnlyTools, type WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import { createImportedAuthorExecution } from "./imported-author-execution.js";
import { createImportedReviewClosure, finishImportedReviewFailure } from "./imported-review-closure.js";
import { createImportedValidationReviewEvidence } from "./imported-validation-review-evidence.js";
import { readPreparedProductReleaseRetry, type PreparedProductReleaseRetry } from "./product-release.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { readWindowsDaemonSupervisorAuthority, type PreparedWindowsDaemonSupervisorAuthority } from "./windows-supervisor-authority.js";
import { readCleanDaemonGuardian } from "./windows-clean-local-configuration.js";

type ImportedDesignEvent = RunEventMessage["event"];
const freezeJson = immutable, key = (value: string) => sha(value).slice(7), overlaps = windowsPathsOverlap;
function boundedFile(path: string, maximum = 12 * 1024 * 1024): Buffer {
  const identity = fileIdentity(path), stat = lstatSync(path);
  if (identity.directory || stat.nlink !== 1 || stat.size > maximum) fail("persisted state exceeds physical file bounds");
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size || canonical(fileIdentity(path)) !== canonical(identity)) fail("persisted state changed during read");
  return bytes;
}
function writeExclusive(path: string, bytes: string): void {
  const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function synchronousSession(check: () => void): void {
  const result: unknown = check(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); fail("session assertion must be synchronous"); }
}
function initialSubject(request: ImportedRecoveryValidationRequestV1) { return request.previous_source?.subject_digest ?? request.checkpoint.subject_digest; }
interface ImplementationSourceState { runtime: PreparedWindowsSourceRecoveryRuntime; workspace: PreparedRecoveredWorkspace;
  profile: PreparedVerificationProfile; research: Buffer; design: Buffer; effectivePlan: ProductResearchReport["measurement_plan"];
  readReleaseCapabilities?: ReleaseCapabilityReader }
function assertImplementationFiles(source: ImplementationSourceState, _completeSubject: boolean): void {
  const current = runtimeState(source.runtime), checkpoint = recovered.get(source.workspace);
  if (!checkpoint || current.current !== source.workspace || current.epochId !== checkpoint.epochId) fail("recovery source lost its current checkpoint");
  readRecoveredWorkspaceResult(source.workspace);
  if (!readProductFile(source.profile.workspace_root, ".artoo/product/research.json").equals(source.research)
    || !readProductFile(source.profile.workspace_root, ".artoo/product/design.json").equals(source.design)) fail("accepted recovery inputs changed");
}
function state(runtime: PreparedWindowsSourceRecoveryRuntime) {
  const current = runtimeState(runtime), source = readGuardianProductSourceConfiguration(current.source, current.guardian);
  return { ...current, ...source };
}

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
function fail(reason: string): never { throw new Error(`Windows source recovery: ${reason}`); }
function immutable<T>(value: T): T { const result = structuredClone(value); const freeze = (item: unknown): void => {
  if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
}; freeze(result); return result; }
function writeOnce(path: string, value: unknown): void {
  const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
function fileIdentity(path: string) {
  const stat = lstatSync(path); if (stat.isSymbolicLink() || realpathSync.native(path) !== path) fail("fixed path is linked or aliased");
  return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
}
declare const configurationBrand: unique symbol, runtimeBrand: unique symbol, recoveredBrand: unique symbol;
export interface PreparedWindowsSourceRecoveryConfiguration { readonly [configurationBrand]: true }
export interface PreparedWindowsSourceRecoveryRuntime { readonly [runtimeBrand]: true }
export interface PreparedRecoveredWorkspace { readonly [recoveredBrand]: true }
interface Configuration {
  source: ProductSourceRuntimeOptions; workspaceRoot: string; controlDirectory: string; deviceId: string;
  storage: ReturnType<typeof prepareWindowsReleaseStorage>; controlStorage: ReturnType<typeof prepareWindowsReleaseStorage>;
  configurationDigest: string; identities: ReturnType<typeof fileIdentity>[]; gitDigest: string;
  supervisor: PreparedWindowsDaemonSupervisorAuthority;
}
interface RecoveryRuntime { configuration: PreparedWindowsSourceRecoveryConfiguration; guardian: PreparedWindowsGuardian;
  source: PreparedProductSourceRuntime; epochId: string; current?: PreparedRecoveredWorkspace }
interface RecoveredWorkspace {
  configuration: PreparedWindowsSourceRecoveryConfiguration; guardian: PreparedWindowsGuardian; epochId: string;
  request: ProductSourceRecoveryRequestV1; checkpoint: ProductSourceRecoveryCheckpointV1; result: ProductSourceRecoveryResultV1;
  profile: PreparedVerificationProfile; research: Buffer; design: Buffer; effectivePlan: ProductResearchReport["measurement_plan"];
  baseline: PreparedValidationBaseline; requestPath: string; resultPath: string; consumed: boolean;
}
const configurations = new WeakMap<object, Configuration>(), runtimes = new WeakMap<object, RecoveryRuntime>();
const recovered = new WeakMap<object, RecoveredWorkspace>();

/** Runs before a guardian/backend is activated. Node-local configuration is qualified
 * once as original objects; wire metadata cannot install programs or profiles. */
export function prepareWindowsSourceRecoveryConfiguration(input: { version: 1; source: ProductSourceRuntimeOptions;
  workspaceRoot: string; controlDirectory: string; deviceId: string; supervisor: PreparedWindowsDaemonSupervisorAuthority }): PreparedWindowsSourceRecoveryConfiguration {
  if (process.platform !== "win32" || input.version !== 1 || !input.deviceId || input.deviceId.length > 128) fail("native Windows local configuration required");
  const source: ProductSourceRuntimeOptions = Object.freeze({ ...input.source,
    allowedRoots: Object.freeze([...input.source.allowedRoots]), profiles: Object.freeze([...input.source.profiles]),
    ...(input.source.sourceResearch ? { sourceResearch: immutable(input.source.sourceResearch) } : {}),
    ...(input.source.destinationResearchMappings ? { destinationResearchMappings: immutable(input.source.destinationResearchMappings) } : {}),
    ...(input.source.measurementV2 ? { measurementV2: Object.freeze({ ...input.source.measurementV2,
      releaseProfiles: Object.freeze([...input.source.measurementV2.releaseProfiles]),
      ...(input.source.measurementV2.destinationResearchMappings ? { destinationResearchMappings: immutable(input.source.measurementV2.destinationResearchMappings) } : {}) }) } : {}) });
  const workspaceRoot = physicalWindowsDirectory(input.workspaceRoot), controlDirectory = physicalWindowsDirectory(input.controlDirectory);
  const supervisor = readWindowsDaemonSupervisorAuthority(input.supervisor, source.windowsBackend);
  if (source.storeRoot !== physicalWindowsDirectory(source.storeRoot) || !source.profiles.some(profile => profile.workspace_root === workspaceRoot)
    || source.allowedRoots.some(root => windowsPathsOverlap(controlDirectory, root)) || windowsPathsOverlap(controlDirectory, source.storeRoot))
    fail("source, control store and fixed workspace boundaries differ");
  for (const profile of source.profiles) assertLocallyPreparedVerificationProfile(profile);
  const installation = describeWindowsProcessInstallation(source.windowsBackend);
  const storage = prepareWindowsReleaseStorage({ directory: source.storeRoot, writableWorkspaceRoots: source.allowedRoots });
  const controlStorage = prepareWindowsReleaseStorage({ directory: controlDirectory, writableWorkspaceRoots: source.allowedRoots });
  const gitDigest = sha(readFileSync(source.gitExecutable));
  const configurationDigest = hash({ version: 1, nodeId: source.nodeId, deviceId: input.deviceId, storeRoot: source.storeRoot,
    controlDirectory, workspaceRoot, allowedRoots: [...source.allowedRoots].sort(), installation, supervisorLaunchIdentityDigest: supervisor.launchIdentityDigest,
    profiles: source.profiles.map(profile => ({ id: profile.id, projectId: profile.project_id, workspaceRoot: profile.workspace_root, digest: profile.digest })),
    git: { path: source.gitExecutable, digest: gitDigest }, mappings: source.destinationResearchMappings ?? [],
    measurementMappings: source.measurementV2?.destinationResearchMappings ?? [],
    releases: source.measurementV2?.releaseProfiles.map(profile => ({ id: profile.id, digest: profile.digest, capabilities: prepareReleaseCapabilityReader(profile).capabilities })) ?? [] });
  const token = Object.freeze({}) as PreparedWindowsSourceRecoveryConfiguration;
  configurations.set(token, { source, workspaceRoot, controlDirectory, deviceId: input.deviceId, storage, controlStorage, configurationDigest,
    identities: [source.storeRoot, controlDirectory, workspaceRoot, ...source.allowedRoots].map(fileIdentity), gitDigest, supervisor: input.supervisor }); return token;
}
function configuration(token: PreparedWindowsSourceRecoveryConfiguration): Configuration {
  const saved = configurations.get(token); if (!saved) fail("original prepared recovery configuration required");
  readWindowsDaemonSupervisorAuthority(saved.supervisor, saved.source.windowsBackend);
  if (saved.identities.some(identity => canonical(fileIdentity(identity.path)) !== canonical(identity)) || sha(readFileSync(saved.source.gitExecutable)) !== saved.gitDigest)
    fail("fixed physical configuration or Git program changed");
  assertWindowsReleaseStorage(saved.storage, saved.source.storeRoot); assertWindowsReleaseStorage(saved.controlStorage, saved.controlDirectory);
  saved.source.profiles.forEach(assertLocallyPreparedVerificationProfile); return saved;
}
export function windowsGuardianConfiguration(token: PreparedWindowsSourceRecoveryConfiguration, sessionId: string): WindowsGuardianLocalConfiguration {
  const saved = configuration(token);
  return { nodeId: saved.source.nodeId, deviceId: saved.deviceId, sessionId, configurationDigest: saved.configurationDigest,
    storeDirectory: saved.source.storeRoot, workspaceRoot: saved.workspaceRoot, storage: saved.storage,
    controlDirectory: saved.controlDirectory, controlStorage: saved.controlStorage, topology: "supervisor-plain-daemon.v1",
    supervisor: saved.supervisor };
}
export function recoveryConfigurationBackend(token: PreparedWindowsSourceRecoveryConfiguration) { return configuration(token).source.windowsBackend; }

/** Initial or recovered current epoch. The guardian already owns operations/owner.lock;
 * no stale file, constructor option or JSON checkpoint can substitute for its object. */
export function prepareWindowsSourceRecoveryRuntime(token: PreparedWindowsSourceRecoveryConfiguration,
  guardian: PreparedWindowsGuardian, workspace?: PreparedRecoveredWorkspace): PreparedWindowsSourceRecoveryRuntime {
  const saved = configuration(token), live = readWindowsGuardianLocalRuntime(guardian), original = workspace && recovered.get(workspace);
  if (live.mode !== "active" || live.local.configurationDigest !== saved.configurationDigest || live.backend !== saved.source.windowsBackend
    || workspace && (!original || original.guardian !== guardian || original.configuration !== token || original.epochId !== live.epoch.epoch_id))
    fail("runtime requires the current registered guardian and original recovered workspace");
  const source = withWindowsGuardianOperation(guardian, { operationId: "lifecycle-" + hash(live.epoch).slice(7),
    bindingDigest: hash({ configuration: saved.configurationDigest, epoch: live.epoch }), serverOperation: null },
  () => prepareGuardianProductSourceRuntime(saved.source, guardian));
  const runtime = Object.freeze({}) as PreparedWindowsSourceRecoveryRuntime;
  runtimes.set(runtime, { configuration: token, guardian, source, epochId: live.epoch.epoch_id, ...(workspace ? { current: workspace } : {}) }); return runtime;
}
export function readWindowsRecoverySourceRuntime(runtime: PreparedWindowsSourceRecoveryRuntime): PreparedProductSourceRuntime { return runtimeState(runtime).source; }
/** Configuration identity only, including a quarantined clean successor. This
 * grants no ordinary workspace admission and cannot construct a source runtime. */
export function assertWindowsSourceRuntimeConfiguration(runtime: PreparedWindowsSourceRecoveryRuntime, nodeId: string,
  allowedRoots: readonly string[], profiles: readonly PreparedVerificationProfile[]): void {
  const saved = runtimeState(runtime), clean = readCleanDaemonGuardian(saved.guardian);
  const local = clean ? readCleanGuardianProductSourceConfiguration(saved.source, saved.guardian, clean)
    : readGuardianProductSourceConfiguration(saved.source, saved.guardian);
  if (local.options.nodeId !== nodeId || canonical([...allowedRoots].sort()) !== canonical([...local.options.allowedRoots].sort())
    || profiles.length !== local.options.profiles.length || profiles.some(profile => !local.options.profiles.includes(profile)))
    fail("Source discovery changed its exact current native configuration or profiles");
}
function runtimeState(runtime: PreparedWindowsSourceRecoveryRuntime): RecoveryRuntime {
  const saved = runtimes.get(runtime); if (!saved) fail("original current recovery runtime required");
  const live = readWindowsGuardianLocalRuntime(saved.guardian);
  if (live.mode !== "active" || live.epoch.epoch_id !== saved.epochId) fail("recovery runtime belongs to another epoch");
  configuration(saved.configuration);
  const clean = readCleanDaemonGuardian(saved.guardian);
  if (clean) readCleanGuardianProductSourceConfiguration(saved.source, saved.guardian, clean);
  else readGuardianProductSourceConfiguration(saved.source, saved.guardian);
  return saved;
}

/** Uses the genuine live native fence once, then captures current bytes as UNVERIFIED.
 * No process is spawned between transfer and checkpoint creation. Full future execution
 * audits happen after the new epoch's independent Server registration ACK. */
export function prepareRecoveredWorkspace(token: PreparedWindowsSourceRecoveryConfiguration, guardian: PreparedWindowsGuardian,
  fence: WindowsRecoveryFence, input: unknown): PreparedRecoveredWorkspace {
  const saved = configuration(token), live = readWindowsGuardianLocalRuntime(guardian);
  const research = readProductFile(saved.workspaceRoot, ".artoo/product/research.json"), design = readProductFile(saved.workspaceRoot, ".artoo/product/design.json");
  const request = immutable(inspectProductSourceRecoveryRequestV1(input, research, sha));
  if (request.binding.configuration_digest !== saved.configurationDigest || request.binding.workspace_root !== saved.workspaceRoot
    || request.current_session_id !== live.local.sessionId) fail("recovery request changed current configuration");
  const verification = request.origin.execution_request.run_start.verification;
  if (!verification?.capability_binding) fail("accepted H6 verification profile binding is required");
  const profile = saved.source.profiles.find(profile => profile.workspace_root === saved.workspaceRoot
    && profile.id === verification.profile_id);
  if (!profile || profile.digest !== verification.capability_binding.profile_digest) fail("accepted H6 profile no longer matches local configuration");
  const acceptedInputs = importedExecutionAcceptedInputsV1(request.origin.execution_request);
  for (const pin of acceptedInputs.files) {
    const bytes = pin.path === ".artoo/product/research.json" ? research : pin.path === ".artoo/product/design.json" ? design : undefined;
    if (!bytes || bytes.length !== pin.size || sha(bytes) !== pin.checksum) fail("accepted research/design pins changed during interruption");
  }
  const prior = request.origin.execution_request.review_request.continuation_request.review_result;
  if (prior.outcome !== "reviewed") fail("original accepted research mapping is missing");
  const effectivePlan = inspectProductSourceVerificationEnvelope(prior.after.admission, research, sha).effective_plan;
  const facts = consumeWindowsRecoveryFence(guardian, fence);
  if (facts.requestDigest !== productSourceRecoveryRequestDigestV1(request, sha) || facts.newEpochId !== live.epoch.epoch_id) fail("native fence differs from exact recovery request");
  const measured = subjectManifest(profile);
  const assertSnapshot = () => { configuration(token);
    if (readWindowsGuardianLocalRuntime(guardian).epoch.epoch_id !== facts.newEpochId || subjectManifest(profile).digest !== measured.digest)
      fail("current interrupted workspace changed during checkpoint capture"); };
  const baseline = retainImportedValidationBaseline(profile, saved.source.storeRoot, "recovery-" + request.recovery_id, measured.digest, assertSnapshot);
  const checkpoint = immutable(ProductSourceRecoveryCheckpointV1Schema.parse({ version: 1, recovery_id: request.recovery_id,
    request_digest: facts.requestDigest, binding: request.binding, old_epoch_id: facts.oldEpochId, new_epoch_id: facts.newEpochId,
    generation: facts.generation, current_session_id: facts.currentSessionId, new_daemon_identity_digest: facts.newDaemonIdentityDigest,
    challenge_id: facts.challengeId, roster_revision: facts.rosterRevision, roster_digest: facts.rosterDigest,
    closure_set_digest: facts.closureSetDigest, operations: request.operations, subject_digest: measured.digest,
    baseline: assertImportedValidationBaseline(baseline), accepted_inputs: acceptedInputs, source_state: "unverified" }));
  const result = immutable(inspectProductSourceRecoveryResultV1(request, { version: 1, recovery_id: request.recovery_id,
    request_digest: productSourceRecoveryRequestDigestV1(request, sha), outcome: "recovered", closed: true, checkpoint }, sha));
  const requestPath = join(saved.source.storeRoot, "attestations", "recovery-request-" + sha(request.recovery_id).slice(7) + ".json");
  const resultPath = join(saved.source.storeRoot, "attestations", "recovery-result-" + sha(request.recovery_id).slice(7) + ".json");
  assertSnapshot(); writeOnce(requestPath, request); writeOnce(resultPath, result); assertSnapshot();
  const prepared = Object.freeze({}) as PreparedRecoveredWorkspace;
  recovered.set(prepared, { configuration: token, guardian, epochId: live.epoch.epoch_id, request, checkpoint, result, profile,
    research: Buffer.from(research), design: Buffer.from(design), effectivePlan, baseline, requestPath, resultPath, consumed: false }); return prepared;
}
export function readRecoveredWorkspaceResult(workspace: PreparedRecoveredWorkspace): ProductSourceRecoveryResultV1 {
  const saved = recovered.get(workspace); if (!saved) fail("original captured recovered workspace required");
  configuration(saved.configuration); assertImportedValidationBaseline(saved.baseline);
  if (sha(readFileSync(saved.requestPath)) !== hash(saved.request) || sha(readFileSync(saved.resultPath)) !== hash(saved.result)) fail("persisted recovery facts changed");
  return saved.result;
}

declare const validationBrand: unique symbol, validationReviewBrand: unique symbol;
export interface PreparedImportedRecoveryValidation { readonly [validationBrand]: true }
export interface PreparedImportedRecoveryValidationReview { readonly [validationReviewBrand]: true }
type ValidationPredecessor = PreparedRecoveredWorkspace | ImportedRecoveryValidationResultV1 | ImportedRecoveryValidationReviewResultV1;
interface ValidationAncestors {
  implementation: ImplementationSourceState; origin: ImportedValidationOriginV1; history: readonly { path: string; digest: string }[];
  assertClosed: () => void; assertSession: () => void;
}
interface ValidationAuthorOwner {
  runtime: PreparedWindowsSourceRecoveryRuntime; control: ImportedRecoveryValidationControlV1; action: "start" | "stop";
  claimed: boolean; executed: boolean; nativeAttempted: boolean; settled: boolean;
  active?: { request: ImportedRecoveryValidationRequestV1; original: ValidationPredecessor; ancestors: ValidationAncestors;
    baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile; config: AgentInstanceConfig; adapter: RuntimeAdapter;
    methods: Record<string, unknown>; assertSession: () => void; claimPath: string; claim: string; history: readonly { path: string; digest: string }[];
    phase: "author" | "final" | "done"; previewRequest?: string; finalEvidence?: RunVerificationPayload; failedEvidence?: RunVerificationPayload;
    assertAuthorClosed?: () => void; failedSubject?: string; retainedFailure?: ReturnType<typeof captureProductSourceSnapshot> };
}
interface ValidationSourceState {
  runtime: PreparedWindowsSourceRecoveryRuntime; permit: PreparedImportedRecoveryValidation; original: ImportedRecoveryValidationResultV1; source: ImportedRecoveryValidationSourceV1;
  ancestors: ValidationAncestors; baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile;
  history: readonly { path: string; digest: string }[]; assertClosed: () => void; assertSession: () => void;
}
interface ValidationReviewOwner {
  runtime: PreparedWindowsSourceRecoveryRuntime; control: ImportedRecoveryValidationReviewControlV1; action: "start" | "stop"; claimed: boolean; settled: boolean;
  active?: { request: ImportedRecoveryValidationReviewRequestV1; original: ImportedRecoveryValidationResultV1; source: ValidationSourceState;
    adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void; phase: "before" | "review" | "after" | "done";
    before?: RunVerificationPayload; after?: RunVerificationPayload; assertReviewerClosed?: () => void; retryableFailure?: boolean; closure: ReturnType<typeof createImportedReviewClosure> };
}
const validationOwners = new WeakMap<PreparedImportedRecoveryValidation, ValidationAuthorOwner>();
const validationReviewOwners = new WeakMap<PreparedImportedRecoveryValidationReview, ValidationReviewOwner>();
const validationContexts = new WeakMap<ContextPack, PreparedImportedRecoveryValidation>(), validationReviewContexts = new WeakMap<ContextPack, PreparedImportedRecoveryValidationReview>();
const recoveryExecutionConfigs = new WeakMap<AgentInstanceConfig, { runtime: PreparedWindowsSourceRecoveryRuntime;
  author?: PreparedImportedRecoveryValidation; review?: PreparedImportedRecoveryValidationReview }>();
export function assertWindowsRecoveryExecutionConfiguration(config: AgentInstanceConfig, backend: PreparedWindowsProcessBackend): void {
  const saved = recoveryExecutionConfigs.get(config); if (!saved) fail("Original recovery execution config required");
  const runtime = runtimeState(saved.runtime), live = readWindowsGuardianLocalRuntime(runtime.guardian);
  if (live.backend !== backend) fail("Recovery execution changed its original native backend");
  if (saved.author) {
    const active = readValidationAuthorOwner(saved.author);
    if (active.config !== config || active.phase !== "author") fail("Recovery author config or phase changed");
  } else if (saved.review) {
    const active = readValidationReviewOwner(saved.review);
    if (active.phase !== "review" || config.runStart !== active.request.review_start) fail("Recovery reviewer config or phase changed");
  } else fail("Recovery execution has no original owner");
}
const completedValidations = new WeakMap<ImportedRecoveryValidationResultV1, PreparedImportedRecoveryValidation>();
const completedValidationReviews = new WeakMap<ImportedRecoveryValidationReviewResultV1, PreparedImportedRecoveryValidationReview>();
const consumedValidationPredecessors = new WeakSet<ValidationPredecessor>(), consumedValidationSources = new WeakSet<ImportedRecoveryValidationResultV1>();
const consumedFailedValidationReviews = new WeakSet<ImportedRecoveryValidationReviewResultV1>();
const retainedValidationWork = new WeakMap<PreparedWindowsSourceRecoveryRuntime, Set<PreparedImportedRecoveryValidation | PreparedImportedRecoveryValidationReview>>();
const validationLineages = new WeakMap<PreparedWindowsSourceRecoveryRuntime, Map<string, { author: PreparedImportedRecoveryValidation; review?: PreparedImportedRecoveryValidationReview }>>();
function validationPath(runtime: PreparedWindowsSourceRecoveryRuntime, kind: string, id: string) { return join(state(runtime).options.storeRoot, "attestations", "recovery-validation-" + kind + "-" + key(id) + ".json"); }
function retainValidation(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidation | PreparedImportedRecoveryValidationReview) {
  const retained = retainedValidationWork.get(runtime) ?? new Set(); retained.add(permit); retainedValidationWork.set(runtime, retained);
}
function validationLineage(runtime: PreparedWindowsSourceRecoveryRuntime, root: string) { return validationLineages.get(runtime)?.get(root); }
function assertValidationAncestors(ancestors: ValidationAncestors) {
  synchronousSession(ancestors.assertSession); ancestors.assertClosed(); assertImplementationFiles(ancestors.implementation, false);
  if (ancestors.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation ancestor history changed");
}
export function reserveImportedRecoveryValidation(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationControlV1, action: "start" | "stop"): PreparedImportedRecoveryValidation {
  const control = freezeJson(ImportedRecoveryValidationControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "reservation", control.validation_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedRecoveryValidation;
  validationOwners.set(permit, { runtime, control, action, claimed: false, executed: false, nativeAttempted: false, settled: false }); retainValidation(runtime, permit); return permit;
}
export function reserveImportedRecoveryValidationReview(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationReviewControlV1, action: "start" | "stop"): PreparedImportedRecoveryValidationReview {
  const control = freezeJson(ImportedRecoveryValidationReviewControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "review-reservation", control.review_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedRecoveryValidationReview;
  validationReviewOwners.set(permit, { runtime, control, action, claimed: false, settled: false }); retainValidation(runtime, permit); return permit;
}
function readValidationAuthorOwner(permit: PreparedImportedRecoveryValidation) {
  const owner = validationOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation author is required");
  const current = state(owner.runtime), start = active.request.run_start;
  if (validationLineage(owner.runtime, active.request.root_validation_id)?.author !== permit || current.active.get(start.run_id) !== active.profile.workspace_root
    || !consumedValidationPredecessors.has(active.original) || active.config.runStart !== start || active.adapter.runtimeId !== start.runtime
    || importedRecoveryValidationRequestDigestV1(active.request, sha) !== owner.control.request_digest || start.run_id !== owner.control.run_id
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest))
    fail("Validation author ownership, lineage, adapter or history changed");
  synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors); assertImportedValidationBaseline(active.baseline);
  assertAcceptedProductInputs(active.profile.workspace_root, start.context_pack.payload); assertImportedValidationVerificationProfile(active.profile); return active;
}
export function readImportedRecoveryValidationVerificationAdmission(permit: PreparedImportedRecoveryValidation, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readValidationAuthorOwner(permit), start = active.request.run_start;
  if (profile !== active.profile || context !== start.context_pack.payload || (scope === "final"
    ? active.phase !== "final" || requestId !== start.verification.request_id
    : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification.request_id)) fail("Validation verifier changed its original author invocation");
  return { request: active.request, request_digest: importedRecoveryValidationRequestDigestV1(active.request, sha), readReleaseCapabilities: active.ancestors.implementation.readReleaseCapabilities };
}
export function readRecoveryValidationResearch(root: string, context: ContextPack, bytes: Uint8Array) {
  const authorPermit = validationContexts.get(context), reviewPermit = validationReviewContexts.get(context);
  const author = authorPermit ? readValidationAuthorOwner(authorPermit) : undefined, review = reviewPermit ? readValidationReviewOwner(reviewPermit) : undefined;
  const source = author?.ancestors.implementation ?? review?.source.ancestors.implementation;
  const expected = author?.request.run_start.context_pack.payload ?? (review?.phase === "before" ? review.request.before_start.context_pack.payload
    : review?.phase === "after" ? review.request.after_start.context_pack.payload : undefined);
  if (!source || expected !== context || root !== source.profile.workspace_root || realpathSync.native(root) !== root || !Buffer.from(bytes).equals(source.research))
    fail("Original validation phase and accepted research bytes are required");
  return ProductResearchReportSchema.parse({ ...JSON.parse(source.research.toString("utf8")), measurement_plan: source.effectivePlan });
}
function validationPredecessor(runtime: PreparedWindowsSourceRecoveryRuntime, original: ValidationPredecessor, request: ImportedRecoveryValidationRequestV1): ValidationAncestors {
  if (request.kind === "initial") {
    const recoveredSource = recovered.get(original as PreparedRecoveredWorkspace), current = runtimeState(runtime);
    if (!recoveredSource || current.current !== original || recoveredSource.consumed
      || recoveredSource.epochId !== current.epochId || canonical(request.checkpoint) !== canonical(recoveredSource.checkpoint)
      || canonical(request.origin) !== canonical(recoveredSource.request.origin) || validationLineage(runtime, request.root_validation_id))
      fail("Initial recovery author requires the exact original current unverified checkpoint");
    readRecoveredWorkspaceResult(original as PreparedRecoveredWorkspace);
    const local = readGuardianProductSourceConfiguration(current.source, current.guardian);
    const release = local.releases.find(item => item.profile.verifier === recoveredSource.profile);
    const implementation: ImplementationSourceState = { runtime, workspace: original as PreparedRecoveredWorkspace,
      profile: recoveredSource.profile, research: recoveredSource.research, design: recoveredSource.design,
      effectivePlan: recoveredSource.effectivePlan, ...(release ? { readReleaseCapabilities: release.readCapabilities } : {}) };
    return { implementation, origin: request.origin,
      history: [{ path: recoveredSource.requestPath, digest: hash(recoveredSource.request) }, { path: recoveredSource.resultPath, digest: hash(recoveredSource.result) }],
      assertClosed: () => { readRecoveredWorkspaceResult(original as PreparedRecoveredWorkspace); },
      assertSession: () => { runtimeState(runtime); } };
  }
  let source: ValidationSourceState, history: readonly { path: string; digest: string }[], assertClosed: () => void;
  if (request.predecessor?.kind === "review") {
    if (!("review_id" in original)) fail("Validation repair requires an original rejected final review");
    const reviewed = readSettledValidationReview(runtime, original as ImportedRecoveryValidationReviewResultV1);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected" || canonical({ review_id: request.predecessor.review_id,
      request_digest: request.predecessor.request_digest, result_digest: request.predecessor.result_digest }) !== canonical({
      review_id: original.review_id, request_digest: original.request_digest, result_digest: hash(original) })) fail("Validation repair changed its exact rejected predecessor");
    source = reviewed.active.source; history = [...source.history, ...reviewed.history]; assertClosed = reviewed.assertClosed;
    if (request.authorization.attempt_index <= reviewed.active.request.authorization.attempt_index) fail("Repair must consume a fresh cumulative retry after its rejected review");
  } else {
    if (!("validation_id" in original) || request.predecessor?.kind !== "failure") fail("Validation repair requires an original typed closed failure");
    source = readSettledValidation(runtime, original as ImportedRecoveryValidationResultV1);
    if (source.source.outcome !== "closed-failure") fail("Generic validation failure cannot grant repair authority");
    history = source.history; assertClosed = source.assertClosed;
  }
  const originalCheckpoint = recovered.get(source.ancestors.implementation.workspace);
  if (!originalCheckpoint || canonical(request.checkpoint) !== canonical(originalCheckpoint.checkpoint)
    || canonical(request.previous_source) !== canonical(source.source) || canonical(request.origin) !== canonical(source.ancestors.origin)
    || validationLineage(runtime, request.root_validation_id)?.author !== source.permit) fail("Validation repair must continue the latest original source");
  return { implementation: source.ancestors.implementation, origin: source.ancestors.origin, history,
    assertClosed, assertSession: source.assertSession };
}
export async function failUnstartedImportedRecoveryValidation(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidation,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedRecoveryValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Original unstarted validation reservation is required");
  owner.executed = true; const reason = (error instanceof Error ? error.message : "Validation admission failed").slice(0, 2000) || "Validation admission failed";
  let closed = true;
  try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Validation was not started: " + reason.slice(0, 1900) } }); } catch { closed = false; }
  const result: ImportedRecoveryValidationResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) { state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done"; validationContexts.delete(owner.active.request.run_start.context_pack.payload); }
  completedValidations.set(result, permit); return result;
}
async function executeImportedRecoveryValidation(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidation, original: ValidationPredecessor,
  input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedRecoveryValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.executed || owner.settled) fail("Original unused validation reservation is required");
  owner.executed = true;
  try {
    const shape = ImportedRecoveryValidationRequestV1Schema.parse(input);
    const ancestors = validationPredecessor(runtime, original, shape), source = ancestors.implementation;
    const request = freezeJson(inspectImportedRecoveryValidationRequestV1(shape, source.research, sha)), start = request.run_start, profile = source.profile, current = state(runtime);
    if (owner.claimed || owner.control.validation_id !== request.validation_id || owner.control.run_id !== start.run_id
      || owner.control.request_digest !== importedRecoveryValidationRequestDigestV1(request, sha) || consumedValidationPredecessors.has(original)) fail("Validation predecessor or reservation already consumed or changed");
    if (process.platform !== "win32" || adapter.runtimeId !== start.runtime) fail("Validation requires its original native Windows destination");
    assertImportedValidationVerificationProfile(profile); assertValidationAncestors(ancestors);
    if (selectVerificationProfile(start, [profile], false, source.readReleaseCapabilities) !== profile || subjectManifest(profile).digest !== initialSubject(request))
      fail("Validation initial subject or protected configuration changed");
    if (current.importing || [...current.active.values()].some(root => overlaps(root, profile.workspace_root))) fail("Validation destination is occupied");
    const methods = Object.fromEntries(["start", "stop", "streamEvents", "collectArtifacts"].map(name => [name, Object.getOwnPropertyDescriptor(adapter, name)?.value]));
    if (Object.values(methods).some(method => typeof method !== "function")) fail("Validation adapter methods must be stable local functions");
    const assertBefore = () => { signal.throwIfAborted(); synchronousSession(assertSession); assertValidationAncestors(ancestors);
      if (subjectManifest(profile).digest !== initialSubject(request)) fail("Validation source changed before baseline capture"); };
    auditWindowsReleaseStorage(current.store, current.options.storeRoot);
    const baseline = retainImportedValidationBaseline(profile, current.options.storeRoot, request.validation_id, initialSubject(request), assertBefore);
    auditWindowsReleaseStorage(current.store, current.options.storeRoot);
    const config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    const claimPath = validationPath(runtime, "owner", request.validation_id), authorizationPath = validationPath(runtime, "authorization", request.authorization.event_id);
    const claim = canonical({ ...owner.control, request }); assertBefore(); consumedValidationPredecessors.add(original); owner.claimed = true;
    const initialWorkspace = recovered.get(original as PreparedRecoveredWorkspace); if (initialWorkspace) initialWorkspace.consumed = true;
    // Replace the latest owner before any writer can start; a prior acceptance cannot publish S0 after this point.
    const lineages = validationLineages.get(runtime) ?? new Map(); lineages.set(request.root_validation_id, { author: permit }); validationLineages.set(runtime, lineages);
    writeExclusive(authorizationPath, claim); writeExclusive(claimPath, claim); current.active.set(start.run_id, profile.workspace_root);
    const active: NonNullable<ValidationAuthorOwner["active"]> = { request, original, ancestors, baseline, profile, config, adapter, methods, assertSession,
      claimPath, claim, history: [...ancestors.history, { path: authorizationPath, digest: sha(claim) }], phase: "author" };
    owner.active = active; validationContexts.set(start.context_pack.payload, permit); recoveryExecutionConfigs.set(config, { runtime, author: permit });
    const assertCurrent = () => { signal.throwIfAborted(); readValidationAuthorOwner(permit); };
    let verified: ImportedRecoveryCompletedValidationV1 | undefined, closedFailure: ImportedRecoveryClosedValidationFailureV1 | undefined;
    const completion = () => {
      return { ...owner.control, root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
        author: request.writer, run_start_digest: hash(start), recovery_id: request.recovery_id, checkpoint_digest: productSourceRecoveryCheckpointDigestV1(request.checkpoint, sha),
        initial_subject_digest: initialSubject(request), subject_digest: subjectManifest(profile).digest, authorization_event_id: request.authorization.event_id,
        attempt_index: request.authorization.attempt_index, baseline: assertImportedValidationBaseline(baseline), closure: "windows-job-and-tools-closed.v1" as const }; };
    const author = createImportedAuthorExecution({ stage: "validation", adapter, config, profile, signal, assertCurrent, emit,
      markNativeAttempted: () => { owner.nativeAttempted = true; }, prepareFinal: () => { active.phase = "final"; assertCurrent(); },
      verify: () => runImportedRecoveryValidationVerification(profile, start.verification.request_id, signal, start.context_pack.payload, permit),
      beforeCompleted: evidence => {
        assertCurrent(); author.assertClosed(); assertImportedFinalVerificationBinding(profile, evidence, permit, start.verification.request_id, start.context_pack.payload, "recovery-validation");
        active.finalEvidence = evidence; verified = { ...completion(), stage: "validation", scope: "all-declared-workspace-validation-cases", verification: evidence };
        inspectImportedRecoveryValidationResultV1(request, { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }, source.research, sha);
      },
      beforeFailed: failure => {
        assertCurrent(); author.assertClosed();
        if (failure.kind === "verification-failed") {
          // Only the original failed verifier with a real exit is repairable. All
          // other failures remain generic even when the author itself has closed.
          try { assertImportedRecoveryValidationFailedVerificationBinding(profile, failure.verification, permit, start.verification.request_id, start.context_pack.payload); }
          catch { return; }
          active.failedEvidence = failure.verification;
        }
        const value = completion(); active.failedSubject = value.subject_digest;
        active.retainedFailure = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: value.subject_digest });
        closedFailure = { ...value, failure_kind: failure.kind, reason: failure.reason.slice(0, 2000),
          ...(failure.kind === "verification-failed" ? { verification: failure.verification } : {}) };
        inspectImportedRecoveryValidationResultV1(request, { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }, source.research, sha);
      } });
    active.assertAuthorClosed = () => author.assertClosed(); let result: ImportedRecoveryValidationResultV1;
    try {
      bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
      if (source.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.readReleaseCapabilities);
      bindWorkspaceToolVerifier(config, async previewSignal => {
        assertCurrent(); if (active.previewRequest) fail("Validation preview is already active"); active.previewRequest = "preview-" + randomUUID();
        try { return await runImportedRecoveryValidationVerificationPreview(profile, active.previewRequest, previewSignal, start.context_pack.payload, permit); }
        finally { active.previewRequest = undefined; }
      });
      Object.freeze(config); await author.run();
      if (!signal.aborted && (verified || closedFailure)) {
        assertCurrent(); author.assertClosed();
        if (subjectManifest(profile).digest !== (verified ?? closedFailure)!.subject_digest) fail("Validation subject changed while awaiting terminal commit");
        if (verified) assertImportedFinalVerificationBinding(profile, active.finalEvidence!, permit, start.verification.request_id, start.context_pack.payload, "recovery-validation");
        else if (active.failedEvidence) assertImportedRecoveryValidationFailedVerificationBinding(profile, active.failedEvidence, permit, start.verification.request_id, start.context_pack.payload);
      }
      result = freezeJson(verified && !signal.aborted ? { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }
        : closedFailure && !signal.aborted ? { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }
          : { ...owner.control, outcome: "failed", closed: true, reason: signal.aborted ? "Validation cancelled" : "Validation did not produce verified completion or a typed closed product failure" });
    } catch (error) { result = freezeJson({ ...owner.control, ...await author.failure(error) }); }
    finally { author.dispose(); }
    if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; validationContexts.delete(start.context_pack.payload); }
    completedValidations.set(result, permit); return result;
  } catch (error) {
    if (!owner.nativeAttempted) return failUnstartedImportedRecoveryValidation(runtime, permit, error, emit);
    const result: ImportedRecoveryValidationResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false,
      reason: (error instanceof Error ? error.message : "Validation execution uncertain").slice(0, 2000) || "Validation execution uncertain" });
    completedValidations.set(result, permit); return result;
  }
}
export function persistImportedRecoveryValidationResult(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidation, input: ImportedRecoveryValidationResultV1) {
  const owner = validationOwners.get(permit), result = ImportedRecoveryValidationResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.validation_id !== owner.control.validation_id || result.request_digest !== owner.control.request_digest
    || result.run_id !== owner.control.run_id || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidations.get(input) !== permit) fail("Validation result differs from its original reservation or process");
  if (owner.active) inspectImportedRecoveryValidationResultV1(owner.active.request, input, owner.active.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "result", result.validation_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function assertValidationFiles(source: ValidationSourceState, currentSubject: boolean) {
  state(source.runtime); synchronousSession(source.assertSession); assertValidationAncestors(source.ancestors); source.assertClosed();
  assertImportedValidationBaseline(source.baseline);
  if (source.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation persisted history changed");
  if (currentSubject && subjectManifest(source.profile).digest !== source.source.subject_digest) fail("Validation current product subject changed");
}
function readSettledValidation(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationResultV1): ValidationSourceState {
  const permit = completedValidations.get(input), owner = permit && validationOwners.get(permit), active = owner?.active;
  const value = input.outcome === "finished" ? input.verified_validation : input.outcome === "failed" ? input.closed_failure : undefined;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.assertAuthorClosed || !value
    || validationLineage(runtime, active.request.root_validation_id)?.author !== permit) fail("Original latest persisted validation completion is required");
  const source = inspectImportedRecoveryValidationCompletionV1(active.request, input, active.ancestors.implementation.research, sha).source;
  if (!source) fail("Recovery completion has no original measured source");
  const saved: ValidationSourceState = { runtime, permit, original: input, source, profile: active.profile, ancestors: active.ancestors, baseline: active.baseline,
    history: [...active.history, { path: active.claimPath, digest: sha(active.claim) }, { path: validationPath(runtime, "result", input.validation_id), digest: hash(input) }],
    assertSession: active.assertSession, assertClosed: () => {
      synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors);
      active.assertAuthorClosed!();
      if (input.outcome === "finished") {
        if (!active.finalEvidence || canonical(active.finalEvidence) !== canonical(input.verified_validation.verification)) fail("Validation original passed evidence changed");
        assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload, "recovery-validation");
      } else {
        if (!active.retainedFailure || active.failedSubject !== value.subject_digest
          || describeProductSourceSnapshot(active.retainedFailure).source.subject_digest !== value.subject_digest) fail("Validation original failed product bytes are unavailable");
        if (source.failure_kind === "verification-failed") {
          if (!active.failedEvidence || canonical(active.failedEvidence) !== canonical(value.verification)) fail("Validation original failed evidence changed");
          assertImportedRecoveryValidationFailedVerificationBinding(active.profile, active.failedEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload);
        }
      }
      if (Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("Validation author methods changed after closure");
      inspectImportedRecoveryValidationResultV1(active.request, input, active.ancestors.implementation.research, sha);
    } };
  assertValidationFiles(saved, true); return saved;
}
/** Strict getter for a new continuation or initial receipt; writes must retain separate ancestor liveness. */
export function readCompletedImportedRecoveryValidation(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationResultV1) { return readSettledValidation(runtime, input).source; }

function readValidationReviewOwner(permit: PreparedImportedRecoveryValidationReview) {
  const owner = validationReviewOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation reviewer is required");
  const current = state(owner.runtime), latest = validationLineage(owner.runtime, active.request.source.root_validation_id);
  if (latest?.author !== active.source.permit || latest.review !== permit || current.active.get(active.request.review_start.run_id) !== active.source.profile.workspace_root
    || !consumedValidationSources.has(active.original) || importedRecoveryValidationReviewRequestDigestV1(active.request, sha) !== owner.control.request_digest
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(validationPath(owner.runtime, "review-request", active.request.review_id)).toString("utf8") !== canonical(active.request))
    fail("Validation review ownership, source, request or adapter changed");
  synchronousSession(active.assertSession); assertValidationFiles(active.source, true); return active;
}
export function readImportedRecoveryValidationReviewVerificationAdmission(permit: PreparedImportedRecoveryValidationReview, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, phase: "before" | "after") {
  const active = readValidationReviewOwner(permit), start = phase === "before" ? active.request.before_start : active.request.after_start;
  if (active.phase !== phase || profile !== active.source.profile || context !== start.context_pack.payload || requestId !== start.verification.request_id)
    fail("Validation review verifier differs from its registered phase");
  return { request: active.request, request_digest: importedRecoveryValidationReviewRequestDigestV1(active.request, sha), phase, start,
    readReleaseCapabilities: active.source.ancestors.implementation.readReleaseCapabilities };
}
async function executeImportedRecoveryValidationReview(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidationReview,
  original: ImportedRecoveryValidationResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  retryOriginal?: ImportedRecoveryValidationReviewResultV1): Promise<ImportedRecoveryValidationReviewResultV1> {
  const owner = validationReviewOwners.get(permit), current = state(runtime), source = readSettledValidation(runtime, original as ImportedRecoveryValidationResultV1);
  const request = freezeJson(inspectImportedRecoveryValidationReviewRequestV1(input, source.ancestors.implementation.research, sha));
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.claimed || owner.settled
    || owner.control.review_id !== request.review_id || owner.control.request_digest !== importedRecoveryValidationReviewRequestDigestV1(request, sha)
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
    const before = await runImportedRecoveryValidationReviewVerification(profile, request.before_start.verification.request_id, signal, request.before_start.context_pack.payload, permit, "before");
    closure.confirm("before-verifier"); if (before.outcome !== "passed") fail("Validation review before verification failed");
    assertImportedFinalVerificationBinding(profile, before, permit, request.before_start.verification.request_id, request.before_start.context_pack.payload, "recovery-validation-review-before");
    owner.active.before = before; owner.active.phase = "review"; assertCurrent();
    const start = request.review_start, config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    recoveryExecutionConfigs.set(config, { runtime, review: permit });
    const evidence = createImportedValidationReviewEvidence(profile, before, { requestId: request.before_start.verification.request_id,
      subjectDigest: source.source.subject_digest }, source.baseline, () => { assertCurrent(); if (owner.active?.phase !== "review") fail("Validation evidence is only available to its original active reviewer"); });
    bindWorkspaceReadOnlyTools(config, { projectId: profile.project_id, workspaceRoot: profile.workspace_root, assertCurrent,
      source: { profile, subjectDigest: source.source.subject_digest, importedRecoveryValidationReviewId: request.review_id }, readEvidenceIndex: evidence.readEvidenceIndex });
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
    const after = await runImportedRecoveryValidationReviewVerification(profile, request.after_start.verification.request_id, signal, request.after_start.context_pack.payload, permit, "after");
    closure.confirm("after-verifier"); if (after.outcome !== "passed") fail("Validation review after verification failed");
    assertImportedFinalVerificationBinding(profile, after, permit, request.after_start.verification.request_id, request.after_start.context_pack.payload, "recovery-validation-review-after");
    owner.active.after = after;
    const measured = (start: RunStartPayload, verification: RunVerificationPayload) => ({ run_id: start.run_id, config_digest: hash(start),
      closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-validation-cases" as const, verification });
    const result: ImportedRecoveryValidationReviewResultV1 = { ...base, outcome: "reviewed", closed: true, before: measured(request.before_start, before), after: measured(request.after_start, after),
      reviewer: { run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1" }, verdict };
    inspectImportedRecoveryValidationReviewResultV1(request, result, source.ancestors.implementation.research, sha); assertCurrent();
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
export function persistImportedRecoveryValidationReviewResult(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedImportedRecoveryValidationReview, input: ImportedRecoveryValidationReviewResultV1) {
  const owner = validationReviewOwners.get(permit), result = ImportedRecoveryValidationReviewResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.review_id !== owner.control.review_id || result.request_digest !== owner.control.request_digest
    || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidationReviews.get(input) !== permit) fail("Validation review result differs from its original operation");
  if (owner.active) inspectImportedRecoveryValidationReviewResultV1(owner.active.request, result, owner.active.source.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "review-result", result.review_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function readSettledValidationReview(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationReviewResultV1) {
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
    if (active.before) assertImportedFinalVerificationBinding(active.source.profile, active.before, permit, active.request.before_start.verification.request_id, active.request.before_start.context_pack.payload, "recovery-validation-review-before");
    if (active.after) assertImportedFinalVerificationBinding(active.source.profile, active.after, permit, active.request.after_start.verification.request_id, active.request.after_start.context_pack.payload, "recovery-validation-review-after");
    if (input.outcome === "reviewed" && (!active.assertReviewerClosed || !active.before || !active.after
      || canonical(input.before.verification) !== canonical(active.before) || canonical(input.after.verification) !== canonical(active.after))) fail("Validation original reviewed phase evidence changed");
  };
  assertClosed(); assertValidationFiles(active.source, true);
  if (history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation review persisted history changed");
  inspectImportedRecoveryValidationReviewResultV1(active.request, input, active.source.ancestors.implementation.research, sha);
  return { owner, active, history, assertClosed };
}
export function readCompletedImportedRecoveryValidationReview(runtime: PreparedWindowsSourceRecoveryRuntime, input: ImportedRecoveryValidationReviewResultV1) {
  return readSettledValidationReview(runtime, input).active.request;
}

/** A recovery publication is derived only from the original fresh author verifier and
 * independent reviewed result in this process. The checkpoint itself is unverified. */
function readRecoveryValidationRelease(runtime: PreparedWindowsSourceRecoveryRuntime, original: ImportedRecoveryValidationReviewResultV1, request: ProductReleaseRequest) {
  const reviewed = readSettledValidationReview(runtime, original), source = reviewed.active.source;
  const author = validationOwners.get(source.permit)?.active, release = request.imported_recovery;
  const checkpoint = recovered.get(source.ancestors.implementation.workspace);
  if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted" || source.source.outcome !== "verified"
    || !author?.finalEvidence || !release || !checkpoint || request.imported_validation
    || release.recovery_id !== checkpoint.checkpoint.recovery_id || release.checkpoint_digest !== productSourceRecoveryCheckpointDigestV1(checkpoint.checkpoint, sha)
    || release.validation_id !== source.source.validation_id || release.validation_request_digest !== source.source.request_digest
    || release.validation_result_digest !== source.source.result_digest || release.review_id !== original.review_id
    || release.review_request_digest !== original.request_digest || release.review_result_digest !== hash(original)
    || release.subject_digest !== source.source.subject_digest || request.subject_digest !== source.source.subject_digest
    || request.run_id !== author.request.run_start.run_id || request.verification_request_id !== author.request.run_start.verification.request_id
    || request.verification_profile_id !== source.profile.id || request.verification_profile_digest !== source.profile.digest
    || request.project_id !== source.profile.project_id || request.goal_id !== author.request.authorization.goal_id
    || release.authorization.goal_id !== author.request.authorization.goal_id || release.authorization.actor_user_id !== checkpoint.request.authorization.actor_user_id
    || release.authorization.attempt_index < author.request.authorization.attempt_index || release.authorization.event_id === author.request.authorization.event_id
    || release.recovery_of_release_id !== (checkpoint.request.operations.find(operation => operation.kind === "release")?.operation_id ?? null))
    fail("Publication requires the exact current independently accepted recovery author and fresh publication authorization");
  assertImportedFinalVerificationBinding(source.profile, author.finalEvidence, source.permit, author.request.run_start.verification.request_id,
    author.request.run_start.context_pack.payload, "recovery-validation");
  return { profile: source.profile, start: author.request.run_start, verification: author.finalEvidence, checkpoint: checkpoint.checkpoint,
    effectivePlan: source.ancestors.implementation.effectivePlan, readReleaseCapabilities: source.ancestors.implementation.readReleaseCapabilities,
    assertCurrent: () => { readSettledValidationReview(runtime, original); } };
}
declare const recoveryReleaseBrand: unique symbol;
export interface PreparedRecoveryValidationRelease { readonly [recoveryReleaseBrand]: true }
const recoveryReleases = new WeakMap<PreparedRecoveryValidationRelease, { runtime: PreparedWindowsSourceRecoveryRuntime;
  original: ImportedRecoveryValidationReviewResultV1; request: ProductReleaseRequest; assertReceipt: () => void;
  retry?: PreparedProductReleaseRetry; predecessor?: PreparedRecoveryValidationRelease }>();
const recoveryPublicationClaims = new WeakMap<ImportedRecoveryValidationReviewResultV1, PreparedRecoveryValidationRelease>();
export function isPreparedRecoveryValidationRelease(input: unknown): input is PreparedRecoveryValidationRelease {
  return typeof input === "object" && input !== null && recoveryReleases.has(input as PreparedRecoveryValidationRelease);
}
export function prepareRecoveryValidationRelease(runtime: PreparedWindowsSourceRecoveryRuntime, original: ImportedRecoveryValidationReviewResultV1,
  request: ProductReleaseRequest, assertReceipt: () => void, retry?: PreparedProductReleaseRetry): PreparedRecoveryValidationRelease {
  request = ProductReleaseRequestSchema.parse(request); synchronousSession(assertReceipt); readRecoveryValidationRelease(runtime, original, request);
  const prior = recoveryPublicationClaims.get(original);
  if (prior && canonical(recoveryReleases.get(prior)!.request) === canonical(request)) { if (retry) readPreparedProductReleaseRetry(retry, request); return prior; }
  if (prior) {
    if (!retry || !request.retry) fail("Accepted recovery validation is already bound to a publication request");
    const previous = recoveryReleases.get(prior)!, prepared = readPreparedProductReleaseRetry(retry, request);
    if (previous.original !== original || canonical(previous.request) !== canonical(prepared.previousRequest)
      || request.retry.previous_release_id !== previous.request.release_id
      || request.retry.authorization.attempt_index <= readSettledValidationReview(runtime, original).active.request.authorization.attempt_index)
      fail("Recovery publication retry requires its original preceding release permit and a fresh goal attempt");
  } else if (retry || request.retry) fail("Recovery publication retry cannot manufacture a missing preceding owner");
  const permit = Object.freeze({}) as PreparedRecoveryValidationRelease;
  recoveryReleases.set(permit, { runtime, original, request: immutable(request), assertReceipt, ...(retry ? { retry, predecessor: prior! } : {}) });
  recoveryPublicationClaims.set(original, permit); return permit;
}
export function readPreparedRecoveryValidationRelease(permit: PreparedRecoveryValidationRelease, request?: ProductReleaseRequest, root?: string) {
  const saved = recoveryReleases.get(permit);
  if (!saved || recoveryPublicationClaims.get(saved.original) !== permit || request && canonical(request) !== canonical(saved.request))
    fail("Original current recovery publication permit required");
  synchronousSession(saved.assertReceipt); if (saved.retry) readPreparedProductReleaseRetry(saved.retry, saved.request);
  const current = readRecoveryValidationRelease(saved.runtime, saved.original, saved.request);
  if (root && subjectManifest({ ...current.profile, workspace_root: root }).digest !== saved.request.subject_digest) fail("Recovery publication copy changed the accepted subject");
  return { ...current, request: saved.request };
}
export function claimRecoveryValidationRelease(runtime: PreparedWindowsSourceRecoveryRuntime, permit: PreparedRecoveryValidationRelease, claimId: string) {
  const saved = recoveryReleases.get(permit), admitted = readPreparedRecoveryValidationRelease(permit);
  if (!saved || saved.runtime !== runtime || claimId !== "product-release:" + saved.request.release_id) fail("Recovery publication workspace claim changed");
  const current = state(runtime), root = admitted.profile.workspace_root;
  if (current.importing || current.active.has(claimId) || [...current.active.values()].some(path => overlaps(path, root))) fail("Recovery publication workspace is occupied");
  current.active.set(claimId, root);
}

/** Authenticated controllers capture this scope around both initial commands and
 * retained tool callbacks. It grants complete Job-subtree ownership, not settlement. */
export function withWindowsSourceRecoveryOperation<T>(runtime: PreparedWindowsSourceRecoveryRuntime,
  descriptor: Parameters<typeof withWindowsGuardianOperation>[1], work: () => T): T {
  const saved = runtimes.get(runtime); if (!saved) fail("original current recovery runtime required");
  const live = readWindowsGuardianLocalRuntime(saved.guardian);
  if (live.mode !== "active" || live.epoch.epoch_id !== saved.epochId) fail("recovery runtime belongs to another epoch");
  // Full configuration/source capability checks may launch fixed ACL observers.
  // Establish the original guardian scope first; never bypass those checks or let
  // a bound backend fall back to an unowned collector when a scope is missing.
  return withWindowsGuardianOperation(saved.guardian, descriptor, () => { runtimeState(runtime); return work(); });
}
/** Publisher isolation only. This original current checkpoint can fence old publication
 * replay but cannot grant a release. Source bytes may legitimately change during the
 * fresh author attempt, so this getter never compares them to the interrupted subject. */
export function readWindowsSourceRecoveryPublicationFence(runtime: PreparedWindowsSourceRecoveryRuntime) {
  const current = runtimeState(runtime), workspace = current.current, saved = workspace && recovered.get(workspace);
  if (!workspace || !saved || saved.guardian !== current.guardian || saved.epochId !== current.epochId
    || saved.configuration !== current.configuration) fail("Current original recovered workspace required for publication isolation");
  const assertCurrent = () => {
    const latest = runtimeState(runtime);
    if (latest.current !== workspace || latest.epochId !== saved.epochId) fail("Recovered publication isolation belongs to another current epoch");
    readRecoveredWorkspaceResult(workspace);
  };
  assertCurrent(); return Object.freeze({ checkpoint: saved.checkpoint, workspaceRoot: saved.profile.workspace_root,
    projectId: saved.profile.project_id, assertCurrent });
}
export function runImportedRecoveryValidation(...args: Parameters<typeof executeImportedRecoveryValidation>) {
  const [runtime, permit] = args, owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime) fail("Original recovery author reservation required");
  return withWindowsSourceRecoveryOperation(runtime, { operationId: owner.control.validation_id, bindingDigest: owner.control.request_digest,
    serverOperation: { kind: "validation", operation_id: owner.control.validation_id, request_digest: owner.control.request_digest, run_id: owner.control.run_id } },
  () => executeImportedRecoveryValidation(...args));
}
export function runImportedRecoveryValidationReview(...args: Parameters<typeof executeImportedRecoveryValidationReview>) {
  const [runtime, permit] = args, owner = validationReviewOwners.get(permit);
  if (!owner || owner.runtime !== runtime) fail("Original recovery review reservation required");
  return withWindowsSourceRecoveryOperation(runtime, { operationId: owner.control.review_id, bindingDigest: owner.control.request_digest,
    serverOperation: { kind: "validation_review", operation_id: owner.control.review_id, request_digest: owner.control.request_digest } },
  () => executeImportedRecoveryValidationReview(...args));
}
