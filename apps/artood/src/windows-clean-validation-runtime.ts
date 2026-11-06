import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalProductSourceTransferValueV1 as canonical, sourceCleanValidationOriginDigestV1,
  ImportedCleanValidationControlV1Schema, ImportedCleanValidationRequestV1Schema, ImportedCleanValidationResultV1Schema,
  ImportedCleanValidationReviewControlV1Schema, ImportedCleanValidationReviewResultV1Schema, ImportedValidationReviewVerdictV1Schema,
  inspectImportedCleanValidationRequestV1, inspectImportedCleanValidationResultV1, inspectImportedCleanValidationCompletionV1,
  inspectImportedCleanValidationReviewRequestV1, inspectImportedCleanValidationReviewResultV1,
  importedCleanValidationRequestDigestV1, importedCleanValidationReviewRequestDigestV1, importedValidationOriginDigestV1,
  ProductReleaseRequestSchema, ProductResearchReportSchema,
  type ImportedValidationOriginV1, type ProductResearchReport, type ProductReleaseRequest,
  type ImportedCleanValidationControlV1, type ImportedCleanValidationRequestV1, type ImportedCleanValidationResultV1,
  type ImportedCleanValidationSourceV1, type ImportedCleanValidationReviewControlV1, type ImportedCleanValidationReviewRequestV1,
  type ImportedCleanValidationReviewResultV1, type ImportedCleanCompletedValidationV1, type ImportedCleanClosedValidationFailureV1,
  type ContextPack, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import { adapterRunEventBodySchema, type AgentInstanceConfig, type AgentInstanceHandle, type RuntimeAdapter, type RunEventMessage } from "@artoo/protocol";
import { assertLocallyPreparedVerificationProfile, subjectManifest, selectVerificationProfile, assertImportedValidationVerificationProfile,
  assertImportedFinalVerificationBinding, assertImportedCleanValidationFailedVerificationBinding,
  runImportedCleanValidationVerification, runImportedCleanValidationVerificationPreview, runImportedCleanValidationReviewVerification,
  type PreparedVerificationProfile } from "./verification.js";
import { readProductFile, assertAcceptedProductInputs } from "./product-stage.js";
import { retainImportedValidationBaseline, assertImportedValidationBaseline, type PreparedValidationBaseline } from "./imported-validation-baseline.js";
import { readWindowsGuardianLocalRuntime } from "./owned/windows-runtime-guardian.js";
import { withWindowsGuardianOperation } from "./owned/windows-guardian-scope.js";
import { windowsPathsOverlap } from "./windows-local-acl.js";
import type { ReleaseCapabilityReader } from "./release-capability-authority.js";
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
import { withWindowsSourceRecoveryOperation, type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import { readCleanDaemonCheckpoint, readCleanDaemonCheckpointSource, readAcceptedCleanDaemonOrigin,
  type PreparedCleanDaemonCheckpoint } from "./windows-clean-daemon-client.js";

type ImportedDesignEvent = RunEventMessage["event"];
const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value)), key = (value: string) => sha(value).slice(7), overlaps = windowsPathsOverlap;
function fail(reason: string): never { throw new Error(`Windows clean validation: ${reason}`); }
function immutable<T>(value: T): T { const result = structuredClone(value); const freeze = (item: unknown): void => {
  if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
}; freeze(result); return result; }
const freezeJson = immutable;
function fileIdentity(path: string) {
  const stat = lstatSync(path); if (stat.isSymbolicLink() || realpathSync.native(path) !== path) fail("fixed path is linked or aliased");
  return { path, dev: stat.dev, ino: stat.ino, directory: stat.isDirectory() };
}
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
function initialSubject(request: ImportedCleanValidationRequestV1) { return request.previous_source?.subject_digest ?? request.restart.checkpoint.subject_digest; }
declare const runtimeBrand: unique symbol;
export interface PreparedWindowsCleanValidationRuntime { readonly [runtimeBrand]: true }
interface CleanRuntime { source: PreparedWindowsSourceRecoveryRuntime; checkpoint: PreparedCleanDaemonCheckpoint }
const runtimes = new WeakMap<object, CleanRuntime>(), preparedCheckpoints = new WeakSet<PreparedCleanDaemonCheckpoint>();
/** A clean checkpoint is a distinct original object; it never creates a surviving-
 * Guardian recovered workspace or reuses its execution/review/publication brands. */
export function prepareWindowsCleanValidationRuntime(source: PreparedWindowsSourceRecoveryRuntime,
  checkpoint: PreparedCleanDaemonCheckpoint): PreparedWindowsCleanValidationRuntime {
  readCleanDaemonCheckpointSource(checkpoint, source);
  if (preparedCheckpoints.has(checkpoint)) fail("Original clean checkpoint already has its sole validation runtime");
  const token = Object.freeze({}) as PreparedWindowsCleanValidationRuntime;
  preparedCheckpoints.add(checkpoint); runtimes.set(token, { source, checkpoint }); return token;
}
function runtimeState(runtime: PreparedWindowsCleanValidationRuntime) {
  const saved = runtimes.get(runtime); if (!saved) fail("Original clean validation runtime required");
  return { ...saved, ...readCleanDaemonCheckpointSource(saved.checkpoint, saved.source) };
}
function state(runtime: PreparedWindowsCleanValidationRuntime) { return runtimeState(runtime); }
interface ImplementationSourceState { runtime: PreparedWindowsCleanValidationRuntime; workspace: PreparedCleanDaemonCheckpoint;
  profile: PreparedVerificationProfile; research: Buffer; design: Buffer; effectivePlan: ProductResearchReport["measurement_plan"];
  readReleaseCapabilities?: ReleaseCapabilityReader }
function assertImplementationFiles(source: ImplementationSourceState, _completeSubject: boolean): void {
  const current = runtimeState(source.runtime);
  if (current.checkpoint !== source.workspace) fail("Clean source lost its original current checkpoint");
  readCleanDaemonCheckpoint(source.workspace);
  if (!readProductFile(source.profile.workspace_root, ".artoo/product/research.json").equals(source.research)
    || !readProductFile(source.profile.workspace_root, ".artoo/product/design.json").equals(source.design)) fail("Clean accepted inputs changed");
}

