import { assertNotAborted, gitOperation, snapshotGitOptions } from "./git-operations.js";
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  parseWorktreePorcelain, preflightFreshWorktree,
  type FreshWorktreeInput, type FreshWorktreeValidation, type GitReadOptions,
} from "./worktree-preflight.js";

export class WorktreeReservationError extends Error {
  readonly code: string;
  readonly retainedRoot?: string;
  constructor(code: string, message: string, retainedRoot?: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorktreeReservationError";
    this.code = code;
    this.retainedRoot = retainedRoot;
  }
}

interface DirectoryIdentity { readonly path: string; readonly identity: string }
export interface PreparedWorktree {
  readonly root: string;
  readonly branch: string;
  readonly committedHead: string;
}
export interface OwnedReservation extends PreparedWorktree { readonly targetIdentity: string }
export interface MaterializedWorktree extends OwnedReservation { readonly commonDirectory: string }

interface State {
  readonly input: FreshWorktreeInput;
  readonly options: GitReadOptions;
  readonly validation: FreshWorktreeValidation;
  readonly branch: string;
  readonly boundaries: readonly DirectoryIdentity[];
  readonly allowedPaths: readonly string[];
  phase: "prepared" | "reserving" | "reserved" | "materializing" | "materialized" | "failed";
  target?: DirectoryIdentity;
}
// Only handles created by this module authorize a reservation or materialization.
const preparedStates = new WeakMap<PreparedWorktree, State>();
const reservedStates = new WeakMap<OwnedReservation, State>();
const materializedStates = new WeakMap<MaterializedWorktree, State>();
const fail = (code: string, message: string): never => { throw new WorktreeReservationError(code, message); };
const within = (child: string, parent: string): boolean => {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);

async function git(state: State, cwd: string, args: readonly string[], allowedStatuses: readonly number[] = [0], kind: "read" | "materialize" = "read") {
  if (state.phase === "failed") fail("invalid_handle", "The owned attempt has already failed");
  const admittedPhase = state.phase;
  assertNotAborted(state.options);
  assertBoundaries(state);
  const result = await gitOperation(cwd, args, state.options, kind);
  if (state.phase !== admittedPhase) fail("invalid_handle", "The owned attempt changed state during Git validation");
  assertNotAborted(state.options);
  assertBoundaries(state);
  if (!allowedStatuses.includes(result.status)) {
    fail("git_failed", `Git ${args[0]} failed (exit ${result.status}); no cleanup was attempted`);
  }
  return { output: result.stdout, status: result.status };
}

function line(output: Buffer): string {
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(output); }
  catch { fail("invalid_git_output", "Git output is not UTF-8"); }
  if (!value!.endsWith("\n") || !value!.slice(0, -1) || /[\x00-\x1f\x7f]/.test(value!.slice(0, -1))) {
    fail("invalid_git_output", "Git output is not one unambiguous line");
  }
  return value!.slice(0, -1);
}

function observe(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path) {
    fail("invalid_directory", "An observed canonical directory is no longer a plain directory");
  }
  return { path, identity: `${info.dev}:${info.ino}` };
}

async function canonicalGitPath(state: State, cwd: string, arg: string): Promise<string> {
  const value = line((await git(state, cwd, ["rev-parse", arg])).output);
  // Preserve OS traversal semantics; do not lexically erase a link/.. pair.
  return realpathSync.native(isAbsolute(value) ? value : `${cwd}${sep}${value}`);
}

function assertBoundaries(state: State, requireEmpty = false): void {
  const value = state.validation;
  if (realpathSync.native(dirname(state.input.root)) !== dirname(value.canonicalTarget)
    || realpathSync.native(state.input.sourceRepo) !== value.canonicalSource
    || state.input.allowedRoots.some((root, index) => realpathSync.native(root) !== state.allowedPaths[index])) {
    fail("changed_identity", "A configured path now resolves to a different directory");
  }
  for (const expected of [...state.boundaries, ...(state.target ? [state.target] : [])]) {
    if (observe(expected.path).identity !== expected.identity) fail("changed_identity", "An observed directory identity changed");
  }
  if (state.target && realpathSync.native(state.input.root) !== state.target.path) {
    fail("changed_identity", "The owned target now resolves to a different directory");
  }
  if (requireEmpty && readdirSync(state.input.root).length) fail("occupied_reservation", "The owned reservation is no longer empty");
}

