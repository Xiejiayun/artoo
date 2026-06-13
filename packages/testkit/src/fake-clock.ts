import type { Clock } from "@artoo/domain";

/**
 * Deterministic {@link Clock} for tests — satisfies the domain Gate 0 rule that
 * domain/run logic never reads wall-clock time directly. Time only moves when a
 * test calls `advance` / `set`, so event ordering and timestamps are reproducible.
 */
export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(date: Date): void;
}

export function createFakeClock(start: string | Date = "2026-06-11T00:00:00.000Z"): FakeClock {
  let current = (typeof start === "string" ? new Date(start) : start).getTime();
  return {
    now(): Date {
      return new Date(current);
    },
    nowIso(): string {
      return new Date(current).toISOString();
    },
    advance(ms: number): void {
      current += ms;
    },
    set(date: Date): void {
      current = date.getTime();
    }
  };
}
