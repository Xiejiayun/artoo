import { agentInstances, eventLog, goals, runs, tasks } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGoal, getGoal, pauseGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";
import { failRunDaemonDisconnect, ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";

describe("goal scheduling budget boundaries", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });

  async function goalTasks(budgets: Record<string, unknown>, count = 1) {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Budget boundary", budgets });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: Array.from({ length: count }, (_, i) => ({
      title: `Task ${i}`, acceptance_criteria: ["verified"], required_capabilities: ["code.modify"], dependencies: [],
    })) });
    const taskIds = (await acceptPlan(server.ctx, plan.id)).task_ids;
    for (const taskId of taskIds) await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    return { goalId: goal.id, taskIds };
  }
  const assign = (taskId: string) => server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
  const retry = (taskId: string) => server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/retry` });
  const changes = (taskId: string) => server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`, payload: { outcome: "changes_requested" } });
  async function finish(runId: string, phase: "completed" | "failed") {
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase } });
  }

  it("serializes concurrent assignments at the goal limit and frees capacity on terminal state", async () => {
    const { goalId, taskIds } = await goalTasks({ max_concurrent_runs: 1 }, 2);
    // Give the worker spare capacity so only the goal limit can reject a start.
    await server.db.db.update(agentInstances).set({ config: { concurrency_limit: 4 } });
    const results = await Promise.all(taskIds.map(assign));
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const rejectedIndex = results.findIndex((res) => res.statusCode === 409);
    expect(results[rejectedIndex]!.json().error.details.budget).toBe("max_concurrent_runs");
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
    expect((await getGoal(server.ctx, goalId))?.status).toBe("running");
    await finish(results.find((res) => res.statusCode === 200)!.json().run.id as string, "completed");
    expect((await assign(taskIds[rejectedIndex]!)).statusCode).toBe(200);
  });

  it("allows the last permitted retry to run, then rejects a prospective excess", async () => {
    const { goalId, taskIds: [taskId] } = await goalTasks({ max_retries: 1 });
    await finish((await assign(taskId!)).json().run.id as string, "failed");
    expect((await retry(taskId!)).statusCode).toBe(200);
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    const last = await assign(taskId!);
    expect(last.statusCode).toBe(200);
    await finish(last.json().run.id as string, "failed");
    const blocked = await retry(taskId!);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details.budget).toBe("max_retries");
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, taskId!)))[0]?.status).toBe("blocked");
  });

  it("counts disconnected writers until their held leases are released by confirmed exit", async () => {
    const { taskIds } = await goalTasks({ max_concurrent_runs: 1 }, 2);
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[0]}/assign`, payload: { mode: "auto", write_paths: ["src/**"] } });
    const runId = response.json().run.id as string;
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await failRunDaemonDisconnect(server.ctx, runId, "computer_local_mock");
    const denied = await assign(taskIds[1]!);
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.details.budget).toBe("max_concurrent_runs");
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase: "cancelled" } });
    expect((await assign(taskIds[1]!)).statusCode).toBe(200);
  });

  it("rejects request changes at a zero retry limit without changing review state", async () => {
    const { goalId, taskIds: [taskId] } = await goalTasks({ max_retries: 0 });
    await finish((await assign(taskId!)).json().run.id as string, "completed");
    expect((await changes(taskId!)).statusCode).toBe(409);
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(0);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, taskId!)))[0]?.status).toBe("review");
  });

  it("blocks paused retries and review changes while allowing accepted review", async () => {
    const { goalId, taskIds } = await goalTasks({}, 2);
    await finish((await assign(taskIds[0]!)).json().run.id as string, "failed");
    await finish((await assign(taskIds[1]!)).json().run.id as string, "completed");
    await pauseGoal(server.ctx, goalId);
    expect((await retry(taskIds[0]!)).statusCode).toBe(409);
    expect((await changes(taskIds[1]!)).statusCode).toBe(409);
    const accepted = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskIds[1]}/review`, payload: { outcome: "accepted" } });
    expect(accepted.statusCode).toBe(200);
  });

  it("checks the elapsed deadline before assignment, retry and request changes, without a timer", async () => {
    const { taskIds } = await goalTasks({ max_elapsed_ms: 1000 }, 3);
    await server.db.db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, taskIds[1]!));
    await server.db.db.update(tasks).set({ status: "review" }).where(eq(tasks.id, taskIds[2]!));
    server.ctx.clock = fixedClock(new Date(Date.parse(server.ctx.clock.nowIso()) + 1000).toISOString());
    for (const response of [await assign(taskIds[0]!), await retry(taskIds[1]!), await changes(taskIds[2]!)]) {
      expect(response.statusCode).toBe(409);
      expect(response.json().error.details.budget).toBe("max_elapsed_ms");
    }
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it.each([
    { budgets: { max_cost_usd: 1 } },
    ...["custom", "approval_timeout", "consecutive_failures"].map((type) => ({ stop_conditions: { rules: [{ type, action: "pause", threshold: 1 }] } })),
    ...["cancel", "notify"].map((action) => ({ stop_conditions: { rules: [{ type: "budget_exceeded", action, threshold: 1 }] } })),
  ])("rejects unsupported budget policy at API creation: %j", async (policy) => {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: "proj_artoo", title: "Unsupported", ...policy } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    expect(await server.db.db.select().from(goals)).toHaveLength(0);
  });

  it("rejects unsupported cost or stop rules restored from an older database at execution", async () => {
    const { goalId, taskIds: [taskId] } = await goalTasks({});
    await server.db.db.update(goals).set({ budgets: { max_cost_usd: 1 } }).where(eq(goals.id, goalId));
    expect((await assign(taskId!)).statusCode).toBe(400);
    await server.db.db.update(goals).set({ budgets: {}, stopConditions: { rules: [{ type: "custom", action: "notify", threshold: "anything" }] } }).where(eq(goals.id, goalId));
    expect((await assign(taskId!)).statusCode).toBe(400);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });

  it("the live elapsed monitor pauses once while an active run drains", async () => {
    await server.close();
    server = await buildTestServer({ budgetMonitorIntervalMs: 10 });
    const { goalId, taskIds } = await goalTasks({ max_elapsed_ms: 1000 }, 2);
    const runId = (await assign(taskIds[0]!)).json().run.id as string;
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    server.ctx.clock = fixedClock(new Date(Date.parse(server.ctx.clock.nowIso()) + 1000).toISOString());
    await expect.poll(async () => (await getGoal(server.ctx, goalId))?.status).toBe("paused");
    expect((await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe("running");
    expect((await assign(taskIds[1]!)).statusCode).toBe(409);
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase: "completed" } });
    expect((await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]?.status).toBe("completed");
    const events = await server.db.db.select().from(eventLog).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.budget_exceeded")));
    expect(events).toHaveLength(1);
  });
});
