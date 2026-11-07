import path from "node:path";
import { isPathWithinScope } from "@artoo/protocol";
import type { ServerContext } from "../context.js";

/** Compare node paths using the node OS, never the server's current directory. */
export function canonicalAutomationWorkspace(root: string, os: string): string {
  const windows = os === "windows" || os === "win32";
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || root.includes("\0")) throw new Error("Autonomous execution requires an absolute workspace root");
  const value = paths.normalize(root), filesystemRoot = paths.parse(value).root;
  const trimmed = value.replace(/[\\/]+$/, "");
  const normalized = trimmed.length < filesystemRoot.length ? filesystemRoot : trimmed;
  return windows ? normalized.toLowerCase() : normalized;
}

export function automationWorkspacesOverlap(left: string, right: string, os: string): boolean {
  const paths = os === "windows" || os === "win32" ? path.win32 : path.posix;
  const a = canonicalAutomationWorkspace(left, os), b = canonicalAutomationWorkspace(right, os);
  return isPathWithinScope(a, [b], paths) || isPathWithinScope(b, [a], paths);
}

/** Preserve the advertised root for execution; comparison keys are never execution paths. */
export function resolveAutomationWorkspace(ctx: Pick<ServerContext, "getVerificationWorkspace" | "supportsVerificationProfile">,
  computer: { id: string; os: string }, profileId: string, projectId: string, instanceRoot: string): string | undefined {
  const key = canonicalAutomationWorkspace(instanceRoot, computer.os);
  if (computer.os !== "win32" && computer.os !== "windows") {
    return ctx.supportsVerificationProfile?.(computer.id, profileId, projectId, key) === true ? key : undefined;
  }
  const root = ctx.getVerificationWorkspace?.(computer.id, profileId, projectId, instanceRoot);
  // An absent or stale getter never falls back to the instance's unverified spelling.
  return root !== undefined && canonicalAutomationWorkspace(root, computer.os) === key
    && ctx.supportsVerificationProfile?.(computer.id, profileId, projectId, root) === true ? root : undefined;
}
