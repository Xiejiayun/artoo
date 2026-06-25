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
import { agentInstances, agentRuntimes, computers, devices, runs, tasks } from "@artoo/db";
import {
  derivePresenceState,
  isActiveRunStatus,
  synthesizeAgentInstancePresence,
  synthesizeComputerPresence,
  type AgentInstancePresence,
  type AgentInstancePresenceFacts,
  type ComputerPresence,
  type ComputerPresenceFacts,
  type DevicePresence,
  type DevicePresenceState,
  type PresenceWindows,
} from "@artoo/domain";
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

// ---------------------------------------------------------------------------
// Agent-instance + computer presence (#113). Server-synthesized at read time
// from runs/tasks/agent_runtimes/computers/devices + live-connection info passed
// from the app layer. The domain `synthesize*` helpers (and the shared
// `isSchedulable` eligibility used by the scheduler) hold the logic — this layer
// only gathers facts. NEVER selects or returns a token/secret.
// ---------------------------------------------------------------------------

const ISO = (v: string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** Live-connection predicate the app layer supplies (e.g. nodeRegistry.get(id) !== undefined). */
export type LiveConnection = (computerId: string) => boolean;

async function activeRunsForInstance(
  ctx: ServerContext,
  agentInstanceId: string,
): Promise<Array<{ runStatus: string; taskStatus: string }>> {
  const rows = await ctx.db.db
    .select({ runStatus: runs.status, taskStatus: tasks.status })
    .from(runs)
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.agentInstanceId, agentInstanceId)));
  return rows.filter((r) => isActiveRunStatus(r.runStatus));
}

async function instanceFacts(
  ctx: ServerContext,
  inst: { id: string; agentId: string; computerId: string; runtime: string; config: Record<string, unknown> | null },
  isLive: LiveConnection,
): Promise<AgentInstancePresenceFacts> {
  const runtimeRow = (
    await ctx.db.db
      .select()
      .from(agentRuntimes)
      .where(and(eq(agentRuntimes.computerId, inst.computerId), eq(agentRuntimes.runtime, inst.runtime)))
  )[0];
  const computer = (await ctx.db.db.select().from(computers).where(eq(computers.id, inst.computerId)))[0];
  const device = (await ctx.db.db.select().from(devices).where(eq(devices.computerId, inst.computerId)))[0];
  const active = await activeRunsForInstance(ctx, inst.id);
  const limitRaw = (inst.config ?? {})["concurrency_limit"];
  const concurrencyLimit = typeof limitRaw === "number" && limitRaw > 0 ? limitRaw : 1;
  return {
    agentInstanceId: inst.id,
    agentId: inst.agentId,
    computerId: inst.computerId,
    hasLiveConnection: isLive(inst.computerId),
    deviceTrust: (device?.trust as "active" | "revoked" | undefined) ?? null,
    lastSeenAt: ISO(runtimeRow?.lastSeenAt ?? computer?.lastHeartbeatAt ?? null),
    runtimeStatus: (runtimeRow?.status as AgentInstancePresenceFacts["runtimeStatus"]) ?? null,
    concurrencyLimit,
    activeRuns: active.map((r) => ({
      runStatus: r.runStatus as AgentInstancePresenceFacts["activeRuns"][number]["runStatus"],
      taskStatus: r.taskStatus as AgentInstancePresenceFacts["activeRuns"][number]["taskStatus"],
    })),
  };
}

export async function agentInstancePresence(
  ctx: ServerContext,
  instanceId: string,
  isLive: LiveConnection,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<AgentInstancePresence | null> {
  const inst = (
    await ctx.db.db
      .select()
      .from(agentInstances)
      .where(and(eq(agentInstances.id, instanceId), eq(agentInstances.organizationId, ctx.organizationId)))
  )[0];
  if (inst === undefined) return null;
  const facts = await instanceFacts(
    ctx,
    { id: inst.id, agentId: inst.agentId, computerId: inst.computerId, runtime: inst.runtime, config: inst.config as Record<string, unknown> | null },
    isLive,
  );
  return synthesizeAgentInstancePresence(facts, ctx.clock.nowIso(), config.windows);
}

export async function listAgentInstancePresence(
  ctx: ServerContext,
  isLive: LiveConnection,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<AgentInstancePresence[]> {
  const insts = await ctx.db.db
    .select()
    .from(agentInstances)
    .where(eq(agentInstances.organizationId, ctx.organizationId));
  const out: AgentInstancePresence[] = [];
  for (const inst of insts) {
    const facts = await instanceFacts(
      ctx,
      { id: inst.id, agentId: inst.agentId, computerId: inst.computerId, runtime: inst.runtime, config: inst.config as Record<string, unknown> | null },
      isLive,
    );
    out.push(synthesizeAgentInstancePresence(facts, ctx.clock.nowIso(), config.windows));
  }
  return out;
}

async function computerFacts(
  ctx: ServerContext,
  computer: { id: string; lastHeartbeatAt: string | null },
  isLive: LiveConnection,
): Promise<ComputerPresenceFacts> {
  const device = (await ctx.db.db.select().from(devices).where(eq(devices.computerId, computer.id)))[0];
  const rtRows = await ctx.db.db.select().from(agentRuntimes).where(eq(agentRuntimes.computerId, computer.id));
  const runRows = await ctx.db.db
    .select({ status: runs.status })
    .from(runs)
    .where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computer.id)));
  const active = runRows.filter((r) => isActiveRunStatus(r.status));
  const queueDepth = runRows.filter((r) => r.status === "queued" || r.status === "starting").length;
  return {
    computerId: computer.id,
    hasLiveConnection: isLive(computer.id),
    deviceTrust: (device?.trust as "active" | "revoked" | undefined) ?? null,
    lastHeartbeatAt: ISO(computer.lastHeartbeatAt),
    runtimes: rtRows.map((r) => ({
      runtime: r.runtime,
      status: r.status as ComputerPresenceFacts["runtimes"][number]["status"],
      lastSeenAt: ISO(r.lastSeenAt),
    })),
    activeRuns: active.length,
    queueDepth,
  };
}

export async function computerPresence(
  ctx: ServerContext,
  computerId: string,
  isLive: LiveConnection,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<ComputerPresence | null> {
  const computer = (
    await ctx.db.db
      .select()
      .from(computers)
      .where(and(eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId)))
  )[0];
  if (computer === undefined) return null;
  const facts = await computerFacts(ctx, { id: computer.id, lastHeartbeatAt: computer.lastHeartbeatAt }, isLive);
  return synthesizeComputerPresence(facts, ctx.clock.nowIso(), config.windows);
}

export async function listComputerPresence(
  ctx: ServerContext,
  isLive: LiveConnection,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Promise<ComputerPresence[]> {
  const rows = await ctx.db.db.select().from(computers).where(eq(computers.organizationId, ctx.organizationId));
  const out: ComputerPresence[] = [];
  for (const computer of rows) {
    const facts = await computerFacts(ctx, { id: computer.id, lastHeartbeatAt: computer.lastHeartbeatAt }, isLive);
    out.push(synthesizeComputerPresence(facts, ctx.clock.nowIso(), config.windows));
  }
  return out;
}
