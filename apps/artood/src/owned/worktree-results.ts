import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentInstanceHandle } from "@artoo/protocol";
import { RunStartPayloadSchema, type RunStartPayload } from "@artoo/domain";
import { z } from "zod";
import { getOwnedWorkspaceClosure, getOwnedWorkspaceLaunchProof, type OwnedRunAdmission } from "../process-adapter.js";
import { allocationStartBinding } from "../node-allocation-identity.js";
import { provisionRunNamespace } from "./workspace-namespace.js";
import { OwnedGitError, runOwnedGit, type OwnedGitReceipt } from "./owned-git.js";
import { assertOwnedMaterializedWorktree, prepareOwnedWorktree, reserveOwnedWorktree,
  materializeOwnedWorktree, type MaterializedWorktree } from "./worktree-reservation.js";
import { OwnedVerificationIntentSchema, OwnedVerificationExecutionSchema, OwnedVerificationReceiptSchema,
  OwnedVerificationReceiptReferenceSchema, assertOwnedVerificationEvidenceBindings,
  type OwnedVerificationIntent, type OwnedVerificationExecution, type OwnedVerificationLookup, type OwnedVerificationReceiptReference,
  type OwnedWorktreeVerificationEvidence, type SealedOwnedVerificationReceipt } from "./worktree-verification-contract.js";

const MAX_FILES = 512, MAX_BYTES = 8 * 1024 * 1024, MAX_RECORD_BYTES = 16 * 1024 * 1024;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const safeText = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const absolutePath = safeText.refine(value => isAbsolute(value) && resolve(value) === value, "Expected a canonical absolute path");
const sourcePath = z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)
  && !isAbsolute(value) && !value.includes("\\")
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  && !value.startsWith("-"), "Expected a canonical relative content path");

