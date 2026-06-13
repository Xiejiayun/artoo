import nodePath from "node:path";

/**
 * Workspace allowlist guard (design.md §4.7 / §6 security). Pure path-containment
 * check: normalizes both target and allowed roots, then verifies the target sits
 * on or under a root at a path boundary (not just a string prefix). The `pathApi`
 * is injectable (`node:path`, `path.win32`, `path.posix`) so Windows drive/`..`
 * cases are deterministically testable on any host.
 *
 * This is the one isolation guarantee v0.1-core makes: a process adapter must
 * only operate inside configured workspace roots.
 */
export type PathApi = Pick<typeof nodePath, "resolve" | "sep">;

function caseFold(value: string, pathApi: PathApi): string {
  // Windows paths are case-insensitive; posix paths are not.
  return pathApi.sep === "\\" ? value.toLowerCase() : value;
}

export function isPathWithinScope(
  target: string,
  allowedRoots: readonly string[],
  pathApi: PathApi = nodePath
): boolean {
  const resolvedTarget = caseFold(pathApi.resolve(target), pathApi);
  return allowedRoots.some((root) => {
    const resolvedRoot = caseFold(pathApi.resolve(root), pathApi);
    if (resolvedTarget === resolvedRoot) {
      return true;
    }
    const rootWithSep = resolvedRoot.endsWith(pathApi.sep)
      ? resolvedRoot
      : resolvedRoot + pathApi.sep;
    return resolvedTarget.startsWith(rootWithSep);
  });
}

export class WorkspaceScopeError extends Error {
  readonly code = "permission_denied" as const;

  constructor(
    readonly target: string,
    readonly allowedRoots: readonly string[]
  ) {
    super(`path '${target}' is outside the allowed workspace scope`);
    this.name = "WorkspaceScopeError";
  }
}

export function assertWorkspaceScope(
  target: string,
  allowedRoots: readonly string[],
  pathApi: PathApi = nodePath
): void {
  if (!isPathWithinScope(target, allowedRoots, pathApi)) {
    throw new WorkspaceScopeError(target, allowedRoots);
  }
}
