// @vitest-environment node
import { goals, organizations, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";
import { failRunStart } from "./services/run-service.js";

const SPECS = [
  { title: "build", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] },
];

/**
 * #115 P3b-2 — a genuine task retry on a goal-linked task consumes the goal's
 * retry budget: `retry` (blocked→ready) and review `request_changes`
 * (review→ready) each bump the linked goal's retry_count by exactly one, only
 * after the task transition's compare-and-set actually changed. Accepts, ordinary
 * run failures, no-goal tasks, and stale/duplicate retries never increment.
 */
describe("goal retry_count tracking #115 P3b-2", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** A running goal (draft→planned→running via first-plan accept) + its first task. */
  async function goalTask(): Promise<{ goalId: string; taskId: string }> {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: SPECS });
    const taskId = (await acceptPlan(server.ctx, plan.id)).task_ids[0]!;
    return { goalId: goal.id, taskId };
  }

  async function retryCount(goalId: string): Promise<number> {
    const row = (await server.db.db.select().from(goals).where(eq(goals.id, goalId)))[0]!;
    return row.retryCount;
  }

  async function taskStatus(taskId: string): Promise<string> {
    const row = (await server.db.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]!;
    return row.status;
  }

  const ready = (taskId: string) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assign = (taskId: string) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
  const mockExecute = (runId: string, query = "") =>
    server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute${query}` });
  const review = (taskId: string, payload: Record<string, unknown>) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/review`, payload });
  const retry = (taskId: string) =>
    server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/retry` });

  /** Drive a task to review via a completed mock run. */
  async function toReview(taskId: string): Promise<void> {
    await ready(taskId);
    const runId = (await assign(taskId)).json().run.id as string;
    await mockExecute(runId);
  }

  /** Drive a task to blocked via a failed mock run. */
  async function toBlocked(taskId: string): Promise<void> {
    await ready(taskId);
    const runId = (await assign(taskId)).json().run.id as string;
    await mockExecute(runId, "?outcome=failed");
  }

  it("increments once on a `retry` (blocked→ready) of a goal-linked task", async () => {
    const { goalId, taskId } = await goalTask();
    await toBlocked(taskId);
    expect(await retryCount(goalId)).toBe(0); // ordinary run failure (→blocked) does NOT count

    const res = await retry(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("ready");
    expect(await retryCount(goalId)).toBe(1);
  });

  it("increments once on a `request_changes` review (review→ready) of a goal-linked task", async () => {
    const { goalId, taskId } = await goalTask();
    await toReview(taskId);
    expect(await retryCount(goalId)).toBe(0);

    const res = await review(taskId, { outcome: "changes_requested", comment: "tweak" });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("ready");
    expect(await retryCount(goalId)).toBe(1);
  });

  it("does NOT increment on an accepted review", async () => {
    const { goalId, taskId } = await goalTask();
    await toReview(taskId);
    const res = await review(taskId, { outcome: "accepted" });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("done");
    expect(await retryCount(goalId)).toBe(0);
  });

  it("does NOT double-count a stale/duplicate retry", async () => {
    const { goalId, taskId } = await goalTask();
    await toBlocked(taskId);
    expect((await retry(taskId)).statusCode).toBe(200); // blocked→ready, +1
    expect(await retryCount(goalId)).toBe(1);

    // Task is now `ready`; a second retry can't transition → 4xx, no extra increment.
    const stale = await retry(taskId);
    expect(stale.statusCode).toBeGreaterThanOrEqual(400);
    expect(await retryCount(goalId)).toBe(1);
  });

  it("counts across multiple genuine retries of the same goal", async () => {
    const { goalId, taskId } = await goalTask();
    await toBlocked(taskId);
    await retry(taskId); // +1
    // Re-drive: assign a fresh run, fail it, retry again.
    const runId = (await assign(taskId)).json().run.id as string;
    await mockExecute(runId, "?outcome=failed");
    await retry(taskId); // +1
    expect(await retryCount(goalId)).toBe(2);
  });

  it("does NOT touch any goal when retrying a task with no goal", async () => {
    const { goalId } = await goalTask(); // an unrelated running goal, retry_count 0
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "plain", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
    });
    const taskId = created.json().task.id as string;
    await toBlocked(taskId);
    const res = await retry(taskId);
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("ready");
    // The goal-less retry cannot bump any goal's counter.
    expect(await retryCount(goalId)).toBe(0);
  });

  it("does NOT increment on assign_failed_retryable infrastructure recovery", async () => {
    const { goalId, taskId } = await goalTask();
    await ready(taskId);
    const runId = (await assign(taskId)).json().run.id as string;

    await failRunStart(server.ctx, runId, "process_start_failed", "adapter rejected");

    expect(await taskStatus(taskId)).toBe("ready");
    expect(await retryCount(goalId)).toBe(0);
  });

  it("does NOT increment a cross-org goal referenced by task.goal_id", async () => {
    const { taskId } = await goalTask();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other Org", createdAt: now });
    await server.db.db.insert(goals).values({
      id: "goal_cross_org_retry",
      organizationId: "org_other",
      projectId: "proj_artoo",
      ownerUserId: "user_owner",
      title: "cross-org",
      objective: "",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await server.db.db.update(tasks).set({ goalId: "goal_cross_org_retry" }).where(eq(tasks.id, taskId));

    await toBlocked(taskId);
    const res = await retry(taskId);

    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("ready");
    expect(await retryCount("goal_cross_org_retry")).toBe(0);
  });
});