/** Local operator configuration only. This module does not interpret task text or artifact metadata. */
export const WorktreeResultsProfileSchema = z.object({
  version: z.literal(1), id, node_id: id, project_id: id,
  repository_root: absolutePath, state_root: absolutePath, baseline_commit: oid,
  content_paths: z.array(sourcePath).min(1).max(32), allowed_roots: z.array(absolutePath).min(1).max(32),
  git_executable: absolutePath.default("/usr/bin/git"),
}).strict().superRefine((value, ctx) => {
  for (let index = 0; index < value.content_paths.length; index++) {
    const path = value.content_paths[index]!;
    if (value.content_paths.slice(index + 1).some(other => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content_paths"], message: "Content paths must be unique and nonoverlapping" });
    }
  }
});
export type WorktreeResultsProfile = z.input<typeof WorktreeResultsProfileSchema>;
type Profile = z.output<typeof WorktreeResultsProfileSchema>;
export const WorktreeResultReferenceSchema = z.object({ result_id: id, receipt_digest: digest }).strict();
export const WorktreeConflictReferenceSchema = z.object({ operation_id: id, state_digest: digest }).strict();
export type WorktreeResultReference = z.infer<typeof WorktreeResultReferenceSchema>;
export type WorktreeConflictReference = z.infer<typeof WorktreeConflictReferenceSchema>;
type InputReference = WorktreeResultReference | WorktreeConflictReference;
const inputReference = z.union([WorktreeResultReferenceSchema, WorktreeConflictReferenceSchema]);
const fileSchema = z.object({ path: sourcePath, mode: z.enum(["100644", "100755"]), checksum: digest,
  size: z.number().int().min(0).max(MAX_BYTES) }).strict();
const manifestSchema = z.object({ files: z.array(fileSchema).max(MAX_FILES), directories: z.array(sourcePath).max(MAX_FILES), digest }).strict();
export type WorktreeContentManifest = z.infer<typeof manifestSchema>;
type FileFact = z.infer<typeof fileSchema>;
const executionSchema = z.object({ args: z.array(z.string()).max(1024), status: z.number().int(),
  started_at: z.string().datetime(), finished_at: z.string().datetime(), child_exit_observed: z.literal(true),
  child_close_observed: z.literal(true), group_absent: z.literal(true), cleanup_confirmed: z.literal(true),
  parent_guard_confirmed: z.literal(true) }).strict();
type GitEvidence = z.infer<typeof executionSchema>;
const sourceLaunchProofSchema = z.object({ version: z.literal(1), launch_binding_digest: digest, author_context_digest: digest,
  context_pack_id: safeText, rendered_context: z.object({ digest, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict() }).strict();
const sourceSchema = z.object({ launch_key: safeText, run_id: id, task_id: id, agent_instance_id: id, runtime: safeText,
  workspace_root: absolutePath, workspace_branch: safeText, physical_receipt_observed_at: z.string().datetime(),
  result_closure_checked_at: z.string().datetime(),
  closure_scope: z.literal("physical-writer-and-tools-closed; not business success or verification"),
  /** Optional explicit provenance. Old signed sources are never upgraded on read. */
  launch_proof: sourceLaunchProofSchema.optional() }).strict();
const receiptSchema = z.object({ version: z.literal(1), result_id: id, kind: z.enum(["authored", "merged", "resolution"]),
  profile_digest: digest, repository_binding: digest, request_digest: digest, created_at: z.string().datetime(),
  base_commit: oid, commit: oid, tree: oid, parents: z.array(oid).min(1).max(2),
  manifest: manifestSchema, inputs: z.array(WorktreeResultReferenceSchema).max(2),
  source: sourceSchema.optional(), conflict: WorktreeConflictReferenceSchema.optional(),
  commit_content_digest: digest, git: z.array(executionSchema).max(4096),
  scope: z.literal("immutable-scoped-git-content; not verification, review, integration acceptance or publication"),
}).strict();
export type WorktreeResultReceipt = z.infer<typeof receiptSchema>;
export interface SealedWorktreeResult { reference: WorktreeResultReference; receipt: WorktreeResultReceipt }
/** Public shape deliberately carries no MaterializedWorktree or writer admission. */
export interface OwnedResultVerificationTarget {
  readonly version: 1;
  readonly kind: "owned-result-verification-target";
}
export interface OwnedResultVerificationBinding {
  readonly profile_id: string;
  readonly profile_digest: string;
  readonly node_id: string;
  readonly project_id: string;
  readonly repository_root: string;
  readonly repository_binding: string;
  readonly content_paths: readonly string[];
  readonly workspace_root: string;
  readonly workspace_branch: string;
  readonly result: SealedWorktreeResult;
}
/** A verifier with unknown process closure retains the same repository fence as unknown Git closure. */
export class OwnedResultVerificationCleanupError extends Error {}
/** Durable storage outcome is uncertain; this does not assert that a process is still running. */
export class OwnedResultVerificationPersistenceError extends Error {}
type DurableVerificationBody = (binding: OwnedResultVerificationBinding,
  admit: (execution: OwnedVerificationExecution) => void) => Promise<OwnedWorktreeVerificationEvidence>;
interface VerificationTargetAuthority {
  phase: "fresh" | "running" | "closed" | "uncertain";
  execute<T>(body: (binding: OwnedResultVerificationBinding) => Promise<T>): Promise<T>;
  executeDurably(intent: OwnedVerificationIntent, body: DurableVerificationBody): Promise<SealedOwnedVerificationReceipt>;
}
const verificationTargetAuthorities = new WeakMap<OwnedResultVerificationTarget, VerificationTargetAuthority>();
const sealedVerificationReceipts = new WeakSet<SealedOwnedVerificationReceipt>();
const projectionStoreBindingSchema = z.object({ node_id: id, project_id: id, results_profile_id: id,
  results_profile_digest: digest, repository_root: absolutePath, subject_paths: z.array(sourcePath).min(1).max(32) }).strict();
export type OwnedResultProjectionStoreBinding = z.infer<typeof projectionStoreBindingSchema>;
export interface OwnedResultStoreDescription {
  node_id: string; project_id: string;
  result_profile: { id: string; digest: string; repository_binding: string; baseline_commit: string };
  content_paths: string[];
}
export interface OwnedResultProjectionFacts {
  description: OwnedResultStoreDescription;
  verification: SealedOwnedVerificationReceipt;
  result: { reference: WorktreeResultReference; kind: WorktreeResultReceipt["kind"]; profile_digest: string;
    repository_binding: string; base_commit: string; commit: string; tree: string; manifest_digest: string;
    inputs: WorktreeResultReference[]; source?: WorktreeResultReceipt["source"] };
  input?: { reference: WorktreeResultReference; commit: string };
}
interface ProjectionStoreAuthority {
  describe(binding: OwnedResultProjectionStoreBinding): Promise<OwnedResultStoreDescription>;
  read(binding: OwnedResultProjectionStoreBinding, sealed: SealedOwnedVerificationReceipt): Promise<OwnedResultProjectionFacts>;
  materializeAuthor(binding: OwnedResultProjectionStoreBinding, input: OwnedResultAuthorMaterialization, signal: AbortSignal): Promise<MaterializedWorktree>;
  captureAuthor(binding: OwnedResultProjectionStoreBinding, input: CaptureWorktreeResult): Promise<SealedWorktreeResult>;
  materializeVerifier(binding: OwnedResultProjectionStoreBinding, input: OwnedResultVerifierMaterialization): Promise<OwnedResultVerificationTarget>;
  lookupVerification(binding: OwnedResultProjectionStoreBinding, input: OwnedVerificationIntent): Promise<OwnedVerificationLookup>;
}
export interface OwnedResultAuthorMaterialization {
  request_id: string;
  run_start: RunStartPayload;
  input: { kind: "baseline" } | { kind: "result"; reference: WorktreeResultReference };
}
interface OwnedResultVerifierMaterialization { request_id: string; reference: WorktreeResultReference; root: string; branch: string }
export interface BoundOwnedResultExecutionStore {
  materializeAuthor(input: OwnedResultAuthorMaterialization, signal: AbortSignal): Promise<MaterializedWorktree>;
  capture(input: CaptureWorktreeResult): Promise<SealedWorktreeResult>;
  materializeForVerification(input: OwnedResultVerifierMaterialization): Promise<OwnedResultVerificationTarget>;
  lookupVerification(input: OwnedVerificationIntent): Promise<OwnedVerificationLookup>;
}
const projectionStores = new WeakMap<object, ProjectionStoreAuthority>();
function projectionStore(value: unknown): ProjectionStoreAuthority {
  if (!value || typeof value !== "object") return fail("an original locally opened result store is required");
  const found = projectionStores.get(value);
  if (!found) return fail("an original locally opened result store is required");
  return found;
}
/** Local read boundaries use captured private methods, never replaceable public methods. */
export function describeOwnedResultStore(store: unknown, raw: OwnedResultProjectionStoreBinding): Promise<OwnedResultStoreDescription> {
  const authority = projectionStore(store), binding = projectionStoreBindingSchema.parse(raw);
  return authority.describe(binding);
}
export function readOwnedResultProjectionFacts(store: unknown, raw: OwnedResultProjectionStoreBinding,
  value: unknown): Promise<OwnedResultProjectionFacts> {
  const authority = projectionStore(store), binding = projectionStoreBindingSchema.parse(raw);
  if (!value || typeof value !== "object" || !sealedVerificationReceipts.has(value as SealedOwnedVerificationReceipt)) {
    return Promise.reject(new Error("An original authenticated sealed verification receipt is required"));
  }
  return authority.read(binding, value as SealedOwnedVerificationReceipt);
}
/** Captures private store operations. Replacing public methods cannot substitute
 * a source repository, input result, capture receipt or verifier target. */
export function bindOwnedResultExecutionStore(store: unknown, raw: OwnedResultProjectionStoreBinding): BoundOwnedResultExecutionStore {
  const authority = projectionStore(store), binding = projectionStoreBindingSchema.parse(raw);
  return Object.freeze({
    materializeAuthor(input: OwnedResultAuthorMaterialization, signal: AbortSignal) {
      const request = z.object({ request_id: id, run_start: RunStartPayloadSchema,
        input: z.discriminatedUnion("kind", [z.object({ kind: z.literal("baseline") }).strict(),
          z.object({ kind: z.literal("result"), reference: WorktreeResultReferenceSchema }).strict()]) }).strict().parse(input);
      if (!(signal instanceof AbortSignal)) throw new Error("An actual author materialization AbortSignal is required");
      return authority.materializeAuthor(binding, request, signal);
    },
    capture(input: CaptureWorktreeResult) {
      return authority.captureAuthor(binding, { ...sourceSnapshot(input), request_id: id.parse(input.request_id),
        ...(input.input === undefined ? {} : { input: WorktreeResultReferenceSchema.parse(input.input) }) });
    },
    materializeForVerification(input: OwnedResultVerifierMaterialization) {
      return authority.materializeVerifier(binding, { request_id: id.parse(input.request_id), reference: WorktreeResultReferenceSchema.parse(input.reference),
        root: absolutePath.parse(input.root), branch: safeText.parse(input.branch) });
    },
    lookupVerification(input: OwnedVerificationIntent) { return authority.lookupVerification(binding, OwnedVerificationIntentSchema.parse(input)); },
  });
}
function freezeReceipt<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeReceipt(child); Object.freeze(value); }
  return value;
}
function issueVerificationReceipt(receipt: z.infer<typeof OwnedVerificationReceiptSchema>): SealedOwnedVerificationReceipt {
  const sealed = freezeReceipt({ reference: { verification_id: receipt.request_id, receipt_digest: sha(canonical(receipt)) },
    receipt: structuredClone(receipt) });
  sealedVerificationReceipts.add(sealed); return sealed;
}
/** A structural store wrapper cannot inject copied JSON as a historical receipt. */
export function authenticateSealedOwnedVerificationReceipt(value: SealedOwnedVerificationReceipt,
  intent: OwnedVerificationIntent): SealedOwnedVerificationReceipt {
  if (!sealedVerificationReceipts.has(value) || !same(value.receipt.intent, OwnedVerificationIntentSchema.parse(intent))) {
    fail("an original authenticated verification receipt with the exact intent is required");
  }
  return value;
}

/** Node-internal execution boundary. A copied token, receipt, path or ordinary writer handle cannot enter it. */
export async function executeOwnedResultVerificationTarget<T>(target: OwnedResultVerificationTarget,
  body: (binding: OwnedResultVerificationBinding) => Promise<T>): Promise<T> {
  const authority = verificationTargetAuthorities.get(target);
  if (!authority || authority.phase !== "fresh") fail("a fresh genuine verification-only materialization is required");
  return authority.execute(body);
}
/** Node-internal coordinator only. The callback cannot mint a final receipt from arbitrary JSON. */
export async function executeOwnedResultVerificationTargetDurably(target: OwnedResultVerificationTarget,
  raw: OwnedVerificationIntent, body: DurableVerificationBody): Promise<SealedOwnedVerificationReceipt> {
  const intent = OwnedVerificationIntentSchema.parse(raw), authority = verificationTargetAuthorities.get(target);
  if (!authority || authority.phase !== "fresh") fail("a fresh genuine verification-only materialization is required");
  return authority.executeDurably(intent, body);
}
const conflictSchema = z.object({ version: z.literal(1), operation_id: id, profile_digest: digest, repository_binding: digest,
  request_digest: digest, created_at: z.string().datetime(), base_commit: oid, ours: oid, theirs: oid,
  candidate_commit: oid, candidate_tree: oid, commit_content_digest: digest,
  inputs: z.tuple([WorktreeResultReferenceSchema, WorktreeResultReferenceSchema]), manifest: manifestSchema,
  paths: z.array(sourcePath).min(1).max(MAX_FILES), git: z.array(executionSchema).max(4096),
  scope: z.literal("unresolved-git-conflict; not an accepted result"),
}).strict();
export type WorktreeConflict = z.infer<typeof conflictSchema>;
export type WorktreeMergeOutcome = ({ outcome: "candidate" } & SealedWorktreeResult)
  | { outcome: "conflicted"; reference: WorktreeConflictReference; conflict: WorktreeConflict };
const repositorySchema = z.object({ root: absolutePath, common: absolutePath, root_identity: safeText, common_identity: safeText, config_digest: digest }).strict();
const storeBoundarySchema = z.object({ root_identity: safeText, operations_identity: safeText, commits_identity: safeText, key_identity: safeText }).strict();
// Retain the persisted namespace format accepted before Zod v4; generation still uses randomUUID().
const markerSchema = z.object({ version: z.literal(1), namespace: z.string().guid(), profile_digest: digest,
  repository: repositorySchema, store: storeBoundarySchema, baseline: manifestSchema }).strict();
type Marker = z.infer<typeof markerSchema>;
const operationSchema = z.object({ version: z.literal(1), profile_digest: digest, request_id: id, request_digest: digest,
  request: z.record(z.string(), z.unknown()), directory_identity: safeText, created_at: z.string().datetime(),
  phase: z.enum(["preparing", "sealed", "conflicted", "materialized", "failed", "uncertain"]),
  pending_git: z.array(z.string()).optional(), git: z.array(executionSchema).max(4096),
  receipt: receiptSchema.optional(), conflict: conflictSchema.optional(), failure: z.string().max(128).optional(),
  verification_execution: OwnedVerificationExecutionSchema.optional(), verification_receipt: OwnedVerificationReceiptSchema.optional(),
}).strict();
type Operation = z.infer<typeof operationSchema>;
type Source = { worktree: MaterializedWorktree; admission: OwnedRunAdmission; handle: AgentInstanceHandle; closure: unknown };
export interface CaptureWorktreeResult extends Source { request_id: string; input?: WorktreeResultReference }
export interface ResolveWorktreeConflict extends Source { request_id: string; conflict_ref: WorktreeConflictReference }
function sourceSnapshot(source: Source): Readonly<Source> {
  return Object.freeze({ worktree: source.worktree, admission: source.admission, handle: source.handle, closure: source.closure });
}
/** Failure classification only; this does not authenticate a closure or authorize recovery. */
export function worktreeResultFailureIsUncertain(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current);) {
    if (current instanceof OwnedResultVerificationCleanupError || current instanceof OwnedResultVerificationPersistenceError) return true;
    seen.add(current);
    if (current instanceof OwnedGitError && !current.receipt.cleanupConfirmed) return true;
    if (!(current instanceof Error)) break;
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return false;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value) ?? fail("unsupported canonical JSON value");
}
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const within = (child: string, parent: string) => { const suffix = relative(parent, child); return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix)); };
const overlap = (left: string, right: string) => within(left, right) || within(right, left);
function fail(message: string): never { throw new Error(`Worktree results: ${message}`); }
function physicalGitPath(base: string, value: string): string {
  // Follow the OS path before normalizing: a symlink/.. pair must not be erased.
  return realpathSync.native(isAbsolute(value) ? value : `${base}${sep}${value}`);
}
function identity(path: string): string {
  const stat = lstatSync(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) fail("physical directory identity required");
  return `${stat.dev}:${stat.ino}`;
}
function privateDirectory(path: string): string {
  const value = identity(path), stat = lstatSync(path);
  if (stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) fail("protected directory must be owned and mode 0700");
  return value;
}
function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`;
}
function regular(path: string, maximum = MAX_RECORD_BYTES, privateFile = false): Buffer {
  const stat = lstatSync(path);
  const valid = (value: typeof stat) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.size <= maximum
    && (!privateFile || value.uid === process.getuid!() && (value.mode & 0o777) === 0o600);
  if (!valid(stat) || realpathSync.native(path) !== path) fail("invalid protected regular file or permissions");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!valid(opened) || stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size) fail("file changed before reading");
    // Keep the memory bound even if another local process grows the file during this read.
    const buffer = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break; length += count;
    }
    const bytes = buffer.subarray(0, length), after = lstatSync(path), read = fstatSync(fd);
    if (!valid(after) || !valid(read) || bytes.length !== stat.size || stat.dev !== after.dev || stat.ino !== after.ino
      || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs
      || stat.size !== read.size || stat.mtimeMs !== read.mtimeMs || stat.ctimeMs !== read.ctimeMs) fail("file changed while reading");
    return bytes;
  } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function exclusiveFile(path: string, bytes: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
function makeManifest(files: FileFact[], directories: string[]): WorktreeContentManifest {
  files.sort((a, b) => a.path.localeCompare(b.path)); directories = [...new Set(directories)].sort();
  if (files.length + directories.length > MAX_FILES || files.reduce((total, file) => total + file.size, 0) > MAX_BYTES) fail("content exceeds the bounded manifest");
  if (new Set(files.map(file => file.path)).size !== files.length || files.some(file => directories.includes(file.path))) fail("ambiguous content manifest");
  const result = { files, directories, digest: sha(canonical({ files, directories })) };
  return manifestSchema.parse(result);
}
function validateManifest(manifest: WorktreeContentManifest): void {
  if (!same(makeManifest([...manifest.files], [...manifest.directories]), manifest)) fail("content manifest identity changed");
}
function snapshot(root: string, paths: readonly string[]): { manifest: WorktreeContentManifest; bytes: Map<string, Buffer> } {
  identity(root); const files: FileFact[] = [], directories: string[] = [], bytes = new Map<string, Buffer>();
  let totalBytes = 0;
  function walk(path: string): void {
    sourcePath.parse(path); const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail("links are unsupported in result content");
    if (files.length + directories.length >= MAX_FILES) fail("content exceeds the file-count bound");
    if (stat.isDirectory()) {
      directories.push(path);
      for (const child of readdirSync(absolute).sort()) walk(`${path}/${child}`);
    } else {
      const content = regular(absolute, MAX_BYTES - totalBytes); totalBytes += content.length; bytes.set(path, content);
      files.push({ path, mode: stat.mode & 0o111 ? "100755" : "100644", checksum: sha(content), size: content.length });
    }
  }
  for (const path of paths) {
    // Validate every ancestor: a scoped path must not enter a linked directory.
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = join(root, ...parts.slice(0, index));
      if (existsSync(parent)) identity(parent);
    }
    if (existsSync(join(root, path))) walk(path);
  }
  return { manifest: makeManifest(files, directories), bytes };
}
function oneLine(bytes: Buffer): string {
  const value = bytes.toString("utf8"); if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) fail("unexpected Git line output");
  return value.slice(0, -1);
}
function execution(args: readonly string[], status: number, receipt: OwnedGitReceipt): GitEvidence {
  if (!receipt.spawned || receipt.childStatus !== status || !receipt.childExitObserved || !receipt.childCloseObserved
    || receipt.groupState !== "absent" || !receipt.cleanupConfirmed || !receipt.parent_guard?.cleanupConfirmed) fail("Git process closure was not confirmed");
  return executionSchema.parse({ args: [...args], status, started_at: receipt.startedAt, finished_at: receipt.finishedAt,
    child_exit_observed: true, child_close_observed: true, group_absent: true, cleanup_confirmed: true, parent_guard_confirmed: true });
}
const safeConfig = new Set(["core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates",
  "core.ignorecase", "core.precomposeunicode", "user.name", "user.email", "extensions.objectformat"]);
const unsupportedMetadata = ["objects/info/alternates", "info/grafts", "shallow", "info/attributes", "config.worktree"];

function commonDirectoryForLease(profile: Profile): string {
  identity(profile.repository_root);
  const entry = join(profile.repository_root, ".git");
  let metadata: string;
  if (lstatSync(entry).isDirectory()) metadata = entry;
  else {
    const pointer = oneLine(regular(entry, 4096));
    if (!pointer.startsWith("gitdir: ")) fail("unsupported checkout Git metadata pointer");
    metadata = physicalGitPath(profile.repository_root, pointer.slice(8));
  }
  identity(metadata);
  const commonPointer = join(metadata, "commondir");
  const common = existsSync(commonPointer) ? physicalGitPath(metadata, oneLine(regular(commonPointer, 4096))) : metadata;
  identity(common); const stat = lstatSync(common);
  if (!profile.allowed_roots.some(path => within(common, path)) || overlap(common, profile.state_root)
    || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) fail("Git executor lease is outside its protected repository boundary");
  return common;
}
/** A create-only repository lease serializes cooperating store instances and processes.
 * An interrupted/uncertain owner leaves the lease in place. There is deliberately no
 * automatic stale-lock adoption: a PID or retained file cannot prove writer closure. */
async function withRepositoryLease<T>(profile: Profile, body: (common: string) => Promise<T>, expectedCommon?: string): Promise<T> {
  const common = commonDirectoryForLease(profile), commonIdentity = identity(common);
  if (expectedCommon !== undefined && common !== expectedCommon) fail("Git repository binding changed before acquiring its executor lease");
  const path = join(common, "artoo-results-executor.lock"), token = randomUUID();
  try { exclusiveFile(path, token); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("single-writer executor is busy; another operation or retained uncertain lease is active");
    throw error;
  }
  const leaseIdentity = fileIdentity(path); syncDirectory(common);
  let uncertain = false;
  try { return await body(common); }
  catch (error) { uncertain = worktreeResultFailureIsUncertain(error); throw error; }
  finally {
    if (!uncertain) {
      if (identity(common) !== commonIdentity || fileIdentity(path) !== leaseIdentity || regular(path, 128, true).toString("utf8") !== token) fail("executor lease continuity changed; retained for inspection");
      unlinkSync(path); syncDirectory(common);
    }
  }
}

/** Explicit create/open: existing directories, serialized handles and retained paths never grant fresh execution authority.
 * Async calls use one repository-wide writer lease; competing requests fail before starting their operation. */
export async function openOwnedWorktreeResults(raw: WorktreeResultsProfile, options: { mode: "create" | "open" }) {
  if (process.platform !== "linux" && process.platform !== "darwin") fail("only Linux/macOS owned Git execution is supported");
  const profile: Profile = WorktreeResultsProfileSchema.parse(raw), mode = options.mode;
  if (mode !== "create" && mode !== "open") fail("explicit create/open mode required");
  return withRepositoryLease(profile, common => initializeOwnedWorktreeResults(profile, mode, common));
}

async function initializeOwnedWorktreeResults(profile: Profile, mode: "create" | "open", leasedCommon: string) {
  const profileDigest = sha(canonical(profile));
  for (const path of profile.allowed_roots) identity(path);
  identity(profile.repository_root); identity(dirname(profile.state_root));
  if (!profile.allowed_roots.some(path => within(profile.repository_root, path)) || overlap(profile.repository_root, profile.state_root)) fail("repository/state boundaries are not authorized");
  let marker: Marker | undefined, key: Buffer | undefined, keyIdentity: string | undefined;
  let markerIdentity: string | undefined, markerBytes: Buffer | undefined, metadataRoot: string | undefined;
  let gitEntryIdentity: string | undefined, gitEntryBytes: Buffer | undefined;
  let configBytes: Buffer | undefined;
  const stateDirectories = new Map<string, string>(), stateAncestry = new Map<string, string>();
  for (let parent = dirname(profile.state_root);; parent = dirname(parent)) {
    stateAncestry.set(parent, identity(parent)); if (dirname(parent) === parent) break;
  }
  const handles = new WeakMap<MaterializedWorktree, InputReference>();
  const materializations = new Map<string, MaterializedWorktree>();
  const verificationTargets = new Map<string, OwnedResultVerificationTarget>();
  const scope = (path: string) => profile.content_paths.some(root => path === root || path.startsWith(`${root}/`));
  function assertScopedManifest(manifest: WorktreeContentManifest): void {
    validateManifest(manifest);
    const directories = new Set(manifest.directories);
    for (const path of [...manifest.files.map(file => file.path), ...directories]) {
      if (!scope(path)) fail("manifest path is outside configured content");
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        const ancestor = parts.slice(0, index).join("/");
        if (scope(ancestor) && !directories.has(ancestor)) fail("directory-only merge conflict: scoped ancestor is absent");
      }
    }
  }
  function rememberStateDirectory(path: string): string {
    const observed = privateDirectory(path), prior = stateDirectories.get(path);
    if (prior !== undefined && prior !== observed) fail("protected store directory changed");
    stateDirectories.set(path, observed); return observed;
  }
  function assertStatePath(path: string): void {
    if (!within(path, profile.state_root) || path === profile.state_root) fail("protected file path escaped its store");
    for (let parent = dirname(path);; parent = dirname(parent)) {
      rememberStateDirectory(parent); if (parent === profile.state_root) break;
    }
  }
  function assertRepositoryMetadata(): void {
    if (!metadataRoot) return;
    const entry = join(profile.repository_root, ".git"), entryStat = lstatSync(entry);
    const observedEntry = entryStat.isDirectory() ? identity(entry) : fileIdentity(entry);
    const observedBytes = entryStat.isDirectory() ? undefined : regular(entry, 4096);
    if (gitEntryIdentity !== undefined && (observedEntry !== gitEntryIdentity || (observedBytes === undefined) !== (gitEntryBytes === undefined)
      || observedBytes && !observedBytes.equals(gitEntryBytes!))) fail("checkout Git metadata entry changed");
    gitEntryIdentity ??= observedEntry; gitEntryBytes ??= observedBytes;
    for (const path of unsupportedMetadata) if (existsSync(join(metadataRoot, path))) fail("alternates, grafts, shallow history and repository attributes/worktree config are unsupported");
    const observedConfig = regular(join(metadataRoot, "config"), 65536);
    if (configBytes && !observedConfig.equals(configBytes)) fail("local Git configuration changed");
    configBytes ??= observedConfig;
    let entries = 0;
    const walk = (path: string) => {
      const stat = lstatSync(path);
      if (++entries > 32768 || stat.isSymbolicLink() || realpathSync.native(path) !== path
        || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) fail("Git metadata has an unsupported identity, permissions or size");
      if (stat.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); }
      else if (!stat.isFile() || stat.nlink !== 1) fail("Git metadata must contain only plain directories and single-link regular files");
    };
    walk(metadataRoot);
  }
  function assertState(): void {
    for (const [path, expected] of stateAncestry) if (identity(path) !== expected) fail("protected store ancestry changed");
    for (const [path, expected] of stateDirectories) if (privateDirectory(path) !== expected) fail("protected store directory changed");
    if (keyIdentity !== undefined && (fileIdentity(join(profile.state_root, "key")) !== keyIdentity
      || !regular(join(profile.state_root, "key"), 32, true).equals(key!))) fail("protected store key changed");
    if (markerIdentity !== undefined && (fileIdentity(join(profile.state_root, "marker.json")) !== markerIdentity
      || !regular(join(profile.state_root, "marker.json"), MAX_RECORD_BYTES, true).equals(markerBytes!))) fail("protected store marker changed");
    if (marker && (identity(marker.repository.root) !== marker.repository.root_identity || identity(marker.repository.common) !== marker.repository.common_identity)) fail("protected repository identity changed");
    assertRepositoryMetadata();
  }
  async function git(args: readonly string[], operation?: Operation, indexFile?: string, allowed: readonly number[] = [0]) {
    assertState();
    const actual = ["--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "commit.gpgsign=false", ...args];
    if (operation) { if (operation.git.length >= 4096) fail("Git operation budget exhausted"); operation.pending_git = actual; saveOperation(operation); }
    const result = await runOwnedGit({ cwd: profile.repository_root, args: actual, kind: "materialize" }, {
      gitExecutable: profile.git_executable, readTimeoutMs: 10000, materializeTimeoutMs: 120000,
      maxOutputBytes: MAX_BYTES + 1024 * 1024, guardParent: true, indexFile,
    });
    assertState();
    const observed = execution(actual, result.status, result.receipt);
    if (operation) { operation.git.push(observed); delete operation.pending_git; saveOperation(operation); }
    if (!allowed.includes(result.status)) fail(`Git ${args[0]} returned an unsupported outcome`);
    return result;
  }
  async function repositoryBoundary(): Promise<z.infer<typeof repositorySchema>> {
    const root = oneLine((await git(["rev-parse", "--show-toplevel"])).stdout);
    if (root !== profile.repository_root) fail("configured repository must be its physical checkout root");
    const common = physicalGitPath(root, oneLine((await git(["rev-parse", "--git-common-dir"])).stdout));
    if (common !== leasedCommon) fail("observed Git repository differs from the acquired executor lease");
    if (!profile.allowed_roots.some(path => within(common, path)) || overlap(common, profile.state_root)) fail("Git metadata is outside the configured boundary");
    if (metadataRoot !== undefined && metadataRoot !== common) fail("Git metadata root changed");
    metadataRoot = common; assertRepositoryMetadata();
    const result = { root, common, root_identity: identity(root), common_identity: identity(common), config_digest: sha(configBytes!) };
    if (marker && !same(marker.repository, result)) fail("repository binding changed");
    const config = (await git(["config", "--local", "--no-includes", "--name-only", "--null", "--list"])).stdout.toString("utf8");
    if (config.split("\0").filter(Boolean).some(name => !safeConfig.has(name.toLowerCase()))) fail("repository has unsupported local Git configuration");
    return result;
  }
  const repository = await repositoryBoundary();
  const repositoryBinding = sha(canonical(repository));
  const signature = (value: unknown) => createHmac("sha256", key!).update(canonical(value)).digest("hex");
  function writeSigned(path: string, value: unknown): void {
    assertState(); assertStatePath(path);
    if (existsSync(path)) regular(path, MAX_RECORD_BYTES, true);
    const data = canonical({ data: value, mac: signature(value) });
    if (Buffer.byteLength(data) > MAX_RECORD_BYTES) fail("protected record exceeds size limit");
    const temporary = `${path}.${randomUUID()}.tmp`; exclusiveFile(temporary, data);
    assertState(); assertStatePath(path); renameSync(temporary, path); syncDirectory(dirname(path)); assertState();
  }
  function readSigned(path: string): unknown {
    assertState(); assertStatePath(path);
    const envelope = z.object({ data: z.unknown(), mac: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(JSON.parse(regular(path, MAX_RECORD_BYTES, true).toString("utf8")));
    if (!timingSafeEqual(Buffer.from(envelope.mac, "hex"), Buffer.from(signature(envelope.data), "hex"))) fail("protected record authentication failed");
    assertState();
    return envelope.data;
  }
  const operationPath = (requestId: string) => join(profile.state_root, "operations", sha(id.parse(requestId)).slice(7));
  function saveOperation(operation: Operation): void { writeSigned(join(operationPath(operation.request_id), "state.json"), operationSchema.parse(operation)); }
  function readOperation(requestId: string): Operation {
    const operation = operationSchema.parse(readSigned(join(operationPath(requestId), "state.json")));
    if (operation.request_id !== requestId || operation.profile_digest !== profileDigest || operation.request_digest !== sha(canonical(operation.request))
      || operation.directory_identity !== rememberStateDirectory(operationPath(requestId))) fail("operation identity changed");
    return operation;
  }
  function assertObject(type: "blob" | "tree" | "commit", objectId: string, bytes: Buffer): void {
    const actual = createHash(objectId.length === 40 ? "sha1" : "sha256")
      .update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
    if (actual !== objectId) fail("Git object bytes differ from their immutable object ID");
  }
  async function objectBytes(type: "blob" | "tree" | "commit", objectId: string): Promise<Buffer> {
    const bytes = (await git(["cat-file", type, oid.parse(objectId)])).stdout;
    assertObject(type, objectId, bytes); return bytes;
  }
  async function treeFiles(tree: string): Promise<Array<{ path: string; mode: FileFact["mode"]; oid: string }>> {
    oid.parse(tree);
    const rootTree = oid.parse(oneLine((await git(["rev-parse", "--verify", `${tree}^{tree}`])).stdout));
    if (tree !== rootTree && !(await objectBytes("commit", tree)).toString("utf8").startsWith(`tree ${rootTree}\n`)) fail("commit tree binding changed");
    await objectBytes("tree", rootTree);
    const output = (await git(["ls-tree", "-r", "-t", "-z", rootTree])).stdout;
    const text = output.toString("utf8"); if (!Buffer.from(text).equals(output) || (text && !text.endsWith("\0"))) fail("unsupported Git tree path encoding");
    const result: Array<{ path: string; mode: FileFact["mode"]; oid: string }> = [];
    const rows = text.split("\0").filter(Boolean);
    if (rows.length > MAX_FILES * 4) fail("repository tree exceeds the supported bound");
    for (const row of rows) {
      const directory = /^040000 tree ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(row);
      if (directory) { sourcePath.parse(directory[2]); await objectBytes("tree", directory[1]!); continue; }
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/u.exec(row);
      if (!match) fail("only regular Git files are supported");
      const path = sourcePath.parse(match[3]);
      if ([".gitattributes", ".gitmodules"].includes(path.split("/").at(-1)!)) fail("Git attributes and submodules are unsupported by this executor");
      result.push({ path, mode: match[1] as FileFact["mode"], oid: match[2]! });
      if (result.length > MAX_FILES * 4) fail("repository tree exceeds the supported bound");
    }
    return result;
  }
  async function manifestForTree(tree: string, extraDirectories: readonly string[] = []): Promise<WorktreeContentManifest> {
    const files: FileFact[] = [], directories = new Set(extraDirectories);
    let totalBytes = 0;
    for (const file of (await treeFiles(tree)).filter(item => scope(item.path))) {
      const bytes = await objectBytes("blob", file.oid);
      totalBytes += bytes.length;
      if (totalBytes > MAX_BYTES) fail("content exceeds the bounded manifest");
      files.push({ path: file.path, mode: file.mode, checksum: sha(bytes), size: bytes.length });
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index++) { const path = parts.slice(0, index).join("/"); if (scope(path)) directories.add(path); }
    }
    const manifest = makeManifest(files, [...directories]); assertScopedManifest(manifest); return manifest;
  }
  if (mode === "create") {
    mkdirSync(profile.state_root, { mode: 0o700 }); rememberStateDirectory(profile.state_root);
    key = randomBytes(32); exclusiveFile(join(profile.state_root, "key"), key);
    keyIdentity = fileIdentity(join(profile.state_root, "key"));
    mkdirSync(join(profile.state_root, "operations"), { mode: 0o700 }); mkdirSync(join(profile.state_root, "commits"), { mode: 0o700 });
    const store = { root_identity: rememberStateDirectory(profile.state_root), operations_identity: rememberStateDirectory(join(profile.state_root, "operations")),
      commits_identity: rememberStateDirectory(join(profile.state_root, "commits")), key_identity: keyIdentity };
    await git(["cat-file", "-e", `${profile.baseline_commit}^{commit}`]);
    const baseline = snapshot(profile.repository_root, profile.content_paths).manifest;
    const fromGit = await manifestForTree(profile.baseline_commit, baseline.directories);
    if (!same(baseline, fromGit)) fail("configured baseline differs from scoped checkout bytes");
    marker = { version: 1, namespace: randomUUID(), profile_digest: profileDigest, repository, store, baseline };
    writeSigned(join(profile.state_root, "marker.json"), marker); syncDirectory(dirname(profile.state_root));
  } else {
    rememberStateDirectory(profile.state_root); key = regular(join(profile.state_root, "key"), 32, true);
    if (key.length !== 32) fail("invalid store key");
    keyIdentity = fileIdentity(join(profile.state_root, "key"));
    marker = markerSchema.parse(readSigned(join(profile.state_root, "marker.json")));
    markerIdentity = fileIdentity(join(profile.state_root, "marker.json"));
    markerBytes = regular(join(profile.state_root, "marker.json"), MAX_RECORD_BYTES, true);
    const expectedMarker = canonical({ data: marker, mac: signature(marker) });
    if (!markerBytes.equals(Buffer.from(expectedMarker))) fail("protected store marker changed during opening");
    if (marker.profile_digest !== profileDigest || !same(marker.repository, repository)) fail("store is bound to another profile or repository");
    const store = { root_identity: rememberStateDirectory(profile.state_root), operations_identity: rememberStateDirectory(join(profile.state_root, "operations")),
      commits_identity: rememberStateDirectory(join(profile.state_root, "commits")), key_identity: keyIdentity };
    if (!same(store, marker.store)) fail("protected store continuity changed");
    assertScopedManifest(marker.baseline);
    if (!same(await manifestForTree(profile.baseline_commit, marker.baseline.directories), marker.baseline)) fail("baseline manifest changed");
    const entries = readdirSync(join(profile.state_root, "operations"));
    if (entries.length > 4096) fail("operation recovery bound exceeded");
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/u.test(entry)) fail("unexpected protected operation directory");
      const path = join(profile.state_root, "operations", entry); rememberStateDirectory(path);
      if (existsSync(join(path, "owner.lock"))) regular(join(path, "owner.lock"), 0, true);
      if (existsSync(join(path, "state.json"))) {
        const operation = operationSchema.parse(readSigned(join(path, "state.json")));
        if (operationPath(operation.request_id) !== path) fail("protected operation path changed");
        readOperation(operation.request_id);
      }
    }
  }
  markerIdentity = fileIdentity(join(profile.state_root, "marker.json"));
  markerBytes = regular(join(profile.state_root, "marker.json"), MAX_RECORD_BYTES, true); assertState();
  const protectedMarker = marker;
  const refName = (requestId: string) => `refs/artoo/results/${protectedMarker.namespace.replaceAll("-", "")}/${sha(requestId).slice(7)}`;
  async function assertCommit(commit: string, tree: string, contentDigest: string, manifest: WorktreeContentManifest): Promise<void> {
    await repositoryBoundary(); assertScopedManifest(manifest);
    const bytes = await objectBytes("commit", commit);
    if (sha(bytes) !== contentDigest || !bytes.toString("utf8").startsWith(`tree ${tree}\n`)) fail("sealed commit identity changed");
    if (!same(await manifestForTree(tree, manifest.directories), manifest)) fail("sealed tree differs from its manifest");
  }
  async function readResult(reference: WorktreeResultReference): Promise<SealedWorktreeResult> {
    const selected = WorktreeResultReferenceSchema.parse(reference), operation = readOperation(selected.result_id);
    if (operation.phase !== "sealed" || !operation.receipt) fail("result is not durably sealed");
    const receipt = operation.receipt;
    if (receipt.result_id !== selected.result_id || receipt.request_digest !== operation.request_digest || receipt.profile_digest !== profileDigest
      || receipt.repository_binding !== repositoryBinding || sha(canonical(receipt)) !== selected.receipt_digest) fail("result reference does not match its node receipt");
    if (oneLine((await git(["rev-parse", "--verify", refName(selected.result_id)])).stdout) !== receipt.commit) fail("private result ref changed");
    await assertCommit(receipt.commit, receipt.tree, receipt.commit_content_digest, receipt.manifest);
    return { reference: selected, receipt: structuredClone(receipt) };
  }
  async function readConflict(reference: WorktreeConflictReference): Promise<WorktreeConflict> {
    const selected = WorktreeConflictReferenceSchema.parse(reference), operation = readOperation(selected.operation_id);
    if (operation.phase !== "conflicted" || !operation.conflict) fail("operation is not a recorded conflict");
    const conflict = operation.conflict;
    if (conflict.operation_id !== selected.operation_id || conflict.request_digest !== operation.request_digest || conflict.profile_digest !== profileDigest
      || conflict.repository_binding !== repositoryBinding || sha(canonical(conflict)) !== selected.state_digest) fail("conflict reference changed");
    if (oneLine((await git(["rev-parse", "--verify", refName(selected.operation_id)])).stdout) !== conflict.candidate_commit) fail("private conflict ref changed");
    await assertCommit(conflict.candidate_commit, conflict.candidate_tree, conflict.commit_content_digest, conflict.manifest);
    return structuredClone(conflict);
  }
  async function readVerification(raw: OwnedVerificationReceiptReference): Promise<SealedOwnedVerificationReceipt> {
    const reference = OwnedVerificationReceiptReferenceSchema.parse(raw), operation = readOperation(reference.verification_id);
    if (operation.phase !== "sealed" || !operation.verification_receipt || !operation.verification_execution
      || operation.receipt || operation.conflict) fail("verification is not durably sealed");
    const receipt = operation.verification_receipt, intent = OwnedVerificationIntentSchema.parse(operation.request);
    if (receipt.request_id !== operation.request_id || intent.request_id !== operation.request_id || receipt.request_digest !== operation.request_digest
      || receipt.profile_digest !== profileDigest || receipt.repository_binding !== repositoryBinding
      || receipt.started_at !== operation.created_at || !same(receipt.intent, intent)
      || !same(receipt.execution, operation.verification_execution) || sha(canonical(receipt)) !== reference.receipt_digest) {
      fail("verification reference does not match its node receipt");
    }
    assertVerificationIntent(intent);
    assertOwnedVerificationEvidenceBindings(intent, receipt.execution, receipt.evidence);
    const result = await readResult(intent.result.reference), evidence = receipt.evidence.result;
    if (evidence.commit !== result.receipt.commit || evidence.tree !== result.receipt.tree
      || evidence.manifest_digest !== result.receipt.manifest.digest || evidence.repository_binding !== repositoryBinding) {
      fail("historical verification differs from its sealed result");
    }
    // Historical read authenticates the immutable result, not today's mutable checkout.
    // It never reconstructs a target, admission, writer handle or execution authority.
    return issueVerificationReceipt(receipt);
  }
  function assertVerificationIntent(intent: OwnedVerificationIntent): void {
    if (intent.template.node_id !== profile.node_id || intent.template.project_id !== profile.project_id
      || intent.result.profile_id !== profile.id || intent.result.profile_digest !== profileDigest) fail("verification intent differs from the result store");
  }
  async function lookupVerification(raw: OwnedVerificationIntent): Promise<OwnedVerificationLookup> {
    const intent = OwnedVerificationIntentSchema.parse(raw); assertVerificationIntent(intent); assertState();
    if (!existsSync(operationPath(intent.request_id))) return { phase: "absent" };
    const operation = readOperation(intent.request_id);
    if (!same(operation.request, intent)) fail("verification request ID is already bound to another intent");
    if (operation.phase === "sealed" && operation.verification_receipt) {
      return { phase: "sealed", sealed: await readVerification({ verification_id: intent.request_id,
        receipt_digest: sha(canonical(operation.verification_receipt)) }) };
    }
    if (operation.phase === "preparing" || operation.phase === "failed" || operation.phase === "uncertain") {
      return { phase: operation.phase, request_id: intent.request_id,
        ...(operation.verification_execution ? { execution: structuredClone(operation.verification_execution) } : {}) };
    }
    return fail("retained operation is not a verification attempt");
  }
  async function operate(requestId: string, request: Record<string, unknown>, body: (operation: Operation) => Promise<void>,
    durableVerification = false): Promise<Operation> {
    id.parse(requestId); await repositoryBoundary();
    request = JSON.parse(canonical(request)) as Record<string, unknown>;
    const requestDigest = sha(canonical(request)), path = operationPath(requestId);
    if (existsSync(path)) {
      rememberStateDirectory(path); const previous = readOperation(requestId);
      if (previous.request_digest !== requestDigest || !same(previous.request, request)) fail("operation ID is already bound to another request");
      if (!["sealed", "conflicted", "materialized"].includes(previous.phase)) fail(`prior operation is ${previous.phase}; retained state cannot be promoted or resumed`);
      return previous;
    }
    const persistence = <T>(action: () => T): T => {
      try { return action(); }
      catch (cause) {
        if (durableVerification) throw new OwnedResultVerificationPersistenceError("Verification journal durability is unconfirmed; repository remains fenced", { cause });
        throw cause;
      }
    };
    // Cover uncertainty from the very first create-only directory claim, even
    // before there is a state.json or an open owner descriptor to clean up.
    const directoryIdentity = persistence(() => {
      mkdirSync(path, { mode: 0o700 }); const observed = rememberStateDirectory(path); syncDirectory(dirname(path)); return observed;
    });
    const lock = join(path, "owner.lock"), fd = persistence(() => openSync(lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600));
    const operation: Operation = { version: 1, profile_digest: profileDigest, request_id: requestId, request_digest: requestDigest,
      request, directory_identity: directoryIdentity, created_at: new Date().toISOString(), phase: "preparing", git: [] };
    const persist = () => persistence(() => saveOperation(operation));
    let primaryFailure: unknown;
    try {
      persistence(() => fsyncSync(fd)); persist(); await body(operation);
      if (!["sealed", "conflicted", "materialized"].includes(operation.phase)) fail("operation did not reach a durable terminal result");
      persist(); return operation;
    } catch (error) {
      primaryFailure = error;
      operation.phase = worktreeResultFailureIsUncertain(error) ? "uncertain" : "failed";
      operation.failure = operation.phase === "uncertain" ? "Git process closure unconfirmed" : "Operation failed; no result acceptance";
      if (durableVerification) {
        delete operation.verification_receipt;
        operation.failure = operation.phase === "uncertain" ? "Verification process closure or durable outcome unconfirmed" : "Verification failed before final receipt";
      }
      try { persist(); }
      catch (cause) {
        operation.phase = "uncertain";
        if (durableVerification) throw new OwnedResultVerificationPersistenceError("Verification failure could not be durably recorded; repository remains fenced",
          { cause: new AggregateError([error, cause], "Verification and failure-record persistence both failed", { cause: error }) });
      }
      throw error;
    } finally {
      try {
        closeSync(fd);
        if (operation.phase !== "uncertain") { assertState(); assertStatePath(lock); regular(lock, 0, true); unlinkSync(lock); syncDirectory(path); }
      } catch (cause) {
        if (durableVerification) throw new OwnedResultVerificationPersistenceError("Verification journal closure is unconfirmed; repository remains fenced",
          { cause: primaryFailure === undefined ? cause : new AggregateError([primaryFailure, cause], "Verification and journal cleanup both failed", { cause: primaryFailure }) });
        throw cause;
      }
    }
  }
  async function writeCommit(operation: Operation, tree: string, parents: string[], manifest: WorktreeContentManifest): Promise<{ commit: string; contentDigest: string }> {
    const epoch = Math.floor(Date.parse(operation.created_at) / 1000);
    const rawCommit = `tree ${oid.parse(tree)}\n${parents.map(parent => `parent ${oid.parse(parent)}\n`).join("")}`
      + `author Artoo <node@artoo.local> ${epoch} +0000\ncommitter Artoo <node@artoo.local> ${epoch} +0000\n\n`
      + `Artoo node result ${operation.request_id}\nrequest ${operation.request_digest}\nmanifest ${manifest.digest}\n`;
    const path = join(operationPath(operation.request_id), "commit.txt"); exclusiveFile(path, rawCommit);
    const commit = oid.parse(oneLine((await git(["hash-object", "-t", "commit", "-w", "--no-filters", "--", path], operation)).stdout));
    await git(["update-ref", refName(operation.request_id), commit, "0".repeat(commit.length)], operation);
    return { commit, contentDigest: sha(rawCommit) };
  }
  async function seal(operation: Operation, input: { kind: WorktreeResultReceipt["kind"]; base: string; tree: string; parents: string[];
    manifest: WorktreeContentManifest; inputs: WorktreeResultReference[]; source?: WorktreeResultReceipt["source"]; conflict?: WorktreeConflictReference }): Promise<void> {
    const committed = await writeCommit(operation, input.tree, input.parents, input.manifest);
    const receipt = receiptSchema.parse({ version: 1, result_id: operation.request_id, kind: input.kind, profile_digest: profileDigest,
      repository_binding: repositoryBinding, request_digest: operation.request_digest, created_at: operation.created_at,
      base_commit: input.base, commit: committed.commit, tree: input.tree, parents: input.parents, manifest: input.manifest,
      inputs: input.inputs, source: input.source, conflict: input.conflict, commit_content_digest: committed.contentDigest, git: operation.git,
      scope: "immutable-scoped-git-content; not verification, review, integration acceptance or publication" });
    operation.receipt = receipt; operation.phase = "sealed";
    writeSigned(join(profile.state_root, "commits", `${receipt.commit}.json`), { reference: { result_id: receipt.result_id, receipt_digest: sha(canonical(receipt)) }, manifest: receipt.manifest });
  }
  async function validateSource(source: Source, expected: InputReference | undefined, base: string) {
    source = sourceSnapshot(source);
    const authenticated = getOwnedWorkspaceClosure(source.closure, source.admission, source.handle, source.worktree);
    if (!authenticated) fail("a genuine closed writer bound to this exact worktree is required");
    await assertOwnedMaterializedWorktree(source.worktree); await repositoryBoundary();
    if (source.worktree.commonDirectory !== protectedMarker.repository.common || source.worktree.committedHead !== base
      || overlap(source.worktree.root, profile.state_root) || !profile.allowed_roots.some(root => within(source.worktree.root, root))) fail("writer is outside its fixed repository/baseline boundary");
    const admitted = handles.get(source.worktree);
    if (expected ? !admitted || !same(admitted, expected) : admitted !== undefined) fail("writer did not consume this exact input through the node store");
    const value = authenticated.identity;
    const launchProof = getOwnedWorkspaceLaunchProof(source.closure, source.admission, source.handle, source.worktree);
    return sourceSchema.parse({ launch_key: value.launchKey, run_id: value.runId, task_id: value.taskId,
      agent_instance_id: value.agentInstanceId, runtime: value.runtime, workspace_root: value.workspaceRoot,
      workspace_branch: value.workspaceBranch, physical_receipt_observed_at: authenticated.receipt.observedAt,
      result_closure_checked_at: new Date().toISOString(),
      closure_scope: "physical-writer-and-tools-closed; not business success or verification",
      ...(launchProof ? { launch_proof: launchProof } : {}) });
  }
  async function captureTree(operation: Operation, worktree: MaterializedWorktree, base: string, content: ReturnType<typeof snapshot>) {
    const path = operationPath(operation.request_id), index = join(path, "index");
    const tracked = await treeFiles(base);
    await git(["read-tree", base], operation, index);
    for (const file of tracked.filter(item => scope(item.path))) await git(["update-index", "--force-remove", "--", file.path], operation, index);
    for (const file of content.manifest.files) {
      const staged = join(path, `blob-${sha(file.path).slice(7)}`); exclusiveFile(staged, content.bytes.get(file.path)!);
      const blob = oid.parse(oneLine((await git(["hash-object", "-w", "--no-filters", "--", staged], operation)).stdout));
      await git(["update-index", "--add", "--cacheinfo", `${file.mode},${blob},${file.path}`], operation, index);
    }
    const tree = oid.parse(oneLine((await git(["write-tree"], operation, index)).stdout));
    if (!same(await manifestForTree(tree, content.manifest.directories), content.manifest)
      || !same(snapshot(worktree.root, profile.content_paths).manifest, content.manifest)) fail("writer content changed during sealing");
    return { tree, manifest: content.manifest };
  }
  async function outcome(operation: Operation): Promise<WorktreeMergeOutcome> {
    if (operation.phase === "sealed" && operation.receipt) return { outcome: "candidate", ...await readResult({ result_id: operation.request_id, receipt_digest: sha(canonical(operation.receipt)) }) };
    if (operation.phase === "conflicted" && operation.conflict) {
      const reference = { operation_id: operation.request_id, state_digest: sha(canonical(operation.conflict)) };
      return { outcome: "conflicted", reference, conflict: await readConflict(reference) };
    }
    return fail("operation has no consumable outcome");
  }
  async function baseManifest(commit: string): Promise<WorktreeContentManifest> {
    if (commit === profile.baseline_commit) {
      if (!same(await manifestForTree(commit, protectedMarker.baseline.directories), protectedMarker.baseline)) fail("baseline manifest changed");
      return protectedMarker.baseline;
    }
    const record = z.object({ reference: WorktreeResultReferenceSchema, manifest: manifestSchema }).strict()
      .parse(readSigned(join(profile.state_root, "commits", `${oid.parse(commit)}.json`)));
    const source = await readResult(record.reference);
    if (source.receipt.commit !== commit || !same(source.receipt.manifest, record.manifest)) fail("merge base manifest is not node-owned");
    return source.receipt.manifest;
  }
  const api = {
    async capture(input: CaptureWorktreeResult): Promise<SealedWorktreeResult> {
      const requestId = id.parse(input.request_id), frozenSource = sourceSnapshot(input);
      const reference = input.input === undefined ? undefined : WorktreeResultReferenceSchema.parse(input.input);
      const consumed = reference ? await readResult(reference) : undefined, base = consumed?.receipt.commit ?? profile.baseline_commit;
      const source = await validateSource(frozenSource, reference, base);
      const { physical_receipt_observed_at: _physicalAt, result_closure_checked_at: _checkedAt, ...binding } = source;
      // The exact scoped bytes, directories and modes are request input too. A
      // repeated ID cannot silently return an old receipt for changed content.
      const content = snapshot(frozenSource.worktree.root, profile.content_paths);
      const operation = await operate(requestId, { kind: "capture", source: binding, input: reference ?? null, base,
        content_manifest_digest: content.manifest.digest }, async operation => {
        const captured = await captureTree(operation, frozenSource.worktree, base, content);
        await seal(operation, { kind: "authored", base, ...captured, parents: [base], inputs: reference ? [reference] : [], source });
      });
      const result = await outcome(operation); if (result.outcome !== "candidate") return fail("capture cannot produce a merge conflict");
      if (!same(snapshot(frozenSource.worktree.root, profile.content_paths).manifest, content.manifest)) fail("writer content changed during capture or replay");
      return { reference: result.reference, receipt: result.receipt };
    },
    async merge(input: { request_id: string; inputs: readonly [WorktreeResultReference, WorktreeResultReference] }): Promise<WorktreeMergeOutcome> {
      const requestId = id.parse(input.request_id);
      const references = z.tuple([WorktreeResultReferenceSchema, WorktreeResultReferenceSchema]).parse(input.inputs);
      if (references[0].result_id === references[1].result_id) fail("merge inputs must identify two distinct results");
      const left = await readResult(references[0]), right = await readResult(references[1]);
      const operation = await operate(requestId, { kind: "merge", inputs: references }, async operation => {
        const base = oid.parse(oneLine((await git(["merge-base", "--all", left.receipt.commit, right.receipt.commit], operation)).stdout));
        const original = await baseManifest(base), leftDirs = new Set(left.receipt.manifest.directories), rightDirs = new Set(right.receipt.manifest.directories), baseDirs = new Set(original.directories);
        const directories = [...new Set([...baseDirs, ...leftDirs, ...rightDirs])].filter(path => leftDirs.has(path) === rightDirs.has(path)
          ? leftDirs.has(path) : leftDirs.has(path) === baseDirs.has(path) ? rightDirs.has(path) : leftDirs.has(path));
        const merged = await git(["merge-tree", "--write-tree", "--messages", "-z", left.receipt.commit, right.receipt.commit], operation, undefined, [0, 1]);
        const fields = merged.stdout.toString("utf8").split("\0"), tree = oid.parse(fields[0]);
        const manifest = await manifestForTree(tree, directories);
        // Git cannot represent empty directories. Never silently discard a directory/file conflict or a deleted-directory/added-child conflict.
        if (manifest.files.some(file => directories.includes(file.path) || directories.some(path => path.startsWith(`${file.path}/`)))
          || manifest.directories.some(path => baseDirs.has(path) && !directories.includes(path))) fail("directory-only merge conflict is unsupported and retained");
        if (merged.status === 0) {
          await seal(operation, { kind: "merged", base, tree, manifest, parents: [left.receipt.commit, right.receipt.commit], inputs: references });
          return;
        }
        const paths = new Set<string>();
        for (const field of fields.slice(1)) {
          if (field === "") break;
          const match = /^(?:100644|100755) [a-f0-9]{40,64} [123]\t(.+)$/u.exec(field);
          if (!match) fail("unsupported Git conflict entry");
          const path = sourcePath.parse(match[1]); if (!scope(path)) fail("conflict outside configured result content"); paths.add(path);
        }
        if (!paths.size) fail("Git conflict had no supported conflict paths");
        const committed = await writeCommit(operation, tree, [left.receipt.commit, right.receipt.commit], manifest);
        operation.conflict = conflictSchema.parse({ version: 1, operation_id: operation.request_id, profile_digest: profileDigest,
          repository_binding: repositoryBinding, request_digest: operation.request_digest, created_at: operation.created_at,
          base_commit: base, ours: left.receipt.commit, theirs: right.receipt.commit, candidate_commit: committed.commit,
          candidate_tree: tree, commit_content_digest: committed.contentDigest, inputs: references, manifest, paths: [...paths].sort(),
          git: operation.git, scope: "unresolved-git-conflict; not an accepted result" });
        operation.phase = "conflicted";
      });
      return outcome(operation);
    },
    async materialize(input: { request_id: string; reference: InputReference; root: string; branch: string },
      purpose: "writer" | "verification" = "writer"): Promise<MaterializedWorktree> {
      const requestId = id.parse(input.request_id);
      const reference = inputReference.parse(input.reference), root = absolutePath.parse(input.root), branch = safeText.parse(input.branch);
      if (overlap(root, profile.state_root)) fail("writer workspace overlaps protected state");
      const selected = "result_id" in reference ? (await readResult(reference)).receipt : await readConflict(reference);
      const commit = "commit" in selected ? selected.commit : selected.candidate_commit;
      const operation = await operate(requestId, { kind: purpose === "writer" ? "materialize" : "verification-materialize", reference, root, branch }, async operation => {
        const prepared = await prepareOwnedWorktree({ root, branch, sourceRepo: profile.repository_root, sourceCommit: commit, allowedRoots: profile.allowed_roots },
          { gitExecutable: profile.git_executable, guardParent: true });
        const worktree = await materializeOwnedWorktree(await reserveOwnedWorktree(prepared));
        for (const path of selected.manifest.directories) mkdirSync(join(root, path), { recursive: true });
        if (!same(snapshot(root, profile.content_paths).manifest, selected.manifest)) fail("materialized input differs from its sealed content");
        if (purpose === "writer") handles.set(worktree, reference);
        materializations.set(operation.request_id, worktree); operation.phase = "materialized";
      });
      const worktree = materializations.get(operation.request_id);
      if (!worktree) fail("previous materialization is retained; restart cannot manufacture its in-memory execution authority");
      await assertOwnedMaterializedWorktree(worktree); return worktree;
    },
    async materializeForVerification(input: { request_id: string; reference: WorktreeResultReference; root: string; branch: string }): Promise<OwnedResultVerificationTarget> {
      const requestId = id.parse(input.request_id), reference = WorktreeResultReferenceSchema.parse(input.reference);
      const root = absolutePath.parse(input.root), branch = safeText.parse(input.branch);
      const worktree = await api.materialize({ request_id: requestId, reference, root, branch }, "verification");
      const prior = verificationTargets.get(requestId);
      if (prior) return prior;
      // The genuine handle stays private. A replay through materialize has a
      // different durable request kind and cannot obtain a writer-capable handle.
      const target = Object.freeze({ version: 1 as const, kind: "owned-result-verification-target" as const });
      async function inspect(): Promise<OwnedResultVerificationBinding> {
        await assertOwnedMaterializedWorktree(worktree); await repositoryBoundary();
        const result = await readResult(reference);
        if (worktree.committedHead !== result.receipt.commit || worktree.commonDirectory !== repository.common
          || !same(snapshot(worktree.root, profile.content_paths).manifest, result.receipt.manifest)) {
          fail("verification materialization differs from its sealed result");
        }
        return { profile_id: profile.id, profile_digest: profileDigest, node_id: profile.node_id, project_id: profile.project_id,
          repository_root: profile.repository_root, repository_binding: repositoryBinding, content_paths: [...profile.content_paths],
          workspace_root: root, workspace_branch: branch, result };
      }
      const authority: VerificationTargetAuthority = { phase: "fresh", execute: body => withRepositoryLease(profile, async () => {
        // Consume only after acquiring the lease. A busy repository has not run
        // the verifier and must leave this same exact target available to retry.
        if (authority.phase !== "fresh") fail("a fresh genuine verification-only materialization is required");
        authority.phase = "running";
        try {
          const before = await inspect(), value = await body(before), after = await inspect();
          if (!same(before, after)) fail("verification target binding changed during execution");
          return value;
        } catch (error) {
          if (worktreeResultFailureIsUncertain(error)) authority.phase = "uncertain";
          throw error;
        } finally { if (authority.phase === "running") authority.phase = "closed"; }
      }, repository.common), executeDurably: (intent, body) => withRepositoryLease(profile, async () => {
        if (authority.phase !== "fresh") fail("a fresh genuine verification-only materialization is required");
        assertVerificationIntent(intent);
        if (intent.materialization_request_id !== requestId || !same(intent.result.reference, reference)
          || intent.workspace.root !== root || intent.workspace.branch !== branch) fail("durable verification intent differs from the private target");
        authority.phase = "running";
        try {
          const operation = await operate(intent.request_id, intent, async operation => {
            const before = await inspect();
            let admissionOpen = true;
            const admit = (raw: OwnedVerificationExecution) => {
              if (!admissionOpen || operation.verification_execution) fail("verification execution admission is closed or already recorded");
              const execution = OwnedVerificationExecutionSchema.parse(raw);
              if (execution.request_id !== intent.request_id || execution.profile_id !== intent.template.id
                || execution.workspace_root !== root || execution.context_digest !== intent.context_digest) fail("prepared verifier request differs from the durable intent");
              operation.verification_execution = execution;
              try { saveOperation(operation); }
              catch (cause) { throw new OwnedResultVerificationPersistenceError("Prepared verifier request was not durably recorded; repository remains fenced", { cause }); }
            };
            let candidate: OwnedWorktreeVerificationEvidence;
            try { candidate = await body(before, admit); }
            finally { admissionOpen = false; }
            if (!operation.verification_execution) fail("actual verifier request was not admitted before execution");
            // Load the coordinator's read-only proof bridge lazily: ordinary
            // result-store initialization must not acquire a cyclic dependency.
            const { authenticateOwnedVerificationCandidate } = await import("../owned-worktree-verification.js");
            const evidence = authenticateOwnedVerificationCandidate(candidate, target, intent, operation.verification_execution);
            assertOwnedVerificationEvidenceBindings(intent, operation.verification_execution, evidence);
            const after = await inspect();
            if (!same(before, after)) fail("verification target binding changed during execution");
            // Only here: genuine node result, known closure, postchecked complete
            // scoped content. operate() syncs the terminal record before returning.
            operation.verification_receipt = OwnedVerificationReceiptSchema.parse({ version: 1,
              kind: "owned-result-verification-receipt.v1", request_id: intent.request_id,
              request_digest: operation.request_digest, profile_digest: profileDigest, repository_binding: repositoryBinding,
              started_at: operation.created_at, completed_at: new Date().toISOString(), intent,
              execution: operation.verification_execution, evidence,
              scope: "historical node-local exact-result verification; no delivery, writer recovery, review or publication authority" });
            operation.phase = "sealed";
          }, true);
          if (operation.phase !== "sealed" || !operation.verification_receipt) fail("durable verification did not produce a final receipt");
          return issueVerificationReceipt(operation.verification_receipt);
        } catch (error) {
          if (worktreeResultFailureIsUncertain(error)) authority.phase = "uncertain";
          throw error;
        } finally { if (authority.phase === "running") authority.phase = "closed"; }
      }, repository.common) };
      verificationTargetAuthorities.set(target, authority);
      verificationTargets.set(requestId, target);
      return target;
    },
    async resolve(input: ResolveWorktreeConflict): Promise<SealedWorktreeResult> {
      const requestId = id.parse(input.request_id), frozenSource = sourceSnapshot(input);
      const reference = WorktreeConflictReferenceSchema.parse(input.conflict_ref), conflict = await readConflict(reference);
      const source = await validateSource(frozenSource, reference, conflict.candidate_commit),
        { physical_receipt_observed_at: _physicalAt, result_closure_checked_at: _checkedAt, ...binding } = source;
      const content = snapshot(frozenSource.worktree.root, profile.content_paths);
      const operation = await operate(requestId, { kind: "resolve", conflict: reference, source: binding,
        content_manifest_digest: content.manifest.digest }, async operation => {
        for (const path of conflict.paths) {
          const bytes = content.bytes.get(path); if (!bytes) continue; // An intentional deletion remains subject to later verification/review.
          const previous = conflict.manifest.files.find(file => file.path === path);
          if (previous?.checksum === sha(bytes) || /^<<<<<<< |^=======\r?$|^>>>>>>> /mu.test(bytes.toString("utf8"))) fail("conflict content is unresolved");
        }
        const captured = await captureTree(operation, frozenSource.worktree, conflict.candidate_commit, content);
        await seal(operation, { kind: "resolution", base: conflict.base_commit, ...captured,
          parents: [conflict.ours, conflict.theirs], inputs: conflict.inputs, source, conflict: reference });
      });
      const result = await outcome(operation); if (result.outcome !== "candidate") return fail("resolution did not produce a sealed candidate");
      if (!same(snapshot(frozenSource.worktree.root, profile.content_paths).manifest, content.manifest)) fail("writer content changed during resolution or replay");
      return { reference: result.reference, receipt: result.receipt };
    },
    read: readResult,
    conflict: readConflict,
    readVerification,
    lookupVerification,
    /** A nonterminal/uncertain historical operation is reported as such, never promoted from files found on disk. */
    inspect(requestId: string) { const operation = readOperation(id.parse(requestId)); return { request_id: operation.request_id, request_digest: operation.request_digest,
      phase: operation.phase, ...(operation.failure ? { failure: operation.failure } : {}), git_commands: operation.git.length }; },
  };
  const store = {
    capture(input: CaptureWorktreeResult) { return withRepositoryLease(profile, () => api.capture(input), repository.common); },
    merge(input: Parameters<typeof api.merge>[0]) { return withRepositoryLease(profile, () => api.merge(input), repository.common); },
    materialize(input: Parameters<typeof api.materialize>[0]) { return withRepositoryLease(profile, () => api.materialize(input), repository.common); },
    materializeForVerification(input: Parameters<typeof api.materializeForVerification>[0]) {
      return withRepositoryLease(profile, () => api.materializeForVerification(input), repository.common);
    },
    resolve(input: ResolveWorktreeConflict) { return withRepositoryLease(profile, () => api.resolve(input), repository.common); },
    read(reference: WorktreeResultReference) { return withRepositoryLease(profile, () => api.read(reference), repository.common); },
    conflict(reference: WorktreeConflictReference) { return withRepositoryLease(profile, () => api.conflict(reference), repository.common); },
    readVerification(reference: OwnedVerificationReceiptReference) { return withRepositoryLease(profile, () => api.readVerification(reference), repository.common); },
    lookupVerification(intent: OwnedVerificationIntent) { return withRepositoryLease(profile, () => api.lookupVerification(intent), repository.common); },
    inspect: api.inspect,
  };
  async function description(binding: OwnedResultProjectionStoreBinding): Promise<OwnedResultStoreDescription> {
    if (binding.node_id !== profile.node_id || binding.project_id !== profile.project_id
      || binding.results_profile_id !== profile.id || binding.results_profile_digest !== profileDigest
      || binding.repository_root !== profile.repository_root
      || !same([...binding.subject_paths].sort(), [...profile.content_paths].sort())) fail("prepared template differs from the original result store");
    await repositoryBoundary();
    if (!same(await manifestForTree(profile.baseline_commit, protectedMarker.baseline.directories), protectedMarker.baseline)) fail("baseline manifest changed");
    return freezeReceipt({ node_id: profile.node_id, project_id: profile.project_id,
      result_profile: { id: profile.id, digest: profileDigest, repository_binding: repositoryBinding, baseline_commit: profile.baseline_commit },
      content_paths: [...profile.content_paths] });
  }
  projectionStores.set(store, {
    materializeAuthor: (binding, input, signal) => withRepositoryLease(profile, async () => {
      await description(binding); signal.throwIfAborted();
      const launch = allocationStartBinding(input.run_start, process.platform, true);
      if (!launch || launch.payload.context_pack.payload?.project.id !== profile.project_id) fail("author materialization requires the exact allocated project context");
      const start = launch.payload, root = start.workspace.root, branch = safeText.parse(start.workspace.branch);
      if (overlap(root, profile.state_root)) fail("author workspace overlaps protected state");
      const reference = input.input.kind === "result" ? input.input.reference : undefined;
      const selected = reference ? (await readResult(reference)).receipt : undefined;
      const commit = selected?.commit ?? profile.baseline_commit, manifest = selected?.manifest ?? protectedMarker.baseline;
      const operation = await operate(input.request_id, { kind: "author-materialize.v1", launch_key: launch.key,
        input: reference ?? null, base: commit, root, branch }, async operation => {
        const gitOptions = { gitExecutable: profile.git_executable, guardParent: true, signal };
        await provisionRunNamespace({ root, basePath: start.workspace_allocation!.base_path, agentInstanceId: start.agent_instance_id,
          runId: start.run_id, sourceRepo: profile.repository_root, sourceCommit: commit, allowedRoots: profile.allowed_roots }, gitOptions);
        signal.throwIfAborted();
        const prepared = await prepareOwnedWorktree({ root, branch, sourceRepo: profile.repository_root,
          sourceCommit: commit, allowedRoots: profile.allowed_roots }, gitOptions);
        const worktree = await materializeOwnedWorktree(await reserveOwnedWorktree(prepared));
        for (const path of manifest.directories) mkdirSync(join(root, path), { recursive: true });
        if (!same(snapshot(root, profile.content_paths).manifest, manifest)) fail("author materialization differs from the fixed input content");
        if (reference) handles.set(worktree, reference);
        materializations.set(operation.request_id, worktree); operation.phase = "materialized";
      });
      const worktree = materializations.get(operation.request_id);
      if (!worktree) fail("previous author materialization is retained; restart cannot manufacture writer authority");
      signal.throwIfAborted(); await assertOwnedMaterializedWorktree(worktree);
      return worktree;
    }, repository.common),
    captureAuthor: (binding, input) => withRepositoryLease(profile, async () => {
      await description(binding); return api.capture(input);
    }, repository.common),
    materializeVerifier: (binding, input) => withRepositoryLease(profile, async () => {
      await description(binding); return api.materializeForVerification(input);
    }, repository.common),
    lookupVerification: (binding, input) => withRepositoryLease(profile, async () => {
      await description(binding); return lookupVerification(input);
    }, repository.common),
    describe: binding => withRepositoryLease(profile, () => description(binding), repository.common),
    read: (binding, original) => withRepositoryLease(profile, async () => {
      const described = await description(binding), verification = await readVerification(original.reference);
      if (!same(verification, original)) fail("original verification receipt differs from the current authenticated store record");
      const sealed = await readResult(verification.receipt.intent.result.reference), receipt = sealed.receipt;
      if (receipt.kind !== "authored" || !receipt.source?.launch_proof) fail("public projection requires an authored result with original signed launch provenance");
      if (receipt.inputs.length > 1 || !same(receipt.parents, [receipt.base_commit])) fail("authored result has an unsupported input lineage");
      const input = receipt.inputs[0] ? await readResult(receipt.inputs[0]) : undefined;
      if (input ? receipt.base_commit !== input.receipt.commit : receipt.base_commit !== profile.baseline_commit) fail("authored result base differs from its fixed input");
      assertState();
      return freezeReceipt({ description: described, verification,
        result: { reference: sealed.reference, kind: receipt.kind, profile_digest: receipt.profile_digest,
          repository_binding: receipt.repository_binding, base_commit: receipt.base_commit, commit: receipt.commit, tree: receipt.tree,
          manifest_digest: receipt.manifest.digest, inputs: receipt.inputs, source: receipt.source },
        ...(input ? { input: { reference: input.reference, commit: input.receipt.commit } } : {}) });
    }, repository.common),
  });
  return store;
}
