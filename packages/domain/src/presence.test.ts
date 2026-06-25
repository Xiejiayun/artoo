import { describe, expect, it } from "vitest";

import type { PresenceWindows } from "./device.js";
import {
  ageMs,
  deriveConnection,
  deriveHealthReason,
  deriveRuntime,
  deriveWork,
  isActiveRunStatus,
  isSchedulable,
  synthesizeAgentInstancePresence,
  synthesizeComputerPresence,
  type ActiveRunFact,
  type AgentInstancePresenceFacts,
} from "./presence.js";

const NOW = "2026-06-16T00:02:00.000Z";
const WINDOWS: PresenceWindows = { onlineWithinMs: 30_000, staleWithinMs: 120_000 };
// helper: ISO `secondsAgo` before NOW
function ago(seconds: number): string {
  return new Date(Date.parse(NOW) - seconds * 1000).toISOString();
}

function facts(over: Partial<AgentInstancePresenceFacts> = {}): AgentInstancePresenceFacts {
  return {
    agentInstanceId: "inst_1",
    agentId: "agent_1",
    computerId: "computer_1",
    hasLiveConnection: true,
    deviceTrust: "active",
    lastSeenAt: ago(5),
    runtimeStatus: "available",
    concurrencyLimit: 1,
    activeRuns: [],
    ...over,
  };
}

describe("ageMs", () => {
  it("computes positive age, null on missing/unparseable", () => {
    expect(ageMs(ago(5), NOW)).toBe(5000);
    expect(ageMs(null, NOW)).toBeNull();
    expect(ageMs("not-a-date", NOW)).toBeNull();
  });
});

describe("deriveConnection", () => {
  it("revoked trust wins over everything", () => {
    expect(deriveConnection({ hasLiveConnection: true, deviceTrust: "revoked", lastSeenAt: ago(1) }, NOW, WINDOWS)).toBe(
      "revoked",
    );
  });
  it("no live socket => offline", () => {
    expect(deriveConnection({ hasLiveConnection: false, deviceTrust: "active", lastSeenAt: ago(1) }, NOW, WINDOWS)).toBe(
      "offline",
    );
  });
  it("freshness windows at boundaries (inclusive)", () => {
    const c = (s: number) => deriveConnection({ hasLiveConnection: true, deviceTrust: "active", lastSeenAt: ago(s) }, NOW, WINDOWS);
    expect(c(30)).toBe("online"); // exactly online window
    expect(c(31)).toBe("stale");
    expect(c(120)).toBe("stale"); // exactly stale window
    expect(c(121)).toBe("offline");
  });
});

describe("deriveRuntime", () => {
  const r = (over: Partial<AgentInstancePresenceFacts>) => deriveRuntime(facts(over), NOW, WINDOWS);
  it("missing row or status => missing", () => {
    expect(r({ runtimeStatus: null })).toBe("missing");
    expect(r({ runtimeStatus: "missing" })).toBe("missing");
  });
  it("disabled => disabled", () => {
    expect(r({ runtimeStatus: "disabled" })).toBe("disabled");
  });
  it("at capacity => busy (over stale/available)", () => {
    expect(r({ concurrencyLimit: 1, activeRuns: [{ runStatus: "running", taskStatus: "running" }] })).toBe("busy");
  });
  it("stale last_seen => stale", () => {
    expect(r({ lastSeenAt: ago(200) })).toBe("stale");
  });
  it("fresh + available + spare capacity => available", () => {
    expect(r({})).toBe("available");
  });
});

describe("deriveWork", () => {
  const w = (runs: ActiveRunFact[]) => deriveWork(runs);
  it("no active runs => idle", () => {
    expect(w([])).toBe("idle");
  });
  it("awaiting_approval task dominates", () => {
    expect(w([{ runStatus: "running", taskStatus: "awaiting_approval" }])).toBe("awaiting_approval");
  });
  it("blocked task over running", () => {
    expect(
      w([
        { runStatus: "running", taskStatus: "running" },
        { runStatus: "running", taskStatus: "blocked" },
      ]),
    ).toBe("blocked");
  });
  it("awaiting_input / paused / running / queued", () => {
    expect(w([{ runStatus: "awaiting_input", taskStatus: "running" }])).toBe("awaiting_input");
    expect(w([{ runStatus: "paused", taskStatus: "running" }])).toBe("paused");
    expect(w([{ runStatus: "running", taskStatus: "running" }])).toBe("running");
    expect(w([{ runStatus: "queued", taskStatus: "assigned" }])).toBe("queued");
    expect(w([{ runStatus: "starting", taskStatus: "assigned" }])).toBe("queued");
  });
});

