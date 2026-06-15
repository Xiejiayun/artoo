/**
 * Runtime eligibility helpers (#15 Part 3). PURE — no IO. The scheduler uses
 * these to decide whether a candidate instance's runtime (as last reported via
 * node heartbeat into `agent_runtimes`) is usable.
 */

/**
 * Whether a runtime row is STALE (its last heartbeat is older than `staleAfterMs`,
 * or it has no timestamp at all). `lastSeenIso == null` means a row exists but was
 * never freshly reported — treated as stale/bad and excluded. Otherwise the check
 * is strict: `now - last_seen > staleAfterMs` (exactly at the threshold is still
 * fresh). Unparseable timestamps are treated as stale (safe: exclude rather than
 * route to a possibly-dead runtime).
 */
export function isRuntimeStale(
  lastSeenIso: string | null | undefined,
  nowIso: string,
  staleAfterMs: number,
): boolean {
  if (lastSeenIso == null) {
    return true;
  }
  const lastSeen = Date.parse(lastSeenIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(lastSeen) || Number.isNaN(now)) {
    return true;
  }
  return now - lastSeen > staleAfterMs;
}
