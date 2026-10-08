import { runOwnedGit } from "./owned-git.js";

/** Trusted local configuration; none of these options are accepted from a run payload. */
export interface GitReadOptions {
  readonly gitExecutable?: string;
  readonly readTimeoutMs?: number;
  readonly materializeTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly terminationTimeoutMs?: number;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
}

export function snapshotGitOptions(options: GitReadOptions): Readonly<GitReadOptions> {
  return Object.freeze({ ...options, environment: Object.freeze({ ...(options.environment ?? process.env) }) });
}

export function assertNotAborted(options: GitReadOptions): void {
  options.signal?.throwIfAborted();
}

/** The execution helper retains typed timeout/abort/uncertain-cleanup errors. */
export async function gitOperation(cwd: string, args: readonly string[], options: GitReadOptions, kind: "read" | "materialize" = "read") {
  return runOwnedGit({ cwd, args, kind, signal: options.signal }, {
    gitExecutable: options.gitExecutable ?? "/usr/bin/git",
    readTimeoutMs: options.readTimeoutMs ?? 10_000,
    materializeTimeoutMs: options.materializeTimeoutMs ?? 120_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    terminationTimeoutMs: options.terminationTimeoutMs ?? 5_000,
    environment: options.environment,
  });
}
