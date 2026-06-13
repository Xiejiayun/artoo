import type { IdGen } from "@artoo/domain";
import { formatId } from "@artoo/domain";

/**
 * Deterministic {@link IdGen} for tests — the domain Gate 0 counterpart to the
 * ULID generator. Ids are sequential and zero-padded per prefix
 * (`evt_00000000000000000000000000`, `evt_00000000000000000000000001`, …), so
 * they are stable and monotonic across a test run without drawing entropy.
 */
export interface FixedIdGen extends IdGen {
  reset(): void;
}

const ULID_LENGTH = 26;

export function createFixedIdGen(): FixedIdGen {
  const counters = new Map<string, number>();
  return {
    generate(prefix: string): string {
      const next = counters.get(prefix) ?? 0;
      counters.set(prefix, next + 1);
      return formatId(prefix, String(next).padStart(ULID_LENGTH, "0"));
    },
    reset(): void {
      counters.clear();
    }
  };
}
