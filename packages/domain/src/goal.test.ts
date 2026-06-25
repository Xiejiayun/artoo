import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_TYPES,
  GOAL_STATUSES,
  GOAL_TRANSITIONS,
  GoalSchema,
  InvalidGoalTransitionError,
  PlanSchema,
  applyGoalTransition,
  applyPlanTransition,
  canProposePlan,
  canTransitionGoal,
  canTransitionPlan,
  deriveGoalStatusFromChildren,
  goalTransitionTarget,
  isTerminalGoalStatus,
} from "./goal.js";

describe("goal state machine", () => {
  it("has 9 statuses and 7 checkpoint types (typo fix: doc said 6)", () => {
    expect(GOAL_STATUSES).toHaveLength(9);
    expect(CHECKPOINT_TYPES).toHaveLength(7);
  });

  it("every transition references a valid status on both ends", () => {
    for (const t of GOAL_TRANSITIONS) {
      expect(GOAL_STATUSES).toContain(t.from);
      expect(GOAL_STATUSES).toContain(t.to);
    }
  });

  it("applies a legal transition and rejects an illegal one", () => {
    expect(applyGoalTransition("draft", "plan_accepted")).toBe("planned");
    expect(applyGoalTransition("planned", "dag_materialized")).toBe("running");
    expect(applyGoalTransition("running", "pause")).toBe("paused");
    expect(applyGoalTransition("paused", "resume")).toBe("running");
    expect(canTransitionGoal("completed", "resume")).toBe(false);
    expect(() => applyGoalTransition("completed", "resume")).toThrow(InvalidGoalTransitionError);
    expect(goalTransitionTarget("draft", "resume")).toBeNull();
  });

  it("marks terminal statuses and only allows archive out of them", () => {
    expect(isTerminalGoalStatus("completed")).toBe(true);
    expect(isTerminalGoalStatus("cancelled")).toBe(true);
    expect(isTerminalGoalStatus("archived")).toBe(true);
    expect(isTerminalGoalStatus("running")).toBe(false);
    expect(applyGoalTransition("completed", "archive")).toBe("archived");
    expect(applyGoalTransition("cancelled", "archive")).toBe("archived");
  });

  it("flags human-override triggers distinctly from system-derived ones", () => {
    const pause = GOAL_TRANSITIONS.find((t) => t.trigger === "pause" && t.from === "running");
    const derived = GOAL_TRANSITIONS.find((t) => t.trigger === "all_tasks_terminal");
    expect(pause?.human).toBe(true);
    expect(derived?.human).toBe(false);
  });
});

describe("plan versioning", () => {
  it("transitions proposed→accepted/rejected and accepted→superseded", () => {
    expect(applyPlanTransition("proposed", "accept")).toBe("accepted");
    expect(applyPlanTransition("proposed", "reject")).toBe("rejected");
    expect(applyPlanTransition("accepted", "new_version_accepted")).toBe("superseded");
    expect(canTransitionPlan("rejected", "accept")).toBe(false);
    expect(() => applyPlanTransition("accepted", "accept")).toThrow(InvalidGoalTransitionError);
  });

  it("gates new plan proposals on goal status + existing accepted plan", () => {
    // first plan: only while drafting/planned
    expect(canProposePlan("draft", false)).toBe(true);
    expect(canProposePlan("running", false)).toBe(false);
    // re-plan only after an explicit pause/block
    expect(canProposePlan("running", true)).toBe(false);
    expect(canProposePlan("paused", true)).toBe(true);
    expect(canProposePlan("blocked", true)).toBe(true);
  });
});

describe("deriveGoalStatusFromChildren", () => {
  it("returns null when there are no children yet", () => {
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: [], openBlockers: 0, awaitingApproval: false, acceptanceMet: false }),
    ).toBeNull();
  });

  it("completed only when all children terminal AND acceptance met", () => {
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: ["done", "cancelled"], openBlockers: 0, awaitingApproval: false, acceptanceMet: true }),
    ).toBe("completed");
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: ["done"], openBlockers: 0, awaitingApproval: false, acceptanceMet: false }),
    ).toBe("blocked");
  });

  it("prioritizes awaiting_approval, then blocked, else running", () => {
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: ["running"], openBlockers: 0, awaitingApproval: true, acceptanceMet: false }),
    ).toBe("awaiting_approval");
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: ["running"], openBlockers: 2, awaitingApproval: false, acceptanceMet: false }),
    ).toBe("blocked");
    expect(
      deriveGoalStatusFromChildren({ taskStatuses: ["running", "done"], openBlockers: 0, awaitingApproval: false, acceptanceMet: false }),
    ).toBe("running");
  });
});

describe("goal/plan schemas", () => {
  it("parse a representative goal and plan", () => {
    const goal = GoalSchema.parse({
      id: "goal_1",
      organization_id: "org_default",
      project_id: "proj_artoo",
      room_id: "room_goal_1",
      owner_user_id: "user_1",
      title: "Ship V3",
      objective: "make it a product",
      priority: "p1",
      status: "draft",
      acceptance_criteria: ["all gates green"],
      stop_conditions: { rules: [] },
      budgets: { max_elapsed_ms: 3_600_000, max_retries: 5, max_cost_usd: null, max_concurrent_runs: null, allowed_runtimes: null },
      current_plan_id: null,
      running_since: null,
      elapsed_cost_usd: null,
      retry_count: 0,
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z",
    });
    expect(goal.status).toBe("draft");

    const plan = PlanSchema.parse({
      id: "plan_1",
      organization_id: "org_default",
      goal_id: "goal_1",
      version: 1,
      author_type: "agent",
      author_id: "SkywalkerClaude",
      rationale: "first plan",
      status: "proposed",
      task_specs: [
        { title: "scaffold", dependencies: [], required_capabilities: ["code.modify"], approval_gates: [], write_scopes: [], expected_artifacts: [] },
        { title: "wire", dependencies: [{ ref: "0", type: "blocks" }] },
      ],
      materialized_at: null,
      materialization_event_id: null,
      created_at: "2026-06-25T00:00:00.000Z",
      accepted_at: null,
    });
    expect(plan.task_specs).toHaveLength(2);
    expect(plan.task_specs[1]!.dependencies[0]!.ref).toBe("0");
  });
});
