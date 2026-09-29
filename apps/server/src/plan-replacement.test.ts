import { artifacts, eventLog, plans, rooms, runs, tasks } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGoal, getGoal, pauseGoal, resumeGoal, transitionGoal } from "./services/goal-service.js";
import { acceptPlan, getPlan, materializePlan, proposePlan } from "./services/plan-service.js";
import { failRunDaemonDisconnect, ingestRunEvent, unconfirmedProcessRunIdsForComputer } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const specs = (count = 1) => Array.from({ length: count }, (_, i) => ({ title: `Task ${i}`, acceptance_criteria: ["verified"], required_capabilities: ["code.modify"], dependencies: [] }));

describe("paused goal plan replacement", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  const post = (url: string, payload: Record<string, unknown> = {}) => server.app.inject({ method: "POST", url, payload });
  async function firstPlan(count = 1) {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Replan safely" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: specs(count) });
    const result = await acceptPlan(server.ctx, plan.id);
    return { goalId: goal.id, planId: plan.id, taskIds: result.task_ids };
  }
  async function runTask(taskId: string, outcome: "completed" | "failed" = "completed") {
    expect((await post(`/api/v1/tasks/${taskId}/ready`)).statusCode).toBe(200);
    const assigned = await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const runId = assigned.json().run.id as string;
    expect((await post(`/api/v1/dev/runs/${runId}/mock-execute?outcome=${outcome}`)).statusCode).toBe(200);
    return runId;
  }

  it("creates bidirectional task rooms for materialized tasks and retains them on idempotent acceptance", async () => {
    const { planId, taskIds } = await firstPlan(2);
    for (const taskId of taskIds) {
      const task = (await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
      expect(task.roomId).not.toBeNull();
      expect((await server.db.db.select().from(rooms).where(eq(rooms.id, task.roomId!)))[0]?.taskId).toBe(taskId);
      expect((await post(`/api/v1/rooms/${task.roomId}/messages`, { body: "Ready for team review" })).statusCode).toBe(201);
    }
    const before = await server.db.db.select().from(rooms);
    expect((await acceptPlan(server.ctx, planId)).task_ids).toEqual(taskIds);
    expect(await server.db.db.select().from(rooms)).toHaveLength(before.length);
  });

  it("keeps executed tasks/artifacts as history, retires unstarted tasks and completes only the current plan", async () => {
    const { goalId, planId, taskIds } = await firstPlan(4);
    await runTask(taskIds[0]!);
    expect((await post(`/api/v1/tasks/${taskIds[0]}/review`, { outcome: "accepted" })).statusCode).toBe(200);
    const reviewedRun = await runTask(taskIds[1]!);
    const failedRun = await runTask(taskIds[2]!, "failed");
    await post(`/api/v1/tasks/${taskIds[3]}/ready`);
    const previousArtifacts = await server.db.db.select().from(artifacts);
    expect(previousArtifacts.length).toBeGreaterThan(0);
    await pauseGoal(server.ctx, goalId);
    const next = await proposePlan(server.ctx, goalId, { task_specs: specs(), rationale: "Revised remaining work" });
    const replacement = await acceptPlan(server.ctx, next.id);
    expect((await getGoal(server.ctx, goalId))?.status).toBe("paused");
    expect((await getPlan(server.ctx, planId))?.status).toBe("superseded");
    const oldTasks = await server.db.db.select().from(tasks).where(eq(tasks.sourcePlanId, planId));
    expect(taskIds.map((id) => oldTasks.find((task) => task.id === id)?.status)).toEqual(["done", "review", "blocked", "cancelled"]);
    expect(await server.db.db.select().from(artifacts)).toEqual(previousArtifacts);
    for (const id of [reviewedRun, failedRun]) expect((await server.app.inject({ url: `/api/v1/runs/${id}` })).statusCode).toBe(200);
    await expect(materializePlan(server.ctx, planId)).rejects.toThrow("only an accepted plan");
    expect((await acceptPlan(server.ctx, next.id)).task_ids).toEqual(replacement.task_ids);
    await resumeGoal(server.ctx, goalId);
    const oldRetry = await post(`/api/v1/tasks/${taskIds[2]}/retry`);
    expect(oldRetry.statusCode).toBe(409);
    expect(oldRetry.json().error.message).toContain("superseded plan");
    expect((await post(`/api/v1/tasks/${taskIds[1]}/review`, { outcome: "changes_requested" })).statusCode).toBe(409);
    await runTask(replacement.task_ids[0]!);
    expect((await post(`/api/v1/tasks/${replacement.task_ids[0]}/review`, { outcome: "accepted" })).statusCode).toBe(200);
    expect((await getGoal(server.ctx, goalId))?.status).toBe("completed");
    const accepted = await server.db.db.select().from(eventLog).where(and(eq(eventLog.goalId, goalId), eq(eventLog.type, "goal.plan_accepted")));
    expect(accepted).toHaveLength(2);
    expect(accepted[1]?.payload).toMatchObject({ previous_plan_id: planId, retired_task_ids: [taskIds[3]] });
  });

  it("rejects live and disconnected executions without leases until the node explicitly confirms absence", async () => {
    const { goalId, planId, taskIds: [taskId] } = await firstPlan();
    await post(`/api/v1/tasks/${taskId}/ready`);
    const runId = (await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" })).json().run.id as string;
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await pauseGoal(server.ctx, goalId);
    const next = await proposePlan(server.ctx, goalId, { task_specs: specs() });
    await expect(acceptPlan(server.ctx, next.id)).rejects.toThrow("confirmed they stopped");
    await failRunDaemonDisconnect(server.ctx, runId, "computer_local_mock");
    await expect(acceptPlan(server.ctx, next.id)).rejects.toThrow("confirmed they stopped");
    expect(await unconfirmedProcessRunIdsForComputer(server.ctx, "computer_local_mock")).toContain(runId);
    expect((await getPlan(server.ctx, planId))?.status).toBe("accepted");
    expect((await getPlan(server.ctx, next.id))?.status).toBe("proposed");
    await failRunDaemonDisconnect(server.ctx, runId, "computer_local_mock", true);
    await failRunDaemonDisconnect(server.ctx, runId, "computer_local_mock", true);
    expect(await unconfirmedProcessRunIdsForComputer(server.ctx, "computer_local_mock")).not.toContain(runId);
    expect((await acceptPlan(server.ctx, next.id)).plan.status).toBe("accepted");
    const proof = await server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, runId), eq(eventLog.type, "run.reconciled")));
    expect(proof).toHaveLength(1);
    expect(proof[0]?.payload).toMatchObject({ process_exit_confirmed: true });
  });

  it("requires explicit pause for a blocked goal and rejects stale proposed versions", async () => {
    const { goalId } = await firstPlan();
    await transitionGoal(server.ctx, goalId, "blocked_detected");
    const second = await proposePlan(server.ctx, goalId, { task_specs: specs() });
    const third = await proposePlan(server.ctx, goalId, { task_specs: specs() });
    await expect(acceptPlan(server.ctx, second.id)).rejects.toThrow("Pause the goal");
    await pauseGoal(server.ctx, goalId);
    await acceptPlan(server.ctx, third.id);
    await expect(acceptPlan(server.ctx, second.id)).rejects.toThrow("newer than the current");
    expect((await getGoal(server.ctx, goalId))?.current_plan_id).toBe(third.id);
  });

  it("rolls back retirement and supersession if replacement materialization fails", async () => {
    const { goalId, planId, taskIds: [taskId] } = await firstPlan();
    await pauseGoal(server.ctx, goalId);
    const next = await proposePlan(server.ctx, goalId, { task_specs: specs() });
    // Simulate a damaged stored spec to exercise the atomic accept/materialize boundary.
    await server.db.db.update(plans).set({ taskSpecs: [{ ...specs()[0], dependencies: [{ ref: "7", type: "blocks" }] }] }).where(eq(plans.id, next.id));
    await expect(acceptPlan(server.ctx, next.id)).rejects.toThrow("unknown dependency ref");
    expect((await getGoal(server.ctx, goalId))?.current_plan_id).toBe(planId);
    expect((await getPlan(server.ctx, planId))?.status).toBe("accepted");
    expect((await getPlan(server.ctx, next.id))?.status).toBe("proposed");
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, taskId!)))[0]?.status).toBe("backlog");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });
});
