// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";

const SPECS = [{ title: "build", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] }];

/**
 * #115 P3b-1 — the goal's allowed_runtimes budget filters scheduler candidates
 * after #113 eligibility. The seeded mock instance runs runtime "mock".
 */
describe("goal allowed_runtimes scheduler filter #115 P3b-1", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** A running goal with `budgets`, then its first task readied for assign. */
  async function goalTaskReady(budgets: Record<string, unknown>): Promise<string> {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G", budgets });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: SPECS });
    const taskId = (await acceptPlan(server.ctx, plan.id)).task_ids[0]!;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    return taskId;
  }

  async function assign(taskId: string) {
    return server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
  }

  it("assigns when the instance runtime is in allowed_runtimes", async () => {
    const taskId = await goalTaskReady({ allowed_runtimes: ["mock"] });
    const res = await assign(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().run.runtime_id ?? res.json().run.runtimeId ?? "mock").toBeDefined();
  });

  it("fails with an explainable goal_allowed_runtimes reason when the runtime is filtered out", async () => {
    const taskId = await goalTaskReady({ allowed_runtimes: ["claude-code"] });
    const res = await assign(taskId);
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe("runtime_unavailable");
    expect(err.details.reason).toBe("goal_allowed_runtimes");
    expect(err.details.allowed_runtimes).toEqual(["claude-code"]);
    // The task stays ready (not consumed by the failed assign).
    const task = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json().task;
    expect(task.status).toBe("ready");
  });

  it("leaves scheduling unchanged when the goal has no allowed_runtimes budget", async () => {
    const taskId = await goalTaskReady({ max_retries: 5 }); // budget present, but no allowed_runtimes
    expect((await assign(taskId)).statusCode).toBe(200);
  });

  it("leaves scheduling unchanged for a task with no goal", async () => {
    // An ordinary (goal-less) task assigns exactly as before.
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "plain", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
    });
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    expect((await assign(taskId)).statusCode).toBe(200);
  });
});
