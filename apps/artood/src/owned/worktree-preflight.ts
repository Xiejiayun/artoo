import { assertNotAborted, gitOperation, snapshotGitOptions, type GitReadOptions } from "./git-operations.js";
export type { GitReadOptions } from "./git-operations.js";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PreflightErrorCode =
  | "invalid_input" | "occupied_target" | "invalid_path" | "outside_allowlist"
  | "git_query_failed" | "invalid_git_output" | "unsupported_repository"
  | "unsafe_topology" | "changed_during_preflight";

export class WorktreePreflightError extends Error {
  readonly code: PreflightErrorCode;
  constructor(code: PreflightErrorCode, message: string) {
    super(message);
    this.name = "WorktreePreflightError";
    this.code = code;
  }
}

export interface FreshWorktreeInput {
  readonly root: string;
  readonly sourceRepo: string;
  readonly allowedRoots: readonly string[];
}


export interface WorktreeRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

interface DirectoryIdentity {
  readonly canonicalPath: string;
  readonly identity: string;
}

interface PhysicalPath {
  readonly canonicalPath: string;
  readonly missingSegments: readonly string[];
  readonly ancestor: DirectoryIdentity;
  readonly ancestry: readonly DirectoryIdentity[];
}

/** Validation observations only: these are not a reservation or an execution plan. */
export interface FreshWorktreeValidation {
  readonly requestedRoot: string;
  readonly canonicalTarget: string;
  readonly targetExistingAncestor: DirectoryIdentity;
  readonly targetMissingSegments: readonly string[];
  readonly canonicalSource: string;
  readonly canonicalSourceCheckout: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonDirectory: string;
  readonly sourceHead: string;
  readonly registeredWorktrees: readonly (WorktreeRecord & { canonicalPath: string })[];
}

function fail(code: PreflightErrorCode, message: string): never {
  throw new WorktreePreflightError(code, message);
}

const components = (path: string): string[] => path.split(process.platform === "win32" ? /[\\/]/ : /\//);
const hasDotSegments = (path: string): boolean => components(path).some((part) => part === "." || part === "..");

function pathInput(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") || !isAbsolute(value) || hasDotSegments(value)) {
    fail("invalid_input", `${field} must be a well-formed absolute local path without NUL or dot segments`);
  }
}

function within(child: string, parent: string): boolean {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function absentTarget(path: string): void {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    fail("invalid_path", "Cannot establish target absence");
  }
  fail("occupied_target", "Target is occupied; existing entries are never adopted");
}

function directoryIdentity(canonicalPath: string): DirectoryIdentity {
  try {
    const value = statSync(canonicalPath, { bigint: true });
    if (!value.isDirectory()) fail("invalid_path", "An existing path component is not a directory");
    return { canonicalPath, identity: `${value.dev}:${value.ino}` };
  } catch (error) {
    if (error instanceof WorktreePreflightError) throw error;
    fail("invalid_path", "Cannot inspect an existing directory");
  }
}

