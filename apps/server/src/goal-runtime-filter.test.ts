// @vitest-environment node
import { goals, organizations, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
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

  async function assign(taskId: string, payload: Record<string, unknown> = { mode: "auto" }) {
    return server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload });
  }

  it("assigns when the instance runtime is in allowed_runtimes", async () => {
    const taskId = await goalTaskReady({ allowed_runtimes: ["mock"] });
    const res = await assign(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().run.runtime_id).toBe("mock");
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

  it("applies the same budget filter to a manual pinned instance", async () => {
    const taskId = await goalTaskReady({ allowed_runtimes: ["claude-code"] });
    const res = await assign(taskId, { mode: "manual", agent_instance_id: "instance_mock_coder" });
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe("runtime_unavailable");
    expect(err.details.reason).toBe("goal_allowed_runtimes");
    expect(err.details.allowed_runtimes).toEqual(["claude-code"]);
  });

  it("leaves scheduling unchanged when the goal has no allowed_runtimes budget", async () => {
    const taskId = await goalTaskReady({ max_retries: 5 }); // budget present, but no allowed_runtimes
    expect((await assign(taskId)).statusCode).toBe(200);
  });

  it("does not trust a cross-org task.goal_id when loading allowed_runtimes", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "plain", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
    });
    const taskId = created.json().task.id as string;
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other Org", createdAt: now });
    await server.db.db.insert(goals).values({
      id: "goal_cross_org_budget",
      organizationId: "org_other",
      projectId: "proj_artoo",
      ownerUserId: "user_owner",
      title: "cross-org",
      objective: "",
      status: "running",
      budgets: { allowed_runtimes: ["claude-code"] },
      createdAt: now,
      updatedAt: now,
    });
    await server.db.db.update(tasks).set({ goalId: "goal_cross_org_budget" }).where(eq(tasks.id, taskId));
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const res = await assign(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().run.runtime_id).toBe("mock");
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
