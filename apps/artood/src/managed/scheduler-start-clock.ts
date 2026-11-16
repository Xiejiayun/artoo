/** Same monotonic epoch in the facade and its worker. Never persisted across
 * processes/restarts and never inferred from server wall-clock timestamps. */
export function schedulerStartTickMs(): number {
  const value = Number(process.hrtime.bigint() / 1_000_000n);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Scheduler monotonic clock continuity is unknown");
  return value;
}
