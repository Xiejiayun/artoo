/**
 * Web command-side dogfood of the canonical `@artoo/client` command queue (#27).
 *
 * Mutations run through {@link createApiCommandQueue} so the web reuses the SAME
 * offline-replay contract every other client shell uses instead of a bespoke
 * one: each command carries a stable idempotency key (so a replay after a flaky
 * send never double-applies), failed/offline sends are queued and replayed in
 * order on reconnect, and a stale-version 409 is surfaced as a conflict.
 *
 * This wraps the pure queue from `@artoo/client` with a `send` adapter over the
 * REST {@link ApiClient}: a successful call is `applied`, a transport failure is
 * `retry` (kept queued), a `stale_base_version` 409 is `conflict`, and any other
 * API error is non-retryable — settled so the queue does not loop, with the
 * caller's promise rejected.
 */
import {
  createCommandQueue,
  type CommandConflict,
  type CommandQueue,
  type SendResult,
} from "@artoo/client";

import { ApiClientError } from "./client.js";

/** Thrown to a `submit` caller when the server rejects a command as stale. */
export class CommandConflictError extends Error {
  constructor(readonly conflict: CommandConflict) {
    super(`command conflict: ${conflict.reason}`);
    this.name = "CommandConflictError";
  }
}

export interface SubmitOptions {
  /** Stable idempotency key — reused across replays of the SAME logical command. */
  key: string;
  /** Optional optimistic-concurrency snapshot the user acted on. */
  baseVersion?: number;
}

export interface ApiCommandQueue {
  /**
   * Run a mutation through the offline-replay queue. Resolves with the mutation
   * result once the server applies it (possibly after a reconnect); rejects with
   * a {@link CommandConflictError} on a stale-version 409, or the original error
   * for a non-retryable failure.
   */
  submit<T>(run: () => Promise<T>, opts: SubmitOptions): Promise<T>;
  /** Replay queued commands (call on reconnect / `online`). */
  flush(): Promise<void>;
  /** Commands still awaiting a successful send. */
  pendingCount(): number;
  /** Detach any listeners this queue registered (e.g. the `online` handler). */
  dispose(): void;
}

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

/** Marker wrapping a non-retryable error in an `applied` outcome's response. */
interface CommandErrorBox {
  __commandError: unknown;
}

function isStaleConflict(error: ApiClientError): boolean {
  return error.code === "conflict" && (error.details as { reason?: unknown }).reason === "stale_base_version";
}

export interface CreateApiCommandQueueOptions {
  /** Attach a `window` `online` listener that flushes on reconnect. Default true
   *  in a browser; pass false in tests to drive `flush()` manually. */
  attachOnlineListener?: boolean;
}

export function createApiCommandQueue(options: CreateApiCommandQueueOptions = {}): ApiCommandQueue {
  const deferreds = new Map<string, Deferred>();
  const thunks = new Map<string, () => Promise<unknown>>();

  const queue: CommandQueue = createCommandQueue({
    send: async (cmd): Promise<SendResult> => {
      const run = thunks.get(cmd.key);
      if (run === undefined) {
        return { status: "applied", response: undefined };
      }
      try {
        const response = await run();
        return { status: "applied", response };
      } catch (error) {
        if (error instanceof ApiClientError) {
          if (error.code === "network_error") {
            return { status: "retry" }; // offline/transient — keep queued, replay later
          }
          if (isStaleConflict(error)) {
            return { status: "conflict", conflict: error.details as unknown as CommandConflict };
          }
        }
        // Non-retryable (validation / not_found / ...): settle so the queue does
        // not loop, and reject the caller via the error box.
        return { status: "applied", response: { __commandError: error } satisfies CommandErrorBox };
      }
    },
    onOutcome: (outcome) => {
      const deferred = deferreds.get(outcome.key);
      if (deferred === undefined) {
        return;
      }
      deferreds.delete(outcome.key);
      thunks.delete(outcome.key);
      if (outcome.status === "conflict") {
        deferred.reject(new CommandConflictError(outcome.conflict));
        return;
      }
      const response = outcome.response as CommandErrorBox | unknown;
      if (response !== null && typeof response === "object" && "__commandError" in response) {
        deferred.reject((response as CommandErrorBox).__commandError);
        return;
      }
      deferred.resolve(response);
    },
  });

  const onOnline = (): void => {
    void queue.flush();
  };
  const attach =
    options.attachOnlineListener ?? (typeof window !== "undefined" && typeof window.addEventListener === "function");
  if (attach && typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
  }

  return {
    submit<T>(run: () => Promise<T>, opts: SubmitOptions): Promise<T> {
      if (deferreds.has(opts.key)) {
        return Promise.reject(new Error(`command already pending: ${opts.key}`));
      }
      return new Promise<T>((resolve, reject) => {
        deferreds.set(opts.key, { resolve: resolve as (v: unknown) => void, reject });
        thunks.set(opts.key, run as () => Promise<unknown>);
        queue.enqueue({ key: opts.key, baseVersion: opts.baseVersion, payload: null });
        void queue.flush();
      });
    },
    flush(): Promise<void> {
      return queue.flush().then(() => undefined);
    },
    pendingCount(): number {
      return queue.pending().length;
    },
    dispose(): void {
      if (attach && typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
      }
    },
  };
}
