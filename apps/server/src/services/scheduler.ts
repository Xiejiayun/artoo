import { agentInstances, agents, computers } from "@artoo/db";
import { matchCapabilities, type Capability } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

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
    })
    .from(agentInstances)
    .innerJoin(computers, eq(agentInstances.computerId, computers.id))
    .innerJoin(agents, eq(agentInstances.agentId, agents.id))
    .where(eq(agentInstances.organizationId, ctx.organizationId));

  const candidates: SchedulerCandidate[] = rows
    .filter((r) => r.instanceStatus === "idle" && r.computerStatus === "online")
    .filter(
      (r) =>
        opts.mode !== "manual" ||
        opts.agentInstanceId == null ||
        r.instanceId === opts.agentInstanceId,
    )
    .filter((r) =>
      matchCapabilities(required, [
        ...(r.agentCaps as Capability[]),
        ...(r.computerCaps as Capability[]),
      ]),
    )
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