async function assertRepository(state: State, materialized: boolean): Promise<void> {
  const value = state.validation;
  const source = value.canonicalSource;
  if (await canonicalGitPath(state, source, "--show-toplevel") !== value.canonicalSourceCheckout
    || await canonicalGitPath(state, source, "--absolute-git-dir") !== value.canonicalGitDirectory
    || await canonicalGitPath(state, source, "--git-common-dir") !== value.canonicalCommonDirectory) {
    fail("changed_repository", "Source checkout or Git metadata location changed");
  }
  await git(state, source, ["cat-file", "-e", `${value.sourceHead}^{commit}`]);
  const records = parseWorktreePorcelain((await git(state, source, ["worktree", "list", "--porcelain", "-z"])).output);
  const identities = new Set<string>();
  let ownEntries = 0;
  for (const record of records) {
    const path = realpathSync.native(record.path);
    const directory = observe(path);
    if (identities.has(directory.identity)) fail("invalid_registry", "Worktree records alias one physical directory");
    identities.add(directory.identity);
    if (materialized && path === value.canonicalTarget && directory.identity === state.target?.identity) {
      if (record.head !== value.sourceHead || record.branch !== `refs/heads/${state.branch}`
        || record.detached || record.bare || record.locked || record.prunable) {
        fail("unexpected_worktree", "The owned worktree registration has unexpected state");
      }
      ownEntries += 1;
    } else if (overlaps(path, value.canonicalTarget)) {
      fail("unsafe_topology", "Target overlaps another registered worktree");
    }
  }
  if (materialized) {
    if (ownEntries !== 1) fail("unexpected_worktree", "Expected exactly one owned worktree registration");
    if (await canonicalGitPath(state, state.input.root, "--show-toplevel") !== value.canonicalTarget
      || await canonicalGitPath(state, state.input.root, "--git-common-dir") !== value.canonicalCommonDirectory
      || line((await git(state, state.input.root, ["symbolic-ref", "--quiet", "HEAD"])).output) !== `refs/heads/${state.branch}`
      || line((await git(state, state.input.root, ["rev-parse", "--verify", "HEAD^{commit}"])).output) !== value.sourceHead) {
      fail("unexpected_worktree", "Materialized checkout does not match the requested root, branch, commit and repository");
    }
    const metadata = await canonicalGitPath(state, state.input.root, "--absolute-git-dir");
    if (!within(metadata, value.canonicalCommonDirectory) || !state.allowedPaths.some((root) => within(metadata, root))) {
      fail("outside_allowlist", "New worktree metadata is outside its authorized common directory");
    }
  }
}

/** Read-only preparation. The direct target parent and allowlist roots must exist. */
export async function prepareOwnedWorktree(input: FreshWorktreeInput & { readonly branch: string }, options: GitReadOptions = {}): Promise<PreparedWorktree> {
  // Detach mutable caller state before the first asynchronous observation.
  input = Object.freeze({ ...input, allowedRoots: Object.freeze([...input.allowedRoots]) });
  options = snapshotGitOptions(options);
  assertNotAborted(options);
  const validation = await preflightFreshWorktree(input, options);
  if (validation.targetMissingSegments.length !== 1) fail("missing_parent", "Provision the direct target parent before reservation");
  if (typeof input.branch !== "string" || !input.branch || input.branch.trim() !== input.branch || /[\x00-\x1f\x7f]/.test(input.branch)) {
    fail("invalid_branch", "An explicit branch without surrounding whitespace or control characters is required");
  }
  const allowedPaths = input.allowedRoots.map((root) => realpathSync.native(root));
  // Later rev-parse verification uses the same exact single-line contract.
  // Reject unsupported path bytes now, before creating a reservation.
  if ([input.root, input.sourceRepo, ...input.allowedRoots, ...allowedPaths, validation.canonicalTarget,
    validation.canonicalSource, validation.canonicalSourceCheckout, validation.canonicalGitDirectory,
    validation.canonicalCommonDirectory].some((path) => /[\x00-\x1f\x7f]/.test(path))) {
    fail("invalid_path", "Control characters in filesystem paths are unsupported by this prototype");
  }
  const paths = new Set<string>();
  for (const original of [dirname(validation.canonicalTarget), validation.canonicalSource, validation.canonicalSourceCheckout,
    validation.canonicalGitDirectory, validation.canonicalCommonDirectory, ...allowedPaths]) {
    let path = original;
    for (;;) { paths.add(path); const parent = dirname(path); if (parent === path) break; path = parent; }
  }
  const state: State = {
    input: Object.freeze({ root: input.root, sourceRepo: input.sourceRepo, allowedRoots: Object.freeze([...input.allowedRoots]) }),
    options, validation, branch: input.branch, allowedPaths,
    boundaries: [...paths].map(observe), phase: "prepared",
  };
  if (observe(dirname(validation.canonicalTarget)).identity !== validation.targetExistingAncestor.identity) {
    fail("changed_identity", "The target parent changed after preflight");
  }
  const branchCheck = await git(state, validation.canonicalSource, ["check-ref-format", "--branch", state.branch], [0, 1, 128]);
  if (branchCheck.status !== 0) fail("invalid_branch", "Git rejected the requested branch name");
  const checkedBranch = line(branchCheck.output);
  if (checkedBranch !== state.branch) fail("invalid_branch", "Branch shorthand is not accepted");
  if ((await git(state, validation.canonicalSource, ["show-ref", "--verify", "--quiet", `refs/heads/${state.branch}`], [0, 1])).status === 0) {
    fail("existing_branch", "The requested branch already exists");
  }
  assertBoundaries(state);
  assertNotAborted(options);
  const handle = Object.freeze({ root: input.root, branch: state.branch, committedHead: validation.sourceHead });
  preparedStates.set(handle, state);
  return handle;
}

