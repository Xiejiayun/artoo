import { z } from "zod";

import { DeviceTrustSchema, derivePresenceState, type PresenceWindows } from "./device.js";
import { AgentRuntimeStatusSchema } from "./schemas.js";
import { RunStatusSchema, TaskStatusSchema } from "./state.js";

/**
 * V3 #113 — Agent presence model (PURE domain). Server-synthesized read model,
 * not a stored dot. `now` + windows + already-gathered "facts" are injected; this
 * module performs NO IO, holds NO DB/nodeRegistry handle, and NEVER carries a
 * token/secret. Live presence synthesis uses the helpers below; scheduler uses
 * the DB-fact eligibility helpers because it has no live socket dimension and
 * preserves the missing-runtime compatibility fallback.
 *
 * Work-state is derived-on-read from the instance's non-terminal runs + their
 * tasks — we do NOT trust `agent_instances.status`. See docs/v3-113-presence-design.md.
 */

// --------------------------------------------------------------------------- enums

export const ConnectionStateSchema = z.enum(["online", "stale", "offline", "revoked"]);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const WorkStateSchema = z.enum([
  "idle",
  "queued",
  "running",
  "awaiting_input",
  "awaiting_approval",
  "blocked",
  "paused",
]);
export type WorkState = z.infer<typeof WorkStateSchema>;

export const RuntimePresenceStateSchema = z.enum(["available", "busy", "disabled", "stale", "missing"]);
export type RuntimePresenceState = z.infer<typeof RuntimePresenceStateSchema>;

export const HealthReasonSchema = z.enum([
  "heartbeat_timeout",
  "device_revoked",
  "runtime_missing",
  "approval_required",
  "lease_conflict",
  "daemon_restarting",
]);
export type HealthReason = z.infer<typeof HealthReasonSchema>;

export const PresenceSourceSchema = z.object({
  connection: z.string(),
  work: z.string(),
  runtime: z.string(),
});
export type PresenceSource = z.infer<typeof PresenceSourceSchema>;

// --------------------------------------------------------------------------- read models

export const AgentInstancePresenceSchema = z.object({
  agent_instance_id: z.string(),
  agent_id: z.string(),
  computer_id: z.string(),
  connection: ConnectionStateSchema,
  work: WorkStateSchema,
  runtime: RuntimePresenceStateSchema,
  health_reason: HealthReasonSchema.nullable(),
  concurrency_limit: z.number(),
  active_runs: z.number(),
  last_seen_at: z.string().nullable(),
  age_ms: z.number().nullable(),
  source: PresenceSourceSchema,
  as_of: z.string(),
});
export type AgentInstancePresence = z.infer<typeof AgentInstancePresenceSchema>;

export const ComputerRuntimePresenceSchema = z.object({
  runtime: z.string(),
  status: RuntimePresenceStateSchema,
  last_seen_at: z.string().nullable(),
  age_ms: z.number().nullable(),
});
export type ComputerRuntimePresence = z.infer<typeof ComputerRuntimePresenceSchema>;

export const ComputerPresenceSchema = z.object({
  computer_id: z.string(),
  connection: ConnectionStateSchema,
  health_reason: HealthReasonSchema.nullable(),
  runtimes: z.array(ComputerRuntimePresenceSchema),
  active_runs: z.number(),
  queue_depth: z.number(),
  last_heartbeat_at: z.string().nullable(),
  age_ms: z.number().nullable(),
  as_of: z.string(),
});
export type ComputerPresence = z.infer<typeof ComputerPresenceSchema>;

// --------------------------------------------------------------------------- facts (service-gathered inputs)

/** One non-terminal run owned by an instance + the status of its task. */
export interface ActiveRunFact {
  runStatus: z.infer<typeof RunStatusSchema>;
  taskStatus: z.infer<typeof TaskStatusSchema>;
}

export interface AgentInstancePresenceFacts {
  agentInstanceId: string;
  agentId: string;
  computerId: string;
  /** A live, authenticated node/control socket exists for this computer. */
  hasLiveConnection: boolean;
  /** Trust of the device hosting this computer; null when no device row. */
  deviceTrust: z.infer<typeof DeviceTrustSchema> | null;
  /** Computer/node heartbeat last-seen used for the connection dimension. */
  lastSeenAt: string | null;
  /** Runtime heartbeat last-seen used for the runtime dimension. */
  runtimeLastSeenAt?: string | null;
  /** The instance's runtime row status; null when no runtime row. */
  runtimeStatus: z.infer<typeof AgentRuntimeStatusSchema> | null;
  /** config.concurrency_limit (default 1). */
  concurrencyLimit: number;
  /** Non-terminal runs owned by this instance. */
  activeRuns: ActiveRunFact[];
  /** Optional explicit signals the service may detect. */
  daemonRestarting?: boolean;
  leaseConflict?: boolean;
}

