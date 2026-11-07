import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitSessionClosure } from "./session-closure.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("bounded session closure (controlled joins)", () => {
  it.each(["cleanup", "ordinary"])("revokes synchronously and preserves a synchronous %s failure", async kind => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const failure = kind === "cleanup" ? new VerificationCleanupError("Controlled synchronous cleanup failure") : new Error("Controlled synchronous failure");
    const revoked = vi.fn();
    const closed = awaitSessionClosure(() => { revoked(); throw failure; }, "Controlled closure remains unconfirmed");
    expect(revoked).toHaveBeenCalledOnce();
    const observed = await closed.catch(error => error as unknown);
    expect(observed).toBeInstanceOf(VerificationCleanupError);
    if (kind === "cleanup") expect(observed).toBe(failure);
    else expect((observed as Error).cause).toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when synchronous revocation consumes the original deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    const closed = awaitSessionClosure(() => { now.mockReturnValue(6100); return Promise.resolve(); }, "Controlled closure remains unconfirmed");
    await expect(closed).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails a never-settling join without converting it into cleanup success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const completed = vi.fn(), closed = awaitSessionClosure(() => pending, "Controlled closure remains unconfirmed");
    void closed.then(completed, () => undefined);
    const failure = closed.catch(error => error as unknown);
    await vi.advanceTimersByTimeAsync(4999); expect(completed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await failure).toBeInstanceOf(VerificationCleanupError);
    release(); await Promise.resolve(); await Promise.resolve();
    expect(completed).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the fixed deadline when the join completes before a delayed timeout callback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: () => void;
    const pending = new Promise<void>(done => { release = done; });
    const closed = awaitSessionClosure(() => pending, "Controlled closure remains unconfirmed"), elapsed = performance.now();
    const failure = expect(closed).rejects.toBeInstanceOf(VerificationCleanupError);
    vi.spyOn(performance, "now").mockReturnValue(elapsed + 6000);
    release(); await failure; expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the original cleanup error and clears the deadline for timely closure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const failure = new VerificationCleanupError("Controlled original ownership uncertainty");
    await expect(awaitSessionClosure(async () => { throw failure; }, "Controlled closure remains unconfirmed")).rejects.toBe(failure);
    await expect(awaitSessionClosure(async () => {}, "Controlled closure remains unconfirmed")).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