/** lstat distinguishes dangling links from truly absent suffixes. */
function physicalPath(input: string): PhysicalPath {
  if (hasDotSegments(input)) fail("invalid_path", "Physical validation cannot erase dot segments before following links");
  let existing = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try { lstatSync(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("invalid_path", "Cannot inspect path ancestry");
      const parent = dirname(existing);
      if (parent === existing) fail("invalid_path", "No existing directory ancestor");
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  let canonical: string;
  // Use OS traversal semantics, including link/.. inside a symlink's target.
  // The non-native JS implementation can lexically normalize that pair first.
  try { canonical = realpathSync.native(existing); }
  catch { fail("invalid_path", "An existing ancestor is dangling or cannot be resolved"); }
  const ancestor = directoryIdentity(canonical!);
  const ancestry: DirectoryIdentity[] = [ancestor];
  let parent = dirname(canonical!);
  while (parent !== ancestry.at(-1)!.canonicalPath) {
    ancestry.push(directoryIdentity(parent));
    parent = dirname(parent);
  }
  return { canonicalPath: resolve(canonical!, ...missing), missingSegments: missing, ancestor, ancestry };
}

function existingDirectory(input: string): PhysicalPath {
  const value = physicalPath(input);
  if (value.missingSegments.length) fail("invalid_path", "Required directory is absent");
  return value;
}

function physicallyWithin(child: PhysicalPath, parent: PhysicalPath): boolean {
  // Identity comparison also catches case/Unicode aliases on existing directories.
  if (!parent.missingSegments.length && child.ancestry.some((item) => item.identity === parent.ancestor.identity)) return true;
  return within(child.canonicalPath, parent.canonicalPath);
}

function authorized(value: PhysicalPath, allowed: readonly PhysicalPath[], field: string): void {
  if (!allowed.some((root) => physicallyWithin(value, root))) fail("outside_allowlist", `${field} is outside the node allowlist`);
}

function decode(output: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(output); }
  catch { fail("invalid_git_output", "Git output is not valid UTF-8"); }
}

/** One documented rev-parse result; remove one terminator, never trim path bytes. */
function singleResult(output: Buffer): string {
  const text = decode(output);
  if (!text.endsWith("\n") || text.includes("\0")) fail("invalid_git_output", "Git path output is incomplete");
  const result = text.slice(0, -1);
  if (!result) fail("invalid_git_output", "Git returned an empty value");
  return result;
}

function commonDirectoryPath(value: string, canonicalSource: string): string {
  if (isAbsolute(value)) {
    if (hasDotSegments(value)) fail("invalid_git_output", "Absolute Git metadata path contains dot segments");
    return value;
  }
  // A relative --git-common-dir result can start with ../ from a source
  // subdirectory. Resolve only that leading traversal from the already physical
  // source; do not normalize an intervening symlink/.. pair from Git output.
  const parts = components(value);
  let parent = canonicalSource;
  while (parts[0] === "." || parts[0] === "..") {
    if (parts.shift() === "..") parent = dirname(parent);
  }
  if (parts.some((part) => part === "." || part === "..")) fail("invalid_git_output", "Git metadata path has ambiguous internal traversal");
  return resolve(parent, ...parts);
}

/** Only the NUL porcelain contract is accepted. Unknown/truncated records fail closed. */
export function parseWorktreePorcelain(output: Buffer): WorktreeRecord[] {
  const text = decode(output);
  if (!text.endsWith("\0\0")) fail("invalid_git_output", "Git worktree output is not complete NUL porcelain");
  const blocks = text.slice(0, -2).split("\0\0");
  const seenPaths = new Set<string>();
  return blocks.map((block): WorktreeRecord => {
    const fields = block.split("\0");
    const first = fields.shift();
    if (!first?.startsWith("worktree ")) fail("invalid_git_output", "Git worktree record has no leading path");
    const path = first!.slice("worktree ".length);
    if (!isAbsolute(path) || hasDotSegments(path) || seenPaths.has(path)) fail("invalid_git_output", "Git worktree path is invalid or duplicated");
    seenPaths.add(path);
    let head: string | undefined, branch: string | undefined;
    let detached = false, bare = false, locked = false, prunable = false;
    const seen = new Set<string>();
    for (const field of fields) {
      const split = field.indexOf(" ");
      const key = split < 0 ? field : field.slice(0, split);
      const value = split < 0 ? undefined : field.slice(split + 1);
      if (seen.has(key)) fail("invalid_git_output", "Git worktree attribute is duplicated");
      seen.add(key);
      if (key === "HEAD" && value && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) head = value;
      else if (key === "branch" && value?.startsWith("refs/heads/") && value.length > 11) branch = value;
      else if (key === "detached" && value === undefined) detached = true;
      else if (key === "bare" && value === undefined) bare = true;
      else if (key === "locked") locked = true;
      else if (key === "prunable") prunable = true;
      else fail("invalid_git_output", "Git worktree attribute is unsupported or malformed");
    }
    if (bare ? (head !== undefined || branch !== undefined || detached) : (!head || (branch !== undefined) === detached)) {
      fail("invalid_git_output", "Git worktree record lacks an unambiguous checkout state");
    }
    return { path, head, branch, detached, bare, locked, prunable };
  });
}

function gitReader(source: string, options: GitReadOptions): (args: readonly string[]) => Promise<Buffer> {
  return async (args) => {
    const result = await gitOperation(source, args, options);
    if (result.status !== 0) fail("git_query_failed", "A bounded read-only Git query failed; required Git features may be unavailable");
    return result.stdout;
  };
}

function overlaps(candidate: PhysicalPath, protectedDirectory: PhysicalPath): boolean {
  return physicallyWithin(candidate, protectedDirectory) || physicallyWithin(protectedDirectory, candidate);
}

/**
 * Observes a fresh target and its selected repository without creating, reserving,
 * deleting, adopting, locking, pruning or materializing anything. These sequential
 * checks mitigate mistakes; they are not atomic or safe against all same-UID races.
 */
export async function preflightFreshWorktree(input: FreshWorktreeInput, options: GitReadOptions = {}): Promise<FreshWorktreeValidation> {
  pathInput(input.root, "root");
  pathInput(input.sourceRepo, "sourceRepo");
  if (!Array.isArray(input.allowedRoots) || input.allowedRoots.length === 0) fail("invalid_input", "Node allowlist is required");
  for (const root of input.allowedRoots) pathInput(root, "allowedRoots entry");
  input = Object.freeze({ root: input.root, sourceRepo: input.sourceRepo, allowedRoots: Object.freeze([...input.allowedRoots]) });
  options = snapshotGitOptions(options);
  assertNotAborted(options);
  absentTarget(input.root);
  const target = physicalPath(input.root);
  const source = existingDirectory(input.sourceRepo);
  const allowed = input.allowedRoots.map(physicalPath);
  // Match the process adapter's lexical guard as well as the physical policy.
  if (!input.allowedRoots.some((root) => within(resolve(input.root), resolve(root)))) {
    fail("outside_allowlist", "Target is outside the lexical node allowlist");
  }
  authorized(target, allowed, "Target");
  authorized(source, allowed, "Source");

  const read = gitReader(source.canonicalPath, options);
  const bare = singleResult(await read(["rev-parse", "--is-bare-repository"]));
  if (bare === "true") fail("unsupported_repository", "This prototype requires a non-bare source checkout");
  if (bare !== "false") fail("invalid_git_output", "Git did not identify repository type");
  const checkoutPath = singleResult(await read(["rev-parse", "--show-toplevel"]));
  const gitPath = singleResult(await read(["rev-parse", "--absolute-git-dir"]));
  // --git-common-dir may be relative to -C, including on older Git versions.
  const commonPath = singleResult(await read(["rev-parse", "--git-common-dir"]));
  if (!isAbsolute(checkoutPath) || !isAbsolute(gitPath)) fail("invalid_git_output", "Git did not return absolute checkout/metadata paths");
  const checkout = existingDirectory(checkoutPath);
  const gitDirectory = existingDirectory(gitPath);
  const commonDirectory = existingDirectory(commonDirectoryPath(commonPath, source.canonicalPath));
  authorized(checkout, allowed, "Source checkout");
  authorized(gitDirectory, allowed, "Git directory");
  authorized(commonDirectory, allowed, "Git common directory");
  if (!physicallyWithin(source, checkout)) fail("invalid_git_output", "Configured source is not in its reported checkout");
  if ([checkout, gitDirectory, commonDirectory].some((path) => overlaps(target, path))) {
    fail("unsafe_topology", "Target overlaps source or Git metadata");
  }
  const sourceHead = singleResult(await read(["rev-parse", "--verify", "HEAD^{commit}"]));
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceHead)) fail("invalid_git_output", "Source has no unambiguous committed HEAD");
  const worktrees = parseWorktreePorcelain(await read(["worktree", "list", "--porcelain", "-z"]));
  const registered = worktrees.map((record) => ({ record, physical: existingDirectory(record.path) }));
  if (new Set(registered.map((item) => item.physical.ancestor.identity)).size !== registered.length) {
    fail("invalid_git_output", "Registered worktrees alias the same physical directory");
  }
  if (!registered.some((item) => item.physical.ancestor.identity === checkout.ancestor.identity && item.record.head === sourceHead)) {
    fail("invalid_git_output", "Git worktree inventory does not match the source checkout/HEAD");
  }
  if (registered.some((item) => overlaps(target, item.physical))) {
    fail("unsafe_topology", "Target overlaps a registered worktree");
  }

  assertNotAborted(options);
  // Awaited Git permits other cooperative tasks to run: repeat all observed
  // path identities before returning authority-free validation observations.
  const observations: Array<[string, PhysicalPath]> = [
    [input.sourceRepo, source], [checkoutPath, checkout], [gitPath, gitDirectory],
    [commonDirectoryPath(commonPath, source.canonicalPath), commonDirectory],
    ...input.allowedRoots.map((path, i): [string, PhysicalPath] => [path, allowed[i]!]),
  ];
  for (const [path, before] of observations) {
    if (JSON.stringify(physicalPath(path)) !== JSON.stringify(before)) fail("changed_during_preflight", "An observed path changed during asynchronous preflight");
  }
  absentTarget(input.root);
  const finalTarget = physicalPath(input.root);
  if (JSON.stringify(target) !== JSON.stringify(finalTarget)) {
    fail("changed_during_preflight", "Target ancestry changed during preflight");
  }
  return {
    requestedRoot: input.root, canonicalTarget: target.canonicalPath,
    targetExistingAncestor: target.ancestor, targetMissingSegments: target.missingSegments,
    canonicalSource: source.canonicalPath, canonicalSourceCheckout: checkout.canonicalPath,
    canonicalGitDirectory: gitDirectory.canonicalPath, canonicalCommonDirectory: commonDirectory.canonicalPath,
    sourceHead, registeredWorktrees: registered.map(({ record, physical }) => ({ ...record, canonicalPath: physical.canonicalPath })),
  };
}
