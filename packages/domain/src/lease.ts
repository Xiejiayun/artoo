/**
 * File-lease path semantics (design.md §6 concurrency control). PURE — no IO.
 * The server (#12 Phase B) uses these to gate concurrent writes: a held `write`
 * lease conflicts with any overlapping lease, so the scheduler/run-start path is
 * rejected (409). Every path is normalized to workspace-relative POSIX form
 * BEFORE any storage or comparison, and malicious paths are rejected up front.
 */
import type { LeaseMode } from "./schemas.js";

export interface LeaseScope {
  /** Workspace-relative POSIX path (no leading slash, no `.`/`..` segments). */
  path: string;
  mode: LeaseMode;
}

/** Result of {@link normalizeLeasePath}: either a safe relative path or a reason. */
export type NormalizeLeasePathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** Split a POSIX path into non-empty segments. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

/** Convert backslashes to forward slashes (treat Windows separators uniformly). */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Whether a (separator-normalized) path is absolute: drive-letter or root-anchored. */
function isAbsolutePosix(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith("/");
}

/**
 * Normalize `rawPath` to a workspace-relative POSIX path, or reject it. Rejects:
 * null bytes; absolute paths (drive / UNC / root) that escape `workspaceRoot`;
 * and any `..` traversal that climbs above the workspace root. An absolute path
 * inside `workspaceRoot` is accepted and made relative. The returned path uses
 * `/` separators and contains no `.`/`..`/empty segments (the workspace root
 * itself normalizes to `""`).
 */
export function normalizeLeasePath(
  workspaceRoot: string,
  rawPath: string,
): NormalizeLeasePathResult {
  if (rawPath.includes("\0") || workspaceRoot.includes("\0")) {
    return { ok: false, reason: "path contains a null byte" };
  }
  if (rawPath.trim() === "") {
    return { ok: false, reason: "path is empty" };
  }

  const root = toPosix(workspaceRoot).replace(/\/+$/, "");
  const raw = toPosix(rawPath);

  let relative: string;
  if (isAbsolutePosix(raw)) {
    // Absolute path must live within the workspace root.
    if (raw === root) {
      relative = "";
    } else if (root !== "" && raw.startsWith(`${root}/`)) {
      relative = raw.slice(root.length + 1);
    } else {
      return { ok: false, reason: "absolute path escapes the workspace root" };
    }
  } else {
    relative = raw;
  }

  // Resolve `.`/`..` segments without escaping above the root.
  const stack: string[] = [];
  for (const seg of segments(relative)) {
    if (seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (stack.length === 0) {
        return { ok: false, reason: "path escapes the workspace root" };
      }
      stack.pop();
      continue;
    }
    stack.push(seg);
  }

  return { ok: true, path: stack.join("/") };
}

/**
 * Whether two normalized paths overlap by PATH SEGMENT (containment): equal, or
 * one is an ancestor directory of the other. `src/foo` overlaps `src/foo/bar.ts`
 * but NOT `src/foobar`. The empty path (workspace root) overlaps everything.
 */
export function pathsOverlap(a: string, b: string): boolean {
  const sa = segments(a);
  const sb = segments(b);
  const shared = Math.min(sa.length, sb.length);
  for (let i = 0; i < shared; i++) {
    if (sa[i] !== sb[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Two lease scopes CONFLICT when their paths overlap and at least one is a
 * `write`. read/read coexists; write/read and write/write conflict.
 */
export function leasesConflict(a: LeaseScope, b: LeaseScope): boolean {
  return pathsOverlap(a.path, b.path) && (a.mode === "write" || b.mode === "write");
}
