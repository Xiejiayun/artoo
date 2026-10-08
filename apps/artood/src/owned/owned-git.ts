import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable } from "node:stream";

export interface OwnedGitRequest {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: "read" | "materialize";
  readonly signal?: AbortSignal;
}
export interface OwnedGitOptions {
  readonly gitExecutable: string;
  readonly readTimeoutMs: number;
  readonly materializeTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly terminationTimeoutMs?: number;
  /** Observation-only close/group drain after a numeric normal exit; never resets on polls. */
  readonly normalExitDrainMs?: number;
  /** Operator-owned snapshot only; never wire supplied. Snapshotted synchronously per invocation. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}
export type OwnedGitErrorCode = "invalid_input" | "unsupported_platform" | "spawn_failed" | "aborted"
  | "timeout" | "output_limit" | "stream_failed" | "signaled" | "lingering_group" | "cleanup_uncertain";
type Trigger = Exclude<OwnedGitErrorCode, "cleanup_uncertain">;
type GroupState = "not-launched" | "present" | "absent" | "unknown";
export interface OwnedGitReceipt {
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: string;
  readonly timeoutMs: number;
  readonly terminationTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly spawned: boolean;
  readonly childExitObserved: boolean;
  readonly childCloseObserved: boolean;
  readonly childExitObservedAt: string | null;
  readonly childCloseObservedAt: string | null;
  readonly childStatus: number | null;
  readonly childSignal: NodeJS.Signals | null;
  readonly groupState: GroupState;
  readonly groupChecks: number;
  readonly groupAbsentObservedAt: string | null;
  readonly groupObservations: readonly { at: string; state: GroupState; errorCode?: string }[];
  readonly groupObservationsDropped: number;
  readonly groupProbeErrors: Readonly<Record<string, number>>;
  readonly lastGroupObservation: { at: string; state: GroupState; errorCode?: string } | null;
  readonly normalExitDrain: { budgetMs: number; startedAt: string | null; elapsedMs: number;
    outcome: "not-entered" | "closed" | "interrupted" | "expired" };
  readonly signals: readonly { signal: "SIGTERM" | "SIGKILL"; at: string; outcome: "sent" | "already-absent" | "error"; errorCode?: string }[];
  readonly outputBytesObserved: number;
  readonly outputBytesCaptured: number;
  readonly outputTruncated: boolean;
  readonly cleanupConfirmed: boolean;
  readonly observersDisposed: boolean;
  readonly trigger: Trigger | null;
  readonly spawnErrorCode?: string;
}
export interface OwnedGitResult {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly receipt: OwnedGitReceipt;
}
export class OwnedGitError extends Error {
  override readonly name = "OwnedGitError";
  constructor(readonly code: OwnedGitErrorCode, readonly receipt: OwnedGitReceipt,
    readonly stdout: Buffer, readonly stderr: Buffer) {
    super(`Owned Git ${code.replaceAll("_", " ")}`);
  }
}

/** Trusted local-operation policy, copied once; no environment values are exposed in receipts. */
function gitEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_DISCOVERY_ACROSS_FILESYSTEM: "1", GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C",
    GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
  });
  return env;
}

/** Real asynchronous execution. This is ownership-aware cleanup under a cooperating-worker model,
 * not a sandbox, a PID-reuse-proof kernel handle, or authority to promote an opaque worktree. */
