/**
 * Bounded attempts for the public pairing-claim route (#28 4b review). Once
 * `/api/v1/devices/claim` is reachable without a session, an attacker could brute
 * the short pairing code. A per-source fixed-window counter caps attempts; the
 * limiter is consulted BEFORE the code is examined so a 429 never reveals whether
 * a given code exists (no oracle).
 *
 * Fixed-window, in-process, clock-injected (the server passes
 * `Date.parse(ctx.clock.nowIso())`) so tests are deterministic. A single process
 * is the trust boundary here; a multi-node deploy would back this with a shared
 * store, but the contract (cap per source per window) is the same.
 */

export interface ClaimLimit {
  /** Max attempts allowed per source within a window. */
  capacity: number;
  /** Window length in ms; the counter resets when the window rolls over. */
  windowMs: number;
}

export const DEFAULT_CLAIM_LIMIT: ClaimLimit = { capacity: 10, windowMs: 60_000 };

export interface ClaimLimiter {
  /**
   * Record an attempt from `source` at `nowMs`. Returns true if it is within the
   * cap (allowed) or false if the source has exhausted its window (deny → 429).
   */
  tryConsume(source: string, nowMs: number): boolean;
}

export function createClaimLimiter(limit: ClaimLimit = DEFAULT_CLAIM_LIMIT): ClaimLimiter {
  const windows = new Map<string, { count: number; windowStart: number }>();
  return {
    tryConsume(source, nowMs): boolean {
      const existing = windows.get(source);
      if (existing === undefined || nowMs - existing.windowStart >= limit.windowMs) {
        windows.set(source, { count: 1, windowStart: nowMs });
        return true;
      }
      if (existing.count >= limit.capacity) {
        return false;
      }
      existing.count += 1;
      return true;
    },
  };
}
