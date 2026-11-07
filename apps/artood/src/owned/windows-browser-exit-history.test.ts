import { describe, expect, it, vi } from "vitest";
import { closeObservedWindowsProcesses, WindowsBrowserSessionObservationError } from "./windows-browser-exit.js";

const parentPid = 7001, historicalPid = 7002;
const absent = (): never => { throw Object.assign(new Error("Controlled absent PID"), { code: "ESRCH" }); };
function fixture(observe: () => Promise<readonly number[]>, probe: (pid: number) => void = absent) {
  let now = 0;
  const owned = {
    parentPid, observe, parentClosed: () => true,
    requestGracefulClose: vi.fn(async (_remainingMs: number) => {}),
    terminateParent: vi.fn(async (_remainingMs: number) => {}),
    finalAudit: vi.fn(async (_remainingMs: number): Promise<readonly number[]> => []),
  };
  const primitives = {
    probe: vi.fn(probe), now: () => now, sleep: async (ms: number) => { now += ms; },
    connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100, terminationTimeoutMs: 90,
  };
  return { owned, primitives };
}
function initialFailure(pids: readonly number[] = [historicalPid], root = parentPid) {
  return new WindowsBrowserSessionObservationError("observer_retry_exhausted", "ancestry_confirmation", { parentPid: root, pids });
}

