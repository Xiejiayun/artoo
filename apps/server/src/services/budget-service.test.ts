import { checkpoints, eventLog, goals } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { enforceGoalBudget } from "./budget-service.js";
import { cancelGoal, createGoal, getGoal, pauseGoal } from "./goal-service.js";
import { acceptPlan, proposePlan } from "./plan-service.js";
import { ingestRunEvent } from "./run-service.js";

const SPECS = [{ title: "build", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] }];

describe("budget-service #115 P3a", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** A running goal (draft→planned→running via first-plan accept) with budgets. */
  async function runningGoal(budgets: Record<string, unknown>): Promise<{ goalId: string; taskIds: string[] }> {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G", budgets });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: SPECS });
    const result = await acceptPlan(server.ctx, plan.id);
    return { goalId: goal.id, taskIds: result.task_ids };
  }

  async function budgetEvents(goalId: string) {
    return server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.budget_exceeded"), eq(eventLog.goalId, goalId)));
  }
  async function pausedCheckpoints(goalId: string) {
    return server.db.db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.organizationId, "org_default"), eq(checkpoints.goalId, goalId), eq(checkpoints.type, "paused")));
  }

  it("pauses once on elapsed budget exceeded, with checkpoint + event; duplicate is a no-op", async () => {
    const { ctx } = server;
    const { goalId } = await runningGoal({ max_elapsed_ms: 1000 });
    // Backdate running_since so elapsed exceeds the budget under the fixed clock.
    const past = new Date(Date.parse(ctx.clock.nowIso()) - 3_600_000).toISOString();
    await server.db.db.update(goals).set({ runningSince: past }).where(eq(goals.id, goalId));

    const first = await enforceGoalBudget(ctx, goalId);
    expect(first.enforced).toBe(true);
    expect(first.violations?.some((v) => v.budget === "max_elapsed_ms")).toBe(true);
    expect((await getGoal(ctx, goalId))?.status).toBe("paused");
    expect(await budgetEvents(goalId)).toHaveLength(1);
    expect(await pausedCheckpoints(goalId)).toHaveLength(1);

    // Duplicate enforcement: goal already paused → no-op, no duplicate event/checkpoint.
    const second = await enforceGoalBudget(ctx, goalId);
    expect(second.enforced).toBe(false);
    expect(await budgetEvents(goalId)).toHaveLength(1);
    expect(await pausedCheckpoints(goalId)).toHaveLength(1);
  });

  it("pauses on retry budget exceeded", async () => {
    const { ctx } = server;
    const { goalId } = await runningGoal({ max_retries: 2 });
    await server.db.db.update(goals).set({ retryCount: 5 }).where(eq(goals.id, goalId));
    const res = await enforceGoalBudget(ctx, goalId);
    expect(res.enforced).toBe(true);
    expect(res.violations?.some((v) => v.budget === "max_retries")).toBe(true);
    expect((await getGoal(ctx, goalId))?.status).toBe("paused");
  });

  it("no-op when budget is not exceeded", async () => {
    const { ctx } = server;
    const { goalId } = await runningGoal({ max_elapsed_ms: 999_999_999, max_retries: 100 });
    const res = await enforceGoalBudget(ctx, goalId);
    expect(res.enforced).toBe(false);
    expect((await getGoal(ctx, goalId))?.status).toBe("running");
    expect(await budgetEvents(goalId)).toHaveLength(0);
  });

  it("no-op for a paused or terminal goal", async () => {
    const { ctx } = server;
    const { goalId } = await runningGoal({ max_retries: 0 });
    await server.db.db.update(goals).set({ retryCount: 5 }).where(eq(goals.id, goalId));
    await pauseGoal(ctx, goalId); // now paused (human)
    expect((await enforceGoalBudget(ctx, goalId)).enforced).toBe(false);
    expect(await budgetEvents(goalId)).toHaveLength(0);

    const cancelled = await createGoal(ctx, { project_id: "proj_artoo", title: "C" });
    await cancelGoal(ctx, cancelled.id);
    expect((await enforceGoalBudget(ctx, cancelled.id)).enforced).toBe(false);
  });

  it("no-op for an unknown / cross-org goal", async () => {
    expect((await enforceGoalBudget(server.ctx, "goal_nope")).enforced).toBe(false);
    const { goalId } = await runningGoal({ max_retries: 0 });
    await server.db.db.update(goals).set({ retryCount: 5 }).where(eq(goals.id, goalId));
    expect((await enforceGoalBudget({ ...server.ctx, organizationId: "org_other" }, goalId)).enforced).toBe(false);
    expect((await getGoal(server.ctx, goalId))?.status).toBe("running"); // untouched
  });

  it("the run-lifecycle hook enforces the budget after a terminal run event", async () => {
    const { ctx } = server;
    const { goalId, taskIds } = await runningGoal({ max_retries: 1 });
    await server.db.db.update(goals).set({ retryCount: 5 }).where(eq(goals.id, goalId)); // over budget

    // Drive the goal's first task to a running run, then complete it.
    const taskId = taskIds[0]!;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    const runId = assigned.json().run.id as string;
    await ingestRunEvent(ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(ctx, { runId, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase: "completed" } });

    // The completed-event hook enforced the (exceeded) budget → goal paused.
    expect((await getGoal(ctx, goalId))?.status).toBe("paused");
    expect(await budgetEvents(goalId)).toHaveLength(1);
  });
});
