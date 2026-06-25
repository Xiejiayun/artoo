import { eventLog, goals, rooms } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { cancelGoal, createGoal, getGoal, listGoals, pauseGoal, transitionGoal } from "./goal-service.js";

describe("goal-service #115 P1c", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates a draft goal and auto-creates its goal room (bidirectional link)", async () => {
    const { ctx, db } = server;
    const goal = await createGoal(ctx, {
      project_id: "proj_artoo",
      title: "Ship V3",
      objective: "make it a product",
      priority: "p1",
      acceptance_criteria: ["all gates green"],
      budgets: { max_elapsed_ms: 3_600_000, max_retries: 5 },
    });
    expect(goal.status).toBe("draft");
    expect(goal.id).toMatch(/^goal_/);
    expect(goal.room_id).not.toBeNull();
    expect(goal.budgets.max_retries).toBe(5);

    // The room exists, is type `goal`, and back-links to the goal.
    const room = (await db.db.select().from(rooms).where(eq(rooms.id, goal.room_id!)))[0]!;
    expect(room.type).toBe("goal");
    expect(room.goalId).toBe(goal.id);

    // goal.created event carries the goal_id column + metadata.
    const events = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.created")));
    expect(events).toHaveLength(1);
    expect(events[0]!.goalId).toBe(goal.id);
    expect((events[0]!.payload as { room_id: string }).room_id).toBe(goal.room_id);

    expect(await getGoal(ctx, goal.id)).toEqual(goal);
  });

  it("404s when the project is not in the caller's org", async () => {
    await expect(createGoal(server.ctx, { project_id: "proj_nonexistent", title: "x" })).rejects.toThrow(
      /project not found/,
    );
  });

  it("lists goals filtered by project and status", async () => {
    const { ctx } = server;
    const a = await createGoal(ctx, { project_id: "proj_artoo", title: "A" });
    await createGoal(ctx, { project_id: "proj_artoo", title: "B" });
    await cancelGoal(ctx, a.id);

    expect(await listGoals(ctx, { projectId: "proj_artoo" })).toHaveLength(2);
    expect(await listGoals(ctx, { status: "cancelled" })).toHaveLength(1);
    expect(await listGoals(ctx, { status: "draft" })).toHaveLength(1);
  });

  it("cancels a draft goal and emits goal.cancelled", async () => {
    const { ctx, db } = server;
    const goal = await createGoal(ctx, { project_id: "proj_artoo", title: "to cancel" });
    const cancelled = await cancelGoal(ctx, goal.id);
    expect(cancelled?.status).toBe("cancelled");
    const events = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.cancelled")));
    expect(events[0]!.goalId).toBe(goal.id);
    expect((events[0]!.payload as { to: string }).to).toBe("cancelled");
  });

  it("rejects an illegal transition (pause from draft)", async () => {
    const { ctx } = server;
    const goal = await createGoal(ctx, { project_id: "proj_artoo", title: "no pause" });
    await expect(pauseGoal(ctx, goal.id)).rejects.toThrow(/cannot 'pause'/);
  });

  it("returns null when transitioning a missing goal", async () => {
    expect(await transitionGoal(server.ctx, "goal_missing", "cancel")).toBeNull();
  });
});
