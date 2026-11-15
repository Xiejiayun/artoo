/** Shared by legacy eligibility and shadow inventory; invalid overrides keep 30s. */
export const RUNTIME_STALE_AFTER_MS = (() => {
  const raw = process.env.ARTOO_RUNTIME_STALE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
})();
