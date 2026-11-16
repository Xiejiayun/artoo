import { describe, expect, it } from "vitest";
import {
  SchedulerStartProposalV1Schema,
  canonicalSchedulerStartProposalV1,
  type SchedulerStartProposalV1,
} from "./scheduler-start-proposal.js";

// Metadata only: no node, database, producer or current authorization.
function proposal(): SchedulerStartProposalV1 {
  const digest = `sha256:${"a".repeat(64)}`;
  return {
    version: 1,
    prepared_start: {
      version: 1,
      request_id: "request_one",
      request_snapshot_digest: digest,
      organization_id: "org_one",
      project_id: "project_one",
      task_id: "task_one",
      actor_user_id: "user_one",
      run_id: "run_one",
      agent_instance_id: "ai_one",
      computer_id: "computer_one",
      device_id: "device_one",
      session_id: "session_one",
      assigned: {
        task_input_version: 1,
        task_input_digest: digest,
        queue_revision: 1,
        policy_revisions: { project: 1, agent: 1, computers: { computer_one: 1 } },
        configuration_digest: digest,
      },
      prepared_run_digest: digest,
      execution_authorized: false,
    },
    run_start: {
      run_id: "run_one",
      task_id: "task_one",
      agent_instance_id: "ai_one",
      runtime: "codex",
      workspace: { root: "/fixture/run", branch: "fixture/run" },
      context_pack: {
        id: "context_one",
        payload: {
          task: { id: "task_one", title: "Task", description: "Original", acceptance_criteria: ["Checks pass"] },
          project: { id: "project_one", name: "Project", default_workspace: null },
          workspace: { root: "/fixture/run", file_scope: ["src"] },
          policy: { filesystem_write_scope: ["src"], requires_approval: [] },
          memory: { task_summary: null, project_notes: [] },
          artifacts: { expected: [] },
        },
      },
      policy_snapshot: { filesystem_write_scope: ["/fixture/run"], requires_approval: [] },
      artifact_rules: { paths: [] },
    },
  };
}
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}
describe("scheduler start proposal metadata", () => {
  it("retains complete content and canonicalizes key order without changing array order", () => {
    const raw = proposal(),
      parsed = SchedulerStartProposalV1Schema.parse(raw);
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(canonicalSchedulerStartProposalV1(reverseKeys(raw))).toBe(canonicalSchedulerStartProposalV1(raw));
    raw.run_start.artifact_rules.paths = ["a", "b"];
    const changed = structuredClone(raw);
    changed.run_start.artifact_rules.paths.reverse();
    expect(canonicalSchedulerStartProposalV1(raw)).not.toBe(canonicalSchedulerStartProposalV1(changed));
  });
  it.each(["run_id", "task_id", "agent_instance_id"] as const)("rejects mismatched %s", (key) => {
    const raw = proposal();
    raw.prepared_start[key] = "different";
    expect(() => SchedulerStartProposalV1Schema.parse(raw)).toThrow(/identities/);
  });
  it("requires inline project and task identity", () => {
    const raw = proposal();
    raw.run_start.context_pack = { id: "context_one", uri: "local://unbound" };
    expect(() => SchedulerStartProposalV1Schema.parse(raw)).toThrow(/inline/);
    const changed = proposal();
    changed.run_start.context_pack.payload!.project.id = "another_project";
    expect(() => SchedulerStartProposalV1Schema.parse(changed)).toThrow(/identities/);
  });
  it.each([
    (raw: ReturnType<typeof proposal>) => Object.assign(raw, { grant: true }),
    (raw: ReturnType<typeof proposal>) => Object.assign(raw.run_start, { scheduler_mode: "execute" }),
    (raw: ReturnType<typeof proposal>) => Object.assign(raw.run_start.policy_snapshot, { allow_spawn: true }),
    (raw: ReturnType<typeof proposal>) => Object.assign(raw.run_start.context_pack.payload!.task, { approved: true }),
  ])("rejects unknown fields at every legacy nested codec", (mutate) => {
    const raw = proposal();
    mutate(raw);
    expect(SchedulerStartProposalV1Schema.safeParse(raw).success).toBe(false);
  });
  it("rejects future versions, asserted launch authority and oversized snapshots", () => {
    const raw = proposal();
    expect(SchedulerStartProposalV1Schema.safeParse({ ...raw, version: 2 }).success).toBe(false);
    expect(
      SchedulerStartProposalV1Schema.safeParse({
        ...raw,
        prepared_start: { ...raw.prepared_start, execution_authorized: true },
      }).success,
    ).toBe(false);
    raw.run_start.context_pack.payload!.task.description = "x".repeat(1024 * 1024);
    expect(() => SchedulerStartProposalV1Schema.parse(raw)).toThrow(/bounded/);
  });
  it("binds original user/session, inputs, policies and the full launch content", () => {
    const raw = proposal(),
      original = canonicalSchedulerStartProposalV1(raw);
    for (const mutate of [
      (value: typeof raw) => {
        value.prepared_start.session_id = "new_session";
      },
      (value: typeof raw) => {
        value.prepared_start.actor_user_id = "new_user";
      },
      (value: typeof raw) => {
        value.prepared_start.assigned.policy_revisions.project++;
      },
      (value: typeof raw) => {
        value.prepared_start.assigned.task_input_version++;
      },
      (value: typeof raw) => {
        value.run_start.context_pack.payload!.task.description = "Changed input";
      },
      (value: typeof raw) => {
        value.run_start.runtime = "claude-code";
      },
    ]) {
      const changed = structuredClone(raw);
      mutate(changed);
      expect(canonicalSchedulerStartProposalV1(changed)).not.toBe(original);
    }
  });
});
