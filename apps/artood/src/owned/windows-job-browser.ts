import { finished } from "node:stream/promises";
import { isWindowsOwnedClosureReceipt, startWindowsOwnedProcess, type PreparedWindowsProcessBackend,
  type WindowsOwnedClosureReceipt, type WindowsOwnedProcess, type WindowsOwnedStart } from "./windows-owned-process.js";

export interface WindowsJobBrowserProcess {
  readonly process: WindowsOwnedProcess;
  readonly started: Promise<{ readonly pid: number }>;
  /** Original bridge receipt, after both locally consumed streams finish. */
  readonly closed: Promise<WindowsOwnedClosureReceipt>;
  cancel(): void;
}

/** The caller separately bounds startup and session work. This ceiling cannot renew either deadline. */
export function startWindowsJobBrowserProcess(backend: PreparedWindowsProcessBackend,
  input: Pick<WindowsOwnedStart, "executable" | "args" | "cwd" | "env" | "signal">): WindowsJobBrowserProcess {
  if (process.platform !== "win32") throw new Error("Windows browser process backend is supported only on Windows");
  // startWindowsOwnedProcess validates the opaque local backend before helper spawn;
  // no serialized backend, alternate spawn or observer fallback is accepted here.
  const child = startWindowsOwnedProcess(backend, { ...input, timeoutMs: 43_200_000, maxOutputBytes: 67_108_864,
    cleanupTimeoutMs: 5000, normalExitPolicy: "terminate-descendants", normalExitGraceMs: 250 });
  let cancellationRequested = false, startedPid: number | undefined;
  const cancel = () => { if (!cancellationRequested) { cancellationRequested = true; child.cancel(); } };
  const streamsClosed = Promise.all([finished(child.stdout, { cleanup: true }), finished(child.stderr, { cleanup: true })]);
  // Drain without retaining Chrome output. The bridge enforces its captured-output
  // bound and owns consumption of the helper's separate control/diagnostic streams.
  child.stdout.resume(); child.stderr.resume();
  void streamsClosed.catch(() => cancel());
  const started = child.started.then(value => {
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid !== child.pid) {
      throw new Error("Owned Windows browser root identity differs from its start receipt");
    }
    startedPid = value.pid; return value;
  });
  void started.catch(() => cancel());
  const closed = (async () => {
    const receipt = await child.closed;
    if (!isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed || !receipt.helperSpawnObserved
      || !receipt.helperExitObserved || !receipt.helperCloseObserved || receipt.helperExitCode !== 0 || receipt.helperSignal !== null) {
      throw new Error("Windows browser Job closure is unconfirmed; its profile is retained");
    }
    // The opaque receipt authenticates the exact native HANDLE observation. Bind
    // its root to this process's created/started PID as well, never just its shape.
    if (receipt.noTargetCreated) {
      if (receipt.rootCreated || receipt.rootStarted || receipt.rootPid !== null || child.pid !== undefined
        || receipt.rootWaitObserved || receipt.rootExitCode !== null || receipt.rootCreationTime !== null) {
        throw new Error("Windows browser no-target receipt is inconsistent; its profile is retained");
      }
    } else if (!receipt.rootCreated || !receipt.atomicJobMember || !receipt.rootWaitObserved
      || !receipt.jobEmptyObserved || !receipt.stdoutEof || !receipt.stderrEof || receipt.rootExitCode === null
      || receipt.rootCreationTime === null || receipt.rootPid !== child.pid || receipt.rootPid === null
      || (receipt.rootStarted && (await started).pid !== receipt.rootPid)
      || (startedPid !== undefined && startedPid !== receipt.rootPid)) {
      throw new Error("Windows browser root or Job closure is unconfirmed; its profile is retained");
    }
    await streamsClosed;
    return receipt;
  })();
  void closed.catch(() => cancel());
  return { process: child, started, closed, cancel };
}

/** Successful cleanup is separate from a healthy browser session. */
export function assertWindowsBrowserSessionClosure(receipt: WindowsOwnedClosureReceipt, localCloseCancelled: boolean): void {
  if (!isWindowsOwnedClosureReceipt(receipt) || !receipt.cleanupConfirmed || !receipt.rootCreated || !receipt.rootStarted
    || receipt.failureCode !== null || receipt.nativeError !== null || receipt.outputBytesObserved !== receipt.outputBytesCaptured) {
    throw new Error("Owned Windows browser session failed; its profile is retained");
  }
  const nativeReason = receipt.nativeTerminationReason, reason = receipt.terminationReason;
  const normalRoot = receipt.rootExitCode === 0 && (nativeReason === null || nativeReason === "normal_exit_descendants")
    && (reason === nativeReason || localCloseCancelled && reason === "cancelled");
  // 0xE0000001 is the fixed native Job cancellation exit status. A different
  // nonzero root exit still fails even if a later local close requested cancel.
  const localCancellation = localCloseCancelled && reason === "cancelled" && nativeReason === "cancelled"
    && (receipt.rootExitCode === 0 || receipt.rootExitCode === 0xe0000001);
  if (!normalRoot && !localCancellation) throw new Error("Owned Windows browser session ended abnormally; its profile is retained");
}
