import { assertNotAborted, gitOperation, snapshotGitOptions } from "./git-operations.js";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import { preflightFreshWorktree, type FreshWorktreeInput, type GitReadOptions } from "./worktree-preflight.js";

export interface NamespaceInput extends FreshWorktreeInput {
  readonly basePath: string;
  readonly agentInstanceId: string;
  readonly runId: string;
}
export interface NamespaceResult {
  readonly root: string;
  readonly parent: string;
  readonly createdDirectories: readonly string[];
}
interface DirectoryObservation { path: string; canonical: string; identity: string; aliasAllowed: boolean }
const fail = (message: string): never => { throw new Error(message); };
const within = (child: string, parent: string) => {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
};
function observe(path: string, aliasAllowed: boolean): DirectoryObservation {
  const canonical = realpathSync.native(path);
  const stat = lstatSync(aliasAllowed ? canonical : path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Namespace ancestry must be an existing plain directory");
  return { path, canonical, identity: `${stat.dev}:${stat.ino}`, aliasAllowed };
}
function assertSame(observations: readonly DirectoryObservation[]): void {
  for (const expected of observations) {
    const actual = observe(expected.path, expected.aliasAllowed);
    if (actual.canonical !== expected.canonical || actual.identity !== expected.identity) fail("Namespace directory identity changed; created containers retained");
  }
}
async function requireOutsideRepository(directory: string, options: GitReadOptions): Promise<void> {
  const result = await gitOperation(directory, ["rev-parse", "--git-dir"], options);
  if (result.status === 0) fail("Namespace containers cannot be inside a Git repository");
  if (result.status !== 128 || result.stdout.length !== 0
    || !result.stderr.equals(Buffer.from("fatal: not a git repository (or any of the parent directories): .git\n"))) {
    fail("Cannot establish that the namespace container is outside a Git repository");
  }
}

/** Only provisions parent containers. It never claims, adopts or creates a run target. */
export async function provisionRunNamespace(input: NamespaceInput, options: GitReadOptions = {}): Promise<NamespaceResult> {
  input = Object.freeze({ ...input, allowedRoots: Object.freeze([...input.allowedRoots]) });
  options = snapshotGitOptions(options);
  assertNotAborted(options);
  if (process.platform !== "darwin" && process.platform !== "linux") fail("Namespace provisioning requires qualified POSIX filesystem semantics");
  const expected = allocateWorkspaceRoot({ workspaceRoot: null, branchBacked: true, targetComputerOs: process.platform,
    agentInstanceId: input.agentInstanceId, runId: input.runId,
    worktreeBase: { version: 1, strategy: "per-run", basePath: input.basePath } });
  if (input.root !== expected) fail("Namespace root differs from the immutable allocation identity");
  const base = observe(input.basePath, true);
  const allowed = input.allowedRoots.map((path) => observe(path, true));
  if (!allowed.some((entry) => within(resolve(input.basePath), resolve(entry.path)))
    || !allowed.some((entry) => within(base.canonical, entry.canonical))) fail("Namespace base is outside the node allowlist");
  const initial = await preflightFreshWorktree(input, options);
  const prefix = input.basePath + (input.basePath.endsWith(sep) ? "" : sep);
  const parts = input.root.slice(prefix.length).split(sep);
  if (parts.length !== 3 || parts[0] !== "artoo-runs") fail("Unexpected allocator namespace shape");
  const observations = [...allowed, base], created: string[] = [];
  let current = base;
  for (const part of parts.slice(0, 2)) {
    assertSame(observations);
    await requireOutsideRepository(current.canonical, options);
    assertSame(observations);
    assertNotAborted(options);
    const path = current.path + (current.path.endsWith(sep) ? "" : sep) + part;
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { mkdirSync(path, { mode: 0o700 }); created.push(path); }
      catch (mkdirError) {
        // Parent containers may be created concurrently by cooperating runs.
        // The final run directory is reserved separately and never accepted here.
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
    }
    const next = observe(path, false);
    const expectedChild = current.canonical + (current.canonical.endsWith(sep) ? "" : sep) + part;
    if (next.canonical !== expectedChild) fail("Namespace child changed physical location; containers retained");
    observations.push(next); assertSame(observations); current = next;
  }
  await requireOutsideRepository(current.canonical, options);
  assertSame(observations);
  const final = await preflightFreshWorktree(input, options);
  for (const key of ["canonicalTarget", "canonicalSource", "canonicalSourceCheckout", "canonicalGitDirectory", "canonicalCommonDirectory"] as const) {
    if (final[key] !== initial[key]) fail("Namespace source or target location changed during provisioning");
  }
  if (final.targetMissingSegments.length !== 1 || final.targetExistingAncestor.canonicalPath !== current.canonical) {
    fail("Namespace preparation must leave exactly the final run target absent");
  }
  assertSame(observations);
  assertNotAborted(options);
  return Object.freeze({ root: input.root, parent: current.path, createdDirectories: Object.freeze([...created]) });
}