export interface ComputerPresenceFacts {
  computerId: string;
  hasLiveConnection: boolean;
  deviceTrust: z.infer<typeof DeviceTrustSchema> | null;
  lastHeartbeatAt: string | null;
  runtimes: Array<{ runtime: string; status: z.infer<typeof AgentRuntimeStatusSchema>; lastSeenAt: string | null }>;
  /** Non-terminal runs on this computer. */
  activeRuns: number;
  /** queued|starting runs on this computer. */
  queueDepth: number;
  daemonRestarting?: boolean;
}

// --------------------------------------------------------------------------- helpers

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);
/** A run is non-terminal (counts toward active_runs) when not completed/failed/cancelled. */
export function isActiveRunStatus(status: string): boolean {
  return !TERMINAL_RUN.has(status);
}

export function ageMs(lastSeenIso: string | null | undefined, nowIso: string): number | null {
  if (lastSeenIso == null) return null;
  const last = Date.parse(lastSeenIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return null;
  return now - last;
}

/** connection: revoked > offline(no live socket) > freshness-derived online/stale/offline. */
export function deriveConnection(
  facts: { hasLiveConnection: boolean; deviceTrust: string | null; lastSeenAt: string | null },
  nowIso: string,
  windows: PresenceWindows,
): ConnectionState {
  if (facts.deviceTrust === "revoked") return "revoked";
  if (!facts.hasLiveConnection) return "offline";
  return derivePresenceState(facts.lastSeenAt, nowIso, windows);
}

/** runtime: missing(no row) > disabled > busy(at capacity) > stale(beyond window) > available. */
export function deriveRuntime(
  facts: Pick<AgentInstancePresenceFacts, "runtimeStatus" | "lastSeenAt" | "runtimeLastSeenAt" | "concurrencyLimit" | "activeRuns">,
  nowIso: string,
  windows: PresenceWindows,
): RuntimePresenceState {
  if (facts.runtimeStatus == null || facts.runtimeStatus === "missing") return "missing";
  if (facts.runtimeStatus === "disabled") return "disabled";
  if (facts.activeRuns.length >= facts.concurrencyLimit) return "busy";
  if (derivePresenceState(facts.runtimeLastSeenAt ?? facts.lastSeenAt, nowIso, windows) !== "online") return "stale";
  return "available";
}

/** work: derived-on-read priority over the instance's active runs/tasks. */
export function deriveWork(activeRuns: ActiveRunFact[]): WorkState {
  if (activeRuns.length === 0) return "idle";
  const taskStatuses = new Set(activeRuns.map((r) => r.taskStatus));
  const runStatuses = new Set(activeRuns.map((r) => r.runStatus));
  if (taskStatuses.has("awaiting_approval")) return "awaiting_approval";
  if (taskStatuses.has("blocked")) return "blocked";
  if (runStatuses.has("awaiting_input")) return "awaiting_input";
  if (runStatuses.has("paused")) return "paused";
  if (runStatuses.has("running")) return "running";
  if (runStatuses.has("queued") || runStatuses.has("starting")) return "queued";
  return "idle";
}

/** Dominant non-healthy cause, or null when healthy. Priority per design §4. */
export function deriveHealthReason(input: {
  connection: ConnectionState;
  work: WorkState;
  runtime: RuntimePresenceState;
  daemonRestarting?: boolean;
  leaseConflict?: boolean;
}): HealthReason | null {
  if (input.connection === "revoked") return "device_revoked";
  if (input.runtime === "missing") return "runtime_missing";
  if (input.connection === "stale" || input.connection === "offline" || input.runtime === "stale") return "heartbeat_timeout";
  if (input.daemonRestarting === true) return "daemon_restarting";
  if (input.work === "awaiting_approval") return "approval_required";
  if (input.leaseConflict === true) return "lease_conflict";
  return null;
}

/**
 * Live presence eligibility helper. The scheduler uses the DB-fact helpers below
 * rather than this function because it has no socket registry and must preserve
 * the missing-runtime-row fallback for seeded/dev/pre-heartbeat candidates.
 * A live runtime is schedulable iff it has an online connection (not revoked/
 * stale/offline), a fresh non-disabled runtime row, and spare capacity.
 */
export function isSchedulable(
  facts: AgentInstancePresenceFacts,
  nowIso: string,
  windows: PresenceWindows,
): boolean {
  if (deriveConnection(facts, nowIso, windows) !== "online") return false;
  if (facts.activeRuns.length >= facts.concurrencyLimit) return false;
  const runtime = deriveRuntime(facts, nowIso, windows);
  return runtime === "available";
}

// --------------------------------------------------------------------------- scheduler DB-fact eligibility (#113 slice 5)
// These are DB-fact based (NO live-connection dimension) so the scheduler — which
// runs in the persistence layer with no socket awareness — can reuse the same
// stale/disabled/capacity/admin/trust judgments as presence. The connection
// dimension stays presence/app-layer only.

/** agent_instances.status is an ADMIN availability guard only (not busy/idle
 *  truth). Excludes administratively-unavailable instances; stale `queued`/
 *  `running` values are NOT treated as busy by themselves (capacity decides). */
export function isInstanceAdminAvailable(adminStatus: string): boolean {
  return adminStatus !== "disabled" && adminStatus !== "stopping" && adminStatus !== "failed";
}

/** Capacity from derived active (non-terminal) runs vs the configured limit. */
export function hasSpareCapacity(activeRuns: number, concurrencyLimit: number): boolean {
  return activeRuns < Math.max(1, concurrencyLimit);
}

/** Device trust gate: no bound device => eligible; a bound revoked device =>
 *  excluded (fail-closed). `hasRevokedDevice` is computed by the caller via an
 *  exists/aggregate to avoid duplicating candidates across device rows. */
export function isDeviceTrustEligible(hasRevokedDevice: boolean): boolean {
  return !hasRevokedDevice;
}

/** Read `concurrency_limit` from an agent_instances.config blob (default 1). */
export function concurrencyLimitFromConfig(config: Record<string, unknown> | null | undefined): number {
  const raw = (config ?? {})["concurrency_limit"];
  return typeof raw === "number" && raw > 0 ? raw : 1;
}

// --------------------------------------------------------------------------- synthesis

export function synthesizeAgentInstancePresence(
  facts: AgentInstancePresenceFacts,
  nowIso: string,
  windows: PresenceWindows,
): AgentInstancePresence {
  const connection = deriveConnection(facts, nowIso, windows);
  const work = deriveWork(facts.activeRuns);
  const runtime = deriveRuntime(facts, nowIso, windows);
  const health_reason = deriveHealthReason({
    connection,
    work,
    runtime,
    daemonRestarting: facts.daemonRestarting,
    leaseConflict: facts.leaseConflict,
  });
  return {
    agent_instance_id: facts.agentInstanceId,
    agent_id: facts.agentId,
    computer_id: facts.computerId,
    connection,
    work,
    runtime,
    health_reason,
    concurrency_limit: facts.concurrencyLimit,
    active_runs: facts.activeRuns.length,
    last_seen_at: facts.runtimeLastSeenAt ?? facts.lastSeenAt,
    age_ms: ageMs(facts.runtimeLastSeenAt ?? facts.lastSeenAt, nowIso),
    source: { connection: "device+socket+heartbeat", work: "runs+tasks", runtime: "agent_runtimes" },
    as_of: nowIso,
  };
}

export function synthesizeComputerPresence(
  facts: ComputerPresenceFacts,
  nowIso: string,
  windows: PresenceWindows,
): ComputerPresence {
  const connection = deriveConnection(
    { hasLiveConnection: facts.hasLiveConnection, deviceTrust: facts.deviceTrust, lastSeenAt: facts.lastHeartbeatAt },
    nowIso,
    windows,
  );
  const runtimes: ComputerRuntimePresence[] = facts.runtimes.map((r) => ({
    runtime: r.runtime,
    status: deriveRuntime(
      { runtimeStatus: r.status, lastSeenAt: r.lastSeenAt, concurrencyLimit: Number.POSITIVE_INFINITY, activeRuns: [] },
      nowIso,
      windows,
    ),
    last_seen_at: r.lastSeenAt,
    age_ms: ageMs(r.lastSeenAt, nowIso),
  }));
  const anyMissing = runtimes.some((r) => r.status === "missing");
  const health_reason = deriveHealthReason({
    connection,
    work: "idle",
    runtime: anyMissing ? "missing" : "available",
    daemonRestarting: facts.daemonRestarting,
  });
  return {
    computer_id: facts.computerId,
    connection,
    health_reason,
    runtimes,
    active_runs: facts.activeRuns,
    queue_depth: facts.queueDepth,
    last_heartbeat_at: facts.lastHeartbeatAt,
    age_ms: ageMs(facts.lastHeartbeatAt, nowIso),
    as_of: nowIso,
  };
}
