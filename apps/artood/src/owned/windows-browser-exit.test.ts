import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeObservedWindowsProcesses, snapshotOwnedWindowsProcesses, windowsObservationFailureCode, WINDOWS_BROWSER_ARGUMENT_PARSER } from "./windows-browser-exit.js";

const parentPid = 101, helperPid = 202;
const absent = (): never => { throw Object.assign(new Error("No such process"), { code: "ESRCH" }); };
const profiles: string[] = [];
function profile() {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-observed-exit-test-"));
  writeFileSync(join(directory, "retained.txt"), "Actual test profile: delete only after confirmed exit");
  profiles.push(directory);
  return directory;
}
function removeOwnedProfile(directory: string) {
  if (!existsSync(directory)) return;
  expect(dirname(realpathSync.native(directory))).toBe(realpathSync.native(tmpdir()));
  rmSync(directory, { recursive: true, force: true });
}
afterEach(() => { for (const directory of profiles.splice(0)) removeOwnedProfile(directory); });

function clock(probe: (pid: number) => void = absent) {
  let time = 0;
  return { probe: vi.fn(probe), now: () => time, sleep: vi.fn(async (ms: number) => { time += ms; }), connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 };
}
function termination(code: number) {
  // Explicit controlled command-result fixture; this is not a real taskkill run.
  const error = new Error(`Synthetic termination status ${code}: arbitrary localized diagnostic`);
  const terminateParent = vi.fn(async (_remainingMs: number) => { if (code !== 0 && code !== 128) throw error; });
  return { error, terminateParent };
}
type TestOwnedWindowsExit = Omit<Parameters<typeof closeObservedWindowsProcesses>[0], "finalAudit">
  & { finalAudit?: Parameters<typeof closeObservedWindowsProcesses>[0]["finalAudit"] };
async function closeAndRemove(directory: string, owned: TestOwnedWindowsExit, primitives: Parameters<typeof closeObservedWindowsProcesses>[1]) {
  // Explicit empty final OS audit fixture. Production callers must always supply the protected observer.
  const result = await closeObservedWindowsProcesses({ ...owned, finalAudit: owned.finalAudit ?? (async () => []) }, primitives);
  removeOwnedProfile(directory);
  return result;
}

describe("Windows observed exit authorizes profile cleanup independently of taskkill status", () => {
  it.each([0, 128, 255])("only removes the profile after real parent-close state and every observed ESRCH: status %i", async (code) => {
    const directory = profile(), command = termination(code), primitives = clock();
    const result = await closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives);
    expect(result.observedProcessCount).toBe(2);
    expect(result.terminationError).toBe(code === 255 ? command.error : undefined);
    expect(primitives.probe.mock.calls).toEqual([[parentPid], [helperPid], [parentPid], [helperPid]]);
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(false);
  });

  it.each([0, 128, 255])("retains the profile when an observed helper remains alive: status %i", async (code) => {
    const directory = profile(), command = termination(code), primitives = clock((pid) => { if (pid === parentPid) absent(); });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(100);
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(true);
  });

  it.each([0, 128, 255])("requires the actual parent close even when all observed PIDs disappear: status %i", async (code) => {
    const directory = profile(), command = termination(code), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => false }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });

  it("waits for delayed parent close and helper exit instead of treating command completion as exit", async () => {
    const directory = profile(), command = termination(255);
    const primitives = clock((pid) => { if (pid === parentPid || primitives.now() >= 75) absent(); });
    const result = await closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => primitives.now() >= 50 }, primitives);
    expect(primitives.now()).toBe(75);
    expect(result.terminationError).toBe(command.error);
    expect(existsSync(directory)).toBe(false);
  });

  it.each(["EPERM", "EACCES", "EIO"])("keeps unknown process state closed to success: %s", async (code) => {
    const directory = profile(), command = termination(0);
    const primitives = clock((pid) => { if (pid === parentPid) absent(); throw Object.assign(new Error("Unknown process state"), { code }); });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });

  it("stops the owned parent but retains the profile when OS/CDP observation fails", async () => {
    const directory = profile(), command = termination(255), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => { throw new Error("Protected observation unavailable"); },
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(true);
  });

  it.each([
    { name: "empty set", ids: [] }, { name: "missing parent", ids: [helperPid] },
    { name: "duplicate PID", ids: [parentPid, parentPid] }, { name: "invalid PID", ids: [parentPid, 0] },
    { name: "oversized set", ids: [parentPid, ...Array.from({ length: 256 }, (_, index) => index + 1000)] },
  ])("rejects an invalid required observation and retains the profile: $name", async ({ ids }) => {
    const directory = profile(), command = termination(0), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => ids,
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(command.terminateParent).toHaveBeenCalledTimes(1);
    expect(existsSync(directory)).toBe(true);
  });

  it("does not delete an early-exited parent's profile when no observation could be established", async () => {
    const directory = profile(), command = termination(0), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => { throw new Error("Root already absent"); },
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });

  it("treats a reused but still-live observed PID conservatively and never sends it to the termination callback", async () => {
    const directory = profile(), command = termination(255), primitives = clock((pid) => { if (pid === parentPid) absent(); });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(true);
  });

  it("keeps the captured PID set even if its producer mutates the original after termination starts", async () => {
    const directory = profile(), ids = [parentPid, helperPid], primitives = clock((pid) => { if (pid === parentPid) absent(); });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => ids,
      terminateParent: async () => { ids.pop(); }, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });
});

