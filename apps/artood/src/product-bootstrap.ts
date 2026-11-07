import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runProtectedCommand } from "./protected-command.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

/** Opt-in bootstrap runs before the first context file is written, under the existing workspace lease. */
export async function initializeEmptyProductRepository(workspaceRoot: string, gitExecutable: string, signal?: AbortSignal,
  windowsBackend?: PreparedWindowsProcessBackend): Promise<"created" | "existing"> {
  const root = realpathSync.native(workspaceRoot);
  if (!lstatSync(root).isDirectory() || lstatSync(workspaceRoot).isSymbolicLink()) throw new Error("Product bootstrap requires an ordinary physical workspace");
  if (existsSync(join(root, ".git"))) {
    const git = lstatSync(join(root, ".git"));
    if (!git.isDirectory() || git.isSymbolicLink()) throw new Error("Product bootstrap does not adopt gitfiles or linked repositories");
    const inspection = await runProtectedCommand({ cwd: root, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir"], kind: "read", signal }, {
      gitExecutable, readTimeoutMs: 10000, materializeTimeoutMs: 10000, maxOutputBytes: 64 * 1024,
      environment: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }, windowsBackend);
    const paths = inspection.stdout.toString("utf8").trim().split(/\r?\n/);
    if (inspection.status !== 0 || paths.length !== 2 || realpathSync.native(paths[0]!) !== root || realpathSync.native(paths[1]!) !== join(root, ".git")) throw new Error("Existing Git metadata does not describe the selected product workspace");
    return "existing";
  }
  if (readdirSync(root).length > 0) throw new Error("Product bootstrap refuses a nonempty uninitialized workspace");
  // Build Git metadata in a sibling-in-root staging directory; no existing source is overwritten.
  const temporary = mkdtempSync(join(root, ".artoo-initialize-"));
  let cleanupConfirmed = true;
  try {
    const result = await runProtectedCommand({ cwd: temporary, args: ["-c", "init.templateDir=", "init", "--initial-branch=main", "."], kind: "materialize", signal }, {
      gitExecutable, readTimeoutMs: 10000, materializeTimeoutMs: 10000, maxOutputBytes: 64 * 1024,
      environment: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }, windowsBackend);
    if (result.status !== 0) throw new Error(`Product git initialization exited ${result.status}`);
    const other = readdirSync(root).filter((entry) => join(root, entry) !== temporary);
    if (other.length) throw new Error("Workspace changed during product initialization");
    renameSync(join(temporary, ".git"), join(root, ".git"));
    mkdirSync(join(root, ".artoo", "product"), { recursive: true });
    mkdirSync(join(root, "product"));
    writeFileSync(join(root, ".gitignore"), "context_pack.md\nchanges.patch\nnode_modules/\n.artoo/product/research-receipts.json\n", { flag: "wx" });
    return "created";
  } catch (error) {
    if (error instanceof VerificationCleanupError) cleanupConfirmed = false;
    throw error;
  } finally {
    // An uncertain helper retains its staging directory. A later initialization
    // then sees a nonempty workspace and cannot start another writer blindly.
    if (cleanupConfirmed) rmSync(temporary, { recursive: true, force: true });
  }
}
