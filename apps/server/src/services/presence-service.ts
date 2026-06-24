/**
 * Device presence service (#28 v2-C slice 4c). Turns authenticated device
 * activity into a `devices.last_seen_at` heartbeat and transition-aware
 * `device.presence_changed` events, using the domain presence model
 * ({@link derivePresenceState}) rather than a parallel one.
 *
 * Design constraints (codex-ratified):
 *  - throttle/coalesce: a refresh while already `online` within the throttle
 *    window does NOT rewrite last_seen or fan out a repeated event;
 *  - transition-aware events: emit only on offline/stale -> online and on
 *    online/stale -> offline (disconnect of the last socket, or revoke);
 *  - metadata only: event payloads carry device_id / from / to / source — never a
 *    raw pairing code or device token;
 *  - identity is explicit: activity is recorded only for an authenticated DEVICE
 *    token (node or control), never the dev escape.
 */
import { devices } from "@artoo/db";
import { derivePresenceState, type DevicePresence, type DevicePresenceState, type PresenceWindows } from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { buildEvent } from "../events.js";
import { appendEvent } from "@artoo/db";

/** Which authenticated device credential drove an activity update. */
export type PresenceSource = "node" | "control";

export interface PresenceConfig {
  windows: PresenceWindows;
  /** Minimum interval between last_seen writes from refresh activity (coalesce). */
  throttleMs: number;
}

/** Default presence windows + throttle. Heartbeats are ~30s, so a 15s throttle
 *  coalesces the common case to at most one write per heartbeat. */
export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  windows: { onlineWithinMs: 90_000, staleWithinMs: 300_000 },
  throttleMs: 15_000,
};

export interface PresenceTransition {
  transitioned: boolean;
  from: DevicePresenceState;
  to: DevicePresenceState;
}

const PRESENCE_EVENT = "device.presence_changed";

/** Emit a metadata-only presence-transition event (no task/room/run scope). */
async function emitPresenceEvent(
  ctx: ServerContext,
  deviceId: string,
  from: DevicePresenceState,
  to: DevicePresenceState,
  detail: { source?: PresenceSource; reason?: string },
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await appendEvent(
      tx,
      buildEvent(ctx, {
        type: PRESENCE_EVENT,
        actorType: "system",
        actorId: "system",
        correlationId: deviceId,
        payload: { device_id: deviceId, from, to, ...detail },
      }),
    );
  });
}

/**
 * Record authenticated device activity (an accepted node/control connection or a
 * node heartbeat). Throttled: while already online within `throttleMs` it is a
 * no-op. Otherwise it refreshes `last_seen_at` and, when the device was not
 * already online, emits an offline/stale -> online transition event. A missing or
 * revoked device is ignored (returns transitioned:false).
 */
export async function recordDeviceActivity(
  ctx: ServerContext,
  deviceId: string,
  source: PresenceSource,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<PresenceTransition> {
  const nowIso = ctx.clock.nowIso();
  const device = (
    await ctx.db.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)))
  )[0];
  if (device === undefined || device.trust !== "active") {
    return { transitioned: false, from: "offline", to: "offline" };
  }
  const from = derivePresenceState(device.lastSeenAt, nowIso, config.windows);
  // Coalesce: still online and within the throttle window -> skip the write and
  // the event entirely (a heartbeat storm must not become a write/event storm).
  if (from === "online" && device.lastSeenAt !== null) {
    const age = Date.parse(nowIso) - Date.parse(device.lastSeenAt);
    if (Number.isFinite(age) && age < config.throttleMs) {
      return { transitioned: false, from, to: from };
    }
  }
  await ctx.db.db
    .update(devices)
    .set({ lastSeenAt: nowIso })
    .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)));
  if (from !== "online") {
    await emitPresenceEvent(ctx, deviceId, from, "online", { source });
    return { transitioned: true, from, to: "online" };
  }
  return { transitioned: false, from: "online", to: "online" };
}

/**
 * Mark a device offline on a definitive transition — its last live socket closed
 * or it was revoked. Transition-aware: emits only when the device was not already
 * offline. Does NOT rewrite last_seen_at (that records real activity); the offline
 * state is the explicit signal that the connection ended.
 */
export async function markDeviceOffline(
  ctx: ServerContext,
  deviceId: string,
  reason: "disconnect" | "revoked",
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<PresenceTransition> {
  const nowIso = ctx.clock.nowIso();
  const device = (
    await ctx.db.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)))
  )[0];
  if (device === undefined) {
    return { transitioned: false, from: "offline", to: "offline" };
  }
  const from = derivePresenceState(device.lastSeenAt, nowIso, config.windows);
  if (from === "offline") {
    return { transitioned: false, from, to: "offline" };
  }
  await emitPresenceEvent(ctx, deviceId, from, "offline", { reason });
  return { transitioned: true, from, to: "offline" };
}

export interface PresenceReadInput {
  /** Whether the device currently holds a live authenticated socket (node or
   *  control). Sourced from the in-process connection registry by the caller. */
  hasLiveConnection: boolean;
}

/**
 * Read a device's current presence so it agrees with the emitted transition
 * events. A revoked device or one with NO live socket reads `offline` — matching
 * the offline event emitted on the last-socket-close / revoke edge — regardless
 * of how fresh `last_seen_at` is. While a live socket exists, the state is the
 * domain derivation from `last_seen_at` (online, or `stale` when connected but
 * not heartbeating recently).
 */
export async function devicePresence(
  ctx: ServerContext,
  deviceId: string,
  input: PresenceReadInput,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<DevicePresence> {
  const device = (
    await ctx.db.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)))
  )[0];
  if (device === undefined) {
    return { device_id: deviceId, state: "offline", last_seen_at: null };
  }
  // Normalize the stored timestamp (the DB may return a non-ISO rendering) to ISO.
  const lastSeenIso = device.lastSeenAt === null ? null : new Date(device.lastSeenAt).toISOString();
  // Definitive offline edges: revoked, or no live socket. These are exactly the
  // conditions under which an offline transition event was emitted.
  if (device.trust !== "active" || !input.hasLiveConnection) {
    return { device_id: deviceId, state: "offline", last_seen_at: lastSeenIso };
  }
  const state = derivePresenceState(device.lastSeenAt, ctx.clock.nowIso(), config.windows);
  return { device_id: deviceId, state, last_seen_at: lastSeenIso };
}
