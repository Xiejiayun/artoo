interface PendingStop {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/** Waits for a caller-validated closure receipt, never an acknowledgement alone. */
export function createPendingStopRegistry<TId extends string = string>(timeoutMs: number) {
  const pending = new Map<TId, PendingStop & { timer: ReturnType<typeof setTimeout> }>();
  let closedError: Error | undefined;

  return {
    get(id: TId): PendingStop | undefined {
      return pending.get(id);
    },

    async wait(id: TId, requestAndDispatch: () => Promise<void>, timeoutError: () => Error): Promise<void> {
      if (closedError) throw closedError;
      const prior = pending.get(id);
      if (prior) return prior.promise;

      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Closure may fail while request/dispatch is still awaited. Retain the
      // rejection for all waiters without an intermediate unhandled rejection.
      void promise.catch(() => {});
      const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      pending.set(id, { promise, resolve, reject, timer });
      try {
        await requestAndDispatch();
        await promise;
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    },

    close(error: Error): void {
      closedError ??= error;
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(closedError);
      }
      pending.clear();
    },
  };
}
