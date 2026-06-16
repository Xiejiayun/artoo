/**
 * Pure, deterministic supervision state machine for the local-node control plane
 * (#29 v2-D). NO IO. A desktop client uses this to track and decide transitions
 * for a supervised `artood` process; the actual process IO (spawn/stop/health
 * polling) is a separate layer (slice 3) that feeds events into these pure
 * functions. Keeping the decision logic pure makes supervision testable without
 * spawning anything.
 */

/** Lifecycle of a supervised local node. */
export type SupervisorState = "stopped" | "starting" | "running" | "unhealthy" | "stopping";

/**
 * Events that drive transitions:
 * - `start` / `stop`: operator intent.
 * - `ready`: node.hello + first heartbeat observed (the node is up).
 * - `heartbeat`: a periodic health sample (`healthy` from {@link isHeartbeatHealthy}).
 * - `exited`: the process ended; `expected` is true when we initiated the stop.
 * - `startFailed`: the process failed to start (bad config, missing binary, …).
 */
export type SupervisorEvent =
  | { type: "start" }
  | { type: "ready" }
  | { type: "heartbeat"; healthy: boolean }
  | { type: "stop" }
  | { type: "exited"; expected: boolean }
  | { type: "startFailed" };

/**
 * Pure transition function. Unknown (state, event) pairs are no-ops (return the
 * current state) so the machine never throws on out-of-order events.
 */
export function nextSupervisorState(state: SupervisorState, event: SupervisorEvent): SupervisorState {
  switch (state) {
    case "stopped":
      return event.type === "start" ? "starting" : "stopped";
    case "starting":
      if (event.type === "ready") return "running";
      if (event.type === "startFailed" || event.type === "exited") return "stopped";
      if (event.type === "stop") return "stopping";
      return "starting";
    case "running":
      if (event.type === "heartbeat") return event.healthy ? "running" : "unhealthy";
      if (event.type === "stop") return "stopping";
      if (event.type === "exited") return "stopped";
      return "running";
    case "unhealthy":
      if (event.type === "heartbeat") return event.healthy ? "running" : "unhealthy";
      if (event.type === "stop") return "stopping";
      if (event.type === "exited") return "stopped";
      return "unhealthy";
    case "stopping":
      return event.type === "exited" ? "stopped" : "stopping";
  }
}

/** Whether a process exit at `state` was unexpected (a crash worth auto-restarting). */
export function isCrash(state: SupervisorState, event: SupervisorEvent): boolean {
  return event.type === "exited" && !event.expected && state !== "stopping" && state !== "stopped";
}

/**
 * Health from the last heartbeat timestamp: healthy iff a timestamp exists and is
 * within `staleAfterMs` of `now`. Null/missing/unparseable → unhealthy (safe).
 * Deterministic — `now` is injected, never read from the clock here.
 */
export function isHeartbeatHealthy(
  lastSeenIso: string | null | undefined,
  nowIso: string,
  staleAfterMs: number
): boolean {
  if (lastSeenIso == null) return false;
  const last = Date.parse(lastSeenIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(last) || Number.isNaN(now)) return false;
  return now - last <= staleAfterMs;
}

/** Auto-restart policy: a cap on attempts plus capped exponential backoff. */
export interface RestartPolicy {
  /** Max consecutive auto-restarts before giving up (stays stopped). */
  maxRestarts: number;
  /** Backoff base; delay = min(baseDelayMs * 2^restartCount, maxDelayMs). */
  baseDelayMs: number;
  /** Upper bound on the backoff delay. */
  maxDelayMs: number;
}

export interface RestartDecision {
  restart: boolean;
  delayMs: number;
}

/**
 * Decide whether to auto-restart after a crash, given how many consecutive
 * restarts have already happened. Pure: caller resets `restartCount` to 0 once
 * the node is healthy again.
 */
export function restartDecision(restartCount: number, policy: RestartPolicy): RestartDecision {
  if (restartCount >= policy.maxRestarts) {
    return { restart: false, delayMs: 0 };
  }
  const delayMs = Math.min(policy.baseDelayMs * 2 ** restartCount, policy.maxDelayMs);
  return { restart: true, delayMs };
}