declare const validationBrand: unique symbol, validationReviewBrand: unique symbol;
export interface PreparedImportedCleanValidation { readonly [validationBrand]: true }
export interface PreparedImportedCleanValidationReview { readonly [validationReviewBrand]: true }
type ValidationPredecessor = PreparedCleanDaemonCheckpoint | ImportedCleanValidationResultV1 | ImportedCleanValidationReviewResultV1;
interface ValidationAncestors {
  implementation: ImplementationSourceState; origin: ImportedValidationOriginV1; history: readonly { path: string; digest: string }[];
  assertClosed: () => void; assertSession: () => void;
}
interface ValidationAuthorOwner {
  runtime: PreparedWindowsCleanValidationRuntime; control: ImportedCleanValidationControlV1; action: "start" | "stop";
  claimed: boolean; executed: boolean; nativeAttempted: boolean; settled: boolean;
  active?: { request: ImportedCleanValidationRequestV1; original: ValidationPredecessor; ancestors: ValidationAncestors;
    baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile; config: AgentInstanceConfig; adapter: RuntimeAdapter;
    methods: Record<string, unknown>; assertSession: () => void; claimPath: string; claim: string; history: readonly { path: string; digest: string }[];
    phase: "author" | "final" | "done"; previewRequest?: string; finalEvidence?: RunVerificationPayload; failedEvidence?: RunVerificationPayload;
    assertAuthorClosed?: () => void; failedSubject?: string; retainedFailure?: ReturnType<typeof captureProductSourceSnapshot> };
}
interface ValidationSourceState {
  runtime: PreparedWindowsCleanValidationRuntime; permit: PreparedImportedCleanValidation; original: ImportedCleanValidationResultV1; source: ImportedCleanValidationSourceV1;
  ancestors: ValidationAncestors; baseline: PreparedValidationBaseline; profile: PreparedVerificationProfile;
  history: readonly { path: string; digest: string }[]; assertClosed: () => void; assertSession: () => void;
}
interface ValidationReviewOwner {
  runtime: PreparedWindowsCleanValidationRuntime; control: ImportedCleanValidationReviewControlV1; action: "start" | "stop"; claimed: boolean; settled: boolean;
  active?: { request: ImportedCleanValidationReviewRequestV1; original: ImportedCleanValidationResultV1; source: ValidationSourceState;
    adapter: RuntimeAdapter; methods: Record<string, unknown>; assertSession: () => void; phase: "before" | "review" | "after" | "done";
    before?: RunVerificationPayload; after?: RunVerificationPayload; assertReviewerClosed?: () => void; retryableFailure?: boolean; closure: ReturnType<typeof createImportedReviewClosure> };
}
const validationOwners = new WeakMap<PreparedImportedCleanValidation, ValidationAuthorOwner>();
const validationReviewOwners = new WeakMap<PreparedImportedCleanValidationReview, ValidationReviewOwner>();
const validationContexts = new WeakMap<ContextPack, PreparedImportedCleanValidation>(), validationReviewContexts = new WeakMap<ContextPack, PreparedImportedCleanValidationReview>();
const cleanExecutionConfigs = new WeakMap<AgentInstanceConfig, { runtime: PreparedWindowsCleanValidationRuntime;
  author?: PreparedImportedCleanValidation; review?: PreparedImportedCleanValidationReview }>();
