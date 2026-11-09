type CleanupPhase = "context" | "browser" | "site";
const priority: Record<CleanupPhase, number> = { site: 1, context: 2, browser: 3 };
const messages: Record<CleanupPhase, string> = {
  context: "Browser acceptance context cleanup failed",
  browser: "Browser acceptance owned browser cleanup failed",
  site: "Browser acceptance local site cleanup failed",
};

/** A cleanup failure must not look like the expected rejection of a product case. */
export class AcceptanceCleanupError extends AggregateError {
  constructor(readonly phase: CleanupPhase, errors: unknown[], primary: unknown) {
    super(errors, messages[phase], { cause: primary });
  }
}

/** Synchronous form for owners whose finally-entry latch must precede queued continuations. */
export function acceptanceCleanupFailure(phase: CleanupPhase, error: unknown, workFailed: boolean, workFailure: unknown): AcceptanceCleanupError {
  if (!workFailed && error instanceof AcceptanceCleanupError) return error;
  let primaryPhase = error instanceof AcceptanceCleanupError ? error.phase : phase;
  let primary = error instanceof AcceptanceCleanupError ? error.cause : error;
  // Presentation only: an outer site error cannot hide failed owned-browser cleanup.
  if (workFailed && workFailure instanceof AcceptanceCleanupError && priority[workFailure.phase] > priority[primaryPhase]) {
    primaryPhase = workFailure.phase; primary = workFailure.cause;
  }
  return new AcceptanceCleanupError(primaryPhase, workFailed ? [workFailure, error] : [error], primary);
}

/** Preserve settlement order and original errors without changing cleanup ownership or deadlines. */
export async function withAcceptanceCleanup<T>(phase: CleanupPhase, work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failed = false, failure: unknown, result: T | undefined;
  try { result = await work(); }
  catch (error) { failed = true; failure = error; }
  try { await cleanup(); }
  catch (error) { throw acceptanceCleanupFailure(phase, error, failed, failure); }
  if (failed) throw failure;
  return result as T;
}
