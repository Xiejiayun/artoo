import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../context.js";
import { startGoalBudgetMonitor } from "./budget-service.js";
import { wakeGoalBudgetMonitors } from "./budget-monitor-wake.js";

type ScanRow = { id: string; organizationId: string; budgets: unknown; stopConditions?: unknown };
function fixture(rows: ScanRow[] = []) {
  const scan = vi.fn<() => Promise<ScanRow[]>>().mockResolvedValue(rows);
  const transaction = vi.fn().mockRejectedValue(new Error("controlled enforcement failure"));
  const ctx = { db: { db: { select: () => ({ from: () => ({ where: scan }) }) }, transaction },
    clock: { nowIso: () => "2026-11-14T00:00:00Z" } } as unknown as ServerContext;
  const onError = vi.fn();
  return { ctx, scan, transaction, onError };
}
const monitors: ReturnType<typeof startGoalBudgetMonitor>[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  await Promise.all(monitors.splice(0).map(monitor => monitor.stop()));
  vi.useRealTimers();
});
function start(test: ReturnType<typeof fixture>, options = {}) {
  const monitor = startGoalBudgetMonitor(test.ctx, { onError: test.onError, ...options });
  monitors.push(monitor);
  return monitor;
}

describe("adaptive budget scan scheduling", () => {
  it("backs off empty scans to 30 seconds and skips unlimited/concurrency-only usage transactions", async () => {
    const test = fixture([{ id: "unlimited", organizationId: "one", budgets: {} },
      { id: "capacity", organizationId: "two", budgets: { max_concurrent_runs: 1 } }]);
    start(test);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.scan).toHaveBeenCalledTimes(5); // 1, 3, 7, 15, 31 seconds
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.scan).toHaveBeenCalledTimes(7); // 61, 91 seconds
    expect(test.transaction).not.toHaveBeenCalled();
    expect(test.onError).not.toHaveBeenCalled();
  });

  it("cancels the idle delay on a committed wake and scopes wakeups to the shared client", async () => {
    const test = fixture(), other = fixture();
    start(test); start(other);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.scan).toHaveBeenCalledTimes(4);
    wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.scan).toHaveBeenCalledTimes(5);
    expect(other.scan).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2000);
    expect(test.scan).toHaveBeenCalledTimes(6);
  });

  it("does not overlap scans or lose a wake during a database read, and stop drains without rearming", async () => {
    const test = fixture();
    let release!: (rows: ScanRow[]) => void;
    test.scan.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const monitor = start(test);
    await vi.advanceTimersByTimeAsync(1000);
    wakeGoalBudgetMonitors(test.ctx.db); wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.scan).toHaveBeenCalledTimes(1);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.scan).toHaveBeenCalledTimes(2);
    let releaseLast!: (rows: ScanRow[]) => void;
    test.scan.mockReturnValueOnce(new Promise(resolve => { releaseLast = resolve; }));
    wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = monitor.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseLast([]); await stopping;
    wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.scan).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the active cadence and reports invalid legacy data rather than treating it as unlimited", async () => {
    const test = fixture([{ id: "active", organizationId: "one", budgets: { max_retries: 0 } },
      { id: "bad", organizationId: "two", budgets: { max_retries: -1 } },
      { id: "bad-stop", organizationId: "two", budgets: {}, stopConditions: { rules: "invalid" } }]);
    start(test);
    await vi.advanceTimersByTimeAsync(3000);
    expect(test.scan).toHaveBeenCalledTimes(3);
    expect(test.transaction).toHaveBeenCalledTimes(9);
    expect(test.onError).toHaveBeenCalledTimes(9);
  });

  it("retries failed scans at the base interval and removes just the stopped observer", async () => {
    const test = fixture();
    test.scan.mockRejectedValueOnce(new Error("controlled query failure"));
    const first = start(test);
    await first.stop();
    const second = start(test);
    await first.stop(); // Must not unregister the newer observer.
    wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.scan).toHaveBeenCalledTimes(2);
    await second.stop();
    wakeGoalBudgetMonitors(test.ctx.db);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.scan).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe timer settings", () => {
    const test = fixture();
    for (const options of [{ intervalMs: 0 }, { intervalMs: -1 }, { intervalMs: Infinity }, { intervalMs: 2, idleMaxIntervalMs: 1 }, { idleMaxIntervalMs: 2 ** 31 }]) {
      expect(() => startGoalBudgetMonitor(test.ctx, options)).toThrow(RangeError);
    }
  });
});
