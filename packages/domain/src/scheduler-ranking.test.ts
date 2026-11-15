import { describe, expect, it } from "vitest";
import {
  rankSchedulerCandidates,
  SchedulerRankingSnapshotV1Schema,
  type SchedulerRankingSnapshotV1,
} from "./scheduler-ranking.js";

function snapshot(): SchedulerRankingSnapshotV1 {
  const agent = {
    version: 1 as const,
    max_concurrent_runs: 2,
    pinned_computer_id: null,
    required_runtimes: ["codex"],
    required_labels: ["trusted"],
  };
  const computer = { version: 1 as const, max_concurrent_runs: 2, labels: ["trusted"] };
  return {
    version: 1,
    observed_at_ms: 1000,
    not_before_ms: 1000,
    preferred_computer_id: null,
    prefer_until_ms: null,
    manual_agent_instance_id: null,
    project_policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
    agent_policies: { agent: agent },
    computer_policies: { a: computer, b: computer },
    occupancy: { project: 0, agents: {}, computers: {} },
    candidates: [
      {
        agent_instance_id: "instance_b",
        agent_id: "agent",
        computer_id: "b",
        runtime: "codex",
        available_runtimes: ["codex"],
        legacy_score: 10,
      },
      {
        agent_instance_id: "instance_a",
        agent_id: "agent",
        computer_id: "a",
        runtime: "codex",
        available_runtimes: ["codex"],
        legacy_score: 10,
      },
    ],
  };
}

