import { describe, expect, it } from "vitest";

import {
  isCrash,
  isHeartbeatHealthy,
  nextSupervisorState,
  restartDecision,
  type RestartPolicy,
  type SupervisorState
} from "./state-machine.js";

describe("nextSupervisorState", () => {
  it("starts and reaches running via ready", () => {
    expect(nextSupervisorState("stopped", { type: "start" })).toBe("starting");
    expect(nextSupervisorState("starting", { type: "ready" })).toBe("running");
  });

  it("treats a healthy heartbeat as running and a stale one as unhealthy, and recovers", () => {
    expect(nextSupervisorState("running", { type: "heartbeat", healthy: false })).toBe("unhealthy");
    expect(nextSupervisorState("unhealthy", { type: "heartbeat", healthy: true })).toBe("running");
    expect(nextSupervisorState("running", { type: "heartbeat", healthy: true })).toBe("running");
  });

  it("stops gracefully: running/unhealthy -> stopping -> stopped on exit", () => {
    expect(nextSupervisorState("running", { type: "stop" })).toBe("stopping");
    expect(nextSupervisorState("unhealthy", { type: "stop" })).toBe("stopping");
    expect(nextSupervisorState("stopping", { type: "exited", expected: true })).toBe("stopped");
  });

  it("a process exit from running/unhealthy returns to stopped (caller may restart)", () => {
    expect(nextSupervisorState("running", { type: "exited", expected: false })).toBe("stopped");
    expect(nextSupervisorState("unhealthy", { type: "exited", expected: false })).toBe("stopped");
  });

  it("a failed start returns to stopped", () => {
    expect(nextSupervisorState("starting", { type: "startFailed" })).toBe("stopped");
    expect(nextSupervisorState("starting", { type: "exited", expected: false })).toBe("stopped");
  });

  it("is a no-op for out-of-order events (never throws)", () => {
    const states: SupervisorState[] = ["stopped", "starting", "running", "unhealthy", "stopping"];
    for (const s of states) {
      // a `ready` only matters in `starting`; elsewhere it is ignored
      const next = nextSupervisorState(s, { type: "ready" });
      expect(states).toContain(next);
    }
    expect(nextSupervisorState("stopped", { type: "heartbeat", healthy: true })).toBe("stopped");
  });
});

describe("isCrash", () => {
  it("flags unexpected exits from running/unhealthy as crashes", () => {
    expect(isCrash("running", { type: "exited", expected: false })).toBe(true);
    expect(isCrash("unhealthy", { type: "exited", expected: false })).toBe(true);
  });

  it("does not flag expected exits or exits while stopping/stopped", () => {
    expect(isCrash("running", { type: "exited", expected: true })).toBe(false);
    expect(isCrash("stopping", { type: "exited", expected: false })).toBe(false);
    expect(isCrash("stopped", { type: "exited", expected: false })).toBe(false);
    expect(isCrash("running", { type: "stop" })).toBe(false);
  });
});

describe("isHeartbeatHealthy", () => {
  const now = "2026-06-16T00:00:30.000Z";
  it("is healthy within the stale window and at the exact boundary", () => {
    expect(isHeartbeatHealthy("2026-06-16T00:00:20.000Z", now, 10_000)).toBe(true); // 10s, == window
    expect(isHeartbeatHealthy("2026-06-16T00:00:25.000Z", now, 10_000)).toBe(true);
  });
  it("is unhealthy past the stale window", () => {
    expect(isHeartbeatHealthy("2026-06-16T00:00:19.000Z", now, 10_000)).toBe(false); // 11s > 10s
  });
  it("treats null/missing/unparseable timestamps as unhealthy", () => {
    expect(isHeartbeatHealthy(null, now, 10_000)).toBe(false);
    expect(isHeartbeatHealthy(undefined, now, 10_000)).toBe(false);
    expect(isHeartbeatHealthy("not-a-date", now, 10_000)).toBe(false);
  });
});

describe("restartDecision", () => {
  const policy: RestartPolicy = { maxRestarts: 3, baseDelayMs: 1_000, maxDelayMs: 8_000 };
  it("applies capped exponential backoff under the cap", () => {
    expect(restartDecision(0, policy)).toEqual({ restart: true, delayMs: 1_000 });
    expect(restartDecision(1, policy)).toEqual({ restart: true, delayMs: 2_000 });
    expect(restartDecision(2, policy)).toEqual({ restart: true, delayMs: 4_000 });
  });
  it("caps the delay at maxDelayMs", () => {
    expect(restartDecision(2, { maxRestarts: 10, baseDelayMs: 5_000, maxDelayMs: 8_000 })).toEqual({
      restart: true,
      delayMs: 8_000
    });
  });
  it("stops restarting once the attempt cap is reached", () => {
    expect(restartDecision(3, policy)).toEqual({ restart: false, delayMs: 0 });
    expect(restartDecision(4, policy)).toEqual({ restart: false, delayMs: 0 });
  });
});
