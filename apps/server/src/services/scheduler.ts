import { agentInstances, agentRuntimes, agents, computers } from "@artoo/db";
import { isRuntimeStale, matchCapabilities, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/**
 * How long after its last heartbeat a runtime row is considered stale (and its
 * instance excluded). Default 30s = 3x the 10s heartbeat interval; an
 * `ARTOO_RUNTIME_STALE_MS` env override is honored only if it parses to a
 * positive finite number. Tests stay deterministic via the pure helper.
 */
const RUNTIME_STALE_AFTER_MS = ((): number => {
  const raw = process.env.ARTOO_RUNTIME_STALE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 30_000;
})();

export interface SchedulerCandidate {
  agent_instance_id: string;
  agent_id: string;
  computer_id: string;
  runtime: string;
  model_profile_id: string | null;
  effort_profile_id: string | null;
  score: number;
}

export interface SchedulerOutcome {
  selected: SchedulerCandidate;
  candidates: SchedulerCandidate[];
  score: number;
  reason: string;
}

export interface ScheduleOptions {
  mode: "auto" | "manual";
  agentInstanceId?: string | null;
}

/**
 * Rule-based core scheduler (codex Round 14). Hard filters: idle instance on an
 * online computer whose (agent ∪ computer) capabilities cover the task's
 * required set; a manual override pins the instance. Deterministic selection:
 * highest score, then lowest instance id. No eligible candidate maps to an
 * explainable `computer_offline` / `runtime_unavailable` error (task stays ready).
 */
export async function scheduleTask(
  tx: DrizzleDb,
  ctx: ServerContext,
  required: readonly Capability[],
  opts: ScheduleOptions,
): Promise<SchedulerOutcome> {
  const rows = await tx
    .select({
      instanceId: agentInstances.id,
      agentId: agentInstances.agentId,
      computerId: agentInstances.computerId,
      runtime: agentInstances.runtime,
      modelProfileId: agentInstances.modelProfileId,
      effortProfileId: agentInstances.effortProfileId,
      instanceStatus: agentInstances.status,
      computerStatus: computers.status,
      agentCaps: agents.capabilities,
      computerCaps: computers.capabilities,
      // Runtime row for this instance's runtime (LEFT JOIN: null when absent).
      runtimeStatus: agentRuntimes.status,
      runtimeCaps: agentRuntimes.capabilities,
      runtimeLastSeen: agentRuntimes.lastSeenAt,
    })
    .from(agentInstances)
    .innerJoin(computers, eq(agentInstances.computerId, computers.id))
    .innerJoin(agents, eq(agentInstances.agentId, agents.id))
    .leftJoin(
      agentRuntimes,
      and(
        eq(agentRuntimes.organizationId, ctx.organizationId),
        eq(agentRuntimes.computerId, agentInstances.computerId),
        eq(agentRuntimes.runtime, agentInstances.runtime),
      ),
    )
    .where(eq(agentInstances.organizationId, ctx.organizationId));

  const now = ctx.clock.nowIso();
  const candidates: SchedulerCandidate[] = rows
    .filter((r) => r.instanceStatus === "idle" && r.computerStatus === "online")
    .filter(
      (r) =>
        opts.mode !== "manual" ||
        opts.agentInstanceId == null ||
        r.instanceId === opts.agentInstanceId,
    )
    .filter((r) => {
      // Runtime eligibility (#15 Part 3). A missing agent_runtimes row is a
      // deliberate fallback (seeded/dev/pre-heartbeat): the candidate stays
      // eligible with no runtime caps. A present-but-disabled or stale/timestamp-
      // less row excludes the candidate (its runtime is known-bad). A fresh,
      // enabled row contributes its capabilities. `version` is non-gating.
      let runtimeCaps: Capability[] = [];
      if (r.runtimeStatus !== null) {
        if (r.runtimeStatus === "disabled") {
          return false;
        }
        if (isRuntimeStale(r.runtimeLastSeen, now, RUNTIME_STALE_AFTER_MS)) {
          return false;
        }
        runtimeCaps = (r.runtimeCaps as Capability[] | null) ?? [];
      }
      return matchCapabilities(required, [
        ...(r.agentCaps as Capability[]),
        ...(r.computerCaps as Capability[]),
        ...runtimeCaps,
      ]);
    })
    .map((r) => ({
      agent_instance_id: r.instanceId,
      agent_id: r.agentId,
      computer_id: r.computerId,
      runtime: r.runtime,
      model_profile_id: r.modelProfileId,
      effort_profile_id: r.effortProfileId,
      // capability match (100) + exact-capability bonus + idle bonus (15).
      score: 100 + (required.length > 0 ? 20 : 0) + 15,
    }))
    .sort((a, b) => b.score - a.score || a.agent_instance_id.localeCompare(b.agent_instance_id));

  const selected = candidates[0];
  if (selected === undefined) {
    const anyOnline = rows.some((r) => r.computerStatus === "online");
    if (!anyOnline) {
      throw new AppError("computer_offline", "no online computer is available", 409);
    }
    throw new AppError(
      "runtime_unavailable",
      "no eligible idle agent instance for the required capabilities",
      409,
      { required_capabilities: required },
    );
  }

  return {
    selected,
    candidates,
    score: selected.score,
    reason:
      opts.mode === "manual" && opts.agentInstanceId != null
        ? "manual_override"
        : "capability_match_and_idle",
  };
}
