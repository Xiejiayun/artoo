import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ContextPackSchema, RunStartPayloadSchema, RunVerificationPayloadSchema, NodeOwnedResultProfileDescriptorV1Schema, NodeOwnedResultProfileDescriptorsV1Schema,
  NodeOwnedResultVerificationEvidenceV1Schema, OwnedResultRequirementV1Schema, OwnedResultAuthorBindingV1Schema,
  canonicalOwnedResultAuthorContextV1, canonicalOwnedResultRequirementV1, canonicalOwnedResultVerificationIntentV1,
  projectOwnedResultCommandVerificationV1, assertOwnedResultEvidenceMatchesExpectedV1, OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST,
  type NodeOwnedResultProfileDescriptorV1, type NodeOwnedResultVerificationEvidenceV1, type OwnedResultRequirementV1,
  type OwnedResultRunAdmissionV1, type RunStartPayload, type RunVerificationPayload } from "@artoo/domain";
import { snapshotOwnedResultRunAdmission as exactRunRequest } from "./owned-result-admission.js";
export { OwnedResultRunAdmissionV1Schema, type OwnedResultRunAdmissionV1 } from "@artoo/domain";
import { prepareVerificationProfiles, runVerification, subjectManifest, verificationSupported, VerificationCleanupError,
  type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";
import { executeOwnedResultVerificationTarget, executeOwnedResultVerificationTargetDurably, authenticateSealedOwnedVerificationReceipt,
  OwnedResultVerificationCleanupError, WorktreeResultReferenceSchema, describeOwnedResultStore, readOwnedResultProjectionFacts, bindOwnedResultExecutionStore,
  type BoundOwnedResultExecutionStore, type CaptureWorktreeResult,
  type OwnedResultProjectionStoreBinding, type OwnedResultStoreDescription,
  type OwnedResultVerificationBinding, type OwnedResultVerificationTarget, type WorktreeResultReference } from "./owned/worktree-results.js";
import { allocationStartBinding } from "./node-allocation-identity.js";
import { getOwnedWorkspaceClosure, getOwnedWorkspaceLaunchProof, getOwnedWorkspaceAuthorOutcome } from "./process-adapter.js";
import type { MaterializedWorktree } from "./owned/worktree-reservation.js";
import type { TerminalSettlement } from "./managed/journal-types.js";
import { OwnedVerificationIntentSchema, OwnedVerificationExecutionSchema, ownedVerificationDigest, canonicalOwnedVerification,
  type OwnedVerificationIntent, type OwnedVerificationExecution, type OwnedVerificationLookup, type SealedOwnedVerificationReceipt,
  type OwnedWorktreeVerificationEvidence } from "./owned/worktree-verification-contract.js";
export type { OwnedWorktreeVerificationEvidence } from "./owned/worktree-verification-contract.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const text = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const absolutePath = text.refine(value => isAbsolute(value) && resolve(value) === value, "Expected a canonical absolute path");
const path = z.string().min(1).max(1024).refine(value => !isAbsolute(value) && !value.includes("\\") && !value.includes(":")
  && !/[\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"));

/** Protected node-local configuration. No wire/context/task field selects a command. */
export const OwnedWorktreeVerificationTemplateSchema = z.object({
  version: z.literal(1), id, node_id: id, project_id: id,
  results_profile_id: id, results_profile_digest: digest,
  repository_root: absolutePath, allocation_base: absolutePath,
  commands: z.array(z.object({ id, argv: z.array(text).min(1).max(128), timeout_ms: z.number().int().min(1).max(600_000) }).strict()).min(1).max(32),
  subject_paths: z.array(path).min(1).max(128), required_files: z.array(path).max(128),
}).strict();
export type OwnedWorktreeVerificationTemplateConfig = z.infer<typeof OwnedWorktreeVerificationTemplateSchema>;
/** Metadata is inspectable; only the original object is a prepared local authority. */
export interface PreparedOwnedWorktreeVerificationTemplate {
  readonly version: 1;
  readonly id: string;
  readonly digest: string;
}
interface TemplateAuthority {
  config: OwnedWorktreeVerificationTemplateConfig;
  baseline: PreparedVerificationProfile;
  repositoryIdentity: string;
  allocationIdentity: string;
}
const templates = new WeakMap<PreparedOwnedWorktreeVerificationTemplate, TemplateAuthority>();
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const within = (value: string, root: string) => {
  const suffix = relative(root, value);
  return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
};
function fail(message: string): never { throw new Error(`Owned worktree verification: ${message}`); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function directoryIdentity(value: string): string {
  const stat = lstatSync(value, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(value) !== value
    || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n) fail("a protected canonical owned directory is required");
  return `${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
}
function rawProfile(config: OwnedWorktreeVerificationTemplateConfig, root: string): VerificationProfile {
  return { id: config.id, project_id: config.project_id, workspace_root: root,
    commands: structuredClone(config.commands), subject_paths: [...config.subject_paths], required_files: [...config.required_files] };
}
function program(profile: PreparedVerificationProfile) {
  return { id: profile.id, project_id: profile.project_id, commands: profile.commands,
    subject_paths: profile.subject_paths, required_files: profile.required_files, trustedFiles: profile.trustedFiles };
}
function assertTemplate(authority: TemplateAuthority): void {
  const { config } = authority;
  if (directoryIdentity(config.repository_root) !== authority.repositoryIdentity
    || directoryIdentity(config.allocation_base) !== authority.allocationIdentity) fail("template directory identity changed");
  const current = prepareVerificationProfiles([rawProfile(config, config.repository_root)])[0]!;
  if (current.digest !== authority.baseline.digest || !isDeepStrictEqual(program(current), program(authority.baseline))) {
    fail("protected verifier changed after template preparation");
  }
}

/** Uses the ordinary verifier's validated program preparation, while keeping its root-sensitive digest semantics intact. */
export function prepareOwnedWorktreeVerificationTemplate(input: OwnedWorktreeVerificationTemplateConfig): PreparedOwnedWorktreeVerificationTemplate {
  if (!verificationSupported()) fail("only Linux/macOS owned verification is supported");
  const config = freeze(OwnedWorktreeVerificationTemplateSchema.parse(input));
  const repositoryIdentity = directoryIdentity(config.repository_root), allocationIdentity = directoryIdentity(config.allocation_base);
  if (within(config.repository_root, config.allocation_base) || within(config.allocation_base, config.repository_root)) {
    fail("repository and verification allocation base must not overlap");
  }
  const baseline = prepareVerificationProfiles([rawProfile(config, config.repository_root)])[0]!;
  if (baseline.trustedFiles.some(file => within(file.path, config.allocation_base))) fail("verifier files must be outside every verification allocation");
  const prepared = Object.freeze({ version: 1 as const, id: config.id,
    digest: sha(JSON.stringify({ version: 1, config, protected_program_digest: baseline.digest })) });
  templates.set(prepared, { config, baseline, repositoryIdentity, allocationIdentity });
  return prepared;
}

function projectionBinding(authority: TemplateAuthority): OwnedResultProjectionStoreBinding {
  const config = authority.config;
  return { node_id: config.node_id, project_id: config.project_id, results_profile_id: config.results_profile_id,
    results_profile_digest: config.results_profile_digest, repository_root: config.repository_root, subject_paths: [...config.subject_paths] };
}
function publicDescriptor(template: PreparedOwnedWorktreeVerificationTemplate,
  description: OwnedResultStoreDescription): NodeOwnedResultProfileDescriptorV1 {
  return freeze(NodeOwnedResultProfileDescriptorV1Schema.parse({ version: 1, ...description,
    verifier_template: { id: template.id, digest: template.digest }, workspace_strategy: "per-run", verification_mode: "plain-commands",
    verification_context_policy: { version: 1, mode: "none" },
    scope: "authored-result command verification; no product-stage, review or publication acceptance" }));
}

/** Local routing metadata, derived only from the original opened store/template.
 * It does not activate a node capability, issue a writer, or authorize publication. */
export async function describeOwnedResultProfile(store: unknown,
  template: PreparedOwnedWorktreeVerificationTemplate): Promise<NodeOwnedResultProfileDescriptorV1> {
  const authority = templates.get(template);
  if (!authority) fail("a genuine locally prepared template is required");
  assertTemplate(authority);
  const description = await describeOwnedResultStore(store, projectionBinding(authority));
  assertTemplate(authority);
  return publicDescriptor(template, description);
}

export interface ProjectOwnedResultVerificationInput {
  store: unknown;
  requirement: OwnedResultRequirementV1;
  /** Expected original assignment; authenticated signed source proof must match it. */
  run_start: RunStartPayload;
  verification: SealedOwnedVerificationReceipt;
}
const projections = new WeakSet<NodeOwnedResultVerificationEvidenceV1>();
/** Authenticates only the original local projection object. Serialization loses
 * this authority; future transport must use its own connection/assignment checks. */
export function authenticateProjectedOwnedResultVerification(value: unknown): NodeOwnedResultVerificationEvidenceV1 {
  if (!value || typeof value !== "object" || !projections.has(value as NodeOwnedResultVerificationEvidenceV1)) {
    fail("an original locally projected result verification is required");
  }
  return value as NodeOwnedResultVerificationEvidenceV1;
}

/** Historical public projection. The original sealed receipt is reread from the
 * genuine store under one lease; writer/target authorities are never reconstructed. */
export async function projectOwnedResultVerification(template: PreparedOwnedWorktreeVerificationTemplate,
  input: ProjectOwnedResultVerificationInput): Promise<NodeOwnedResultVerificationEvidenceV1> {
  const authority = templates.get(template);
  if (!authority) fail("a genuine locally prepared template is required");
  // Capture the entire expected assignment before any asynchronous observation.
  const requirement = freeze(OwnedResultRequirementV1Schema.parse(structuredClone(input.requirement)));
  const start = freeze(structuredClone(input.run_start)), store = input.store, original = input.verification;
  // This is structural allocation validation, not a transport/ACK attestation.
  const launch = allocationStartBinding(start, process.platform, true);
  if (!launch || !launch.payload.context_pack.payload || ownedVerificationDigest(launch.payload) !== ownedVerificationDigest(start)) {
    fail("an exact supported per-run author start snapshot is required");
  }
  const context = launch.payload.context_pack.payload;
  const contextDigest = sha(canonicalOwnedResultAuthorContextV1(context));
  if (context.project.id !== authority.config.project_id || contextDigest !== requirement.author_context_digest) {
    fail("author context differs from the selected project or frozen requirement");
  }
  const author = freeze(OwnedResultAuthorBindingV1Schema.parse({ run_id: launch.payload.run_id, task_id: launch.payload.task_id,
    agent_instance_id: launch.payload.agent_instance_id, runtime: launch.payload.runtime,
    launch_binding_digest: `sha256:${launch.key}`, author_context_digest: contextDigest, workspace: launch.payload.workspace }));
  assertTemplate(authority);
  const facts = await readOwnedResultProjectionFacts(store, projectionBinding(authority), original);
  assertTemplate(authority);
  const descriptor = publicDescriptor(template, facts.description), result = facts.result;
  const receipt = facts.verification.receipt, intent = receipt.intent, source = result.source, proof = source?.launch_proof;
  if (!isDeepStrictEqual(requirement.profile, descriptor)) fail("requirement differs from the original store/template descriptor");
  if (!source || !proof || source.run_id !== author.run_id || source.task_id !== author.task_id
    || source.agent_instance_id !== author.agent_instance_id || source.runtime !== author.runtime
    || source.workspace_root !== author.workspace.root || source.workspace_branch !== author.workspace.branch
    || source.launch_key !== launch.key || proof.launch_binding_digest !== author.launch_binding_digest
    || proof.author_context_digest !== contextDigest || proof.context_pack_id !== launch.payload.context_pack.id) {
    fail("signed actual author launch provenance differs from the exact expected start");
  }
  // rendered_context is independently signed evidence of the bytes checked at
  // spawn. Its digest is deliberately not substituted for the ContextPack digest.
  const expectedTemplate = { id: template.id, digest: template.digest, node_id: descriptor.node_id, project_id: descriptor.project_id };
  const expectedResult = { reference: result.reference, profile_id: descriptor.result_profile.id,
    profile_digest: result.profile_digest, repository_binding: result.repository_binding,
    commit: result.commit, tree: result.tree, manifest_digest: result.manifest_digest };
  if (intent.request_id !== requirement.request_id || intent.materialization_request_id !== requirement.verification_materialization_request_id
    || intent.context_digest !== OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST
    || receipt.execution.context_digest !== OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST
    || receipt.profile_digest !== descriptor.result_profile.digest || receipt.repository_binding !== descriptor.result_profile.repository_binding
    || result.reference.result_id !== requirement.capture_request_id || !isDeepStrictEqual(intent.template, expectedTemplate)
    || !isDeepStrictEqual(intent.result, { reference: result.reference, profile_id: descriptor.result_profile.id, profile_digest: result.profile_digest })
    || !isDeepStrictEqual(receipt.evidence.result, expectedResult)) {
    fail("durable verification differs from the exact selected result, template or plain-command intent");
  }
  const projected = NodeOwnedResultVerificationEvidenceV1Schema.parse({ version: 1, kind: "authored-result-verification",
    requirement, requirement_digest: sha(canonicalOwnedResultRequirementV1(requirement)), author, template: expectedTemplate,
    result: { kind: result.kind, ...expectedResult, base_commit: result.base_commit, inputs: result.inputs },
    verification: { receipt: facts.verification.reference, intent_digest: receipt.request_digest, workspace: intent.workspace,
      execution: receipt.execution, payload: projectOwnedResultCommandVerificationV1(receipt.evidence.verification) },
    scope: "historical plain-command node evidence; no product-stage, independent review or publication acceptance" });
  if (sha(canonicalOwnedResultVerificationIntentV1(projected)) !== receipt.request_digest) fail("public intent reconstruction differs from its durable request digest");
  // Here accepted_input is only the exact node-store input fact. Service-level
  // acceptance remains a future server check; projection grants no such status.
  const evidence = freeze(assertOwnedResultEvidenceMatchesExpectedV1(projected,
    { descriptor, requirement, author, ...(facts.input ? { accepted_input: facts.input } : {}) }, sha));
  assertTemplate(authority);
  projections.add(evidence);
  return evidence;
}

/** Registry metadata is public; selection requires the original node-local token. */
export interface PreparedOwnedResultProfiles { readonly version: 1; readonly node_id: string; readonly descriptors: readonly NodeOwnedResultProfileDescriptorV1[] }
interface ProfileEntry { store: unknown; template: PreparedOwnedWorktreeVerificationTemplate; descriptor: NodeOwnedResultProfileDescriptorV1 }
const profileRegistries = new WeakMap<PreparedOwnedResultProfiles, readonly ProfileEntry[]>();
export async function prepareOwnedResultProfiles(nodeId: string,
  entries: readonly { store: unknown; template: PreparedOwnedWorktreeVerificationTemplate }[]): Promise<PreparedOwnedResultProfiles> {
  id.parse(nodeId);
  if (!entries.length || entries.length > 64) fail("a bounded nonempty local result profile list is required");
  const selected: ProfileEntry[] = [], identities = new Set<string>();
  for (const entry of [...entries]) {
    const store = entry.store, template = entry.template, descriptor = await describeOwnedResultProfile(store, template);
    const key = canonicalOwnedVerification(descriptor);
    if (descriptor.node_id !== nodeId || identities.has(key)) fail("result profile node differs or descriptor is duplicated");
    identities.add(key); selected.push(Object.freeze({ store, template, descriptor }));
  }
  const token = freeze({ version: 1 as const, node_id: nodeId, descriptors: NodeOwnedResultProfileDescriptorsV1Schema.parse(selected.map(entry => entry.descriptor)) });
  profileRegistries.set(token, Object.freeze(selected)); return token;
}
export function readOwnedResultProfileDescriptors(token: PreparedOwnedResultProfiles, nodeId: string): readonly NodeOwnedResultProfileDescriptorV1[] {
  if (!profileRegistries.has(token) || token.node_id !== nodeId) fail("an original result profile registry for this node is required");
  return token.descriptors;
}
export function selectOwnedResultProfile(token: PreparedOwnedResultProfiles, nodeId: string,
  descriptor: NodeOwnedResultProfileDescriptorV1): { store: unknown; template: PreparedOwnedWorktreeVerificationTemplate } {
  readOwnedResultProfileDescriptors(token, nodeId);
  const entry = profileRegistries.get(token)!.find(candidate => isDeepStrictEqual(candidate.descriptor, descriptor));
  if (!entry) fail("the requested descriptor is not a configured local result profile");
  return Object.freeze({ store: entry.store, template: entry.template });
}
export interface PreparedOwnedResultRun {
  readonly version: 1;
  /** Full request identity; deliberately distinct from the existing allocation key. */
  readonly admission_digest: string;
  readonly author_launch_digest: string;
  readonly request: OwnedResultRunAdmissionV1;
}
type AuthorSource = Pick<CaptureWorktreeResult, "worktree" | "admission" | "handle" | "closure">;
export interface OwnedResultFinalizationV1 extends TerminalSettlement {
  readonly version: 1;
  readonly kind: "owned-result-finalization.v1";
  readonly admission_digest: string;
  /** Node-owned only. Never accepted through RuntimeAdapter or generic appendEvent. */
  readonly evidence_event: { readonly type: "run.owned-result.verification"; readonly payload: NodeOwnedResultVerificationEvidenceV1 };
}
interface RunFinalizationAuthority {
  store: unknown; template: PreparedOwnedWorktreeVerificationTemplate; authority: TemplateAuthority; bridge: BoundOwnedResultExecutionStore;
  materializationId: string; verificationRoot: string; verificationBranch: string;
  materializing?: Promise<MaterializedWorktree>; materializationSignal?: AbortSignal; worktree?: MaterializedWorktree;
  source?: Readonly<AuthorSource>; finalizationSignal?: AbortSignal; finalizing?: Promise<OwnedResultFinalizationV1>;
}
const ownedRuns = new WeakMap<PreparedOwnedResultRun, RunFinalizationAuthority>();
const runClaims = new WeakMap<object, Map<string, { digest: string; run: WeakRef<PreparedOwnedResultRun> }>>();
const finalizations = new WeakMap<OwnedResultFinalizationV1, PreparedOwnedResultRun>();
export function authenticatePreparedOwnedResultRun(value: unknown): PreparedOwnedResultRun {
  if (!value || typeof value !== "object" || !ownedRuns.has(value as PreparedOwnedResultRun)) fail("an original prepared owned result run is required");
  return value as PreparedOwnedResultRun;
}

/** Binds genuine local authorities and the entire immutable request. Repreparing
 * a retained run cannot manufacture another writer or ignore a changed requirement. */
export async function prepareOwnedResultRun(store: unknown, template: PreparedOwnedWorktreeVerificationTemplate,
  raw: OwnedResultRunAdmissionV1): Promise<PreparedOwnedResultRun> {
  const authority = templates.get(template);
  if (!authority) fail("a genuine locally prepared template is required");
  const bridge = bindOwnedResultExecutionStore(store, projectionBinding(authority));
  const { request, launch, digest: admissionDigest } = exactRunRequest(raw);
  const descriptor = await describeOwnedResultProfile(store, template);
  if (!isDeepStrictEqual(request.requirement.profile, descriptor)) fail("owned result admission differs from the original profile descriptor");
  const materializationId = `author_${admissionDigest.slice(7)}`;
  const ids = [request.requirement.request_id, request.requirement.capture_request_id, request.requirement.verification_materialization_request_id,
    ...(request.requirement.input.kind === "result" ? [request.requirement.input.reference.result_id] : [])];
  if (ids.includes(materializationId)) fail("derived author materialization ID collides with a selected operation");
  const verificationRoot = join(authority.config.allocation_base, request.requirement.verification_materialization_request_id);
  const verificationBranch = `artoo/result-verify-${request.requirement.verification_materialization_request_id}`;
  if (within(verificationRoot, request.run_start.workspace.root) || within(request.run_start.workspace.root, verificationRoot)
    || request.run_start.workspace.branch === verificationBranch) fail("author and verifier allocations must remain separate");
  if (within(request.run_start.workspace.root, authority.config.allocation_base) || within(authority.config.allocation_base, request.run_start.workspace.root)
    || authority.baseline.trustedFiles.some(file => within(file.path, request.run_start.workspace.root))) {
    fail("author workspace overlaps protected verification allocations or programs");
  }
  assertTemplate(authority);
  const originalStore = store as object, claims = runClaims.get(originalStore) ?? new Map<string, { digest: string; run: WeakRef<PreparedOwnedResultRun> }>();
  const previous = claims.get(request.run_start.run_id);
  if (previous) {
    if (previous.digest !== admissionDigest) fail("owned result run already has a different full admission binding");
    const retained = previous.run.deref();
    if (!retained) fail("previous owned result run authority is no longer live; no writer recovery is granted");
    return retained;
  }
  const prepared = freeze({ version: 1 as const, admission_digest: admissionDigest, author_launch_digest: `sha256:${launch.key}`, request });
  ownedRuns.set(prepared, { store, template, authority, bridge, materializationId, verificationRoot, verificationBranch });
  claims.set(request.run_start.run_id, { digest: admissionDigest, run: new WeakRef(prepared) }); runClaims.set(originalStore, claims);
  return prepared;
}

/** Exactly one fixed-baseline/input materialization. A failure retains its
 * original promise and cannot silently retry against current repository HEAD. */
export function materializeOwnedResultRun(run: PreparedOwnedResultRun, signal: AbortSignal): Promise<MaterializedWorktree> {
  const state = ownedRuns.get(run);
  if (!state) return Promise.reject(new Error("An original prepared owned result run is required"));
  if (!(signal instanceof AbortSignal)) return Promise.reject(new Error("An actual author materialization AbortSignal is required"));
  if (state.finalizing) return Promise.reject(new Error("Owned result finalization already claimed this writer"));
  if (state.materializing) return signal === state.materializationSignal ? state.materializing
    : Promise.reject(new Error("Author materialization already has its original cancellation signal"));
  // Install the promise synchronously; concurrent calls share the original work.
  state.materializationSignal = signal;
  state.materializing = Promise.resolve().then(async () => {
    signal.throwIfAborted(); assertTemplate(state.authority);
    const worktree = await state.bridge.materializeAuthor({ request_id: state.materializationId,
      run_start: run.request.run_start, input: run.request.requirement.input }, signal);
    assertTemplate(state.authority); signal.throwIfAborted();
    state.worktree = worktree;
    return worktree;
  });
  return state.materializing;
}

/** The future journal facade must supply its complete private admitted request
 * and current Stop latch. Metadata or a caller-provided digest cannot issue a bundle. */
export function authenticateOwnedResultFinalization(value: unknown, expected: OwnedResultRunAdmissionV1,
  options: { stopRequested: boolean }): OwnedResultFinalizationV1 {
  if (!value || typeof value !== "object") fail("an original owned result finalization is required");
  const result = value as OwnedResultFinalizationV1, owner = finalizations.get(result);
  const state = owner && ownedRuns.get(owner);
  if (!owner || !state) fail("an original owned result finalization is required");
  const checked = exactRunRequest(expected);
  if (checked.digest !== owner.admission_digest || result.admission_digest !== checked.digest
    || result.evidence_event.payload.author.run_id !== checked.request.run_start.run_id
    || result.evidence_event.payload.author.launch_binding_digest !== `sha256:${checked.launch.key}`
    || result.evidence_event.payload.requirement_digest !== sha(canonicalOwnedResultRequirementV1(checked.request.requirement))) {
    fail("finalization differs from the current run's complete admission");
  }
  if (result.terminal.payload.phase === "completed" && (options.stopRequested !== false
    || state.materializationSignal?.aborted !== false || state.finalizationSignal?.aborted !== false)) {
    fail("Stop or original-signal cancellation forbids completed result settlement");
  }
  authenticateProjectedOwnedResultVerification(result.evidence_event.payload);
  return result;
}

/** Real author closure -> capture -> protected durable verifier -> public evidence.
 * Unknown cleanup/persistence rejects and retains state; it produces no terminal bundle. */
export function finalizeOwnedResultRun(run: PreparedOwnedResultRun,
  input: AuthorSource & { signal: AbortSignal }): Promise<OwnedResultFinalizationV1> {
  const state = ownedRuns.get(run);
  if (!state) return Promise.reject(new Error("An original prepared owned result run is required"));
  const source = Object.freeze({ worktree: input.worktree, admission: input.admission, handle: input.handle, closure: input.closure });
  if (!state.worktree || source.worktree !== state.worktree || !(input.signal instanceof AbortSignal)) {
    return Promise.reject(new Error("Finalization requires its original materialized writer and actual signal"));
  }
  if (state.finalizing) {
    if (input.signal !== state.finalizationSignal || !state.source
      || Object.keys(source).some(key => source[key as keyof AuthorSource] !== state.source![key as keyof AuthorSource])) {
      return Promise.reject(new Error("Finalization is already bound to another author source"));
    }
    return state.finalizing;
  }
  if (state.materializationSignal?.aborted !== false) return Promise.reject(new Error("Original author materialization was cancelled"));
  const closure = getOwnedWorkspaceClosure(source.closure, source.admission, source.handle, source.worktree);
  const proof = getOwnedWorkspaceLaunchProof(source.closure, source.admission, source.handle, source.worktree);
  if (!closure || !proof || proof.launch_binding_digest !== run.author_launch_digest
    || proof.author_context_digest !== run.request.requirement.author_context_digest
    || closure.identity.runId !== run.request.run_start.run_id || proof.context_pack_id !== run.request.run_start.context_pack.id) {
    return Promise.reject(new Error("Finalization requires actual closure and exact original author launch provenance"));
  }
  if (getOwnedWorkspaceAuthorOutcome(source.closure, source.admission, source.handle, source.worktree)?.phase !== "completed") {
    return Promise.reject(new Error("Owned result finalization requires an actually completed author; failed or cancelled authors cannot be upgraded by verification"));
  }
  const signal = AbortSignal.any([state.materializationSignal!, input.signal]);
  state.source = source; state.finalizationSignal = input.signal;
  state.finalizing = Promise.resolve().then(async () => {
    signal.throwIfAborted(); assertTemplate(state.authority);
    const requirement = run.request.requirement;
    const captured = await state.bridge.capture({ ...source, request_id: requirement.capture_request_id,
      ...(requirement.input.kind === "result" ? { input: requirement.input.reference } : {}) });
    signal.throwIfAborted();
    const verification = await verifyOwnedWorktreeResultDurably(state.template, { store: state.bridge,
      request_id: requirement.request_id, materialization_request_id: requirement.verification_materialization_request_id,
      reference: captured.reference, root: state.verificationRoot, branch: state.verificationBranch, signal });
    const evidence = await projectOwnedResultVerification(state.template, { store: state.store,
      requirement, run_start: run.request.run_start, verification });
    const outcome = evidence.verification.payload.outcome;
    const phase = signal.aborted || outcome === "cancelled" ? "cancelled" : outcome === "passed" ? "completed" : "failed";
    const result: OwnedResultFinalizationV1 = freeze({ version: 1, kind: "owned-result-finalization.v1", admission_digest: run.admission_digest,
      evidence_event: { type: "run.owned-result.verification", payload: evidence },
      terminal: { type: "run.lifecycle", payload: { phase, ...(phase === "completed" ? {} : { reason: phase === "cancelled"
        ? "owned_result_cancelled" : outcome === "timed_out" ? "owned_result_verification_timed_out" : "owned_result_verification_failed" }) } },
      retentionOutcome: phase });
    finalizations.set(result, run);
    return result;
  });
  return state.finalizing;
}

interface ResultStore {
  materializeForVerification(input: { request_id: string; reference: WorktreeResultReference; root: string; branch: string }): Promise<OwnedResultVerificationTarget>;
}
interface DurableResultStore extends ResultStore {
  lookupVerification(intent: OwnedVerificationIntent): Promise<OwnedVerificationLookup>;
}
export interface VerifyOwnedWorktreeResultInput {
  store: ResultStore;
  request_id: string;
  materialization_request_id: string;
  reference: WorktreeResultReference;
  root: string;
  branch: string;
  signal: AbortSignal;
  context?: RunStartPayload["context_pack"]["payload"];
}
const candidates = new WeakMap<OwnedWorktreeVerificationEvidence, { target: OwnedResultVerificationTarget;
  intent: OwnedVerificationIntent; execution: OwnedVerificationExecution }>();
/** Read-only candidate bridge. The store must still postcheck its target before sealing; there is no public issuer. */
export function authenticateOwnedVerificationCandidate(value: unknown, target: OwnedResultVerificationTarget,
  intent: OwnedVerificationIntent, execution: OwnedVerificationExecution): OwnedWorktreeVerificationEvidence {
  if (!value || typeof value !== "object") fail("an original node-issued verification candidate is required");
  const saved = candidates.get(value as OwnedWorktreeVerificationEvidence);
  if (!saved || saved.target !== target || canonicalOwnedVerification(saved.intent) !== canonicalOwnedVerification(intent)
    || canonicalOwnedVerification(saved.execution) !== canonicalOwnedVerification(execution)) fail("an original exactly bound node-issued verification candidate is required");
  return value as OwnedWorktreeVerificationEvidence;
}
function assertBinding(authority: TemplateAuthority, binding: OwnedResultVerificationBinding,
  expected: { reference: WorktreeResultReference; root: string; branch: string }): void {
  const { config } = authority;
  if (binding.node_id !== config.node_id || binding.project_id !== config.project_id || binding.profile_id !== config.results_profile_id
    || binding.profile_digest !== config.results_profile_digest || binding.repository_root !== config.repository_root
    || binding.workspace_root !== expected.root || binding.workspace_branch !== expected.branch
    || !isDeepStrictEqual(binding.result.reference, expected.reference)) fail("materialization does not match the protected template and exact request");
  // The verifier covers the whole scoped result. Executable flags and empty
  // directories additionally remain under the result store's manifest checks.
  if (!isDeepStrictEqual([...binding.content_paths].sort(), [...config.subject_paths].sort())) {
    fail("verifier subject paths must exactly cover the result profile's content paths");
  }
}

/** Creates a fresh verification-only checkout internally. It never accepts a caller's writer handle or source directory. */
export async function verifyOwnedWorktreeResult(template: PreparedOwnedWorktreeVerificationTemplate,
  input: VerifyOwnedWorktreeResultInput): Promise<OwnedWorktreeVerificationEvidence> {
  return executeVerification(template, input, false);
}

/** Opt-in durable path. Restart replays authenticated historical receipts; it never recovers a writer or reruns a retained attempt. */
export async function verifyOwnedWorktreeResultDurably(template: PreparedOwnedWorktreeVerificationTemplate,
  input: VerifyOwnedWorktreeResultInput & { store: DurableResultStore }): Promise<SealedOwnedVerificationReceipt> {
  return executeVerification(template, input, true);
}

function executeVerification(template: PreparedOwnedWorktreeVerificationTemplate, input: VerifyOwnedWorktreeResultInput,
  durable: false): Promise<OwnedWorktreeVerificationEvidence>;
function executeVerification(template: PreparedOwnedWorktreeVerificationTemplate, input: VerifyOwnedWorktreeResultInput & { store: DurableResultStore },
  durable: true): Promise<SealedOwnedVerificationReceipt>;
async function executeVerification(template: PreparedOwnedWorktreeVerificationTemplate, input: VerifyOwnedWorktreeResultInput,
  durable: boolean): Promise<OwnedWorktreeVerificationEvidence | SealedOwnedVerificationReceipt> {
  const authority = templates.get(template);
  if (!authority) fail("a genuine locally prepared template is required");
  const requestId = id.parse(input.request_id), materializationId = id.parse(input.materialization_request_id);
  const reference = WorktreeResultReferenceSchema.parse(input.reference), root = absolutePath.parse(input.root), branch = text.parse(input.branch);
  const signal = input.signal, context = input.context === undefined ? undefined : ContextPackSchema.parse(structuredClone(input.context));
  if (!(signal instanceof AbortSignal)) fail("an actual AbortSignal is required");
  if (root === authority.config.allocation_base || !within(root, authority.config.allocation_base)) fail("verification root is outside its configured allocation base");
  if (context && (context.project.id !== authority.config.project_id || context.workspace.root !== root)) fail("context project or workspace differs from the verification target");
  // Dynamic capability/measurement/release bindings need their own versioned
  // protocol. This local first slice must not reinterpret ordinary bindings.
  if (context?.verification_capabilities || context?.release_capabilities || context?.review_subject
    || context?.policy.execution_mode === "discussion") fail("capability-bound verification, independent review and release are not enabled for result templates");
  const materialize = input.store.materializeForVerification.bind(input.store);
  const lookup = durable ? (input.store as DurableResultStore).lookupVerification.bind(input.store) : undefined;
  const intent = freeze(OwnedVerificationIntentSchema.parse({ version: 1, kind: "owned-result-verification.v1",
    request_id: requestId, materialization_request_id: materializationId,
    template: { id: template.id, digest: template.digest, node_id: authority.config.node_id, project_id: authority.config.project_id },
    result: { reference, profile_id: authority.config.results_profile_id, profile_digest: authority.config.results_profile_digest },
    workspace: { root, branch }, context_digest: ownedVerificationDigest(context ?? null) }));
  signal.throwIfAborted(); assertTemplate(authority);
  if (lookup) {
    const previous = await lookup(intent);
    if (previous.phase === "sealed") return authenticateSealedOwnedVerificationReceipt(previous.sealed, intent);
    if (previous.phase !== "absent") fail(`prior durable verification is ${previous.phase}; retained attempts cannot be resumed`);
  }
  const target = await materialize({ request_id: materializationId, reference, root, branch });
  const run = async (binding: OwnedResultVerificationBinding, admit?: (execution: OwnedVerificationExecution) => void) => {
    signal.throwIfAborted(); assertTemplate(authority); assertBinding(authority, binding, { reference, root, branch });
    const profile = prepareVerificationProfiles([rawProfile(authority.config, root)])[0]!;
    if (!isDeepStrictEqual(program(profile), program(authority.baseline))) fail("allocated verifier program differs from the protected template");
    const execution = admit ? freeze(OwnedVerificationExecutionSchema.parse({ version: 1, request_id: requestId,
      profile_id: profile.id, profile_digest: profile.digest, workspace_root: root,
      subject_digest: subjectManifest(profile).digest, context_digest: intent.context_digest })) : undefined;
    // The durable execution request is synced before the first verifier command can start.
    if (admit && execution) admit(execution);
    let verification: RunVerificationPayload;
    try { verification = await runVerification(profile, requestId, signal, context, execution?.subject_digest); }
    catch (error) {
      if (error instanceof VerificationCleanupError) {
        throw new OwnedResultVerificationCleanupError("Verifier closure is unconfirmed; its result target and repository lease remain fenced", { cause: error });
      }
      throw error;
    }
    assertTemplate(authority);
    // The target executor revalidates the private handle, sealed Git content and
    // full manifest again after this callback and before returning this value.
    const result = binding.result;
    const evidence = freeze({ version: 1 as const,
      template: { id: template.id, digest: template.digest, node_id: authority.config.node_id, project_id: authority.config.project_id },
      result: { reference: structuredClone(result.reference), profile_id: binding.profile_id, profile_digest: binding.profile_digest,
        repository_binding: binding.repository_binding, commit: result.receipt.commit, tree: result.receipt.tree, manifest_digest: result.receipt.manifest.digest },
      workspace: { root, branch }, verification: RunVerificationPayloadSchema.parse(verification),
      scope: "node-local exact-result command verification; not independent review, integration acceptance or publication" as const });
    if (execution) candidates.set(evidence, { target, intent, execution });
    return evidence;
  };
  return durable ? executeOwnedResultVerificationTargetDurably(target, intent, run)
    : executeOwnedResultVerificationTarget(target, run);
}
