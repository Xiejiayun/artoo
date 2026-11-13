import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPendingStopRegistry } from "./pending-stop-registry.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("pending process closure", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps a successful dispatch pending until its validated closure arrives", async () => {
    const registry = createPendingStopRegistry(15_000);
    const dispatch = vi.fn(async () => {});
    let settled = false;
    const waiting = registry
      .wait("run", dispatch, () => Error("unconfirmed"))
      .then(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    registry.get("run")!.resolve();
    await waiting;
    expect(settled).toBe(true);
    expect(registry.get("run")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares same-ID closure without sending another stop and preserves the dispatch wait", async () => {
    const registry = createPendingStopRegistry(15_000);
    const sending = deferred();
    const dispatch = vi.fn(() => sending.promise);
    let firstFinished = false;
    const first = registry
      .wait("run", dispatch, () => Error("timeout"))
      .then(() => {
        firstFinished = true;
      });
    const second = registry.wait("run", dispatch, () => Error("duplicate timeout"));
    registry.get("run")!.resolve();
    await second;
    expect(firstFinished).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
    sending.resolve();
    await first;
    expect(registry.get("run")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the original 15 second deadline for all same-ID callers and allows a later attempt", async () => {
    const registry = createPendingStopRegistry(15_000);
    const error = Error("stage closure unconfirmed");
    const dispatch = vi.fn(async () => {});
    const first = registry.wait("run", dispatch, () => error);
    await vi.advanceTimersByTimeAsync(10_000);
    const second = registry.wait("run", dispatch, () => Error("must not replace deadline"));
    const checked = Promise.all([expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await checked;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(registry.get("run")).toBeUndefined();
    const retry = registry.wait("run", dispatch, () => error);
    registry.get("run")!.resolve();
    await retry;
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates IDs and rejects an uncertain result without claiming closure", async () => {
    const registry = createPendingStopRegistry(15_000);
    const uncertain = Error("stage closure remains uncertain");
    const first = registry.wait(
      "one",
      async () => {},
      () => Error("first timeout"),
    );
    const second = registry.wait(
      "two",
      async () => {},
      () => Error("second timeout"),
    );
    const rejected = expect(second).rejects.toBe(uncertain);
    registry.get("one")!.resolve();
    registry.get("two")!.reject(uncertain);
    await first;
    await rejected;
    expect(registry.get("one")).toBeUndefined();
    expect(registry.get("two")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains one in-flight dispatch after timeout without launching another stop", async () => {
    const registry = createPendingStopRegistry(15_000);
    const sending = deferred();
    const error = Error("closure timed out while sending");
    const dispatch = vi.fn(() => sending.promise);
    const first = registry.wait("run", dispatch, () => error);
    const checkedFirst = expect(first).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(registry.get("run")).toBeDefined();
    await expect(registry.wait("run", dispatch, () => Error("new deadline"))).rejects.toBe(error);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    sending.resolve();
    await checkedFirst;
    expect(registry.get("run")).toBeUndefined();
  });

  it.each(["request", "dispatch"])("propagates %s failure to duplicate callers and clears its timer", async (phase) => {
    const registry = createPendingStopRegistry(15_000);
    const failed = deferred();
    const error = Error(`${phase} failed`);
    const request = vi.fn(() => (phase === "request" ? failed.promise : Promise.resolve()));
    const dispatch = vi.fn(() => failed.promise);
    const first = registry.wait(
      "run",
      async () => {
        await request();
        await dispatch();
      },
      () => Error("timeout"),
    );
    const second = registry.wait(
      "run",
      async () => {},
      () => Error("timeout"),
    );
    const checked = Promise.all([expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)]);
    failed.reject(error);
    await checked;
    expect(dispatch).toHaveBeenCalledTimes(phase === "request" ? 0 : 1);
    expect(registry.get("run")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original thrown value while normalizing the shared rejection", async () => {
    const registry = createPendingStopRegistry(15_000);
    const sending = deferred();
    const first = registry.wait(
      "run",
      () => sending.promise,
      () => Error("timeout"),
    );
    const second = registry.wait(
      "run",
      async () => {},
      () => Error("timeout"),
    );
    const checked = Promise.all([
      expect(first).rejects.toBe("transport failure"),
      expect(second).rejects.toThrow("transport failure"),
    ]);
    sending.reject("transport failure");
    await checked;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hide a dispatch failure when closure arrived before dispatch settled", async () => {
    const registry = createPendingStopRegistry(15_000);
    const sending = deferred();
    const error = Error("dispatch failed");
    const first = registry.wait(
      "run",
      () => sending.promise,
      () => Error("timeout"),
    );
    const rejected = expect(first).rejects.toBe(error);
    registry.get("run")!.resolve();
    sending.reject(error);
    await rejected;
    expect(registry.get("run")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes every pending ID and refuses a late registration after disconnect", async () => {
    const registry = createPendingStopRegistry(15_000);
    const error = Error("node disconnected before closure");
    const first = registry.wait(
      "one",
      async () => {},
      () => Error("timeout"),
    );
    const second = registry.wait(
      "two",
      async () => {},
      () => Error("timeout"),
    );
    const checked = Promise.all([expect(first).rejects.toBe(error), expect(second).rejects.toBe(error)]);
    registry.close(error);
    registry.close(Error("must not replace original disconnect"));
    await checked;
    const lateDispatch = vi.fn(async () => {});
    await expect(registry.wait("late", lateDispatch, () => Error("timeout"))).rejects.toBe(error);
    expect(lateDispatch).not.toHaveBeenCalled();
    expect(registry.get("one")).toBeUndefined();
    expect(registry.get("two")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains an in-flight dispatch wait across close and handles its later completion", async () => {
    const registry = createPendingStopRegistry(15_000);
    const sending = deferred();
    const error = Error("node disconnected");
    const first = registry.wait(
      "run",
      () => sending.promise,
      () => Error("timeout"),
    );
    const second = registry.wait(
      "run",
      async () => {},
      () => Error("timeout"),
    );
    const checkedFirst = expect(first).rejects.toBe(error);
    const checkedSecond = expect(second).rejects.toBe(error);
    registry.close(error);
    await checkedSecond;
    expect(registry.get("run")).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    sending.resolve();
    await checkedFirst;
  });
});