export function runOwnedGit(request: OwnedGitRequest, options: OwnedGitOptions): Promise<OwnedGitResult> {
  // Snapshot values synchronously; never retain mutable request/options/argv across callbacks.
  const inputArgs = request.args;
  const cwd = request.cwd, args = Array.isArray(inputArgs) ? [...inputArgs] : [], kind = request.kind;
  const executable = options.gitExecutable, signal = request.signal;
  const readTimeoutMs = options.readTimeoutMs, materializeTimeoutMs = options.materializeTimeoutMs;
  const timeoutMs = kind === "materialize" ? materializeTimeoutMs : readTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes, terminationTimeoutMs = options.terminationTimeoutMs ?? 5000;
  const normalExitDrainMs = options.normalExitDrainMs ?? 250;
  const env = gitEnvironment(options.environment ?? process.env), startedAt = new Date().toISOString(), started = performance.now();
  let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  let spawnAttempted = false, synchronousSpawnFailure = false, asyncSpawnFailure = false;
  let pid: number | null = null, spawned = false, exitObserved = false, closeObserved = false;
  let exitObservedAt: string | null = null, closeObservedAt: string | null = null;
  let status: number | null = null, exitSignal: NodeJS.Signals | null = null;
  let groupState: GroupState = "not-launched", groupChecks = 0, groupAbsentObservedAt: string | null = null;
  const groupObservations: { at: string; state: GroupState; errorCode?: string }[] = [], groupProbeErrors: Record<string, number> = {};
  let lastGroupObservation: (typeof groupObservations)[number] | null = null;
  let trigger: Trigger | null = null, spawnErrorCode: string | undefined;
  let observedBytes = 0, capturedBytes = 0, outputTruncated = false;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const signals: { signal: "SIGTERM" | "SIGKILL"; at: string; outcome: "sent" | "already-absent" | "error"; errorCode?: string }[] = [];
  let settled = false, observersDisposed = false, terminationStarted: number | null = null, termSent = false, killSent = false;
  let operationTimer: ReturnType<typeof setTimeout> | undefined, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let normalDrainTimer: ReturnType<typeof setTimeout> | undefined, normalDrainStarted: number | null = null;
  let normalDrainStartedAt: string | null = null, normalDrainElapsed = 0;
  let normalDrainOutcome: OwnedGitReceipt["normalExitDrain"]["outcome"] = "not-entered";

  return new Promise((resolveResult, rejectResult) => {
    function receipt(cleanupConfirmed: boolean): OwnedGitReceipt {
      return Object.freeze({ executable, cwd, args: Object.freeze([...args]), kind, timeoutMs, terminationTimeoutMs, maxOutputBytes,
        startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
        pid, pgid: pid, spawned, childExitObserved: exitObserved, childCloseObserved: closeObserved,
        childExitObservedAt: exitObservedAt, childCloseObservedAt: closeObservedAt,
        childStatus: status, childSignal: exitSignal, groupState, groupChecks, groupAbsentObservedAt,
        groupObservations: Object.freeze(groupObservations.map(row => Object.freeze({ ...row }))),
        groupObservationsDropped: groupChecks - groupObservations.length, groupProbeErrors: Object.freeze({ ...groupProbeErrors }),
        lastGroupObservation: lastGroupObservation ? Object.freeze({ ...lastGroupObservation }) : null,
        normalExitDrain: Object.freeze({ budgetMs: normalExitDrainMs, startedAt: normalDrainStartedAt,
          elapsedMs: normalDrainElapsed, outcome: normalDrainOutcome }),
        signals: Object.freeze(signals.map(item => Object.freeze({ ...item }))),
        outputBytesObserved: observedBytes, outputBytesCaptured: capturedBytes, outputTruncated,
        cleanupConfirmed, observersDisposed, trigger, ...(spawnErrorCode ? { spawnErrorCode } : {}),
      });
    }
    function finish(errorCode?: OwnedGitErrorCode): void {
      if (settled) return;
      settled = true;
      clearTimeout(operationTimer); clearTimeout(cleanupTimer); clearTimeout(normalDrainTimer);
      signal?.removeEventListener("abort", onAbort);
      if (child) {
        child.off("spawn", onSpawn); child.off("error", onChildError);
        child.off("exit", onExit); child.off("close", onClose);
        child.stdout.off("data", onStdout); child.stderr.off("data", onStderr);
        child.stdout.off("error", onStreamError); child.stderr.off("error", onStreamError);
        child.stdout.destroy(); child.stderr.destroy();
      }
      observersDisposed = true;
      const confirmed = pid === null ? !spawnAttempted || synchronousSpawnFailure || (asyncSpawnFailure && closeObserved)
        : exitObserved && closeObserved && groupState === "absent";
      const record = receipt(confirmed), out = Buffer.concat(stdout), err = Buffer.concat(stderr);
      if (!errorCode && typeof status !== "number") errorCode = "spawn_failed";
      if (errorCode) rejectResult(new OwnedGitError(errorCode, record, out, err));
      else resolveResult({ status: status!, stdout: out, stderr: err, receipt: record });
    }
    function probeGroup(): GroupState {
      if (pid === null) return groupState;
      if (groupState === "absent") return groupState; // Never signal this numeric group again after observed absence.
      groupChecks++;
      let errorCode: string | undefined;
      try { process.kill(-pid, 0); groupState = "present"; }
      catch (error) {
        errorCode = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        if (errorCode === "ESRCH") {
          groupState = "absent"; groupAbsentObservedAt = new Date().toISOString();
        } else { groupState = "unknown"; groupProbeErrors[errorCode] = (groupProbeErrors[errorCode] ?? 0) + 1; }
      }
      lastGroupObservation = { at: new Date().toISOString(), state: groupState, ...(errorCode ? { errorCode } : {}) };
      if (groupObservations.length < 32) groupObservations.push(lastGroupObservation);
      return groupState;
    }
    function sendGroupSignal(name: "SIGTERM" | "SIGKILL"): void {
      if (pid === null || !spawned || probeGroup() === "absent") return;
      const entry: (typeof signals)[number] = { signal: name, at: new Date().toISOString(), outcome: "sent" };
      try { process.kill(-pid, name); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") {
          groupState = "absent"; groupAbsentObservedAt = new Date().toISOString(); entry.outcome = "already-absent";
        } else { entry.outcome = "error"; entry.errorCode = code; groupState = "unknown"; }
      }
      signals.push(entry);
    }
    function pollCleanup(): void {
      if (settled || terminationStarted === null) return;
      if (spawned) probeGroup();
      if (pid === null && closeObserved) { finish(trigger ?? "spawn_failed"); return; }
      if (exitObserved && closeObserved && groupState === "absent") { finish(trigger ?? undefined); return; }
      const elapsed = performance.now() - terminationStarted;
      if (spawned && !termSent) { termSent = true; sendGroupSignal("SIGTERM"); }
      if (spawned && !killSent && elapsed >= Math.min(1000, Math.floor(terminationTimeoutMs / 2))) {
        killSent = true; sendGroupSignal("SIGKILL");
      }
      if (elapsed >= terminationTimeoutMs) { finish("cleanup_uncertain"); return; }
      cleanupTimer = setTimeout(pollCleanup, 10);
    }
    function terminate(reason: Trigger): void {
      if (settled) return;
      trigger ??= reason;
      clearTimeout(operationTimer); clearTimeout(normalDrainTimer);
      if (normalDrainStarted !== null && normalDrainOutcome === "not-entered") {
        normalDrainElapsed = performance.now() - normalDrainStarted; normalDrainOutcome = "interrupted";
      }
      if (terminationStarted === null) { terminationStarted = performance.now(); pollCleanup(); }
    }
    function pollNormalDrain(): void {
      if (settled || trigger || normalDrainStarted === null) return;
      probeGroup();
      normalDrainElapsed = performance.now() - normalDrainStarted;
      if (normalDrainElapsed >= normalExitDrainMs) {
        normalDrainOutcome = "expired";
        // The fixed deadline wins even if a delayed callback first observes closure.
        // Later cleanup confirmation cannot turn this sticky failure into Git success.
        terminate("lingering_group"); return;
      }
      if (exitObserved && closeObserved && groupState === "absent") {
        normalDrainOutcome = "closed"; finish(); return;
      }
      normalDrainTimer = setTimeout(pollNormalDrain, Math.min(10, normalExitDrainMs - normalDrainElapsed));
    }
    function onAbort(): void { terminate("aborted"); }
    function onSpawn(): void {
      spawned = true; pid = child!.pid!; groupState = "present";
      if (trigger) { clearTimeout(cleanupTimer); pollCleanup(); }
    }
    function onChildError(error: NodeJS.ErrnoException): void {
      spawnErrorCode = error.code; asyncSpawnFailure = !spawned && !child?.pid;
      if (!pid && child?.pid) { pid = child.pid; spawned = true; groupState = "present"; }
      terminate("spawn_failed");
    }
    function onStreamError(): void { terminate("stream_failed"); }
    function onExit(code: number | null, childSignal: NodeJS.Signals | null): void {
      exitObserved = true; status = code; exitSignal = childSignal;
      exitObservedAt = new Date().toISOString();
      clearTimeout(operationTimer);
      if (trigger) return;
      if (childSignal !== null) { terminate("signaled"); return; }
      if (typeof code !== "number") { terminate("spawn_failed"); return; }
      if (normalDrainStarted === null) { normalDrainStarted = performance.now(); normalDrainStartedAt = new Date().toISOString(); }
      pollNormalDrain();
    }
    function onClose(code: number | null, childSignal: NodeJS.Signals | null): void {
      closeObserved = true; status ??= code; exitSignal ??= childSignal;
      closeObservedAt = new Date().toISOString();
      if (trigger || terminationStarted !== null) { clearTimeout(cleanupTimer); pollCleanup(); return; }
      if (normalDrainStarted !== null) { clearTimeout(normalDrainTimer); pollNormalDrain(); }
      else terminate(spawned ? "lingering_group" : "spawn_failed");
    }
    function onStdout(chunk: Buffer): void { capture(stdout, chunk); }
    function onStderr(chunk: Buffer): void { capture(stderr, chunk); }
    function capture(target: Buffer[], chunk: Buffer): void {
      if (settled) return;
      observedBytes += chunk.length;
      const remaining = maxOutputBytes - capturedBytes;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining)); target.push(kept); capturedBytes += kept.length;
      }
      if (observedBytes > maxOutputBytes) {
        outputTruncated = true; terminate("output_limit");
        // Stop retaining/draining arbitrary producer output while the owned group is terminated.
        child?.stdout.destroy(); child?.stderr.destroy();
      }
    }

    const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
    if (process.platform !== "darwin" && process.platform !== "linux") { trigger = "unsupported_platform"; finish(trigger); return; }
    if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")
      || typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")
      || !Array.isArray(inputArgs) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || !["read", "materialize"].includes(kind) || !bounded(readTimeoutMs, 30_000)
      || !bounded(materializeTimeoutMs, 600_000) || !bounded(maxOutputBytes, 16 * 1024 * 1024)
      || !bounded(terminationTimeoutMs, 30_000) || !bounded(normalExitDrainMs, 5000)) {
      trigger = "invalid_input"; finish(trigger); return;
    }
    if (signal?.aborted) { trigger = "aborted"; finish(trigger); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    operationTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    try {
      spawnAttempted = true;
      child = spawn(executable, args, { cwd, env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      pid = child.pid ?? null;
    } catch (error) {
      synchronousSpawnFailure = true;
      spawnErrorCode = (error as NodeJS.ErrnoException).code;
      trigger = "spawn_failed"; finish(trigger); return;
    }
    child.on("spawn", onSpawn); child.on("error", onChildError);
    child.on("exit", onExit); child.on("close", onClose);
    child.stdout.on("data", onStdout); child.stderr.on("data", onStderr);
    child.stdout.on("error", onStreamError); child.stderr.on("error", onStreamError);
  });
}
