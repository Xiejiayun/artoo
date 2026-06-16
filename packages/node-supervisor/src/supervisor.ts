import {
  isCrash,
  isHeartbeatHealthy,
  nextSupervisorState,
  restartDecision,
  type RestartPolicy,
  type SupervisorState
} from "./state-machine.js";

/**
 * Process supervisor for the local-node control plane (#29 v2-D slice 3). Drives
 * the pure {@link nextSupervisorState} machine from real process + health events,
 * but every side-effecting dependency (spawn, health source, clock, scheduling)
 * is injected, so the supervision behavior is deterministically testable with a
 * fake spawner and no real process IO. Runtime EXECUTION stays in artood; this
 * only supervises the process lifecycle.
 */

/** A handle to a spawned artood process. */
export interface ChildHandle {
  /** Send a termination signal to the process. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Resolves when the process exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

/** Spawns the #23 artood bootstrap with the given env (see toBootstrapEnv). */
export interface Spawner {
  spawn(env: Record<string, string>): ChildHandle;
}

/** Source of the node's latest heartbeat timestamp (server `agent_runtimes` view). */
export interface HealthSource {
  lastHeartbeatIso(): string | null;
}

export interface SupervisorDeps {
  spawner: Spawner;
  health: HealthSource;
  /** Injected clock for deterministic staleness checks. */
  nowIso: () => string;
  /** Deferred execution (default global setTimeout); injected so tests stay deterministic. */
  schedule: (fn: () => void, delayMs: number) => void;
  /** Heartbeat stale window (default 30s). */
  staleAfterMs?: number;
  /** Grace between SIGTERM and SIGKILL on stop (default 5s). */
  killGraceMs?: number;
  restartPolicy?: RestartPolicy;
}

export interface NodeSupervisor {
  state(): SupervisorState;
  restartCount(): number;
  /** Start (only from stopped). Resets the restart budget. */
  start(env: Record<string, string>): void;
  /** Sample health and advance the machine. Called on a timer in production. */
  tick(): void;
  /** Request a graceful stop (SIGTERM, then SIGKILL after the grace window). */
  stop(): void;
  onStateChange(cb: (state: SupervisorState) => void): () => void;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_RESTART: RestartPolicy = { maxRestarts: 5, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export function createNodeSupervisor(deps: SupervisorDeps): NodeSupervisor {
  const staleMs = deps.staleAfterMs ?? DEFAULT_STALE_MS;
  const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const policy = deps.restartPolicy ?? DEFAULT_RESTART;

  let state: SupervisorState = "stopped";
  let restarts = 0;
  let child: ChildHandle | null = null;
  let lastEnv: Record<string, string> | null = null;
  let stopRequested = false;
  // Bumped on every start() and stop() so a pending (scheduled) auto-restart from
  // an older generation is invalidated — otherwise stop() during a crash-loop's
  // backoff window could not cancel the queued respawn.
  let generation = 0;
  const listeners = new Set<(state: SupervisorState) => void>();

  function transition(event: Parameters<typeof nextSupervisorState>[1]): void {
    const crashed = isCrash(state, event);
    const next = nextSupervisorState(state, event);
    if (next !== state) {
      state = next;
      for (const cb of [...listeners]) cb(state);
    }
    if (crashed) maybeRestart();
  }

  function spawnNode(env: Record<string, string>): void {
    lastEnv = env;
    stopRequested = false;
    const handle = deps.spawner.spawn(env);
    child = handle;
    void handle.exited.then(() => {
      const expected = stopRequested;
      if (child === handle) child = null;
      transition({ type: "exited", expected });
    });
    transition({ type: "start" });
  }

  function maybeRestart(): void {
    const decision = restartDecision(restarts, policy);
    if (!decision.restart || lastEnv === null) return;
    restarts += 1;
    const env = lastEnv;
    const gen = generation;
    deps.schedule(() => {
      // Only respawn if no start()/stop() happened in the meantime.
      if (generation === gen && state === "stopped") spawnNode(env);
    }, decision.delayMs);
  }

  return {
    state: () => state,
    restartCount: () => restarts,

    start(env) {
      if (state !== "stopped") return;
      generation += 1;
      restarts = 0;
      spawnNode(env);
    },

    tick() {
      if (state === "stopped" || state === "stopping") return;
      const healthy = isHeartbeatHealthy(deps.health.lastHeartbeatIso(), deps.nowIso(), staleMs);
      // A healthy node has recovered — clear the restart budget (covers both the
      // starting -> running "ready" path and a running/unhealthy heartbeat).
      if (healthy) restarts = 0;
      if (state === "starting") {
        if (healthy) transition({ type: "ready" });
        return;
      }
      transition({ type: "heartbeat", healthy });
    },

    stop() {
      // Invalidate any pending auto-restart even when already stopped (crash-loop
      // backoff window), so "stop" is reliable.
      generation += 1;
      if (state === "stopped") return;
      stopRequested = true;
      transition({ type: "stop" });
      const handle = child;
      if (handle === null) {
        transition({ type: "exited", expected: true });
        return;
      }
      handle.kill("SIGTERM");
      deps.schedule(() => {
        if (state === "stopping" && child === handle) {
          handle.kill("SIGKILL");
        }
      }, killGraceMs);
    },

    onStateChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }
  };
}