describe("Windows graceful close and final owned-profile audit", () => {
  it("only exposes enumerated observer error codes without raw stdout or extra fields", () => {
    expect(windowsObservationFailureCode('{"error_code":"descendant_precedes_parent"}')).toBe("descendant_precedes_parent");
    for (const unsafe of [undefined, "raw private command line", '{"error_code":"private command line"}',
      '{"error_code":"os_query_failed","command_line":"private"}', "null", "[]", '{"error_code":5}', "x".repeat(257)]) {
      expect(windowsObservationFailureCode(unsafe)).toBeUndefined();
    }
  });

  it.runIf(process.platform === "win32")("returns a safe root-identity failure from the actual protected PowerShell observer", async () => {
    await expect(snapshotOwnedWindowsProcesses(process.pid, realpathSync.native(process.execPath), join(tmpdir(), "not-this-node-browser-profile")))
      .rejects.toThrow("Protected Windows process observation failed (root_profile_mismatch)");
  });

  it("waits for disconnected helpers after timely parent close before starting the final audit", async () => {
    const directory = profile(), command = termination(0);
    const primitives = { ...clock(pid => { if (pid === parentPid || primitives.now() >= 150) absent(); }), confirmationTimeoutMs: 200 };
    const finalAudit = vi.fn(async () => []);
    await closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives);
    expect(primitives.now()).toBe(150); expect(finalAudit).toHaveBeenCalledTimes(1); expect(existsSync(directory)).toBe(false);
  });

  it("retains the profile at the shared confirmation deadline when parent close never arrives", async () => {
    const directory = profile(), command = termination(0), primitives = { ...clock(), confirmationTimeoutMs: 200 };
    const finalAudit = vi.fn(async () => []);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => false, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(200); expect(finalAudit).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(true);
  });

  it("accepts actual parent close after three seconds only within the unchanged total confirmation window", async () => {
    const directory = profile(), command = termination(0);
    const primitives = { ...clock(pid => { if (pid === parentPid || primitives.now() >= 5000) absent(); }),
      connectionTimeoutMs: 3000, confirmationTimeoutMs: 20000 };
    const finalAudit = vi.fn(async () => []);
    await closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => primitives.now() >= 3500, finalAudit }, primitives);
    expect(primitives.now()).toBe(5000); expect(finalAudit).toHaveBeenCalledTimes(1); expect(existsSync(directory)).toBe(false);
  });

  it("never accepts absent PIDs without actual close anywhere in the full confirmation window", async () => {
    const directory = profile(), command = termination(0), primitives = { ...clock(), connectionTimeoutMs: 3000, confirmationTimeoutMs: 20000 };
    const finalAudit = vi.fn(async () => []);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => false, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(20000); expect(finalAudit).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(true);
  });

  it("does not renew the total window for a later parent close or lingering helper", async () => {
    const directory = profile(), command = termination(0);
    const primitives = { ...clock(pid => { if (pid === parentPid || primitives.now() > 20000) absent(); }),
      connectionTimeoutMs: 3000, confirmationTimeoutMs: 20000 };
    const finalAudit = vi.fn(async () => []);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => primitives.now() >= 3500, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(20000); expect(finalAudit).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(true);
  });

  it("retains the profile at the fixed helper deadline and never starts the audit while a PID remains", async () => {
    const directory = profile(), command = termination(0);
    const primitives = { ...clock(pid => { if (pid === parentPid) absent(); }), confirmationTimeoutMs: 200 };
    const finalAudit = vi.fn(async () => []);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(200); expect(finalAudit).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(true);
  });

  it("reserves the OS audit budget after a delayed but timely parent-close confirmation", async () => {
    const directory = profile(), command = termination(0), primitives = clock();
    const finalAudit = vi.fn(async (_remaining: number) => { await primitives.sleep(60); return []; });
    await closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => primitives.now() >= 75, finalAudit }, primitives);
    expect(primitives.now()).toBe(135); expect(finalAudit.mock.calls).toEqual([[100]]);
    expect(existsSync(directory)).toBe(false);
  });

  it("allows two slow exact audits of a late helper within one fixed audit budget", async () => {
    const directory = profile(), latePid = 303, command = termination(0);
    const primitives = { ...clock(pid => { if (pid !== latePid || primitives.now() >= 80) absent(); }), auditTimeoutMs: 200 };
    const finalAudit = vi.fn(async (_remaining: number) => { await primitives.sleep(60); return primitives.now() === 60 ? [latePid] : []; });
    const result = await closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives);
    expect(finalAudit.mock.calls).toEqual([[200], [115]]); expect(result.observedProcessCount).toBe(2);
    expect(primitives.now()).toBe(145); expect(existsSync(directory)).toBe(false);
  });

  it("never renews the audit deadline when successive exact audits reveal more helpers", async () => {
    const directory = profile(), command = termination(0), primitives = { ...clock(), auditTimeoutMs: 200 };
    const finalAudit = vi.fn(async (remaining: number) => {
      await primitives.sleep(Math.min(60, remaining)); return [303 + finalAudit.mock.calls.length];
    });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(finalAudit.mock.calls).toEqual([[200], [115], [30]]);
    expect(primitives.now()).toBe(200); expect(existsSync(directory)).toBe(true);
  });

  it("does not start a fresh audit budget after a synchronous exit probe exceeds its deadline", async () => {
    const directory = profile(), command = termination(0); let time = 0;
    const primitives = { probe: () => { time = 100; absent(); }, now: () => time,
      sleep: async (ms: number) => { time += ms; }, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 200 };
    const finalAudit = vi.fn(async () => []);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(finalAudit).not.toHaveBeenCalled(); expect(existsSync(directory)).toBe(true);
  });

  it("keeps a late helper as an observation-only blocker after the original parent and helpers exit", async () => {
    const directory = profile(), latePid = 303, command = termination(0);
    const primitives = clock(pid => { if (pid !== latePid) absent(); });
    const finalAudit = vi.fn(async () => [latePid]);
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives)).rejects.toThrow("profile is retained");
    expect(finalAudit).toHaveBeenCalledTimes(1);
    expect(primitives.now()).toBe(100);
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(primitives.probe.mock.calls.some(([pid]) => pid === latePid)).toBe(true);
    expect(existsSync(directory)).toBe(true);
  });

  it("waits for a late helper to disappear and requires another empty audit within the same deadline", async () => {
    const directory = profile(), latePid = 303, command = termination(0);
    const primitives = clock(pid => { if (pid !== latePid || primitives.now() >= 25) absent(); });
    const finalAudit = vi.fn(async () => primitives.now() === 0 ? [latePid] : []);
    const result = await closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit }, primitives);
    expect(result.observedProcessCount).toBe(3);
    expect(finalAudit.mock.calls.length).toBe(2);
    expect(primitives.now()).toBe(25);
    expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(false);
  });

  it("rejects an empty audit returned after the confirmation deadline", async () => {
    const directory = profile(), command = termination(0), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true,
      finalAudit: async remaining => { expect(remaining).toBe(100); await primitives.sleep(100); return []; } }, primitives)).rejects.toThrow("profile is retained");
    expect(primitives.now()).toBe(100); expect(existsSync(directory)).toBe(true);
  });

  it.each([
    { name: "throws", audit: async (): Promise<number[]> => { throw new Error("Protected audit unavailable"); } },
    { name: "duplicate PIDs", audit: async () => [303, 303] },
    { name: "invalid PID", audit: async () => [0] },
    { name: "oversized", audit: async () => Array.from({ length: 129 }, (_, index) => index + 1000) },
    { name: "wrong shape", audit: async () => null as unknown as number[] },
  ])("retains the profile when final audit $name", async ({ audit }) => {
    const directory = profile(), command = termination(0), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true, finalAudit: audit }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });

  it("uses graceful close without forced termination but still requires real close, every ESRCH and final audit", async () => {
    const directory = profile(), command = termination(0), primitives = clock(), order: string[] = [];
    let closed = false;
    const result = await closeAndRemove(directory, { parentPid, observe: async () => { order.push("observe"); return [parentPid, helperPid]; },
      requestGracefulClose: async remaining => { expect(remaining).toBe(1000); order.push("graceful"); closed = true; },
      terminateParent: command.terminateParent, parentClosed: () => closed,
      closeConnection: async remaining => { expect(remaining).toBe(100); order.push("disconnect"); },
      finalAudit: async () => { order.push("audit"); return []; } }, primitives);
    expect(result.observedProcessCount).toBe(2); expect(command.terminateParent).not.toHaveBeenCalled();
    expect(order).toEqual(["observe", "graceful", "disconnect", "audit"]);
    expect(primitives.probe.mock.calls).toEqual([[parentPid], [helperPid], [parentPid], [helperPid]]);
    expect(existsSync(directory)).toBe(false);
  });

  it("gives forced termination only the remainder of the original budget after graceful failure", async () => {
    const directory = profile(), primitives = clock(), error = new Error("Controlled CDP close failure");
    let closed = false;
    const terminateParent = vi.fn(async (remaining: number) => { expect(remaining).toBe(2250); closed = true; });
    const result = await closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      requestGracefulClose: async () => { await primitives.sleep(750); throw error; },
      terminateParent, parentClosed: () => closed }, primitives);
    expect(result.gracefulError).toBe(error); expect(terminateParent.mock.calls).toEqual([[2250]]);
    expect(existsSync(directory)).toBe(false);
  });

  it("identifies a connection-close failure before probes without replacing its actual cause", async () => {
    const cause = new Error("Controlled client disconnect failure"), primitives = clock(), audit = vi.fn(async () => []);
    const result: unknown = await closeObservedWindowsProcesses({ parentPid, observe: async () => [parentPid], parentClosed: () => true,
      terminateParent: async () => {}, requestGracefulClose: async () => {},
      closeConnection: async remaining => { expect(remaining).toBe(100); throw cause; }, finalAudit: audit }, primitives).catch(error => error);
    expect((result as AggregateError).errors).toContain(cause);
    expect((result as Error).message).toContain("failures=connection_close");
    expect(primitives.probe).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled(); expect(primitives.now()).toBe(0);
  });
  it("keeps the original connection timeout inside the original confirmation deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const probe = vi.fn(absent), audit = vi.fn(async () => []);
      const closing = closeObservedWindowsProcesses({ parentPid, observe: async () => [parentPid], parentClosed: () => true,
        terminateParent: async () => {}, requestGracefulClose: async () => {},
        closeConnection: remaining => { expect(remaining).toBe(3000); return new Promise<void>(() => {}); }, finalAudit: audit },
      { probe, now: () => Date.now(), sleep: async () => {}, connectionTimeoutMs: 3000, confirmationTimeoutMs: 20000, auditTimeoutMs: 5000 }).catch(error => error as AggregateError);
      await vi.advanceTimersByTimeAsync(3000);
      const failure = await closing;
      expect(failure).toBeInstanceOf(AggregateError); expect((failure as Error).message).toContain("failures=connection_close");
      expect((failure as AggregateError).errors[0].message).toBe("Browser client disconnect timed out");
      expect(Date.now()).toBe(3000); expect(probe).not.toHaveBeenCalled(); expect(audit).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("returns to exit confirmation after disconnect without renewing its remaining budget", async () => {
    const primitives = clock(pid => { if (pid === parentPid) absent(); }), audit = vi.fn(async () => []);
    const result: unknown = await closeObservedWindowsProcesses({ parentPid, observe: async () => [parentPid, helperPid], parentClosed: () => true,
      terminateParent: async () => {}, requestGracefulClose: async () => {},
      closeConnection: async () => { await primitives.sleep(75); }, finalAudit: audit }, primitives).catch(error => error);
    expect((result as Error).message).toContain("failures=exit_confirmation");
    expect((result as Error).message).not.toContain("connection_close"); expect(primitives.now()).toBe(100);
    expect(primitives.probe.mock.calls).toEqual([[parentPid], [helperPid]]); expect(audit).not.toHaveBeenCalled();
  });

  it("bounds a nonresponding graceful request and reserves the remaining termination budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const directory = profile(); let closed = false;
      const primitives = { probe: absent, now: () => Date.now(), sleep: async () => {}, connectionTimeoutMs: 3000, confirmationTimeoutMs: 3000, auditTimeoutMs: 3000 };
      const terminateParent = vi.fn(async (remaining: number) => { expect(remaining).toBe(2000); closed = true; });
      const result = closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
        requestGracefulClose: () => new Promise<void>(() => {}), terminateParent, parentClosed: () => closed }, primitives);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await result).gracefulError).toBeInstanceOf(Error);
      expect(terminateParent.mock.calls).toEqual([[2000]]); expect(existsSync(directory)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("does not skip parent termination when the required pre-close observation fails", async () => {
    const directory = profile(), command = termination(0), primitives = clock(), graceful = vi.fn(async () => {});
    await expect(closeAndRemove(directory, { parentPid, observe: async () => { throw new Error("Root unavailable"); },
      requestGracefulClose: graceful, terminateParent: command.terminateParent, parentClosed: () => true }, primitives)).rejects.toThrow("profile is retained");
    expect(graceful).not.toHaveBeenCalled(); expect(command.terminateParent.mock.calls).toEqual([[3000]]);
    expect(existsSync(directory)).toBe(true);
  });

  it("does not treat a graceful command response as the parent's actual close", async () => {
    const directory = profile(), command = termination(0), primitives = clock();
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      requestGracefulClose: async () => {}, terminateParent: command.terminateParent, parentClosed: () => false }, primitives)).rejects.toThrow("profile is retained");
    expect(command.terminateParent.mock.calls).toEqual([[3000]]); expect(existsSync(directory)).toBe(true);
  });

  it("rechecks the original PIDs after an asynchronous empty audit", async () => {
    const directory = profile(), command = termination(0); let reused = false;
    const primitives = clock(pid => { if (pid !== helperPid || !reused) absent(); });
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid, helperPid],
      terminateParent: command.terminateParent, parentClosed: () => true,
      finalAudit: async () => { reused = true; return []; } }, primitives)).rejects.toThrow("profile is retained");
    expect(existsSync(directory)).toBe(true);
  });

  it("rejects a final synchronous PID confirmation that consumes the remaining deadline", async () => {
    const directory = profile(), command = termination(0);
    let time = 0, audited = false;
    const primitives = { probe: () => { if (audited) time = 100; absent(); }, now: () => time,
      sleep: async (ms: number) => { time += ms; }, connectionTimeoutMs: 100, confirmationTimeoutMs: 100, auditTimeoutMs: 100 };
    await expect(closeAndRemove(directory, { parentPid, observe: async () => [parentPid],
      terminateParent: command.terminateParent, parentClosed: () => true,
      finalAudit: async () => { audited = true; return []; } }, primitives)).rejects.toThrow("profile is retained");
    expect(time).toBe(100); expect(existsSync(directory)).toBe(true);
  });

  it.runIf(process.platform === "win32")("matches complete Windows profile arguments, including the actual late-helper quoting", () => {
    const simple = "C:\\Temp\\artoo-owned-browser-example", spaced = "C:\\Temp Folder\\artoo-owned-browser-example";
    const examples = [
      { profile: simple, line: `chrome.exe --user-data-dir=${simple}`, match: true },
      { profile: simple, line: `chrome.exe --user-data-dir="${simple}"`, match: true },
      { profile: simple, line: `chrome.exe "--user-data-dir=${simple}"`, match: true },
      { profile: spaced, line: `"C:\\Task Chrome\\chrome.exe" --user-data-dir="${spaced}"`, match: true },
      { profile: spaced, line: `"C:\\Task Chrome\\chrome.exe" "--user-data-dir=${spaced}"`, match: true },
      { profile: simple, line: `chrome.exe --user-data-dir=${simple}-extra`, match: false },
      { profile: simple, line: "chrome.exe --user-data-dir=C:\\Temp\\another-profile", match: false },
      { profile: simple, line: `chrome.exe --other="--user-data-dir=${simple}"`, match: false },
      { profile: simple, line: `chrome.exe --other="prefix --user-data-dir=${simple} suffix"`, match: false },
      { profile: simple, line: `chrome.exe --other="prefix \\"--user-data-dir=${simple}\\" suffix"`, match: false },
    ];
    // Execute only the production argument parser over controlled strings. No CIM, browser or process inventory.
    const encoded = Buffer.from(JSON.stringify(examples), "utf8").toString("base64");
    const script = WINDOWS_BROWSER_ARGUMENT_PARSER + `\n$items = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))\n`
      + "$result = @($items | ForEach-Object { Test-ArtooBrowserProfile ([string]$_.line) ([string]$_.profile) })\n"
      + "$unknown = @(@($null, '', '  ') | ForEach-Object { try { [void](Test-ArtooBrowserProfile $_ 'C:\\Temp\\profile'); $false } catch { $true } })\n"
      + "$wql = ConvertTo-ArtooWqlLiteral \"C:\\Task Chrome\\it's\\chrome.exe\"\n"
      + "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ matches = $result; wql = $wql; unknown_rejected = $unknown })";
    const output = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" });
    expect(JSON.parse(output.trim())).toEqual({ matches: examples.map(example => example.match), wql: "'C:\\\\Task Chrome\\\\it\\'s\\\\chrome.exe'",
      unknown_rejected: [true, true, true] });
  });
});
