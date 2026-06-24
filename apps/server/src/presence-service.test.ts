import { devices, eventLog } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";
import type { ServerContext } from "./context.js";
import {
  devicePresence,
  markDeviceOffline,
  recordDeviceActivity,
  type PresenceConfig,
} from "./services/presence-service.js";

const T0 = "2026-06-13T00:00:00.000Z";
const CONFIG: PresenceConfig = {
  windows: { onlineWithinMs: 90_000, staleWithinMs: 300_000 },
  throttleMs: 15_000,
};

/** Presence events recorded for a device, oldest first. */
async function presenceEvents(server: TestServer, deviceId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await server.db.db
    .select()
    .from(eventLog)
    .where(and(eq(eventLog.type, "device.presence_changed"), eq(eventLog.correlationId, deviceId)));
  return rows.map((r) => r.payload as Record<string, unknown>);
}

async function lastSeen(server: TestServer, deviceId: string): Promise<string | null> {
  const raw = (await server.db.db.select().from(devices).where(eq(devices.id, deviceId)))[0]!.lastSeenAt;
  // The DB may render timestamps in a non-ISO form; compare by instant.
  return raw === null ? null : new Date(raw).toISOString();
}

describe("device presence service (#28 4c)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** A ctx pinned to a specific wall-clock time (presence is time-derived). */
  function at(iso: string): ServerContext {
    return { ...server.ctx, clock: fixedClock(iso) };
  }

  async function insertDevice(
    id: string,
    opts: { lastSeenAt?: string | null; trust?: "active" | "revoked" } = {},
  ): Promise<void> {
    await server.db.db.insert(devices).values({
      id,
      organizationId: "org_default",
      displayName: id,
      platform: "windows",
      appVersion: "2.0.0",
      computerId: null,
      enrolledByUserId: "user_owner",
      trust: opts.trust ?? "active",
      lastSeenAt: opts.lastSeenAt ?? null,
      createdAt: T0,
      revokedAt: opts.trust === "revoked" ? T0 : null,
    });
  }

  it("first activity transitions offline -> online, sets last_seen, emits one event with the source", async () => {
    await insertDevice("device_a", { lastSeenAt: null });
    const r = await recordDeviceActivity(at(T0), "device_a", "node", CONFIG);
    expect(r).toMatchObject({ transitioned: true, from: "offline", to: "online" });
    expect(await lastSeen(server, "device_a")).toBe(T0);
    const events = await presenceEvents(server, "device_a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ device_id: "device_a", from: "offline", to: "online", source: "node" });
  });

  it("coalesces a refresh while online within the throttle window (no write, no event)", async () => {
    await insertDevice("device_b", { lastSeenAt: T0 });
    // 10s later: online and within the 15s throttle -> no-op.
    const r = await recordDeviceActivity(at("2026-06-13T00:00:10.000Z"), "device_b", "node", CONFIG);
    expect(r.transitioned).toBe(false);
    expect(await lastSeen(server, "device_b")).toBe(T0); // unchanged
    expect(await presenceEvents(server, "device_b")).toHaveLength(0);
  });

  it("refreshes last_seen past the throttle window but emits no event while still online", async () => {
    await insertDevice("device_c", { lastSeenAt: T0 });
    // 30s later: still online (< 90s) but past the 15s throttle -> write, no event.
    const t = "2026-06-13T00:00:30.000Z";
    const r = await recordDeviceActivity(at(t), "device_c", "control", CONFIG);
    expect(r.transitioned).toBe(false);
    expect(await lastSeen(server, "device_c")).toBe(t); // refreshed
    expect(await presenceEvents(server, "device_c")).toHaveLength(0);
  });

  it("transitions stale -> online and emits an event", async () => {
    await insertDevice("device_d", { lastSeenAt: T0 });
    // 120s later: stale (>90s, <300s). Activity brings it back online.
    const t = "2026-06-13T00:02:00.000Z";
    const r = await recordDeviceActivity(at(t), "device_d", "control", CONFIG);
    expect(r).toMatchObject({ transitioned: true, from: "stale", to: "online" });
    const events = await presenceEvents(server, "device_d");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from: "stale", to: "online", source: "control" });
  });

  it("markDeviceOffline emits online -> offline, and is a no-op when already offline", async () => {
    await insertDevice("device_e", { lastSeenAt: T0 });
    // Online (recent last_seen) -> offline emits one transition event.
    const r1 = await markDeviceOffline(at("2026-06-13T00:00:05.000Z"), "device_e", "revoked", CONFIG);
    expect(r1).toMatchObject({ transitioned: true, from: "online", to: "offline" });
    const events = await presenceEvents(server, "device_e");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ to: "offline", reason: "revoked" });

    // A device that already derives offline (stale last_seen well past the window)
    // produces no event — the offline transition is not re-emitted.
    await insertDevice("device_e2", { lastSeenAt: T0 });
    const r2 = await markDeviceOffline(at("2026-06-13T01:00:00.000Z"), "device_e2", "disconnect", CONFIG);
    expect(r2.transitioned).toBe(false);
    expect(await presenceEvents(server, "device_e2")).toHaveLength(0);
  });

  it("ignores a revoked device's activity (no write, no event)", async () => {
    await insertDevice("device_f", { lastSeenAt: null, trust: "revoked" });
    const r = await recordDeviceActivity(at(T0), "device_f", "node", CONFIG);
    expect(r.transitioned).toBe(false);
    expect(await lastSeen(server, "device_f")).toBeNull();
    expect(await presenceEvents(server, "device_f")).toHaveLength(0);
  });

  it("read presence reflects definitive offline edges (revoked / no live socket)", async () => {
    await insertDevice("device_g", { lastSeenAt: T0 });
    await insertDevice("device_h", { lastSeenAt: null });
    await insertDevice("device_r", { lastSeenAt: T0, trust: "revoked" });
    const ctx = at("2026-06-13T00:00:30.000Z");
    // Fresh last_seen + a live socket -> online.
    expect((await devicePresence(ctx, "device_g", { hasLiveConnection: true }, CONFIG)).state).toBe("online");
    // Fresh last_seen but NO live socket -> offline (matches the close edge event).
    expect((await devicePresence(ctx, "device_g", { hasLiveConnection: false }, CONFIG)).state).toBe("offline");
    // Never seen -> offline.
    expect((await devicePresence(at(T0), "device_h", { hasLiveConnection: false }, CONFIG)).state).toBe("offline");
    // Revoked reads offline even with a fresh last_seen and a (stale) live flag.
    expect((await devicePresence(ctx, "device_r", { hasLiveConnection: true }, CONFIG)).state).toBe("offline");
  });

  it("never puts raw secrets in presence event payloads (metadata only)", async () => {
    await insertDevice("device_i", { lastSeenAt: null });
    await recordDeviceActivity(at(T0), "device_i", "node", CONFIG);
    const events = await presenceEvents(server, "device_i");
    const keys = Object.keys(events[0]!);
    expect(keys.sort()).toEqual(["device_id", "from", "source", "to"]);
  });
});
