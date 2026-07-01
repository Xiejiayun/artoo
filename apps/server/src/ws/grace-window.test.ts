import { describe, expect, it } from "vitest";

import { createGraceWindowManager, type GraceScheduler } from "./grace-window.js";

/** A controllable scheduler: capture pending timers and fire them on demand. */
function fakeScheduler(): GraceScheduler & { fireAll: () => void; pendingCount: () => number } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    schedule(fn) {
      const handle = next++;
      timers.set(handle, fn);
      return handle;
    },
    cancel(handle) {
      timers.delete(handle as number);
    },
    fireAll() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
    pendingCount: () => timers.size,
  };
}

describe("grace window manager (#115 P2-S3)", () => {
  it("arms a window and fires onExpire with the disconnect snapshot", () => {
    const scheduler = fakeScheduler();
    const expired: Array<{ computerId: string; runIds: string[] }> = [];
    const gw = createGraceWindowManager({
      graceMs: 30_000,
      scheduler,
      onExpire: (computerId, runIds) => { expired.push({ computerId, runIds }); },
    });

    gw.arm("comp_a", ["run_1", "run_2"]);
    expect(gw.isArmed("comp_a")).toBe(true);
    scheduler.fireAll();
    expect(expired).toEqual([{ computerId: "comp_a", runIds: ["run_1", "run_2"] }]);
    expect(gw.isArmed("comp_a")).toBe(false); // cleared after firing
  });

  it("disarm cancels the window and returns the snapshot (no expiry)", () => {
    const scheduler = fakeScheduler();
    let fired = false;
    const gw = createGraceWindowManager({ graceMs: 1, scheduler, onExpire: () => { fired = true; } });

    gw.arm("comp_a", ["run_1"]);
    const snapshot = gw.disarm("comp_a");
    expect(snapshot).toEqual(["run_1"]);
    expect(gw.isArmed("comp_a")).toBe(false);
    scheduler.fireAll();
    expect(fired).toBe(false); // cancelled → never fires
  });

  it("empty snapshot arms nothing", () => {
    const scheduler = fakeScheduler();
    const gw = createGraceWindowManager({ graceMs: 1, scheduler, onExpire: () => {} });
    gw.arm("comp_a", []);
    expect(gw.isArmed("comp_a")).toBe(false);
    expect(scheduler.pendingCount()).toBe(0);
    expect(gw.disarm("comp_a")).toEqual([]);
  });

  it("re-arming replaces the prior window (latest disconnect wins, one timer)", () => {
    const scheduler = fakeScheduler();
    const expired: string[][] = [];
    const gw = createGraceWindowManager({ graceMs: 1, scheduler, onExpire: (_c, r) => { expired.push(r); } });
    gw.arm("comp_a", ["run_old"]);
    gw.arm("comp_a", ["run_new"]);
    expect(scheduler.pendingCount()).toBe(1); // old timer cancelled
    scheduler.fireAll();
    expect(expired).toEqual([["run_new"]]);
  });

  it("windows are isolated per computer", () => {
    const scheduler = fakeScheduler();
    const expired: string[] = [];
    const gw = createGraceWindowManager({ graceMs: 1, scheduler, onExpire: (c) => { expired.push(c); } });
    gw.arm("comp_a", ["r1"]);
    gw.arm("comp_b", ["r2"]);
    gw.disarm("comp_a");
    scheduler.fireAll();
    expect(expired).toEqual(["comp_b"]); // only the un-disarmed computer fails
  });
});
