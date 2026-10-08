import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { assertOwnedMaterializedWorktree, assertOwnedWorktreeLocalBoundary, WorktreeReservationError, type MaterializedWorktree } from "./worktree-reservation.js";

export interface OwnedContextFile {
  readonly path: string;
  readonly workspaceRoot: string;
  readonly sha256: string;
  readonly bytes: number;
}
interface DirectoryObservation { path: string; canonical: string; identity: string }
interface ContextState {
  worktree: MaterializedWorktree;
  parents: DirectoryObservation[];
  canonicalPath: string;
  fileIdentity: string;
  valid: boolean;
}
const contexts = new WeakMap<OwnedContextFile, ContextState>();
const attempted = new WeakSet<MaterializedWorktree>();
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const identity = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`;
const childPath = (parent: string, child: string) => `${parent}${parent.endsWith(sep) ? "" : sep}${child}`;
const failure = (worktree: MaterializedWorktree, reason: string, cause?: unknown): never => {
  throw new WorktreeReservationError("context_boundary_failed", reason, worktree.root, cause);
};

/** Relative filename validation only; it does not inspect or authorize a path. */
export function contextFilenameParts(filename: string): string[] {
  if (typeof filename !== "string" || !filename || !filename.isWellFormed()
    || isAbsolute(filename) || /[\x00-\x1f\x7f]/u.test(filename)) {
    throw new Error("Context filename must be a well-formed relative path without control characters");
  }
  const parts = filename.split(sep);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Context filename cannot contain empty or dot segments");
  }
  return parts;
}

function observe(path: string): DirectoryObservation {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Context parent must be a plain existing directory");
  return { path, canonical: realpathSync.native(path), identity: identity(stat) };
}

function assertParentIdentities(state: ContextState): void {
  assertOwnedWorktreeLocalBoundary(state.worktree);
  for (const expected of state.parents) {
    const actual = observe(expected.path);
    if (actual.canonical !== expected.canonical || actual.identity !== expected.identity) {
      failure(state.worktree, "A context parent changed after observation; worktree retained");
    }
  }
}

async function assertParents(state: ContextState): Promise<void> {
  await assertOwnedMaterializedWorktree(state.worktree);
  assertParentIdentities(state);
}

function assertFile(file: OwnedContextFile, state: ContextState): void {
  const fd = openSync(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(file.bytes) || identity(stat) !== state.fileIdentity
      || realpathSync.native(file.path) !== state.canonicalPath
      || identity(lstatSync(file.path, { bigint: true })) !== state.fileIdentity) {
      failure(state.worktree, "Context file identity changed; worktree retained");
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) {
      failure(state.worktree, "Context file contents changed before launch; worktree retained");
    }
  } finally { closeSync(fd); }
}

/** Creates one new context file; existing source/worktree content is never overwritten. */
export async function writeOwnedContextFile(worktree: MaterializedWorktree, filename: string, text: string): Promise<OwnedContextFile> {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("Owned context boundary requires qualified POSIX semantics");
  const parts = contextFilenameParts(filename);
  if (attempted.has(worktree)) failure(worktree, "A context creation was already attempted for this worktree");
  attempted.add(worktree); // Claimed before the first async ownership check.
  const bytes = Buffer.from(text, "utf8");
  await assertOwnedMaterializedWorktree(worktree);
  const parents = [observe(worktree.root)];
  for (const part of parts.slice(0, -1)) {
    const parent = parents.at(-1)!;
    const observed = observe(childPath(parent.path, part));
    if (observed.canonical !== childPath(parent.canonical, part)) failure(worktree, "Context ancestry changed physical location");
    parents.push(observed);
  }
  const leaf = parts.at(-1)!;
  const parent = parents.at(-1)!;
  const path = childPath(parent.path, leaf);
  const file = Object.freeze({ path, workspaceRoot: worktree.root, sha256: digest(bytes), bytes: bytes.length });
  const state: ContextState = { worktree, parents, canonicalPath: childPath(parent.canonical, leaf), fileIdentity: "", valid: false };
  await assertParents(state);
  assertParentIdentities(state);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) failure(worktree, "New context file is not an exclusively created regular file");
    state.fileIdentity = identity(stat);
    await assertParents(state);
    if (realpathSync.native(path) !== state.canonicalPath || identity(lstatSync(path, { bigint: true })) !== state.fileIdentity) {
      failure(worktree, "New context file no longer matches its owned descriptor");
    }
    assertParentIdentities(state);
    writeFileSync(fd, bytes);
    closeSync(fd); fd = undefined;
    await assertParents(state);
    assertFile(file, state);
    assertParentIdentities(state);
    state.valid = true;
    contexts.set(file, state);
    return file;
  } catch (error) {
    state.valid = false;
    const reason = (error as NodeJS.ErrnoException)?.code === "EEXIST"
      ? "Context filename is occupied; existing bytes preserved"
      : "Context creation or verification failed; reservation and any created file retained";
    return failure(worktree, reason, error);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Caller must invoke immediately before spawn; this is not a spawn or race-free confinement. */
export async function assertOwnedContextForLaunch(file: OwnedContextFile): Promise<void> {
  const state = contexts.get(file);
  if (!state?.valid) throw new Error("A verified, unchanged owned context handle is required");
  try {
    await assertParents(state);
    assertOwnedContextLocalBoundary(file);
    await assertParents(state);
    assertOwnedContextLocalBoundary(file);
  } catch (error) { state.valid = false; throw error; }
}

/** Use immediately after fresh async validation and before spawn, with no intervening await. */
export function assertOwnedContextLocalBoundary(file: OwnedContextFile): void {
  const state = contexts.get(file);
  if (!state?.valid) throw new Error("A still-valid owned context handle is required");
  try {
    assertParentIdentities(state);
    assertFile(file, state);
  } catch (error) { state.valid = false; throw error; }
}
