import { win32 } from "node:path";
import { finished } from "node:stream/promises";
import { OwnedGitError, runOwnedGit, type OwnedGitOptions, type OwnedGitRequest } from "./owned/owned-git.js";
import { assertWindowsProcessBackend, isWindowsOwnedClosureReceipt, startWindowsOwnedProcess,
  type PreparedWindowsProcessBackend, type WindowsOwnedClosureReceipt } from "./owned/windows-owned-process.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

/** Ordinary bootstrap/verifier commands only; this does not produce a managed-worktree receipt. */
export interface ProtectedCommandResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly elapsedMs: number;
}
export type ProtectedCommandErrorCode = "aborted" | "timeout" | "output_limit" | "lingering_processes" | "spawn_failed" | "execution_failed";
export class ProtectedCommandError extends Error {
  override readonly name = "ProtectedCommandError";
  constructor(readonly code: ProtectedCommandErrorCode, readonly status: number | null, readonly elapsedMs: number,
    readonly stdout: Buffer, readonly stderr: Buffer) {
    super(`Protected command ${code.replaceAll("_", " ")}`);
  }
}

/** Windows adds only local OS startup values to the caller's stripped environment. */
function windowsEnvironment(source: Readonly<NodeJS.ProcessEnv> | undefined): NodeJS.ProcessEnv {
  const entries = new Map<string, { key: string; value: string }>();
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value === undefined || key.toUpperCase().startsWith("GIT_")) continue;
    entries.set(key.toUpperCase(), { key, value });
  }
  const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  if (!systemRoot || !win32.isAbsolute(systemRoot) || /[\u0000-\u001f]/u.test(systemRoot)) {
    throw new Error("Windows protected commands require a local SystemRoot");
  }
  // Match the POSIX owner's offline Git policy, including when a verifier invokes Git.
  // NUL is the Windows null device; no global configuration or repository hook is used.
  const protectedValues = {
    SystemRoot: systemRoot, WINDIR: systemRoot,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C",
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "NUL",
  };
  for (const [key, value] of Object.entries(protectedValues)) entries.set(key.toUpperCase(), { key, value });
  return Object.fromEntries([...entries.values()].map(({ key, value }) => [key, value]));
}

function windowsFailure(receipt: WindowsOwnedClosureReceipt): ProtectedCommandErrorCode | undefined {
  if (receipt.terminationReason === "cancelled") return "aborted";
  if (receipt.terminationReason === "timeout") return "timeout";
  if (receipt.terminationReason === "output_limit") return "output_limit";
  if (receipt.terminationReason === "lingering_processes") return "lingering_processes";
  if (!receipt.rootCreated || !receipt.rootStarted || receipt.rootExitCode === null) return "spawn_failed";
  if (receipt.terminationReason !== null || receipt.failureCode !== null) return "execution_failed";
  return undefined;
}

/** The backend parameter is local opaque authority; it is never read from a command payload. */
export async function runProtectedCommand(request: OwnedGitRequest, options: Omit<OwnedGitOptions, "indexFile">,
  windowsBackend?: PreparedWindowsProcessBackend): Promise<ProtectedCommandResult> {
  if (process.platform !== "win32") {
    try {
      // Preserve POSIX argv, deadlines, environment, parent guard and group-drain semantics.
      const result = await runOwnedGit(request, options);
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, elapsedMs: result.receipt.elapsedMs };
    } catch (error) {
      if (error instanceof OwnedGitError && !error.receipt.cleanupConfirmed) {
        throw new VerificationCleanupError("Protected command process-group cleanup is unconfirmed; execution remains owned", { cause: error });
      }
      throw error;
    }
  }
  if (!windowsBackend) throw new Error("Windows protected commands require a locally prepared backend");
  assertWindowsProcessBackend(windowsBackend);
  // Snapshot before starting: no mutable argv/options/environment survive across awaits.
  const input = { executable: options.gitExecutable, args: [...request.args], cwd: request.cwd,
    env: windowsEnvironment(options.environment), timeoutMs: request.kind === "materialize" ? options.materializeTimeoutMs : options.readTimeoutMs,
    maxOutputBytes: options.maxOutputBytes, cleanupTimeoutMs: options.terminationTimeoutMs ?? 5000,
    normalExitPolicy: "require-empty" as const, normalExitGraceMs: options.normalExitDrainMs ?? 250, signal: request.signal };
  // The bridge guarantees synchronous errors here precede target creation; after
  // creation, every failure is carried by closed and is conservatively retained.
  const child = startWindowsOwnedProcess(windowsBackend, input);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const out = (bytes: Buffer) => stdout.push(Buffer.from(bytes));
  const err = (bytes: Buffer) => stderr.push(Buffer.from(bytes));
  child.stdout.on("data", out); child.stderr.on("data", err);
  const outputClosed = Promise.all([finished(child.stdout, { cleanup: true }), finished(child.stderr, { cleanup: true })]);
  void outputClosed.catch(() => {});
  let receipt: WindowsOwnedClosureReceipt;
  try {
    receipt = await child.closed;
    if (!isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed) {
      throw new VerificationCleanupError("Windows protected command closure is unconfirmed; execution remains owned");
    }
    await outputClosed;
  } catch (error) {
    if (error instanceof VerificationCleanupError) throw error;
    throw new VerificationCleanupError("Windows protected command closure is unconfirmed; execution remains owned", { cause: error });
  } finally {
    child.stdout.off("data", out); child.stderr.off("data", err);
  }
  const output = Buffer.concat(stdout), errorOutput = Buffer.concat(stderr), code = windowsFailure(receipt);
  if (code) throw new ProtectedCommandError(code, receipt.rootExitCode, receipt.elapsedMs, output, errorOutput);
  return { status: receipt.rootExitCode!, stdout: output, stderr: errorOutput, elapsedMs: receipt.elapsedMs };
}
