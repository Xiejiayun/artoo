import { z } from "zod";
import {
  SchedulerAgentPolicyV1Schema,
  SchedulerComputerPolicyV1Schema,
  SchedulerProjectPolicyV1Schema,
} from "./scheduler-policy.js";

const id = z.string().min(1).max(128);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = count.max(8_640_000_000_000_000);

/**
 * A point-in-time counterfactual over candidates already admitted by the trusted
 * scheduler. This data and its result are not an execution or verification grant.
 * Occupancy includes real Runs and dedicated reservations, never hypothetical
 * shadow occupancy for those same executions.
 */
export const SchedulerRankingSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    observed_at_ms: time,
    not_before_ms: time,
    preferred_computer_id: id.nullable(),
    prefer_until_ms: time.nullable(),
    manual_agent_instance_id: id.nullable(),
    project_policy: SchedulerProjectPolicyV1Schema.nullable(),
    agent_policies: z.record(id, SchedulerAgentPolicyV1Schema),
    computer_policies: z.record(id, SchedulerComputerPolicyV1Schema),
    occupancy: z.object({ project: count, agents: z.record(id, count), computers: z.record(id, count) }).strict(),
    candidates: z
      .array(
        z
          .object({
            agent_instance_id: id,
            agent_id: id,
            computer_id: id,
            runtime: id,
            available_runtimes: z.array(id).max(64),
            legacy_score: z.number().finite(),
          })
          .strict(),
      )
      .max(4096),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.preferred_computer_id === null) !== (value.prefer_until_ms === null))
      ctx.addIssue({ code: "custom", message: "Soft affinity requires both computer and deadline" });
    if (new Set(value.candidates.map((candidate) => candidate.agent_instance_id)).size !== value.candidates.length)
      ctx.addIssue({ code: "custom", message: "Candidate instance identities must be unique" });
  });

export type SchedulerRankingSnapshotV1 = z.infer<typeof SchedulerRankingSnapshotV1Schema>;
export type SchedulerRankingReason =
  | "not_before"
  | "project_policy_missing"
  | "agent_policy_missing"
  | "computer_policy_missing"
  | "project_capacity"
  | "agent_capacity"
  | "computer_capacity"
  | "agent_pin"
  | "runtime_unconfirmed"
  | "required_runtime"
  | "required_label"
  | "manual_override"
  | "soft_affinity";

/** Policy only removes trusted candidates; it never broadens eligibility. */
export function rankSchedulerCandidates(input: SchedulerRankingSnapshotV1) {
  const snapshot = SchedulerRankingSnapshotV1Schema.parse(input);
  const decisions = snapshot.candidates.map((candidate) => {
    const reasons: SchedulerRankingReason[] = [];
    const project = snapshot.project_policy;
    const agent = ownEntry(snapshot.agent_policies, candidate.agent_id);
    const computer = ownEntry(snapshot.computer_policies, candidate.computer_id);
    // Legacy manual admission permits absent runtime inventory. Preserve that
    // fact in the snapshot, but do not infer new-path eligibility from it.
    if (!candidate.available_runtimes.includes(candidate.runtime)) reasons.push("runtime_unconfirmed");
    if (snapshot.observed_at_ms < snapshot.not_before_ms) reasons.push("not_before");
    if (!project) reasons.push("project_policy_missing");
    else if (snapshot.occupancy.project >= project.max_concurrent_runs) reasons.push("project_capacity");
    if (!agent) reasons.push("agent_policy_missing");
    else {
      if ((ownEntry(snapshot.occupancy.agents, candidate.agent_id) ?? 0) >= agent.max_concurrent_runs)
        reasons.push("agent_capacity");
      if (agent.pinned_computer_id !== null && agent.pinned_computer_id !== candidate.computer_id)
        reasons.push("agent_pin");
      if (!agent.required_runtimes.every((runtime) => candidate.available_runtimes.includes(runtime)))
        reasons.push("required_runtime");
    }
    if (!computer) reasons.push("computer_policy_missing");
    else {
      if ((ownEntry(snapshot.occupancy.computers, candidate.computer_id) ?? 0) >= computer.max_concurrent_runs)
        reasons.push("computer_capacity");
      if (agent && !agent.required_labels.every((label) => computer.labels.includes(label)))
        reasons.push("required_label");
    }
    if (snapshot.manual_agent_instance_id !== null) {
      if (candidate.agent_instance_id !== snapshot.manual_agent_instance_id) reasons.push("manual_override");
    } else if (
      snapshot.preferred_computer_id !== null &&
      snapshot.prefer_until_ms !== null &&
      snapshot.observed_at_ms < snapshot.prefer_until_ms &&
      candidate.computer_id !== snapshot.preferred_computer_id
    )
      reasons.push("soft_affinity");
    return { agent_instance_id: candidate.agent_instance_id, reasons };
  });
  const admitted = new Set(
    decisions.filter((decision) => decision.reasons.length === 0).map((d) => d.agent_instance_id),
  );
  const ranked = snapshot.candidates
    .filter((candidate) => admitted.has(candidate.agent_instance_id))
    .sort((a, b) => b.legacy_score - a.legacy_score || a.agent_instance_id.localeCompare(b.agent_instance_id));
  return {
    version: 1 as const,
    execution_authorized: false as const,
    selected_agent_instance_id: ranked[0]?.agent_instance_id ?? null,
    ranked_agent_instance_ids: ranked.map((candidate) => candidate.agent_instance_id),
    decisions,
  };
}

function ownEntry<T>(entries: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}
