import { checkpoints, eventLog } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { getCheckpoint, listCheckpoints } from "./checkpoint-service.js";
import { createGoal, getGoal, pauseGoal, resumeGoal } from "./goal-service.js";
import { acceptPlan, materializePlan, proposePlan } from "./plan-service.js";

const TWO_SPECS = [
  { title: "build", acceptance_criteria: ["built"], dependencies: [] },
  { title: "test", acceptance_criteria: ["tested"], dependencies: [{ ref: "0", type: "blocks" }] },
];

describe("checkpoint-service #115 P2-S1", () => {
  let server: TestServer;
  let goalId: string;

  beforeEach(async () => {
    server = await buildTestServer();
    goalId = (await createGoal(server.ctx, { project_id: "proj_artoo", title: "G" })).id;
  });
  afterEach(async () => {
    await server.close();
  });

  async function rows(type?: string) {
    const where =
      type === undefined
        ? eq(checkpoints.organizationId, "org_default")
        : and(eq(checkpoints.organizationId, "org_default"), eq(checkpoints.type, type));
    return server.db.db.select().from(checkpoints).where(where);
  }

  it("materialize writes one dag_materialized checkpoint, atomic + ref-only + linked", async () => {
    const { ctx } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    const result = await acceptPlan(ctx, plan.id);

    const dag = await rows("dag_materialized");
    expect(dag).toHaveLength(1);
    const cp = dag[0]!;
    expect(cp.goalId).toBe(goalId);
    expect(cp.planId).toBe(plan.id);
    // Linked to the materialization event.
    expect(cp.triggerEventId).toBe(result.plan.materialization_event_id);

    // Ref-only: state_refs holds ids/summaries, not copies of runs/tasks.
    const refs = cp.stateRefs as Record<string, unknown>;
    expect(refs.goal_status).toBe("running");
    expect(refs.plan_version).toBe(1);
    expect((refs.task_statuses as unknown[])).toHaveLength(2);
    expect(Array.isArray(refs.active_runs)).toBe(true);
    expect(typeof refs.event_cursor).toBe("number");
    expect((refs.event_cursor as number)).toBeGreaterThan(0);
    // Cursor is explainable: ≥ the position of the materialization event.
    const matEvt = (
      await server.db.db.select().from(eventLog).where(eq(eventLog.id, result.plan.materialization_event_id!))
    )[0]!;
    expect(refs.event_cursor).toBeGreaterThanOrEqual(matEvt.position);

    // A goal.checkpoint_created event accompanies it.
    const created = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.checkpoint_created")));
    expect(created.some((e) => (e.payload as { checkpoint_id: string }).checkpoint_id === cp.id)).toBe(true);
  });

  it("materialize re-entry does not duplicate the dag_materialized checkpoint", async () => {
    const { ctx } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    await acceptPlan(ctx, plan.id);
    await materializePlan(ctx, plan.id); // re-entrant
    await acceptPlan(ctx, plan.id); // re-entrant
    expect(await rows("dag_materialized")).toHaveLength(1);
  });

  it("pause/resume write checkpoints linked to the goal.paused/resumed events", async () => {
    const { ctx, db } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    await acceptPlan(ctx, plan.id); // goal running

    await pauseGoal(ctx, goalId);
    expect((await getGoal(ctx, goalId))?.status).toBe("paused");
    const pausedEvt = (
      await db.db.select().from(eventLog).where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.paused")))
    )[0]!;
    const pausedCp = (await rows("paused"))[0]!;
    expect(pausedCp.triggerEventId).toBe(pausedEvt.id);
    expect((pausedCp.stateRefs as { goal_status: string }).goal_status).toBe("paused");

    await resumeGoal(ctx, goalId);
    const resumedEvt = (
      await db.db.select().from(eventLog).where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.resumed")))
    )[0]!;
    const resumedCp = (await rows("resumed"))[0]!;
    expect(resumedCp.triggerEventId).toBe(resumedEvt.id);
    expect((resumedCp.stateRefs as { goal_status: string }).goal_status).toBe("running");
  });

  it("lists a goal's checkpoints latest-first and gets one by id (org/goal scoped)", async () => {
    const { ctx } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    await acceptPlan(ctx, plan.id);
    await pauseGoal(ctx, goalId);

    const list = await listCheckpoints(ctx, goalId);
    expect(list.length).toBe(2);
    expect(list[0]!.type).toBe("paused"); // latest first
    expect(list[1]!.type).toBe("dag_materialized");

    const one = await getCheckpoint(ctx, list[0]!.id);
    expect(one?.id).toBe(list[0]!.id);

    // Another goal's checkpoints are not visible here.
    const other = await createGoal(ctx, { project_id: "proj_artoo", title: "G2" });
    expect(await listCheckpoints(ctx, other.id)).toHaveLength(0);
  });

  it("listCheckpoints 404s an unknown goal", async () => {
    await expect(listCheckpoints(server.ctx, "goal_nope")).rejects.toThrow(/goal not found/i);
  });
});
