import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../context.js";
import { startSchedulerProjectionMonitor } from "./scheduler-projection-service.js";

describe("projection scan lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("does not overlap and waits for outstanding database work on stop", async () => {
    vi.useFakeTimers();
    let finish!: (rows: { id: string; organizationId: string }[]) => void;
    const pending = new Promise<{ id: string; organizationId: string }[]>((resolve) => {
      finish = resolve;
    });
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => pending }) }) }));
    const ctx = {
      db: { db: { select } },
      schedulerRollout: { version: 1, workspaces: { org: { flags: { task_mirror: true } } } },
    } as unknown as ServerContext;
    const onError = vi.fn();
    const monitor = startSchedulerProjectionMonitor(ctx, { intervalMs: 10, onError });
    await vi.advanceTimersByTimeAsync(100);
    expect(select).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = monitor.stop().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish([]);
    await closing;
    await vi.advanceTimersByTimeAsync(100);
    expect(select).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
  it("never queries the database for absent or entirely disabled configuration", async () => {
    vi.useFakeTimers();
    const select = vi.fn();
    const ctx = {
      db: { db: { select } },
      schedulerRollout: { version: 1, workspaces: { org: { flags: { task_mirror: false, claim_shadow: true } } } },
    } as unknown as ServerContext;
    const monitor = startSchedulerProjectionMonitor(ctx, { intervalMs: 10, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(100);
    await monitor.stop();
    expect(select).not.toHaveBeenCalled();
  });
});
