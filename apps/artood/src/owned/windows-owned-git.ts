import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { OwnedGitError, type OwnedGitErrorCode, type OwnedGitOptions, type OwnedGitReceipt, type OwnedGitRequest, type OwnedGitResult } from "./owned-git.js";
import { startWindowsScopedProcess } from "./windows-guardian-scope.js";
import { assertWindowsProcessBackend, isWindowsOwnedClosureReceipt, type WindowsOwnedClosureReceipt, type WindowsOwnedProcess } from "./windows-owned-process.js";

/** Same Git operation, actual original Job owner on Windows. Numeric taskkill
 * and POSIX process-group evidence are never used by this branch. */
export async function runWindowsOwnedGit(request: OwnedGitRequest, options: OwnedGitOptions, environment: NodeJS.ProcessEnv): Promise<OwnedGitResult> {
  const cwd = request.cwd, args = Object.freeze(Array.isArray(request.args) ? [...request.args] : []), executable = options.gitExecutable;
  const kind = request.kind, signal = request.signal, startedAt = new Date().toISOString(), begun = performance.now();
  const timeoutMs = kind === "materialize" ? options.materializeTimeoutMs : options.readTimeoutMs;
  const maxOutputBytes = options.maxOutputBytes, terminationTimeoutMs = options.terminationTimeoutMs ?? 5000;
  const backend = options.windowsProcessBackend, launchWindow = options.windowsLaunchWindow && Object.freeze({ ...options.windowsLaunchWindow });
  const assertStartCurrent = options.assertStartCurrent;
  let process: WindowsOwnedProcess | undefined, proof: WindowsOwnedClosureReceipt | undefined;
  let entered = false, output = 0, trigger: OwnedGitErrorCode | undefined, failure: unknown;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const bounded = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  try {
    if (!Array.isArray(request.args) || !backend || !isAbsolute(executable) || !executable.toLowerCase().endsWith(".exe") || !isAbsolute(cwd)
      || [executable, cwd, ...args].some(value => typeof value !== "string" || /[\0]/.test(value))
      || !["read", "materialize"].includes(kind) || !bounded(options.readTimeoutMs, 30000)
      || !bounded(options.materializeTimeoutMs, 600000) || !bounded(maxOutputBytes, 16 * 1024 * 1024)
      || !bounded(terminationTimeoutMs, 30000)) throw new Error("Windows Git requires the trusted native backend and bounded absolute executable");
    assertWindowsProcessBackend(backend); signal?.throwIfAborted();
    if (assertStartCurrent && assertStartCurrent() !== undefined) throw new Error("Git launch guard must finish synchronously");
    entered = true;
    process = await startWindowsScopedProcess(backend, { executable, args, cwd, env: Object.freeze({ ...environment }), signal,
      timeoutMs, maxOutputBytes, cleanupTimeoutMs: terminationTimeoutMs, normalExitPolicy: "require-empty",
      normalExitGraceMs: options.normalExitDrainMs ?? 250, launchWindow, assertStartCurrent }, "git");
    const capture = (chunks: Buffer[]) => (bytes: Buffer) => { output += bytes.length;
      if (output <= maxOutputBytes) chunks.push(Buffer.from(bytes)); else { trigger = "output_limit"; process!.cancel(); } };
    process.stdout.on("data", capture(stdout)); process.stderr.on("data", capture(stderr));
    proof = await process.closed;
    if (!isWindowsOwnedClosureReceipt(proof) || !proof.cleanupConfirmed) throw new Error("Windows Git Job closure is not authenticated");
    if (!proof.rootStarted || proof.rootExitCode === null) trigger = signal?.aborted ? "aborted" : "spawn_failed";
    else if (signal?.aborted) trigger = "aborted";
    else if (proof.terminationReason || proof.failureCode) trigger = proof.terminationReason === "timeout" ? "timeout" : proof.terminationReason === "output_limit" ? "output_limit" : "cleanup_uncertain";
  } catch (cause) {
    failure = cause;
    const receipt = (cause as { receipt?: unknown } | undefined)?.receipt;
    if (isWindowsOwnedClosureReceipt(receipt)) proof = receipt;
    trigger ??= !entered ? signal?.aborted ? "aborted" : "invalid_input" : proof?.cleanupConfirmed ? "spawn_failed" : "cleanup_uncertain";
  }
  const cleanupConfirmed = !entered || proof?.cleanupConfirmed === true;
  const record: OwnedGitReceipt = Object.freeze({ executable, cwd, args, kind, timeoutMs, terminationTimeoutMs, maxOutputBytes,
    startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - begun, pid: proof?.rootPid ?? process?.pid ?? null,
    pgid: null, spawned: proof?.rootStarted ?? false, childExitObserved: proof?.rootWaitObserved ?? false,
    childCloseObserved: proof ? proof.stdoutEof && proof.stderrEof : false, childExitObservedAt: proof?.rootWaitObserved ? new Date().toISOString() : null,
    childCloseObservedAt: proof?.cleanupConfirmed ? new Date().toISOString() : null, childStatus: proof?.rootExitCode ?? null, childSignal: null,
    groupState: entered ? "unknown" : "not-launched", groupChecks: 0, groupAbsentObservedAt: null, groupObservations: [],
    groupObservationsDropped: 0, groupProbeErrors: {}, lastGroupObservation: null,
    normalExitDrain: { budgetMs: options.normalExitDrainMs ?? 250, startedAt: null, elapsedMs: 0, outcome: "not-entered" as const }, signals: [],
    outputBytesObserved: proof?.outputBytesObserved ?? output, outputBytesCaptured: stdout.concat(stderr).reduce((count, bytes) => count + bytes.length, 0),
    outputTruncated: output > maxOutputBytes, cleanupConfirmed, observersDisposed: cleanupConfirmed, trigger: trigger === "cleanup_uncertain" ? null : trigger ?? null,
    ...(proof ? { windowsJob: { version: 1 as const, rootCreationTime: proof.rootCreationTime, atomicJobMember: proof.atomicJobMember,
      jobEmptyObserved: proof.jobEmptyObserved, helperExitObserved: proof.helperExitObserved, helperCloseObserved: proof.helperCloseObserved } } : {}) });
  if (trigger || !cleanupConfirmed || !proof || proof.rootExitCode === null)
    throw new OwnedGitError(trigger ?? "cleanup_uncertain", record, Buffer.concat(stdout), Buffer.concat(stderr), failure);
  return { status: proof.rootExitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), receipt: record };
}