describe("Windows initial exit history ownership (controlled probes, no native acceptance)", () => {
  it("copies and freezes trusted history and binds it to the original parent", () => {
    const source = [historicalPid], input = { parentPid, pids: source };
    const failure = new WindowsBrowserSessionObservationError("observer_retry_exhausted", "ancestry_confirmation", input);
    source.push(7003); input.parentPid = 8001;
    const history = WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, parentPid);
    expect(history).toEqual([historicalPid]); expect(Object.isFrozen(history)).toBe(true);
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, 8001)).toBeUndefined();
    expect(() => (history as number[]).push(7004)).toThrow();
  });
  it.each([
    { parentPid: 0, pids: [] }, { parentPid: 0x100000000, pids: [] },
    { parentPid, pids: [parentPid] }, { parentPid, pids: [historicalPid, historicalPid] },
    { parentPid, pids: [0] }, { parentPid, pids: [-1] }, { parentPid, pids: [1.5] },
    { parentPid, pids: [0x100000000] }, { parentPid, pids: Array.from({ length: 128 }, (_, index) => 8000 + index) },
  ])("rejects invalid trusted history at construction: %j", history => {
    expect(() => new WindowsBrowserSessionObservationError("observer_retry_exhausted", "ancestry_confirmation", history))
      .toThrow("Invalid protected observer exit history");
  });
  it.each([undefined, [] as number[], [historicalPid]])("cannot recover initial failure when history %j is entirely absent", async history => {
    const failure = history === undefined
      ? new WindowsBrowserSessionObservationError("observer_retry_exhausted", "ancestry_confirmation") : initialFailure(history);
    const { owned, primitives } = fixture(async () => { throw failure; });
    const result: unknown = await closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toContain(failure);
    expect((result as Error).message).toContain("profile is retained");
    expect((result as Error).message).toContain("initial_observation:observer_retry_exhausted@ancestry_confirmation");
    expect(owned.requestGracefulClose).not.toHaveBeenCalled();
    // Termination receives only its existing time budget. No helper identity is a target.
    expect(owned.terminateParent).toHaveBeenCalledExactlyOnceWith(90);
    expect(primitives.probe.mock.calls.map(([pid]) => pid)).toEqual(history?.length ? [parentPid, historicalPid, parentPid, historicalPid] : [parentPid, parentPid]);
  });
  it.each(["live", "reused", "inaccessible"])("keeps a historical %s PID in cleanup-only probes and retains the profile", async state => {
    const failure = initialFailure();
    const denied = Object.assign(new Error("Controlled access denied"), { code: "EPERM" });
    const { owned, primitives } = fixture(async () => { throw failure; }, pid => {
      if (pid === parentPid) absent();
      if (state === "inaccessible") throw denied;
      // A present replacement PID is conservatively indistinguishable from a live helper.
    });
    const result: unknown = await closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toContain(failure);
    if (state === "inaccessible") expect((result as AggregateError).errors).toContain(denied);
    expect((result as Error).message).toContain("profile is retained");
    expect((result as Error).message).toContain("exit_confirmation");
    expect(primitives.probe.mock.calls.map(([pid]) => pid)).toContain(historicalPid);
    expect(owned.finalAudit).not.toHaveBeenCalled(); expect(owned.requestGracefulClose).not.toHaveBeenCalled();
    expect(owned.terminateParent).toHaveBeenCalledExactlyOnceWith(90);
  });
  it("reprobes error history after awaited final I/O and rejects a reappearing PID", async () => {
    const failure = initialFailure(); let reappeared = false;
    const { owned, primitives } = fixture(async () => { throw failure; }, pid => {
      if (!reappeared || pid !== historicalPid) absent();
    });
    owned.finalAudit.mockImplementation(async () => { reappeared = true; return []; });
    const result: unknown = await closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    expect((result as Error).message).toContain("profile is retained");
    expect((result as Error).message).toContain(`present=${historicalPid}`);
    expect((result as Error).message).toContain("final_audit");
    expect(owned.finalAudit).toHaveBeenCalledTimes(1); expect(owned.requestGracefulClose).not.toHaveBeenCalled();
  });
  it.each(["arbitrary object", "message mimic", "forged prototype", "other root"])("does not accept cleanup history from %s", async kind => {
    const failure = kind === "other root" ? initialFailure([historicalPid], 8001)
      : kind === "forged prototype" ? Object.assign(Object.create(WindowsBrowserSessionObservationError.prototype) as Error, { message: "forged", initialExitHistory: { parentPid, pids: [historicalPid] } })
      : kind === "message mimic" ? Object.assign(new Error("Protected Windows browser session failed (observer_retry_exhausted) [last_phase=ancestry_confirmation]"), { initialExitHistory: { parentPid, pids: [historicalPid] } })
      : { initialExitHistory: { parentPid, pids: [historicalPid] }, cleanupOnlyHistory: () => [historicalPid] };
    const { owned, primitives } = fixture(async () => { throw failure; });
    await expect(closeObservedWindowsProcesses(owned, primitives)).rejects.toThrow("profile is retained");
    expect(WindowsBrowserSessionObservationError.cleanupOnlyHistory(failure, parentPid)).toBeUndefined();
    expect(primitives.probe.mock.calls.map(([pid]) => pid)).toEqual([parentPid, parentPid]);
    expect(owned.requestGracefulClose).not.toHaveBeenCalled();
  });
  it("still requires actual parent close when every history PID is absent", async () => {
    const { owned, primitives } = fixture(async () => { throw initialFailure(); });
    owned.parentClosed = () => false;
    await expect(closeObservedWindowsProcesses(owned, primitives)).rejects.toThrow("closed=false");
    expect(owned.finalAudit).not.toHaveBeenCalled(); expect(owned.requestGracefulClose).not.toHaveBeenCalled();
  });
  it("checks a successful initial union before and after the final audit without using helper PIDs for termination", async () => {
    const { owned, primitives } = fixture(async () => [parentPid, historicalPid]);
    await expect(closeObservedWindowsProcesses(owned, primitives)).resolves.toEqual({ observedProcessCount: 2 });
    expect(primitives.probe.mock.calls.map(([pid]) => pid)).toEqual([parentPid, historicalPid, parentPid, historicalPid]);
    expect(owned.requestGracefulClose).toHaveBeenCalledExactlyOnceWith(30);
    expect(owned.terminateParent).not.toHaveBeenCalled();
  });
});