/** Successful nonrecursive mkdir is the claim. Existing entries are never adopted. */
export async function reserveOwnedWorktree(prepared: PreparedWorktree): Promise<OwnedReservation> {
  const state = preparedStates.get(prepared);
  if (!state || state.phase !== "prepared") fail("invalid_handle", "A fresh prepared handle is required");
  state!.phase = "reserving"; // Claim the one-shot attempt before any await.
  let acquired = false;
  try {
    assertNotAborted(state!.options);
    assertBoundaries(state!);
    const current = await preflightFreshWorktree(state!.input, state!.options);
    for (const key of ["canonicalTarget", "canonicalSource", "canonicalSourceCheckout", "canonicalGitDirectory", "canonicalCommonDirectory"] as const) {
      if (current[key] !== state!.validation[key]) fail("changed_identity", "A preflight location changed before reservation");
    }
    assertBoundaries(state!);
    assertNotAborted(state!.options);
    try { mkdirSync(state!.input.root, { mode: 0o700 }); acquired = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("occupied_target", "Target is occupied; reservation was not acquired");
      throw error;
    }
    state!.target = observe(state!.validation.canonicalTarget);
    assertBoundaries(state!, true);
    state!.phase = "reserved";
    const handle = Object.freeze({ ...prepared, targetIdentity: state!.target.identity });
    reservedStates.set(handle, state!);
    return handle;
  } catch (error) {
    state!.phase = "failed";
    if (acquired) return retainFailure(state!, error);
    throw error; // No acquired target: never label an existing entry as owned.
  }
}

function retainFailure(state: State, error: unknown): never {
  state.phase = "failed";
  const code = error instanceof WorktreeReservationError ? error.code : "verification_failed";
  const message = error instanceof Error ? error.message : "Unknown reservation failure";
  throw new WorktreeReservationError(code, `${message}. Reservation/partial worktree retained at ${state.input.root}`, state.input.root, error);
}

/** No force, reset, cleanup, adoption, retry suffix or application launch occurs here. */
export async function materializeOwnedWorktree(reservation: OwnedReservation): Promise<MaterializedWorktree> {
  const state = reservedStates.get(reservation);
  if (!state || state.phase !== "reserved") fail("invalid_handle", "An unused owned reservation is required");
  state!.phase = "materializing"; // A concurrent call cannot reach Git.
  try {
    assertNotAborted(state!.options);
    assertBoundaries(state!, true);
    await assertRepository(state!, false);
    assertBoundaries(state!, true);
    assertNotAborted(state!.options);
    await git(state!, state!.validation.canonicalSource, ["worktree", "add", "-b", state!.branch, "--", state!.input.root, state!.validation.sourceHead], [0], "materialize");
    assertBoundaries(state!);
    await assertRepository(state!, true);
    assertBoundaries(state!);
    assertNotAborted(state!.options);
    if (state!.phase !== "materializing") fail("invalid_handle", "The materialization attempt was invalidated");
    state!.phase = "materialized";
    const result = Object.freeze({ ...reservation, commonDirectory: state!.validation.canonicalCommonDirectory });
    materializedStates.set(result, state!);
    return result;
  } catch (error) { return retainFailure(state!, error); }
}

/** Revalidate an actual materialized handle at a subsequent owned write boundary. */
export async function assertOwnedMaterializedWorktree(worktree: MaterializedWorktree): Promise<void> {
  const state = materializedStates.get(worktree);
  if (!state || state.phase !== "materialized") fail("invalid_handle", "A verified materialized worktree handle is required");
  try {
    assertBoundaries(state!);
    await assertRepository(state!, true);
    assertOwnedWorktreeLocalBoundary(worktree);
  } catch (error) { return retainFailure(state!, error); }
}

/** Complements fresh asynchronous Git validation; never substitutes for it. */
export function assertOwnedWorktreeLocalBoundary(worktree: MaterializedWorktree): void {
  const state = materializedStates.get(worktree);
  if (!state || state.phase !== "materialized") fail("invalid_handle", "A still-valid materialized worktree handle is required");
  try {
    assertNotAborted(state!.options);
    assertBoundaries(state!);
  } catch (error) { return retainFailure(state!, error); }
}
