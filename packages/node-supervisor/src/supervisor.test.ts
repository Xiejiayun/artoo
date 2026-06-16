import { describe, expect, it } from "vitest";

import { createNodeSupervisor, type ChildHandle, type Spawner } from "./supervisor.js";

const NOW = "2026-06-16T00:01:00.000Z";
const FRESH = "2026-06-16T00:00:55.000Z"; // 5s ago (< 30s stale window)
const STALE = "2026-06-16T00:00:00.000Z"; // 60s ago (> 30s)
const ENV = { ARTOO_NODE_URL: "ws://h/api/v1/node?token=x", ARTOO_NODE_ID: "c1", ARTOO_ALLOWED_ROOTS: "/ws" };

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

class FakeChild implements ChildHandle {
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = [];
  private resolveExit!: (info: { code: number | null; signal: string | null }) => void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  constructor() {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }
  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push(signal);
  }
  exit(code = 0): void {
    this.resolveExit({ code, signal: null });
  }
}

class FakeSpawner implements Spawner {
  readonly children: FakeChild[] = [];
  spawn(): FakeChild {
    const child = new FakeChild();
    this.children.push(child);
    return child;
  }
  last(): FakeChild {
    const c = this.children.at(-1);
    if (!c) throw new Error("no child spawned");
    return c;
  }
}

function makeScheduler() {
  const pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => pending.push(fn),
    runAll: () => {
      for (const fn of pending.splice(0)) fn();
    },
    get size() {
      return pending.length;
    }
  };
}

function setup(opts: { health: { iso: string | null } }) {
  const spawner = new FakeSpawner();
  const sched = makeScheduler();
  const supervisor = createNodeSupervisor({
    spawner,
    health: { lastHeartbeatIso: () => opts.health.iso },
    nowIso: () => NOW,
    schedule: sched.schedule
  });
  return { spawner, sched, supervisor };
}

describe("createNodeSupervisor", () => {
  it("starts (spawns + starting) and reaches running on the first healthy heartbeat", () => {
    const health = { iso: null as string | null };
    const { spawner, supervisor } = setup({ health });
    supervisor.start(ENV);
    expect(supervisor.state()).toBe("starting");
    expect(spawner.children).toHaveLength(1);

    supervisor.tick(); // no heartbeat yet -> stays starting
    expect(supervisor.state()).toBe("starting");

    health.iso = FRESH;
    supervisor.tick();
    expect(supervisor.state()).toBe("running");
  });

  it("goes unhealthy on a stale heartbeat and recovers on a fresh one", () => {
    const health = { iso: FRESH };
    const { supervisor } = setup({ health });
    supervisor.start(ENV);
    supervisor.tick();
    expect(supervisor.state()).toBe("running");

    health.iso = STALE;
    supervisor.tick();
    expect(supervisor.state()).toBe("unhealthy");

    health.iso = FRESH;
    supervisor.tick();
    expect(supervisor.state()).toBe("running");
  });

  it("stops gracefully with SIGTERM, reaching stopped on exit (no restart)", async () => {
    const health = { iso: FRESH };
    const { spawner, supervisor } = setup({ health });
    supervisor.start(ENV);
    supervisor.tick();

    supervisor.stop();
    expect(supervisor.state()).toBe("stopping");
    expect(spawner.last().signals).toContain("SIGTERM");

    spawner.last().exit(0);
    await flush();
    expect(supervisor.state()).toBe("stopped");
    expect(supervisor.restartCount()).toBe(0);
  });

  it("escalates to SIGKILL after the grace window if still stopping", () => {
    const health = { iso: FRESH };
    const { spawner, sched, supervisor } = setup({ health });
    supervisor.start(ENV);
    supervisor.tick();
    supervisor.stop();
    sched.runAll(); // fire the SIGKILL grace timer
    expect(spawner.last().signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("auto-restarts after an unexpected crash and respawns when the backoff fires", async () => {
    const health = { iso: FRESH };
    const { spawner, sched, supervisor } = setup({ health });
    supervisor.start(ENV);
    supervisor.tick();

    spawner.last().exit(1); // crash: not stop-requested
    await flush();
    expect(supervisor.state()).toBe("stopped");
    expect(supervisor.restartCount()).toBe(1);
    expect(sched.size).toBeGreaterThan(0);

    sched.runAll(); // backoff fires -> respawn
    expect(supervisor.state()).toBe("starting");
    expect(spawner.children).toHaveLength(2);
  });

  it("stops auto-restarting once the restart cap is reached", async () => {
    const health = { iso: FRESH };
    const spawner = new FakeSpawner();
    const sched = makeScheduler();
    const supervisor = createNodeSupervisor({
      spawner,
      health: { lastHeartbeatIso: () => health.iso },
      nowIso: () => NOW,
      schedule: sched.schedule,
      restartPolicy: { maxRestarts: 2, baseDelayMs: 1, maxDelayMs: 1 }
    });
    supervisor.start(ENV);
    supervisor.tick();

    // Crash repeatedly without ever recovering.
    for (let i = 0; i < 4; i++) {
      spawner.last().exit(1);
      await flush();
      sched.runAll();
    }
    expect(supervisor.restartCount()).toBe(2); // capped
    expect(supervisor.state()).toBe("stopped"); // gave up
  });

  it("a recovery (healthy heartbeat) resets the restart budget", async () => {
    const health = { iso: FRESH };
    const { spawner, sched, supervisor } = setup({ health });
    supervisor.start(ENV);
    supervisor.tick();

    spawner.last().exit(1); // crash
    await flush();
    sched.runAll(); // respawn (starting), restartCount=1
    expect(supervisor.restartCount()).toBe(1);

    supervisor.tick(); // healthy -> running, resets budget
    expect(supervisor.state()).toBe("running");
    expect(supervisor.restartCount()).toBe(0);
  });

  it("notifies state-change listeners", () => {
    const health = { iso: FRESH };
    const { supervisor } = setup({ health });
    const seen: string[] = [];
    supervisor.onStateChange((s) => seen.push(s));
    supervisor.start(ENV);
    supervisor.tick();
    expect(seen).toEqual(["starting", "running"]);
  });
});
