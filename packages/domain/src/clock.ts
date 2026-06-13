/**
 * Injectable clock for @artoo/domain.
 *
 * Domain logic receives a {@link Clock} by injection; tests pass a fixed clock
 * (see `@artoo/testkit`). {@link createSystemClock} is the only place in this
 * package that reads wall-clock time.
 */
export interface Clock {
  now(): Date;
  nowIso(): string;
}

/**
 * Sanctioned entropy seam — the only place in @artoo/domain that reads
 * wall-clock time. Inject the result; never call from domain logic.
 */
export function createSystemClock(): Clock {
  return {
    now: (): Date => new Date(),
    nowIso: (): string => new Date().toISOString(),
  };
}
