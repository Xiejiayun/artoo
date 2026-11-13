import { goals, organizations, projects, users } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestServer, type TestServer } from "../test-support.js";
import { startGoalBudgetMonitor } from "./budget-service.js";
import { observeGoalBudgetActivity } from "./budget-monitor-wake.js";
import { createGoal, getGoal, pauseGoal, resumeGoal } from "./goal-service.js";
import { acceptPlan, materializePlan, proposePlan } from "./plan-service.js";

const specs = [{ title: "work", acceptance_criteria: ["verified"], required_capabilities: ["code.modify"], dependencies: [] }];
describe("committed budget monitor activity", () => {
  let server: TestServer;
  const cleanup: (() => void | Promise<void>)[] = [];
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    vi.restoreAllMocks();
    await server.close();
  });
  async function planned(budgets: Record<string, unknown> = {}) {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Monitor activity", budgets });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: specs });
    return { goal, plan };
  }

  it("wakes only after successful start/resume commits, including standalone materialization", async () => {
    const wake = vi.fn();
    cleanup.push(observeGoalBudgetActivity(server.ctx.db, wake));
    const { goal, plan } = await planned({ max_elapsed_ms: 1000 });
    expect(wake).not.toHaveBeenCalled();
    await acceptPlan(server.ctx, plan.id);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await getGoal(server.ctx, goal.id))?.status).toBe("running");
    await pauseGoal(server.ctx, goal.id);
    expect(wake).toHaveBeenCalledTimes(1);
    await resumeGoal(server.ctx, goal.id);
    expect(wake).toHaveBeenCalledTimes(2);
    await materializePlan(server.ctx, plan.id);
    expect(wake).toHaveBeenCalledTimes(3);
    await expect(resumeGoal(server.ctx, goal.id)).rejects.toThrow();
    await expect(acceptPlan(server.ctx, "missing")).rejects.toThrow();
    expect(wake).toHaveBeenCalledTimes(3);
    const rollback = await planned();
    // A materialization error rolls back an otherwise eligible acceptance.
    const original = server.ctx.idGen;
    server.ctx.idGen = { generate: () => { throw new Error("controlled task ID failure"); } };
    await expect(acceptPlan(server.ctx, rollback.plan.id)).rejects.toThrow("controlled task ID failure");
    server.ctx.idGen = original;
    expect((await getGoal(server.ctx, rollback.goal.id))?.status).toBe("draft");
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("skips unlimited goals but re-reads supported budgets and enforces across organizations", async () => {
    const unlimited = await planned();
    await acceptPlan(server.ctx, unlimited.plan.id);
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "other", name: "Other", createdAt: now });
    await server.db.db.insert(users).values({ id: "other_user", organizationId: "other", email: "other@example.test", role: "owner", displayName: "Other", createdAt: now });
    await server.db.db.insert(projects).values({ id: "other_project", organizationId: "other", name: "Other", createdAt: now });
    await server.db.db.insert(goals).values({ id: "other_goal", organizationId: "other", projectId: "other_project", ownerUserId: "other_user",
      title: "Other budget", status: "running", budgets: { max_retries: 0 }, retryCount: 1, createdAt: now, updatedAt: now });
    const transaction = vi.spyOn(server.db, "transaction");
    const errors = vi.fn();
    const monitor = startGoalBudgetMonitor(server.ctx, { intervalMs: 10, idleMaxIntervalMs: 1000, onError: errors });
    cleanup.push(() => monitor.stop());
    await expect.poll(async () => (await server.db.db.select().from(goals).where(eq(goals.id, "other_goal")))[0]?.status).toBe("paused");
    await monitor.stop();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect((await getGoal(server.ctx, unlimited.goal.id))?.status).toBe("running");
  });

  it("wakes an idle monitor for a resumed elapsed deadline and preserves the exact boundary", async () => {
    const { goal, plan } = await planned({ max_elapsed_ms: 1000 });
    await acceptPlan(server.ctx, plan.id);
    await pauseGoal(server.ctx, goal.id);
    await server.db.db.update(goals).set({ runningSince: new Date(Date.parse(server.ctx.clock.nowIso()) - 1000).toISOString() }).where(eq(goals.id, goal.id));
    const monitor = startGoalBudgetMonitor(server.ctx, { intervalMs: 60_000, idleMaxIntervalMs: 60_000 });
    cleanup.push(() => monitor.stop());
    await resumeGoal(server.ctx, goal.id);
    // The timer is a minute away; this must be the post-commit wake.
    await expect.poll(async () => (await getGoal(server.ctx, goal.id))?.status).toBe("paused");
  });

  it("uses the transaction's current policy rather than the scan snapshot", async () => {
    const { goal, plan } = await planned({ max_retries: 0 });
    await acceptPlan(server.ctx, plan.id);
    await server.db.db.update(goals).set({ retryCount: 1 }).where(eq(goals.id, goal.id));
    const original = server.db.transaction.bind(server.db);
    const transaction = vi.spyOn(server.db, "transaction").mockImplementationOnce(async fn => {
      await server.db.db.update(goals).set({ budgets: {} }).where(eq(goals.id, goal.id));
      return original(fn);
    });
    const errors = vi.fn();
    const monitor = startGoalBudgetMonitor(server.ctx, { intervalMs: 10, onError: errors });
    cleanup.push(() => monitor.stop());
    await expect.poll(() => transaction.mock.calls.length).toBe(1);
    await monitor.stop();
    expect(errors).not.toHaveBeenCalled();
    expect((await getGoal(server.ctx, goal.id))?.status).toBe("running");
  });
});
