import { afterEach, describe, expect, it, vi } from "vitest";
import { closeObservedWindowsProcesses } from "./windows-browser-exit.js";

const parentPid = 101, helperPid = 202;
const absent = (): never => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); };
afterEach(() => vi.useRealTimers());

function fixture(parentExit = 3500, helperExit = 5000) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const events: string[] = [];
  const primitives = {
    probe: vi.fn((pid: number) => { if (Date.now() >= (pid === parentPid ? parentExit : helperExit)) absent(); }),
    now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    connectionTimeoutMs: 3000, confirmationTimeoutMs: 20000, auditTimeoutMs: 5000,
  };
  const owned = {
    parentPid, observe: async () => [parentPid, helperPid], parentClosed: () => Date.now() >= parentExit,
    terminateParent: vi.fn(async () => { events.push("terminate"); }),
    // Controlled WebSocket-close analogue: transport closure depends on actual
    // browser exit. A successful termination request alone cannot settle it.
    closeConnection: vi.fn(async (_remaining: number) => {
      events.push(`disconnect:${Date.now()}`);
      await primitives.sleep(Math.max(100, parentExit - Date.now()));
    }),
    finalAudit: vi.fn(async (_remaining: number) => { events.push(`audit:${Date.now()}`); return []; }),
  };
  return { owned, primitives, events };
}

describe("Windows browser disconnect follows confirmed process exit", () => {
  it("does not spend the disconnect budget waiting for an asynchronously terminating browser", async () => {
    const { owned, primitives, events } = fixture();
    const result = closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    await vi.advanceTimersByTimeAsync(5100);
    expect(await result).toEqual({ observedProcessCount: 2 });
    expect(events).toEqual(["terminate", "disconnect:5000", "audit:5100"]);
    expect(owned.closeConnection).toHaveBeenCalledExactlyOnceWith(3000);
    expect(owned.finalAudit).toHaveBeenCalledExactlyOnceWith(5000);
    expect(primitives.probe.mock.calls.slice(-4)).toEqual([[parentPid], [helperPid], [parentPid], [helperPid]]);
  });

  it("caps disconnect at the remaining original confirmation budget after a late exit", async () => {
    const { owned, primitives } = fixture(19500, 19500);
    owned.closeConnection.mockImplementation(() => new Promise<void>(() => {}));
    const result = closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toMatchObject({ message: expect.stringContaining("failures=connection_close") });
    expect(owned.closeConnection).toHaveBeenCalledExactlyOnceWith(500);
    expect(owned.finalAudit).not.toHaveBeenCalled();
  });

  it.each([3000, 20000])("rejects a resolved disconnect that overruns its deadline by %i ms even before its timer runs", async elapsed => {
    const { owned, primitives } = fixture(0, 0);
    owned.closeConnection.mockImplementation(async () => { vi.setSystemTime(elapsed); });
    const result = await closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    expect(result).toMatchObject({ message: expect.stringContaining("failures=connection_close") });
    expect(owned.finalAudit).not.toHaveBeenCalled();
  });

  it.each(["present", "EPERM"])("reprobes every observed PID after disconnect and rejects %s before the audit", async state => {
    const { owned, primitives } = fixture(0, 0);
    let disconnected = false;
    owned.closeConnection.mockImplementation(async () => { disconnected = true; });
    primitives.probe.mockImplementation(pid => {
      if (!disconnected || pid === parentPid) absent();
      if (state === "EPERM") throw Object.assign(new Error("Unknown process state"), { code: state });
    });
    const result = closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toMatchObject({ message: expect.stringContaining("failures=exit_confirmation") });
    expect(owned.closeConnection).toHaveBeenCalledTimes(1);
    expect(owned.finalAudit).not.toHaveBeenCalled();
  });

  it("does not repeat disconnect or renew the confirmation deadline when a PID reappears temporarily", async () => {
    const { owned, primitives, events } = fixture(0, 0);
    let disconnected = false;
    owned.closeConnection.mockImplementation(async () => { disconnected = true; events.push("disconnect:0"); });
    primitives.probe.mockImplementation(pid => {
      if (!disconnected || pid === parentPid || Date.now() >= 75) absent();
    });
    const result = closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    await vi.advanceTimersByTimeAsync(75);
    expect(await result).toEqual({ observedProcessCount: 2 });
    expect(events).toEqual(["terminate", "disconnect:0", "audit:75"]);
    expect(owned.closeConnection).toHaveBeenCalledTimes(1);
  });

  it.each(["parent", "helper"])("never calls disconnect or audit without timely actual %s exit", async missing => {
    const { owned, primitives } = fixture(missing === "parent" ? 20000 : 0, missing === "helper" ? 20000 : 0);
    const result = closeObservedWindowsProcesses(owned, primitives).catch(error => error);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await result).toMatchObject({ message: expect.stringContaining("failures=exit_confirmation") });
    expect(owned.closeConnection).not.toHaveBeenCalled();
    expect(owned.finalAudit).not.toHaveBeenCalled();
  });
});
