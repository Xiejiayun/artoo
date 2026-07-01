// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * V3 #115 P1e — goal/plan REST routes. Thin handlers over goal-service /
 * plan-service: create/list/get goal, pause/resume/cancel, propose/accept/reject
 * plan (accept materializes the DAG), validation (400) and not-found (404).
 */
describe("goal + plan routes #115", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  async function createGoal(title = "Ship V3"): Promise<string> {
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { project_id: "proj_artoo", title },
    });
    expect(res.statusCode).toBe(201);
    return res.json().goal.id as string;
  }

  const TWO_SPECS = [
    { title: "build", acceptance_criteria: ["build completes"], dependencies: [] },
    { title: "test", acceptance_criteria: ["tests pass"], dependencies: [{ ref: "0", type: "blocks" }] },
  ];

  it("creates, lists, and gets a goal", async () => {
    const goalId = await createGoal();
    const goal = (await server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}` })).json().goal;
    expect(goal.status).toBe("draft");
    expect(goal.room_id).not.toBeNull();

    const list = await server.app.inject({ method: "GET", url: "/api/v1/goals?project_id=proj_artoo" });
    expect((list.json().goals as { id: string }[]).map((g) => g.id)).toContain(goalId);

    expect((await server.app.inject({ method: "GET", url: "/api/v1/goals/goal_nope" })).statusCode).toBe(404);
  });

  it("rejects an invalid goal payload with 400", async () => {
    const res = await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: "proj_artoo" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid plan payload with 400", async () => {
    const goalId = await createGoal("bad plan");
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/goals/${goalId}/plans`,
      payload: { task_specs: [{ title: "missing criteria", dependencies: [] }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("proposes a plan and accept materializes it into a running goal", async () => {
    const goalId = await createGoal();
    const proposed = await server.app.inject({
      method: "POST",
      url: `/api/v1/goals/${goalId}/plans`,
      payload: { task_specs: TWO_SPECS, rationale: "v1" },
    });
    expect(proposed.statusCode).toBe(201);
    const planId = proposed.json().plan.id as string;
    expect(proposed.json().plan.version).toBe(1);

    const accepted = await server.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/accept` });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().task_ids).toHaveLength(2);
    expect(accepted.json().plan.materialized_at).not.toBeNull();

    const goal = (await server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}` })).json().goal;
    expect(goal.status).toBe("running");
    expect(goal.current_plan_id).toBe(planId);

    const plans = await server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}/plans` });
    expect(plans.json().plans).toHaveLength(1);
    const detail = await server.app.inject({ method: "GET", url: `/api/v1/plans/${planId}` });
    expect(detail.json().plan.status).toBe("accepted");

    const firstTaskId = (accepted.json().task_ids as string[])[0]!;
    const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${firstTaskId}/ready` });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().task.status).toBe("ready");
  });

  it("rejects a plan via the route", async () => {
    const goalId = await createGoal("reject me");
    const planId = (
      await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/plans`, payload: { task_specs: TWO_SPECS } })
    ).json().plan.id as string;
    const rejected = await server.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/reject` });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().plan.status).toBe("rejected");
  });

  it("exposes goal checkpoints via the read routes (#115 P2-S1)", async () => {
    const goalId = await createGoal("checkpoint me");
    const planId = (
      await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/plans`, payload: { task_specs: TWO_SPECS } })
    ).json().plan.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/accept` });

    const list = await server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}/checkpoints` });
    expect(list.statusCode).toBe(200);
    const cps = list.json().checkpoints as { id: string; type: string }[];
    expect(cps.some((c) => c.type === "dag_materialized")).toBe(true);

    const one = await server.app.inject({ method: "GET", url: `/api/v1/checkpoints/${cps[0]!.id}` });
    expect(one.statusCode).toBe(200);
    expect(one.json().checkpoint.id).toBe(cps[0]!.id);

    expect((await server.app.inject({ method: "GET", url: "/api/v1/checkpoints/ckpt_nope" })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/goals/goal_nope/checkpoints" })).statusCode).toBe(404);
  });

  it("reconciles a goal from its latest checkpoint via the route (#115 P2-S2)", async () => {
    const goalId = await createGoal("reconcile me");
    const planId = (
      await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/plans`, payload: { task_specs: TWO_SPECS } })
    ).json().plan.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/plans/${planId}/accept` });

    const res = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/reconcile` });
    expect(res.statusCode).toBe(200);
    expect(res.json().reconciled).toBe(true);
    expect(res.json().checkpoint_id).not.toBeNull();
    expect(res.json().opened_blocker_ids).toEqual([]);

    expect((await server.app.inject({ method: "POST", url: "/api/v1/goals/goal_nope/reconcile" })).statusCode).toBe(404);
  });

  it("cancel works on a draft goal; pause on a draft goal is an invalid-state error", async () => {
    const goalId = await createGoal("cancel me");
    const cancelled = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goalId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().goal.status).toBe("cancelled");

    const goal2 = await createGoal("pause me");
    const paused = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goal2}/pause` });
    expect(paused.statusCode).toBe(409); // invalid_state
  });

  it("404s pause/accept on unknown ids", async () => {
    expect((await server.app.inject({ method: "POST", url: "/api/v1/goals/goal_nope/pause" })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/plans/plan_nope/accept" })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/goals/goal_nope/plans" })).statusCode).toBe(404);
  });
});
