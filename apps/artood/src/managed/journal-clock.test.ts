// Controlled clocks only; no system utility, PowerShell, native helper or SQLite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ windows: vi.fn(), sysctl: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: state.sysctl }));
vi.mock("./windows-journal-native.js", () => ({ readWindowsJournalBootSample: state.windows }));
import { readDeliveryClock } from "./journal-clock.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const bootId = "12345678-1234-1234-1234-123456789abc";
function setPlatform(value: string) { Object.defineProperty(process, "platform", { ...platform, value }); }
function ticks(...values: bigint[]) {
  let index = 0;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => {
    const value = values[index++];
    if (value === undefined) throw new Error("Controlled clock exhausted");
    return value * 1_000_000n;
  });
}
beforeEach(() => {
  setPlatform("win32"); state.windows.mockReset(); state.sysctl.mockReset();
  state.windows.mockReturnValue({ id: `windows-boot-v1:${bootId}`, counterNs: 2_000_000n });
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });

describe("boot-bound delivery clock", () => {
  it("uses the native system counter origin with no per-process offset", () => {
    ticks(1n, 3n, 4n, 8n);
    const clock = readDeliveryClock();
    expect(clock?.id).toBe(`windows-boot-v1:${bootId}`); expect(clock?.tickMs()).toBe(8);
    expect(state.sysctl).not.toHaveBeenCalled();
  });
  it.each([0n, 4_000_000n])("rejects a native counter outside the hrtime interval: %s", counterNs => {
    ticks(1n, 3n); state.windows.mockReturnValue({ id: `windows-boot-v1:${bootId}`, counterNs });
    expect(readDeliveryClock()).toBeNull();
  });
  it("rejects backwards hrtime during native sampling", () => {
    ticks(3n, 1n); expect(readDeliveryClock()).toBeNull();
  });
  it("does not renew the persisted origin when another local clock is opened", () => {
    ticks(1n, 3n, 4n, 5n, 7n, 8n, 9n);
    state.windows.mockReturnValueOnce({ id: `windows-boot-v1:${bootId}`, counterNs: 2_000_000n })
      .mockReturnValueOnce({ id: `windows-boot-v1:${bootId}`, counterNs: 6_000_000n });
    const first = readDeliveryClock(), second = readDeliveryClock();
    expect(first?.id).toBe(second?.id); expect(second?.tickMs()).toBe(9);
  });
  it("rejects later backwards ticks and unsafe millisecond values", () => {
    ticks(1n, 3n, 4n, 3n);
    const clock = readDeliveryClock(); expect(clock).not.toBeNull();
    expect(() => clock!.tickMs()).toThrow(/continuity/);
    vi.restoreAllMocks(); ticks(1n, 3n, 9_007_199_254_740_992n);
    expect(readDeliveryClock()).toBeNull();
  });
  it("returns unknown if the real kernel boot sample fails", () => {
    ticks(1n); state.windows.mockImplementation(() => { throw new Error("Kernel query refused"); });
    expect(readDeliveryClock()).toBeNull();
  });
  it("retains the macOS sysctl identity and monotonic ticks", () => {
    setPlatform("darwin"); ticks(40n, 50n); state.sysctl.mockReturnValue(`${bootId.toUpperCase()}\n`);
    const clock = readDeliveryClock(); expect(clock?.id).toBe(bootId); expect(clock?.tickMs()).toBe(50);
    expect(state.sysctl.mock.calls[0]?.slice(0, 2)).toEqual(["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]]);
    expect(state.windows).not.toHaveBeenCalled();
  });
  it("keeps unsupported platforms unqualified", () => {
    setPlatform("linux"); expect(readDeliveryClock()).toBeNull();
    expect(state.windows).not.toHaveBeenCalled(); expect(state.sysctl).not.toHaveBeenCalled();
  });
});