describe("deriveHealthReason — priority", () => {
  it("device_revoked > runtime_missing > heartbeat_timeout > daemon_restarting > approval_required > lease_conflict", () => {
    expect(deriveHealthReason({ connection: "revoked", work: "idle", runtime: "missing" })).toBe("device_revoked");
    expect(deriveHealthReason({ connection: "online", work: "idle", runtime: "missing" })).toBe("runtime_missing");
    expect(deriveHealthReason({ connection: "stale", work: "idle", runtime: "available" })).toBe("heartbeat_timeout");
    expect(deriveHealthReason({ connection: "online", work: "idle", runtime: "available", daemonRestarting: true })).toBe(
      "daemon_restarting",
    );
    expect(deriveHealthReason({ connection: "online", work: "awaiting_approval", runtime: "available" })).toBe(
      "approval_required",
    );
    expect(deriveHealthReason({ connection: "online", work: "running", runtime: "available", leaseConflict: true })).toBe(
      "lease_conflict",
    );
    expect(deriveHealthReason({ connection: "online", work: "running", runtime: "available" })).toBeNull();
  });
});

describe("isSchedulable — shared eligibility (single source of truth)", () => {
  it("eligible when online + fresh available runtime + spare capacity", () => {
    expect(isSchedulable(facts(), NOW, WINDOWS)).toBe(true);
  });
  it("excludes revoked / offline / stale connection", () => {
    expect(isSchedulable(facts({ deviceTrust: "revoked" }), NOW, WINDOWS)).toBe(false);
    expect(isSchedulable(facts({ hasLiveConnection: false }), NOW, WINDOWS)).toBe(false);
    expect(isSchedulable(facts({ lastSeenAt: ago(200) }), NOW, WINDOWS)).toBe(false);
  });
  it("excludes missing / disabled runtime", () => {
    expect(isSchedulable(facts({ runtimeStatus: null }), NOW, WINDOWS)).toBe(false);
    expect(isSchedulable(facts({ runtimeStatus: "disabled" }), NOW, WINDOWS)).toBe(false);
  });
  it("excludes busy-at-capacity", () => {
    expect(
      isSchedulable(facts({ concurrencyLimit: 1, activeRuns: [{ runStatus: "running", taskStatus: "running" }] }), NOW, WINDOWS),
    ).toBe(false);
    // spare capacity (limit 2, 1 active) is still eligible
    expect(
      isSchedulable(facts({ concurrencyLimit: 2, activeRuns: [{ runStatus: "running", taskStatus: "running" }] }), NOW, WINDOWS),
    ).toBe(true);
  });
});

describe("isActiveRunStatus", () => {
  it("non-terminal runs are active", () => {
    expect(isActiveRunStatus("running")).toBe(true);
    expect(isActiveRunStatus("queued")).toBe(true);
    expect(isActiveRunStatus("completed")).toBe(false);
    expect(isActiveRunStatus("failed")).toBe(false);
    expect(isActiveRunStatus("cancelled")).toBe(false);
  });
});

describe("synthesizeAgentInstancePresence", () => {
  it("combines all dimensions + capacity + source/age, never secrets", () => {
    const p = synthesizeAgentInstancePresence(
      facts({ concurrencyLimit: 2, activeRuns: [{ runStatus: "running", taskStatus: "running" }] }),
      NOW,
      WINDOWS,
    );
    expect(p.connection).toBe("online");
    expect(p.work).toBe("running");
    expect(p.runtime).toBe("available"); // 1 active < limit 2
    expect(p.active_runs).toBe(1);
    expect(p.concurrency_limit).toBe(2);
    expect(p.age_ms).toBe(5000);
    expect(p.as_of).toBe(NOW);
    expect(p.health_reason).toBeNull();
    expect(p.source.work).toBe("runs+tasks");
    expect(JSON.stringify(p)).not.toMatch(/token|secret|hash/i);
  });
  it("revoked surfaces device_revoked health reason", () => {
    const p = synthesizeAgentInstancePresence(facts({ deviceTrust: "revoked" }), NOW, WINDOWS);
    expect(p.connection).toBe("revoked");
    expect(p.health_reason).toBe("device_revoked");
  });
});

describe("synthesizeComputerPresence", () => {
  it("rolls up connection, runtimes, capacity, queue depth", () => {
    const p = synthesizeComputerPresence(
      {
        computerId: "computer_1",
        hasLiveConnection: true,
        deviceTrust: "active",
        lastHeartbeatAt: ago(5),
        runtimes: [
          { runtime: "mock", status: "available", lastSeenAt: ago(5) },
          { runtime: "codex", status: "available", lastSeenAt: ago(200) }, // stale
        ],
        activeRuns: 2,
        queueDepth: 1,
      },
      NOW,
      WINDOWS,
    );
    expect(p.connection).toBe("online");
    expect(p.runtimes.find((r) => r.runtime === "mock")?.status).toBe("available");
    expect(p.runtimes.find((r) => r.runtime === "codex")?.status).toBe("stale");
    expect(p.active_runs).toBe(2);
    expect(p.queue_depth).toBe(1);
    expect(p.age_ms).toBe(5000);
  });
});