export function assertWindowsCleanExecutionConfiguration(config: AgentInstanceConfig, backend: PreparedWindowsProcessBackend): void {
  const saved = cleanExecutionConfigs.get(config); if (!saved) fail("Original clean execution config required");
  const runtime = runtimeState(saved.runtime), live = readWindowsGuardianLocalRuntime(runtime.guardian);
  if (live.backend !== backend) fail("Clean execution changed its original native backend");
  if (saved.author) {
    const active = readValidationAuthorOwner(saved.author);
    if (active.config !== config || active.phase !== "author") fail("Clean author config or phase changed");
  } else if (saved.review) {
    const active = readValidationReviewOwner(saved.review);
    if (active.phase !== "review" || config.runStart !== active.request.review_start) fail("Clean reviewer config or phase changed");
  } else fail("Clean execution has no original owner");
}
const completedValidations = new WeakMap<ImportedCleanValidationResultV1, PreparedImportedCleanValidation>();
const completedValidationReviews = new WeakMap<ImportedCleanValidationReviewResultV1, PreparedImportedCleanValidationReview>();
const consumedValidationPredecessors = new WeakSet<ValidationPredecessor>(), consumedValidationSources = new WeakSet<ImportedCleanValidationResultV1>();
const consumedFailedValidationReviews = new WeakSet<ImportedCleanValidationReviewResultV1>();
const retainedValidationWork = new WeakMap<PreparedWindowsCleanValidationRuntime, Set<PreparedImportedCleanValidation | PreparedImportedCleanValidationReview>>();
const validationLineages = new WeakMap<PreparedWindowsCleanValidationRuntime, Map<string, { author: PreparedImportedCleanValidation; review?: PreparedImportedCleanValidationReview }>>();
function validationPath(runtime: PreparedWindowsCleanValidationRuntime, kind: string, id: string) { return join(state(runtime).options.storeRoot, "attestations", "clean-validation-" + kind + "-" + key(id) + ".json"); }
function retainValidation(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidation | PreparedImportedCleanValidationReview) {
  const retained = retainedValidationWork.get(runtime) ?? new Set(); retained.add(permit); retainedValidationWork.set(runtime, retained);
}
function validationLineage(runtime: PreparedWindowsCleanValidationRuntime, root: string) { return validationLineages.get(runtime)?.get(root); }
function assertValidationAncestors(ancestors: ValidationAncestors) {
  synchronousSession(ancestors.assertSession); ancestors.assertClosed(); assertImplementationFiles(ancestors.implementation, false);
  if (ancestors.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation ancestor history changed");
}
export function reserveImportedCleanValidation(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationControlV1, action: "start" | "stop"): PreparedImportedCleanValidation {
  const control = freezeJson(ImportedCleanValidationControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "reservation", control.validation_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedCleanValidation;
  validationOwners.set(permit, { runtime, control, action, claimed: false, executed: false, nativeAttempted: false, settled: false }); retainValidation(runtime, permit); return permit;
}
export function reserveImportedCleanValidationReview(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationReviewControlV1, action: "start" | "stop"): PreparedImportedCleanValidationReview {
  const control = freezeJson(ImportedCleanValidationReviewControlV1Schema.parse(input));
  writeExclusive(validationPath(runtime, "review-reservation", control.review_id), canonical({ ...control, action }));
  const permit = Object.freeze({}) as PreparedImportedCleanValidationReview;
  validationReviewOwners.set(permit, { runtime, control, action, claimed: false, settled: false }); retainValidation(runtime, permit); return permit;
}
function readValidationAuthorOwner(permit: PreparedImportedCleanValidation) {
  const owner = validationOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation author is required");
  const current = state(owner.runtime), start = active.request.run_start;
  if (validationLineage(owner.runtime, active.request.root_validation_id)?.author !== permit || current.active.get(start.run_id) !== active.profile.workspace_root
    || !consumedValidationPredecessors.has(active.original) || active.config.runStart !== start || active.adapter.runtimeId !== start.runtime
    || importedCleanValidationRequestDigestV1(active.request, sha) !== owner.control.request_digest || start.run_id !== owner.control.run_id
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(active.claimPath).toString("utf8") !== active.claim || active.history.some(item => sha(boundedFile(item.path)) !== item.digest))
    fail("Validation author ownership, lineage, adapter or history changed");
  synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors); assertImportedValidationBaseline(active.baseline);
  assertAcceptedProductInputs(active.profile.workspace_root, start.context_pack.payload); assertImportedValidationVerificationProfile(active.profile); return active;
}
export function readImportedCleanValidationVerificationAdmission(permit: PreparedImportedCleanValidation, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, scope: "preview" | "final") {
  const active = readValidationAuthorOwner(permit), start = active.request.run_start;
  if (profile !== active.profile || context !== start.context_pack.payload || (scope === "final"
    ? active.phase !== "final" || requestId !== start.verification.request_id
    : active.phase !== "author" || requestId !== active.previewRequest || requestId === start.verification.request_id)) fail("Validation verifier changed its original author invocation");
  return { request: active.request, request_digest: importedCleanValidationRequestDigestV1(active.request, sha), readReleaseCapabilities: active.ancestors.implementation.readReleaseCapabilities };
}
export function readCleanValidationResearch(root: string, context: ContextPack, bytes: Uint8Array) {
  const authorPermit = validationContexts.get(context), reviewPermit = validationReviewContexts.get(context);
  const author = authorPermit ? readValidationAuthorOwner(authorPermit) : undefined, review = reviewPermit ? readValidationReviewOwner(reviewPermit) : undefined;
  const source = author?.ancestors.implementation ?? review?.source.ancestors.implementation;
  const expected = author?.request.run_start.context_pack.payload ?? (review?.phase === "before" ? review.request.before_start.context_pack.payload
    : review?.phase === "after" ? review.request.after_start.context_pack.payload : undefined);
  if (!source || expected !== context || root !== source.profile.workspace_root || realpathSync.native(root) !== root || !Buffer.from(bytes).equals(source.research))
    fail("Original validation phase and accepted research bytes are required");
  return ProductResearchReportSchema.parse({ ...JSON.parse(source.research.toString("utf8")), measurement_plan: source.effectivePlan });
}
function validationPredecessor(runtime: PreparedWindowsCleanValidationRuntime, original: ValidationPredecessor, request: ImportedCleanValidationRequestV1): ValidationAncestors {
  if (request.kind === "initial") {
    const current = runtimeState(runtime);
    if (current.checkpoint !== original || consumedValidationPredecessors.has(original) || validationLineage(runtime, request.root_validation_id))
      fail("Initial clean author requires the exact unused current unverified checkpoint");
    const checkpoint = original as PreparedCleanDaemonCheckpoint, checkpointSource = readCleanDaemonCheckpoint(checkpoint);
    const restart = readAcceptedCleanDaemonOrigin(checkpoint);
    if (canonical(request.restart) !== canonical(restart) || canonical(request.origin) !== canonical(restart.grant.origin))
      fail("Initial clean author changed its original accepted restart settlement");
    const release = current.releases.find(item => item.profile.verifier === checkpointSource.profile);
    const implementation: ImplementationSourceState = { runtime, workspace: original as PreparedCleanDaemonCheckpoint,
      profile: checkpointSource.profile, research: checkpointSource.research, design: checkpointSource.design,
      effectivePlan: checkpointSource.effectivePlan, ...(release ? { readReleaseCapabilities: release.readCapabilities } : {}) };
    return { implementation, origin: request.origin,
      history: [], // The original checkpoint reader checks all retained files on every admission.
      assertClosed: () => { readCleanDaemonCheckpoint(checkpoint); readAcceptedCleanDaemonOrigin(checkpoint); },
      assertSession: () => { runtimeState(runtime); } };
  }
  let source: ValidationSourceState, history: readonly { path: string; digest: string }[], assertClosed: () => void;
  if (request.predecessor?.kind === "review") {
    if (!("review_id" in original)) fail("Validation repair requires an original rejected final review");
    const reviewed = readSettledValidationReview(runtime, original as ImportedCleanValidationReviewResultV1);
    if (original.outcome !== "reviewed" || original.verdict.outcome !== "rejected" || canonical({ review_id: request.predecessor.review_id,
      request_digest: request.predecessor.request_digest, result_digest: request.predecessor.result_digest }) !== canonical({
      review_id: original.review_id, request_digest: original.request_digest, result_digest: hash(original) })) fail("Validation repair changed its exact rejected predecessor");
    source = reviewed.active.source; history = [...source.history, ...reviewed.history]; assertClosed = reviewed.assertClosed;
    if (request.authorization.attempt_index <= reviewed.active.request.authorization.attempt_index) fail("Repair must consume a fresh cumulative retry after its rejected review");
  } else {
    if (!("validation_id" in original) || request.predecessor?.kind !== "failure") fail("Validation repair requires an original typed closed failure");
    source = readSettledValidation(runtime, original as ImportedCleanValidationResultV1);
    if (source.source.outcome !== "closed-failure") fail("Generic validation failure cannot grant repair authority");
    history = source.history; assertClosed = source.assertClosed;
  }
  const restart = readAcceptedCleanDaemonOrigin(source.ancestors.implementation.workspace);
  if (canonical(request.restart) !== canonical(restart)
    || canonical(request.previous_source) !== canonical(source.source) || canonical(request.origin) !== canonical(source.ancestors.origin)
    || validationLineage(runtime, request.root_validation_id)?.author !== source.permit) fail("Validation repair must continue the latest original source");
  return { implementation: source.ancestors.implementation, origin: source.ancestors.origin, history,
    assertClosed, assertSession: source.assertSession };
}
export async function failUnstartedImportedCleanValidation(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidation,
  error: unknown, emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedCleanValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.settled || owner.nativeAttempted) fail("Original unstarted validation reservation is required");
  owner.executed = true; const reason = (error instanceof Error ? error.message : "Validation admission failed").slice(0, 2000) || "Validation admission failed";
  let closed = true;
  try { await emit({ type: "run.lifecycle", payload: { phase: "failed", reason: "Validation was not started: " + reason.slice(0, 1900) } }); } catch { closed = false; }
  const result: ImportedCleanValidationResultV1 = freezeJson(closed ? { ...owner.control, outcome: "failed", closed: true, reason }
    : { ...owner.control, outcome: "uncertain", closed: false, reason });
  if (closed && owner.active) { state(runtime).active.delete(owner.control.run_id); owner.active.phase = "done"; validationContexts.delete(owner.active.request.run_start.context_pack.payload); }
  completedValidations.set(result, permit); return result;
}
async function executeImportedCleanValidation(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidation, original: ValidationPredecessor,
  input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  emit: (event: ImportedDesignEvent) => Promise<void>): Promise<ImportedCleanValidationResultV1> {
  const owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.executed || owner.settled) fail("Original unused validation reservation is required");
  owner.executed = true;
  try {
    const shape = ImportedCleanValidationRequestV1Schema.parse(input);
    const ancestors = validationPredecessor(runtime, original, shape), source = ancestors.implementation;
    const request = freezeJson(inspectImportedCleanValidationRequestV1(shape, source.research, sha)), start = request.run_start, profile = source.profile, current = state(runtime);
    if (owner.claimed || owner.control.validation_id !== request.validation_id || owner.control.run_id !== start.run_id
      || owner.control.request_digest !== importedCleanValidationRequestDigestV1(request, sha) || consumedValidationPredecessors.has(original)) fail("Validation predecessor or reservation already consumed or changed");
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
    // Replace the latest owner before any writer can start; a prior acceptance cannot publish S0 after this point.
    const lineages = validationLineages.get(runtime) ?? new Map(); lineages.set(request.root_validation_id, { author: permit }); validationLineages.set(runtime, lineages);
    writeExclusive(authorizationPath, claim); writeExclusive(claimPath, claim); current.active.set(start.run_id, profile.workspace_root);
    const active: NonNullable<ValidationAuthorOwner["active"]> = { request, original, ancestors, baseline, profile, config, adapter, methods, assertSession,
      claimPath, claim, history: [...ancestors.history, { path: authorizationPath, digest: sha(claim) }], phase: "author" };
    owner.active = active; validationContexts.set(start.context_pack.payload, permit); cleanExecutionConfigs.set(config, { runtime, author: permit });
    const assertCurrent = () => { signal.throwIfAborted(); readValidationAuthorOwner(permit); };
    let verified: ImportedCleanCompletedValidationV1 | undefined, closedFailure: ImportedCleanClosedValidationFailureV1 | undefined;
    const completion = () => {
      return { ...owner.control, root_validation_id: request.root_validation_id, generation: request.generation, origin_digest: importedValidationOriginDigestV1(request.origin, sha),
        author: request.writer, run_start_digest: hash(start), clean_generation_id: request.clean_generation_id,
        restart_digest: sourceCleanValidationOriginDigestV1(request.restart, sha),
        initial_subject_digest: initialSubject(request), subject_digest: subjectManifest(profile).digest, authorization_event_id: request.authorization.event_id,
        attempt_index: request.authorization.attempt_index, baseline: assertImportedValidationBaseline(baseline), closure: "windows-job-and-tools-closed.v1" as const }; };
    const author = createImportedAuthorExecution({ stage: "validation", adapter, config, profile, signal, assertCurrent, emit,
      markNativeAttempted: () => { owner.nativeAttempted = true; }, prepareFinal: () => { active.phase = "final"; assertCurrent(); },
      verify: () => runImportedCleanValidationVerification(profile, start.verification.request_id, signal, start.context_pack.payload, permit),
      beforeCompleted: evidence => {
        assertCurrent(); author.assertClosed(); assertImportedFinalVerificationBinding(profile, evidence, permit, start.verification.request_id, start.context_pack.payload, "clean-validation");
        active.finalEvidence = evidence; verified = { ...completion(), stage: "validation", scope: "all-declared-workspace-validation-cases", verification: evidence };
        inspectImportedCleanValidationResultV1(request, { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }, source.research, sha);
      },
      beforeFailed: failure => {
        assertCurrent(); author.assertClosed();
        if (failure.kind === "verification-failed") {
          // Only the original failed verifier with a real exit is repairable. All
          // other failures remain generic even when the author itself has closed.
          try { assertImportedCleanValidationFailedVerificationBinding(profile, failure.verification, permit, start.verification.request_id, start.context_pack.payload); }
          catch { return; }
          active.failedEvidence = failure.verification;
        }
        const value = completion(); active.failedSubject = value.subject_digest;
        active.retainedFailure = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: value.subject_digest });
        closedFailure = { ...value, failure_kind: failure.kind, reason: failure.reason.slice(0, 2000),
          ...(failure.kind === "verification-failed" ? { verification: failure.verification } : {}) };
        inspectImportedCleanValidationResultV1(request, { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }, source.research, sha);
      } });
    active.assertAuthorClosed = () => author.assertClosed(); let result: ImportedCleanValidationResultV1;
    try {
      bindWorkspaceToolCapabilities(config, () => { assertCurrent(); return { ...profile.capabilities!, profile_id: profile.id }; });
      if (source.readReleaseCapabilities) bindWorkspaceToolReleaseCapabilities(config, source.readReleaseCapabilities);
      bindWorkspaceToolVerifier(config, async previewSignal => {
        assertCurrent(); if (active.previewRequest) fail("Validation preview is already active"); active.previewRequest = "preview-" + randomUUID();
        try { return await runImportedCleanValidationVerificationPreview(profile, active.previewRequest, previewSignal, start.context_pack.payload, permit); }
        finally { active.previewRequest = undefined; }
      });
      Object.freeze(config); await author.run();
      if (!signal.aborted && (verified || closedFailure)) {
        assertCurrent(); author.assertClosed();
        if (subjectManifest(profile).digest !== (verified ?? closedFailure)!.subject_digest) fail("Validation subject changed while awaiting terminal commit");
        if (verified) assertImportedFinalVerificationBinding(profile, active.finalEvidence!, permit, start.verification.request_id, start.context_pack.payload, "clean-validation");
        else if (active.failedEvidence) assertImportedCleanValidationFailedVerificationBinding(profile, active.failedEvidence, permit, start.verification.request_id, start.context_pack.payload);
      }
      result = freezeJson(verified && !signal.aborted ? { ...owner.control, outcome: "finished", closed: true, verified_validation: verified }
        : closedFailure && !signal.aborted ? { ...owner.control, outcome: "failed", closed: true, reason: closedFailure.reason, closed_failure: closedFailure }
          : { ...owner.control, outcome: "failed", closed: true, reason: signal.aborted ? "Validation cancelled" : "Validation did not produce verified completion or a typed closed product failure" });
    } catch (error) { result = freezeJson({ ...owner.control, ...await author.failure(error) }); }
    finally { author.dispose(); }
    if (result.closed) { current.active.delete(start.run_id); active.phase = "done"; validationContexts.delete(start.context_pack.payload); }
    completedValidations.set(result, permit); return result;
  } catch (error) {
    if (!owner.nativeAttempted) return failUnstartedImportedCleanValidation(runtime, permit, error, emit);
    const result: ImportedCleanValidationResultV1 = freezeJson({ ...owner.control, outcome: "uncertain", closed: false,
      reason: (error instanceof Error ? error.message : "Validation execution uncertain").slice(0, 2000) || "Validation execution uncertain" });
    completedValidations.set(result, permit); return result;
  }
}
export function persistImportedCleanValidationResult(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidation, input: ImportedCleanValidationResultV1) {
  const owner = validationOwners.get(permit), result = ImportedCleanValidationResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.validation_id !== owner.control.validation_id || result.request_digest !== owner.control.request_digest
    || result.run_id !== owner.control.run_id || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidations.get(input) !== permit) fail("Validation result differs from its original reservation or process");
  if (owner.active) inspectImportedCleanValidationResultV1(owner.active.request, input, owner.active.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "result", result.validation_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function assertValidationFiles(source: ValidationSourceState, currentSubject: boolean) {
  state(source.runtime); synchronousSession(source.assertSession); assertValidationAncestors(source.ancestors); source.assertClosed();
  assertImportedValidationBaseline(source.baseline);
  if (source.history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation persisted history changed");
  if (currentSubject && subjectManifest(source.profile).digest !== source.source.subject_digest) fail("Validation current product subject changed");
}
function readSettledValidation(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationResultV1): ValidationSourceState {
  const permit = completedValidations.get(input), owner = permit && validationOwners.get(permit), active = owner?.active;
  const value = input.outcome === "finished" ? input.verified_validation : input.outcome === "failed" ? input.closed_failure : undefined;
  if (!permit || !owner || owner.runtime !== runtime || !owner.settled || !active || active.phase !== "done" || !active.assertAuthorClosed || !value
    || validationLineage(runtime, active.request.root_validation_id)?.author !== permit) fail("Original latest persisted validation completion is required");
  const source = inspectImportedCleanValidationCompletionV1(active.request, input, active.ancestors.implementation.research, sha).source;
  if (!source) fail("Clean completion has no original measured source");
  const saved: ValidationSourceState = { runtime, permit, original: input, source, profile: active.profile, ancestors: active.ancestors, baseline: active.baseline,
    history: [...active.history, { path: active.claimPath, digest: sha(active.claim) }, { path: validationPath(runtime, "result", input.validation_id), digest: hash(input) }],
    assertSession: active.assertSession, assertClosed: () => {
      synchronousSession(active.assertSession); assertValidationAncestors(active.ancestors);
      active.assertAuthorClosed!();
      if (input.outcome === "finished") {
        if (!active.finalEvidence || canonical(active.finalEvidence) !== canonical(input.verified_validation.verification)) fail("Validation original passed evidence changed");
        assertImportedFinalVerificationBinding(active.profile, active.finalEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload, "clean-validation");
      } else {
        if (!active.retainedFailure || active.failedSubject !== value.subject_digest
          || describeProductSourceSnapshot(active.retainedFailure).source.subject_digest !== value.subject_digest) fail("Validation original failed product bytes are unavailable");
        if (source.failure_kind === "verification-failed") {
          if (!active.failedEvidence || canonical(active.failedEvidence) !== canonical(value.verification)) fail("Validation original failed evidence changed");
          assertImportedCleanValidationFailedVerificationBinding(active.profile, active.failedEvidence, permit, active.request.run_start.verification.request_id, active.request.run_start.context_pack.payload);
        }
      }
      if (Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)) fail("Validation author methods changed after closure");
      inspectImportedCleanValidationResultV1(active.request, input, active.ancestors.implementation.research, sha);
    } };
  assertValidationFiles(saved, true); return saved;
}
/** Strict getter for a new continuation or initial receipt; writes must retain separate ancestor liveness. */
export function readCompletedImportedCleanValidation(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationResultV1) { return readSettledValidation(runtime, input).source; }

function readValidationReviewOwner(permit: PreparedImportedCleanValidationReview) {
  const owner = validationReviewOwners.get(permit), active = owner?.active;
  if (!owner || !active || !owner.claimed || owner.settled || active.phase === "done") fail("Original active validation reviewer is required");
  const current = state(owner.runtime), latest = validationLineage(owner.runtime, active.request.source.root_validation_id);
  if (latest?.author !== active.source.permit || latest.review !== permit || current.active.get(active.request.review_start.run_id) !== active.source.profile.workspace_root
    || !consumedValidationSources.has(active.original) || importedCleanValidationReviewRequestDigestV1(active.request, sha) !== owner.control.request_digest
    || Object.entries(active.methods).some(([name, method]) => Object.getOwnPropertyDescriptor(active.adapter, name)?.value !== method)
    || boundedFile(validationPath(owner.runtime, "review-request", active.request.review_id)).toString("utf8") !== canonical(active.request))
    fail("Validation review ownership, source, request or adapter changed");
  synchronousSession(active.assertSession); assertValidationFiles(active.source, true); return active;
}
export function readImportedCleanValidationReviewVerificationAdmission(permit: PreparedImportedCleanValidationReview, profile: PreparedVerificationProfile,
  requestId: string, context: ContextPack, phase: "before" | "after") {
  const active = readValidationReviewOwner(permit), start = phase === "before" ? active.request.before_start : active.request.after_start;
  if (active.phase !== phase || profile !== active.source.profile || context !== start.context_pack.payload || requestId !== start.verification.request_id)
    fail("Validation review verifier differs from its registered phase");
  return { request: active.request, request_digest: importedCleanValidationReviewRequestDigestV1(active.request, sha), phase, start,
    readReleaseCapabilities: active.source.ancestors.implementation.readReleaseCapabilities };
}
async function executeImportedCleanValidationReview(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidationReview,
  original: ImportedCleanValidationResultV1, input: unknown, adapter: RuntimeAdapter, signal: AbortSignal, assertSession: () => void,
  retryOriginal?: ImportedCleanValidationReviewResultV1): Promise<ImportedCleanValidationReviewResultV1> {
  const owner = validationReviewOwners.get(permit), current = state(runtime), source = readSettledValidation(runtime, original as ImportedCleanValidationResultV1);
  const request = freezeJson(inspectImportedCleanValidationReviewRequestV1(input, source.ancestors.implementation.research, sha));
  if (!owner || owner.runtime !== runtime || owner.action !== "start" || owner.claimed || owner.settled
    || owner.control.review_id !== request.review_id || owner.control.request_digest !== importedCleanValidationReviewRequestDigestV1(request, sha)
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
    const before = await runImportedCleanValidationReviewVerification(profile, request.before_start.verification.request_id, signal, request.before_start.context_pack.payload, permit, "before");
    closure.confirm("before-verifier"); if (before.outcome !== "passed") fail("Validation review before verification failed");
    assertImportedFinalVerificationBinding(profile, before, permit, request.before_start.verification.request_id, request.before_start.context_pack.payload, "clean-validation-review-before");
    owner.active.before = before; owner.active.phase = "review"; assertCurrent();
    const start = request.review_start, config: AgentInstanceConfig = { runId: start.run_id, taskId: start.task_id, agentInstanceId: start.agent_instance_id,
      runtime: start.runtime, workspaceRoot: profile.workspace_root, runStart: start };
    cleanExecutionConfigs.set(config, { runtime, review: permit });
    const evidence = createImportedValidationReviewEvidence(profile, before, { requestId: request.before_start.verification.request_id,
      subjectDigest: source.source.subject_digest }, source.baseline, () => { assertCurrent(); if (owner.active?.phase !== "review") fail("Validation evidence is only available to its original active reviewer"); });
    bindWorkspaceReadOnlyTools(config, { projectId: profile.project_id, workspaceRoot: profile.workspace_root, assertCurrent,
      source: { profile, subjectDigest: source.source.subject_digest, importedCleanValidationReviewId: request.review_id }, readEvidenceIndex: evidence.readEvidenceIndex });
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
    const after = await runImportedCleanValidationReviewVerification(profile, request.after_start.verification.request_id, signal, request.after_start.context_pack.payload, permit, "after");
    closure.confirm("after-verifier"); if (after.outcome !== "passed") fail("Validation review after verification failed");
    assertImportedFinalVerificationBinding(profile, after, permit, request.after_start.verification.request_id, request.after_start.context_pack.payload, "clean-validation-review-after");
    owner.active.after = after;
    const measured = (start: RunStartPayload, verification: RunVerificationPayload) => ({ run_id: start.run_id, config_digest: hash(start),
      closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-validation-cases" as const, verification });
    const result: ImportedCleanValidationReviewResultV1 = { ...base, outcome: "reviewed", closed: true, before: measured(request.before_start, before), after: measured(request.after_start, after),
      reviewer: { run_id: start.run_id, config_digest: hash(start), closure: "windows-job-and-tools-closed.v1" }, verdict };
    inspectImportedCleanValidationReviewResultV1(request, result, source.ancestors.implementation.research, sha); assertCurrent();
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
export function persistImportedCleanValidationReviewResult(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedImportedCleanValidationReview, input: ImportedCleanValidationReviewResultV1) {
  const owner = validationReviewOwners.get(permit), result = ImportedCleanValidationReviewResultV1Schema.parse(input);
  if (!owner || owner.runtime !== runtime || owner.settled || result.review_id !== owner.control.review_id || result.request_digest !== owner.control.request_digest
    || (owner.action === "stop") !== (result.outcome === "cancelled_before_start")
    || owner.action === "start" && result.closed && completedValidationReviews.get(input) !== permit) fail("Validation review result differs from its original operation");
  if (owner.active) inspectImportedCleanValidationReviewResultV1(owner.active.request, result, owner.active.source.ancestors.implementation.research, sha);
  writeExclusive(validationPath(runtime, "review-result", result.review_id), canonical(result)); owner.settled = true;
  if (result.closed) retainedValidationWork.get(runtime)?.delete(permit);
}
function readSettledValidationReview(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationReviewResultV1) {
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
    if (active.before) assertImportedFinalVerificationBinding(active.source.profile, active.before, permit, active.request.before_start.verification.request_id, active.request.before_start.context_pack.payload, "clean-validation-review-before");
    if (active.after) assertImportedFinalVerificationBinding(active.source.profile, active.after, permit, active.request.after_start.verification.request_id, active.request.after_start.context_pack.payload, "clean-validation-review-after");
    if (input.outcome === "reviewed" && (!active.assertReviewerClosed || !active.before || !active.after
      || canonical(input.before.verification) !== canonical(active.before) || canonical(input.after.verification) !== canonical(active.after))) fail("Validation original reviewed phase evidence changed");
  };
  assertClosed(); assertValidationFiles(active.source, true);
  if (history.some(item => sha(boundedFile(item.path)) !== item.digest)) fail("Validation review persisted history changed");
  inspectImportedCleanValidationReviewResultV1(active.request, input, active.source.ancestors.implementation.research, sha);
  return { owner, active, history, assertClosed };
}
export function readCompletedImportedCleanValidationReview(runtime: PreparedWindowsCleanValidationRuntime, input: ImportedCleanValidationReviewResultV1) {
  return readSettledValidationReview(runtime, input).active.request;
}

/** A clean publication is derived only from the original fresh author verifier and
 * independent reviewed result in this process. The checkpoint itself is unverified. */
function readCleanValidationRelease(runtime: PreparedWindowsCleanValidationRuntime, original: ImportedCleanValidationReviewResultV1, request: ProductReleaseRequest) {
  const reviewed = readSettledValidationReview(runtime, original), source = reviewed.active.source;
  const author = validationOwners.get(source.permit)?.active, release = request.imported_clean;
  const checkpoint = readCleanDaemonCheckpoint(source.ancestors.implementation.workspace), restart = readAcceptedCleanDaemonOrigin(source.ancestors.implementation.workspace);
  const current = state(runtime);
  if (original.outcome !== "reviewed" || original.verdict.outcome !== "accepted" || source.source.outcome !== "verified"
    || !author?.finalEvidence || !release || request.imported_validation || request.imported_recovery
    || release.clean_generation_id !== restart.generation_id || release.restart_digest !== sourceCleanValidationOriginDigestV1(restart, sha)
    || release.validation_id !== source.source.validation_id || release.validation_request_digest !== source.source.request_digest
    || release.validation_result_digest !== source.source.result_digest || release.review_id !== original.review_id
    || release.review_request_digest !== original.request_digest || release.review_result_digest !== hash(original)
    || release.subject_digest !== source.source.subject_digest || request.subject_digest !== source.source.subject_digest
    || request.run_id !== author.request.run_start.run_id || request.verification_request_id !== author.request.run_start.verification.request_id
    || request.verification_profile_id !== source.profile.id || request.verification_profile_digest !== source.profile.digest
    || request.project_id !== source.profile.project_id || request.goal_id !== author.request.authorization.goal_id
    || release.authorization.goal_id !== author.request.authorization.goal_id || release.authorization.actor_user_id !== checkpoint.grant.authorization.actor_user_id
    || release.authorization.attempt_index < author.request.authorization.attempt_index || release.authorization.event_id === author.request.authorization.event_id
    || (release.interrupted_release_id === null ? current.predecessorOperations.some(operation => operation.kind === "release")
      : !current.predecessorOperations.some(operation => operation.kind === "release" && operation.operation_id === release.interrupted_release_id)))
    fail("Publication requires the exact current independently accepted clean author and fresh publication authorization");
  assertImportedFinalVerificationBinding(source.profile, author.finalEvidence, source.permit, author.request.run_start.verification.request_id,
    author.request.run_start.context_pack.payload, "clean-validation");
  return { profile: source.profile, start: author.request.run_start, verification: author.finalEvidence, restart,
    checkpoint: source.ancestors.implementation.workspace,
    effectivePlan: source.ancestors.implementation.effectivePlan, readReleaseCapabilities: source.ancestors.implementation.readReleaseCapabilities,
    assertCurrent: () => { readSettledValidationReview(runtime, original); } };
}
declare const cleanReleaseBrand: unique symbol;
export interface PreparedCleanValidationRelease { readonly [cleanReleaseBrand]: true }
const cleanReleases = new WeakMap<PreparedCleanValidationRelease, { runtime: PreparedWindowsCleanValidationRuntime;
  original: ImportedCleanValidationReviewResultV1; request: ProductReleaseRequest; assertReceipt: () => void;
  retry?: PreparedProductReleaseRetry; predecessor?: PreparedCleanValidationRelease }>();
const cleanPublicationClaims = new WeakMap<ImportedCleanValidationReviewResultV1, PreparedCleanValidationRelease>();
export function isPreparedCleanValidationRelease(input: unknown): input is PreparedCleanValidationRelease {
  return typeof input === "object" && input !== null && cleanReleases.has(input as PreparedCleanValidationRelease);
}
export function prepareCleanValidationRelease(runtime: PreparedWindowsCleanValidationRuntime, original: ImportedCleanValidationReviewResultV1,
  request: ProductReleaseRequest, assertReceipt: () => void, retry?: PreparedProductReleaseRetry): PreparedCleanValidationRelease {
  request = ProductReleaseRequestSchema.parse(request); synchronousSession(assertReceipt); readCleanValidationRelease(runtime, original, request);
  const prior = cleanPublicationClaims.get(original);
  if (prior && canonical(cleanReleases.get(prior)!.request) === canonical(request)) { if (retry) readPreparedProductReleaseRetry(retry, request); return prior; }
  if (prior) {
    if (!retry || !request.retry) fail("Accepted clean validation is already bound to a publication request");
    const previous = cleanReleases.get(prior)!, prepared = readPreparedProductReleaseRetry(retry, request);
    if (previous.original !== original || canonical(previous.request) !== canonical(prepared.previousRequest)
      || request.retry.previous_release_id !== previous.request.release_id
      || request.retry.authorization.attempt_index <= readSettledValidationReview(runtime, original).active.request.authorization.attempt_index)
      fail("Clean publication retry requires its original preceding release permit and a fresh goal attempt");
  } else if (retry || request.retry) fail("Clean publication retry cannot manufacture a missing preceding owner");
  const permit = Object.freeze({}) as PreparedCleanValidationRelease;
  cleanReleases.set(permit, { runtime, original, request: immutable(request), assertReceipt, ...(retry ? { retry, predecessor: prior! } : {}) });
  cleanPublicationClaims.set(original, permit); return permit;
}
export function readPreparedCleanValidationRelease(permit: PreparedCleanValidationRelease, request?: ProductReleaseRequest, root?: string) {
  const saved = cleanReleases.get(permit);
  if (!saved || cleanPublicationClaims.get(saved.original) !== permit || request && canonical(request) !== canonical(saved.request))
    fail("Original current clean publication permit required");
  synchronousSession(saved.assertReceipt); if (saved.retry) readPreparedProductReleaseRetry(saved.retry, saved.request);
  const current = readCleanValidationRelease(saved.runtime, saved.original, saved.request);
  if (root && subjectManifest({ ...current.profile, workspace_root: root }).digest !== saved.request.subject_digest) fail("Clean publication copy changed the accepted subject");
  return { ...current, request: saved.request };
}
const cleanWorkspaceClaims = new WeakMap<PreparedCleanValidationRelease, {
  runtime: PreparedWindowsCleanValidationRuntime; claimId: string; root: string; active: Map<string, string>;
}>();
export function claimCleanValidationRelease(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedCleanValidationRelease, claimId: string) {
  const saved = cleanReleases.get(permit), admitted = readPreparedCleanValidationRelease(permit);
  if (!saved || saved.runtime !== runtime || claimId !== "product-release:" + saved.request.release_id) fail("Clean publication workspace claim changed");
  const current = state(runtime), root = admitted.profile.workspace_root;
  if (cleanWorkspaceClaims.has(permit) || current.importing || current.active.has(claimId)
    || [...current.active.values()].some(path => overlaps(path, root))) fail("Clean publication workspace is occupied");
  current.active.set(claimId, root); cleanWorkspaceClaims.set(permit, { runtime, claimId, root, active: current.active });
}
/** Caller removes the claim only after the actual publisher confirms settlement. */
export function releaseCleanValidationClaim(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedCleanValidationRelease, claimId: string): void {
  const saved = cleanWorkspaceClaims.get(permit);
  if (!saved || saved.runtime !== runtime || saved.claimId !== claimId || saved.active.get(claimId) !== saved.root)
    fail("Clean publication claim is not owned by this original release");
  // A committed retry receipt may already have replaced the latest publication
  // permit. Cleanup owns this exact old claim, not permission to publish again.
  saved.active.delete(claimId); cleanWorkspaceClaims.delete(permit);
}
export function withWindowsCleanReleaseOperation<T>(runtime: PreparedWindowsCleanValidationRuntime, permit: PreparedCleanValidationRelease, work: () => T): T {
  const saved = cleanReleases.get(permit);
  if (!saved || saved.runtime !== runtime) fail("Clean publication scope requires its exact original release permit");
  return withWindowsCleanValidationOperation(runtime, { operationId: saved.request.release_id,
    bindingDigest: hash(saved.request), serverOperation: { kind: "release", operation_id: saved.request.release_id, request_digest: hash(saved.request) } },
  () => { readPreparedCleanValidationRelease(permit); return work(); });
}

/** Authenticated controllers capture this scope around both initial commands and
 * retained tool callbacks. It grants complete Job-subtree ownership, not settlement. */
function withWindowsCleanValidationOperation<T>(runtime: PreparedWindowsCleanValidationRuntime,
  descriptor: Parameters<typeof withWindowsGuardianOperation>[1], work: () => T): T {
  const saved = runtimes.get(runtime); if (!saved) fail("Original clean validation runtime required");
  // Only private original objects select the owner. Capability/profile checks
  // may need fixed observers, so perform every full check inside that scope.
  return withWindowsSourceRecoveryOperation(saved.source, descriptor, () => { runtimeState(runtime); return work(); });
}
/** Publisher isolation only. This original current checkpoint can fence old publication
 * replay but cannot grant a release. Source bytes may legitimately change during the
 * fresh author attempt, so this getter never compares them to the interrupted subject. */
export function readWindowsCleanValidationPublicationFence(runtime: PreparedWindowsCleanValidationRuntime) {
  const current = runtimeState(runtime), workspace = current.checkpoint, saved = readCleanDaemonCheckpoint(workspace);
  const assertCurrent = () => {
    const latest = runtimeState(runtime);
    if (latest.checkpoint !== workspace || latest.epochId !== current.epochId) fail("Clean publication isolation belongs to another current epoch");
    readCleanDaemonCheckpoint(workspace);
  };
  assertCurrent(); return Object.freeze({ checkpoint: workspace, generationId: saved.grant.generation_id, lineageId: saved.grant.lineage_id,
    predecessorOperations: current.predecessorOperations, workspaceRoot: saved.profile.workspace_root,
    projectId: saved.profile.project_id, assertCurrent });
}
export function runImportedCleanValidation(...args: Parameters<typeof executeImportedCleanValidation>) {
  const [runtime, permit] = args, owner = validationOwners.get(permit);
  if (!owner || owner.runtime !== runtime) fail("Original clean author reservation required");
  return withWindowsCleanValidationOperation(runtime, { operationId: owner.control.validation_id, bindingDigest: owner.control.request_digest,
    serverOperation: { kind: "validation", operation_id: owner.control.validation_id, request_digest: owner.control.request_digest, run_id: owner.control.run_id } },
  () => executeImportedCleanValidation(...args));
}
export function runImportedCleanValidationReview(...args: Parameters<typeof executeImportedCleanValidationReview>) {
  const [runtime, permit] = args, owner = validationReviewOwners.get(permit);
  if (!owner || owner.runtime !== runtime) fail("Original clean review reservation required");
  return withWindowsCleanValidationOperation(runtime, { operationId: owner.control.review_id, bindingDigest: owner.control.request_digest,
    serverOperation: { kind: "validation_review", operation_id: owner.control.review_id, request_digest: owner.control.request_digest } },
  () => executeImportedCleanValidationReview(...args));
}
