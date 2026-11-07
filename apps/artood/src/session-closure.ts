import { VerificationCleanupError } from "./verification-cleanup-error.js";

const SESSION_CLOSE_TIMEOUT_MS = 5000;

/** Bound the caller's wait, not the underlying cleanup. The join remains observed
 * after rejection; callers must retain files and never put deletion inside join. */
export function awaitSessionClosure(join: () => Promise<void>, description: string): Promise<void> {
  const deadline = performance.now() + SESSION_CLOSE_TIMEOUT_MS;
  const timeout = new VerificationCleanupError(`${description} after ${SESSION_CLOSE_TIMEOUT_MS}ms; session files retained`);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(error instanceof VerificationCleanupError ? error : new VerificationCleanupError(description, { cause: error }));
    };
    const timer = setTimeout(() => fail(timeout), SESSION_CLOSE_TIMEOUT_MS);
    // Revoke the broker and abort admitted work before close() returns. Only
    // the completion join is asynchronous; scheduling revocation later changes
    // the session owner's existing cancellation contract.
    let pending: Promise<void>;
    try { pending = join(); }
    catch (error) { fail(error); return; }
    // Keep both continuations attached even when the deadline wins. An abort or
    // closed socket is not proof that the original async handler has returned.
    void pending.then(() => {
      if (settled) return;
      // A delayed timer must not allow a late completion to become success.
      if (performance.now() >= deadline) { fail(timeout); return; }
      settled = true; clearTimeout(timer); resolve();
    }, fail);
  });
}
