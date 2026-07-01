import { blockers, checkpoints, eventLog, runs } from "@artoo/db";
import { and, eq, max } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { cancelGoal, createGoal, getGoal } from "./goal-service.js";
import { acceptPlan, proposePlan } from "./plan-service.js";
import { reconcileGoalFromCheckpoint } from "./resume-service.js";

const TWO_SPECS = [
  { title: "build", acceptance_criteria: ["built"], dependencies: [] },
  { title: "test", acceptance_criteria: ["tested"], dependencies: [{ ref: "0", type: "blocks" }] },
];

describe("resume-service #115 P2-S2", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** Create a running goal with a materialized 2-task DAG; return goal + task ids. */
  async function runningGoal(): Promise<{ goalId: string; taskIds: string[] }> {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: TWO_SPECS });
    const result = await acceptPlan(server.ctx, plan.id);
    return { goalId: goal.id, taskIds: result.task_ids };
  }

  async function maxPosition(): Promise<number> {
    const row = (await server.db.db.select({ p: max(eventLog.position) }).from(eventLog))[0];
    return row?.p ?? 0;
  }

  async function insertRunEvent(runId: string): Promise<void> {
    await server.db.db.insert(eventLog).values({
      id: server.ctx.idGen.generate("evt"),
      organizationId: "org_default",
      type: "run.output",
      schemaVersion: "2026-06-11",
      actorType: "system",
      actorId: "node",
      runId,
      correlationId: runId,
      occurredAt: server.ctx.clock.nowIso(),
    });
  }

  async function insertRun(id: string, taskId: string, status: string): Promise<void> {
    await server.db.db.insert(runs).values({
      id,
      organizationId: "org_default",
      taskId,
      computerId: "computer_local_mock",
      agentInstanceId: "instance_mock_coder",
      runtimeId: "mock",
      status,
      createdAt: server.ctx.clock.nowIso(),
    });
  }

  async function putCheckpoint(goalId: string, activeRuns: string[], eventCursor: number): Promise<void> {
    // Clear the auto (dag_materialized) checkpoint so ours is the latest.
    await server.db.db.delete(checkpoints).where(eq(checkpoints.goalId, goalId));
    await server.db.db.insert(checkpoints).values({
      id: server.ctx.idGen.generate("ckpt"),
      organizationId: "org_default",
      goalId,
      type: "paused",
      stateRefs: {
        goal_status: "running",
        plan_version: 1,
        task_statuses: [],
        active_runs: activeRuns,
        open_blockers: [],
        pending_approvals: [],
        event_cursor: eventCursor,
      },
      summary: "test",
      createdAt: server.ctx.clock.nowIso(),
    });
  }

  it("reconciles: continue vs failed vs stale vs missing, opens run-sourced blockers, goal→blocked", async () => {
    const { ctx, db } = server;
    const { goalId, taskIds } = await runningGoal();

    await insertRun("run_go", taskIds[0]!, "running");
    await insertRun("run_fail", taskIds[0]!, "failed");
    await insertRun("run_stale", taskIds[1]!, "running");
    // run_missing: referenced by the checkpoint but never inserted.

    // Cursor semantics: run_stale's event is AT the cursor (not newer ⇒ stale);
    // run_go's event is AFTER the cursor (newer ⇒ continue).
    await insertRunEvent("run_stale");
    const cursor = await maxPosition();
    await insertRunEvent("run_go");
    await putCheckpoint(goalId, ["run_go", "run_fail", "run_stale", "run_missing"], cursor);

    const res = await reconcileGoalFromCheckpoint(ctx, goalId);
    expect(res.reconciled).toBe(true);
    expect(res.evaluation!.continue_runs).toEqual(["run_go"]);
    expect(res.evaluation!.blockers.map((b) => b.run_id).sort()).toEqual(["run_fail", "run_missing", "run_stale"]);
    expect(res.opened_blocker_ids).toHaveLength(3);
    expect(res.goal_status).toBe("blocked");
    expect((await getGoal(ctx, goalId))?.status).toBe("blocked");

    // Blockers are source-traceable to their run.
    const rows = await db.db
      .select()
      .from(blockers)
      .where(and(eq(blockers.organizationId, "org_default"), eq(blockers.goalId, goalId)));
    expect(rows).toHaveLength(3);
    for (const b of rows) {
      expect(b.sourceKind).toBe("run");
      expect(["run_fail", "run_stale", "run_missing"]).toContain(b.sourceId);
      expect(["failed_run", "stale_runtime"]).toContain(b.type);
    }
  });

  it("is idempotent: re-reconcile opens no duplicate blockers and does not re-transition", async () => {
    const { ctx, db } = server;
    const { goalId, taskIds } = await runningGoal();
    await insertRun("run_fail", taskIds[0]!, "failed");
    await putCheckpoint(goalId, ["run_fail"], 0);

    const first = await reconcileGoalFromCheckpoint(ctx, goalId);
    expect(first.opened_blocker_ids).toHaveLength(1);
    const second = await reconcileGoalFromCheckpoint(ctx, goalId);
    expect(second.opened_blocker_ids).toHaveLength(0); // no duplicate

    const rows = await db.db.select().from(blockers).where(eq(blockers.goalId, goalId));
    expect(rows).toHaveLength(1);
    const blockedEvents = await db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "goal.status_changed")));
    expect(blockedEvents).toHaveLength(1); // transitioned to blocked exactly once
  });

  it("no pending runs → reconciled with no blockers, goal stays running", async () => {
    const { ctx } = server;
    const { goalId } = await runningGoal();
    await putCheckpoint(goalId, [], 0);
    const res = await reconcileGoalFromCheckpoint(ctx, goalId);
    expect(res.reconciled).toBe(true);
    expect(res.opened_blocker_ids).toHaveLength(0);
    expect(res.goal_status).toBe("running");
  });

  it("no checkpoint → no-op with reason", async () => {
    const { ctx, db } = server;
    const { goalId } = await runningGoal();
    await db.db.delete(checkpoints).where(eq(checkpoints.goalId, goalId));
    const res = await reconcileGoalFromCheckpoint(ctx, goalId);
    expect(res.reconciled).toBe(false);
    expect(res.reason).toBe("no_checkpoint");
  });

  it("terminal goal → no-op with reason", async () => {
    const { ctx } = server;
    const goal = await createGoal(ctx, { project_id: "proj_artoo", title: "cancel" });
    await cancelGoal(ctx, goal.id);
    const res = await reconcileGoalFromCheckpoint(ctx, goal.id);
    expect(res.reconciled).toBe(false);
    expect(res.reason).toBe("goal_terminal");
  });

  it("unknown / cross-org goal → 404", async () => {
    await expect(reconcileGoalFromCheckpoint(server.ctx, "goal_nope")).rejects.toThrow(/goal not found/i);
  });
});
