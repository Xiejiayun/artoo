import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { win32 } from "node:path";
import { assertCanonicalWindowsPath, assertNativeWindows, physicalWindowsDirectory } from "./windows-local-acl.js";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage, auditWindowsReleaseStorage } from "./windows-release-storage.js";

declare const sessionBrand: unique symbol;
export interface PreparedApplicationSession { readonly [sessionBrand]: true }
function fact(path: string) {
  assertCanonicalWindowsPath(path); const value = lstatSync(path, { bigint: true });
  if (!value.isDirectory() || value.isSymbolicLink() || realpathSync.native(path) !== path) throw Error("Application session requires a physical directory");
  return value;
}
const sessions = new WeakMap<object, ReturnType<typeof acquire>>();
function acquire(controlDirectory: string, writableWorkspaceRoots: readonly string[]) {
  assertNativeWindows();
  const control = physicalWindowsDirectory(controlDirectory), roots = Object.freeze(writableWorkspaceRoots.map(physicalWindowsDirectory).sort());
  if (win32.basename(control) !== "control") throw Error("Application session requires the generation control directory");
  const storage = prepareWindowsReleaseStorage({ directory: control, writableWorkspaceRoots: roots });
  const originalControl = fact(control), directory = win32.join(control, ".application-session");
  // EEXIST is uncertainty, even when a PID appears dead. No stale takeover.
  mkdirSync(directory);
  const original = fact(directory); let phase: "held" | "releasing" | "ended" | "failed" = "held";
  const check = () => {
    assertWindowsReleaseStorage(storage, control);
    const nowControl = fact(control), now = fact(directory);
    if (nowControl.dev !== originalControl.dev || nowControl.ino !== originalControl.ino
      || now.dev !== original.dev || now.ino !== original.ino || now.ctimeNs !== original.ctimeNs
      || now.mtimeNs !== original.mtimeNs || now.size !== original.size || readdirSync(directory).length)
      throw Error("Original application session ownership changed");
  };
  const assert = () => {
    if (phase !== "held") throw Error("Application session is no longer held");
    try { check(); } catch (error) { phase = "failed"; throw error; }
  };
  assert();
  return { control, roots, assert, release() {
    assert(); phase = "releasing";
    // Only the original checked empty directory is removed, after the coordinator
    // has settled all actual owners. A failed removal is retained, never retried.
    try { auditWindowsReleaseStorage(storage, control); check(); rmdirSync(directory); phase = "ended"; }
    catch (error) { phase = "failed"; throw error; }
  } };
}
export function acquireApplicationSession(input: { readonly controlDirectory: string; readonly writableWorkspaceRoots: readonly string[] }): PreparedApplicationSession {
  if (!input || Object.keys(input).some(key => !["controlDirectory", "writableWorkspaceRoots"].includes(key))
    || !Array.isArray(input.writableWorkspaceRoots) || input.writableWorkspaceRoots.length < 1 || input.writableWorkspaceRoots.length > 128)
    throw Error("Fixed application session inputs required");
  const saved = acquire(input.controlDirectory, input.writableWorkspaceRoots), token = Object.freeze({}) as PreparedApplicationSession;
  sessions.set(token, saved); return token;
}
export function assertApplicationSession(token: PreparedApplicationSession, control: string, roots: readonly string[]): void {
  const saved = sessions.get(token);
  if (!saved || saved.control !== control || JSON.stringify(saved.roots) !== JSON.stringify([...roots].sort()))
    throw Error("Original matching application session required");
  saved.assert();
}
/** Host-only lifecycle operation; session tokens are never returned by the
 * installed service coordinator or reconstructed from a descriptor. */
export function releaseApplicationSession(token: PreparedApplicationSession): void {
  const saved = sessions.get(token); if (!saved) throw Error("Original application session required");
  saved.release();
}
