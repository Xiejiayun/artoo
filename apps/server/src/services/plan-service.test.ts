import { eventLog, taskDependencies, tasks } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { createGoal, getGoal } from "./goal-service.js";
import {
  acceptPlan,
  listPlans,
  materializePlan,
  proposePlan,
  rejectPlan,
} from "./plan-service.js";

const TWO_SPECS = [
  { title: "build", acceptance_criteria: ["build completes"], dependencies: [], required_capabilities: ["code.modify"] },
  { title: "test", acceptance_criteria: ["tests pass"], dependencies: [{ ref: "0", type: "blocks" }] },
];

describe("plan-service #115 P1d", () => {
  let server: TestServer;
  let goalId: string;

  beforeEach(async () => {
    server = await buildTestServer();
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G" });
    goalId = goal.id;
  });
  afterEach(async () => {
    await server.close();
  });

  it("proposes a versioned plan and emits goal.plan_proposed", async () => {
    const { ctx, db } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS, rationale: "first" });
    expect(plan.version).toBe(1);
    expect(plan.status).toBe("proposed");
    expect(plan.task_specs).toHaveLength(2);
    const events = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.plan_proposed")));
    expect(events[0]!.goalId).toBe(goalId);

    const p2 = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    expect(p2.version).toBe(2); // monotonic
  });

  it("accept materializes the plan into a task DAG (single flow, full provenance)", async () => {
    const { ctx, db } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    const result = await acceptPlan(ctx, plan.id);

    expect(result.task_ids).toHaveLength(2);
    expect(result.plan.status).toBe("accepted");
    expect(result.plan.materialized_at).not.toBeNull();
    expect(result.plan.materialization_event_id).not.toBeNull();

    // Goal advanced draft → planned → running, current plan set.
    const goal = await getGoal(ctx, goalId);
    expect(goal?.status).toBe("running");
    expect(goal?.current_plan_id).toBe(plan.id);
    expect(goal?.running_since).not.toBeNull();

    // Two tasks, each with provenance; ordered by spec ref.
    const taskRows = await db.db.select().from(tasks).where(eq(tasks.sourcePlanId, plan.id));
    expect(taskRows).toHaveLength(2);
    for (const t of taskRows) {
      expect(t.goalId).toBe(goalId);
      expect(t.sourcePlanId).toBe(plan.id);
      expect(t.status).toBe("backlog");
      expect(t.createdByType).toBe("system");
      expect(t.acceptanceCriteria).toHaveLength(1);
    }
    const refs = taskRows.map((t) => t.sourcePlanSpecRef).sort();
    expect(refs).toEqual(["0", "1"]);

    // One dependency edge: spec0 (prereq) → spec1 (dependent).
    const task0 = taskRows.find((t) => t.sourcePlanSpecRef === "0")!;
    const task1 = taskRows.find((t) => t.sourcePlanSpecRef === "1")!;
    const deps = await db.db.select().from(taskDependencies).where(eq(taskDependencies.toTaskId, task1.id));
    expect(deps).toHaveLength(1);
    expect(deps[0]!.fromTaskId).toBe(task0.id);

    // Materialized tasks are ordinary task-lifecycle tasks: acceptance criteria
    // are copied from the plan, so an unblocked task can be marked ready.
    const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task0.id}/ready` });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().task.status).toBe("ready");

    // Provenance event links goal + plan + created task ids.
    const matEvents = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.plan_materialized")));
    expect(matEvents).toHaveLength(1);
    expect(matEvents[0]!.goalId).toBe(goalId);
    expect((matEvents[0]!.payload as { task_ids: string[] }).task_ids.sort()).toEqual(result.task_ids.sort());
    // The plan's materialization_event_id points at that event.
    expect(result.plan.materialization_event_id).toBe(matEvents[0]!.id);
  });

  it("is idempotent / re-entrant: re-materialize does not duplicate the DAG", async () => {
    const { ctx, db } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    const first = await acceptPlan(ctx, plan.id);
    const again = await materializePlan(ctx, plan.id);
    expect(again.task_ids.sort()).toEqual(first.task_ids.sort());
    // acceptPlan again is also re-entrant.
    const acceptAgain = await acceptPlan(ctx, plan.id);
    expect(acceptAgain.task_ids.sort()).toEqual(first.task_ids.sort());

    const taskRows = await db.db.select().from(tasks).where(eq(tasks.sourcePlanId, plan.id));
    expect(taskRows).toHaveLength(2); // no duplicates
    const matEvents = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.plan_materialized")));
    expect(matEvents).toHaveLength(1); // only materialized once
  });

  it("fails closed on a cyclic plan (rejected at propose, nothing persisted)", async () => {
    const { ctx } = server;
    const cyclic = [
      { title: "a", acceptance_criteria: ["a done"], dependencies: [{ ref: "1", type: "blocks" }] },
      { title: "b", acceptance_criteria: ["b done"], dependencies: [{ ref: "0", type: "blocks" }] },
    ];
    await expect(proposePlan(ctx, goalId, { task_specs: cyclic })).rejects.toThrow(/cycle/i);
    expect(await listPlans(ctx, goalId)).toHaveLength(0);
  });

  it("fails closed on an unknown dependency ref", async () => {
    const { ctx } = server;
    const bad = [{ title: "a", acceptance_criteria: ["a done"], dependencies: [{ ref: "5", type: "blocks" }] }];
    await expect(proposePlan(ctx, goalId, { task_specs: bad })).rejects.toThrow(/unknown dependency ref/i);
  });

  it("rejects task specs without acceptance criteria", async () => {
    const { ctx } = server;
    await expect(
      proposePlan(ctx, goalId, {
        task_specs: [{ title: "untriageable", acceptance_criteria: [], dependencies: [] }],
      }),
    ).rejects.toThrow(/acceptance_criteria/i);
  });

  it("enforces plan/goal state boundaries", async () => {
    const { ctx } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });

    // Cannot materialize a proposed (not accepted) plan directly.
    await expect(materializePlan(ctx, plan.id)).rejects.toThrow(/only an accepted plan/i);

    await acceptPlan(ctx, plan.id); // goal now running
    // Cannot propose another plan while goal is running with an accepted plan.
    await expect(proposePlan(ctx, goalId, { task_specs: TWO_SPECS })).rejects.toThrow(/cannot propose/i);
  });

  it("rejects a proposed plan and emits goal.plan_rejected", async () => {
    const { ctx, db } = server;
    const plan = await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    const rejected = await rejectPlan(ctx, plan.id);
    expect(rejected?.status).toBe("rejected");
    const events = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.plan_rejected")));
    expect(events[0]!.goalId).toBe(goalId);
    // Goal stays draft after a rejection.
    expect((await getGoal(ctx, goalId))?.status).toBe("draft");
  });

  it("scopes plan reads to the org/goal", async () => {
    const { ctx } = server;
    await proposePlan(ctx, goalId, { task_specs: TWO_SPECS });
    const otherGoal = await createGoal(ctx, { project_id: "proj_artoo", title: "G2" });
    expect(await listPlans(ctx, otherGoal.id)).toHaveLength(0);
    await expect(listPlans(ctx, "goal_nope")).rejects.toThrow(/goal not found/i);
  });
});