describe("point-in-time shadow scheduler ranking", () => {
  it("preserves historical shapes and checks optional exact policy revision provenance", () => {
    const old = snapshot();
    expect(SchedulerRankingSnapshotV1Schema.parse(old)).toEqual(old);
    expect(SchedulerRankingSnapshotV1Schema.parse(old)).not.toHaveProperty("policy_revisions");
    const provenance = {
      version: 1 as const,
      project_id: "project",
      project: 1,
      agents: { agent: 2 },
      computers: { a: 3, b: 4 },
    };
    const current = { ...old, policy_revisions: provenance };
    expect(SchedulerRankingSnapshotV1Schema.parse(current)).toEqual(current);
    expect(rankSchedulerCandidates(current)).toEqual(rankSchedulerCandidates(old));
    for (const extra of [
      { version: 2 },
      { project: null },
      { project: 0 },
      { project: Number.MAX_SAFE_INTEGER + 1 },
      { agents: {} },
      { agents: { agent: 2, unrelated: 1 } },
      { agents: { agent: 0.1 } },
      { computers: { a: 3 } },
      { execution_authorized: true },
    ])
      expect(
        SchedulerRankingSnapshotV1Schema.safeParse({ ...current, policy_revisions: { ...provenance, ...extra } })
          .success,
      ).toBe(false);
    expect(SchedulerRankingSnapshotV1Schema.safeParse({ ...current, project_policy: null }).success).toBe(false);
    const absent = {
      ...old,
      project_policy: null,
      agent_policies: {},
      computer_policies: {},
      policy_revisions: { version: 1, project_id: "project", project: null, agents: {}, computers: {} },
    };
    expect(SchedulerRankingSnapshotV1Schema.parse(absent)).toEqual(absent);
  });
  it("keeps deterministic legacy scoring without mutating its captured inputs or granting execution", () => {
    const input = snapshot(),
      before = structuredClone(input);
    expect(rankSchedulerCandidates(input)).toMatchObject({
      version: 1,
      execution_authorized: false,
      selected_agent_instance_id: "instance_a",
      ranked_agent_instance_ids: ["instance_a", "instance_b"],
    });
    expect(input).toEqual(before);
    input.candidates[0]!.legacy_score = 11;
    expect(rankSchedulerCandidates(input).selected_agent_instance_id).toBe("instance_b");
  });
  it("explains each independent capacity boundary using the supplied real occupancy", () => {
    for (const [occupancy, reason] of [
      [{ project: 2, agents: {}, computers: {} }, "project_capacity"],
      [{ project: 0, agents: { agent: 2 }, computers: {} }, "agent_capacity"],
      [{ project: 0, agents: {}, computers: { a: 2, b: 2 } }, "computer_capacity"],
    ] as const) {
      const input = snapshot();
      input.occupancy = occupancy;
      const result = rankSchedulerCandidates(input);
      expect(result.selected_agent_instance_id).toBeNull();
      expect(result.decisions.every((decision) => decision.reasons.includes(reason))).toBe(true);
    }
  });
  it("only removes original candidates and enforces pin, required runtime and trusted policy labels", () => {
    const input = snapshot();
    input.agent_policies.agent!.pinned_computer_id = "a";
    expect(rankSchedulerCandidates(input).ranked_agent_instance_ids).toEqual(["instance_a"]);
    input.agent_policies.agent!.required_runtimes.push("claude");
    expect(rankSchedulerCandidates(input).decisions[1]!.reasons).toContain("required_runtime");
    input.candidates[1]!.available_runtimes.push("claude");
    input.computer_policies.a!.labels = [];
    expect(rankSchedulerCandidates(input).decisions[1]!.reasons).toContain("required_label");
    expect(rankSchedulerCandidates({ ...snapshot(), candidates: [] }).selected_agent_instance_id).toBeNull();
  });
  it("keeps absent policy explicit instead of inventing permissive defaults", () => {
    const input = snapshot();
    input.project_policy = null;
    delete input.agent_policies.agent;
    delete input.computer_policies.a;
    const result = rankSchedulerCandidates(input);
    expect(result.selected_agent_instance_id).toBeNull();
    expect(result.decisions[1]!.reasons).toEqual([
      "project_policy_missing",
      "agent_policy_missing",
      "computer_policy_missing",
    ]);
  });
  it("releases soft affinity at its exact deadline and preserves an explicit manual choice", () => {
    const input = snapshot();
    input.preferred_computer_id = "b";
    input.prefer_until_ms = 1001;
    expect(rankSchedulerCandidates(input).selected_agent_instance_id).toBe("instance_b");
    input.observed_at_ms = 1001;
    expect(rankSchedulerCandidates(input).selected_agent_instance_id).toBe("instance_a");
    input.observed_at_ms = 1000;
    input.manual_agent_instance_id = "instance_a";
    expect(rankSchedulerCandidates(input).selected_agent_instance_id).toBe("instance_a");
    input.agent_policies.agent!.pinned_computer_id = "b";
    expect(rankSchedulerCandidates(input).selected_agent_instance_id).toBeNull();
  });
  it("does not mistake inherited object keys for explicit policies", () => {
    const input = snapshot();
    input.candidates[0]!.agent_id = "constructor";
    input.candidates[0]!.computer_id = "toString";
    expect(rankSchedulerCandidates(input).decisions[0]!.reasons).toEqual([
      "agent_policy_missing",
      "computer_policy_missing",
    ]);
  });
  it("can explain the existing manual runtime-inventory fallback without treating it as new-path evidence", () => {
    const input = snapshot();
    input.candidates[0]!.available_runtimes = [];
    input.agent_policies.agent!.required_runtimes = [];
    const result = rankSchedulerCandidates(input);
    expect(result.decisions[0]!.reasons).toEqual(["runtime_unconfirmed"]);
    expect(result.ranked_agent_instance_ids).toEqual(["instance_a"]);
    expect(input.candidates).toHaveLength(2);
    expect(input.candidates[0]!.runtime).toBe("codex");
  });
  it("rejects malformed or ambiguous snapshots and never changes queue timing", () => {
    const input = snapshot();
    input.not_before_ms = 1001;
    expect(rankSchedulerCandidates(input).decisions.every((d) => d.reasons.includes("not_before"))).toBe(true);
    expect(input.not_before_ms).toBe(1001);
    for (const invalid of [
      { ...snapshot(), version: 2 },
      { ...snapshot(), observed_at_ms: Number.NaN },
      { ...snapshot(), prefer_until_ms: 1001 },
      { ...snapshot(), occupancy: { project: -1, agents: {}, computers: {} } },
      { ...snapshot(), candidates: [snapshot().candidates[0], snapshot().candidates[0]] },
      { ...snapshot(), execution_authorized: true },
    ])
      expect(() => rankSchedulerCandidates(invalid as SchedulerRankingSnapshotV1)).toThrow();
  });
});
