/**
 * Per-call idempotency keys for mutating API requests.
 *
 * codex guardrail: mutation calls require a caller-provided key (especially
 * approval / artifact / request_changes), so retries from the UI or a flaky
 * network never double-apply a side effect.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
