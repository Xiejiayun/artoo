import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { IDLE_WORK_QUERY } from "./idle.mjs";

test("release drain SQL distinguishes paused waiting goals from executable work", async (t) => {
  const database = new PGlite();
  const goal = { id: "goal_one", organizationId: "org_one", status: "paused", currentPlanId: null };
  const automation = {
    goalId: goal.id,
    organizationId: goal.organizationId,
    status: "waiting",
    planId: null,
    discussionId: null,
  };
  try {
    // Keep only queried columns, with nullable statuses to exercise fail-closed
    // handling of corrupt/unknown historical data as well as normal rows.
    await database.exec(`
      CREATE TABLE public.goals (id TEXT, organization_id TEXT, status TEXT, current_plan_id TEXT);
      CREATE TABLE public.goal_automations (goal_id TEXT, organization_id TEXT, status TEXT, plan_id TEXT, discussion_id TEXT);
      CREATE TABLE public.runs (id TEXT, organization_id TEXT, status TEXT, failure_reason TEXT);
      CREATE TABLE public.assistant_turns (status TEXT);
      CREATE TABLE public.event_log (organization_id TEXT, run_id TEXT, type TEXT, payload JSONB);
      CREATE TABLE public.file_leases (status TEXT);
      CREATE TABLE public.plans (goal_id TEXT, organization_id TEXT, status TEXT);
      CREATE TABLE public.discussions (goal_id TEXT, organization_id TEXT, status TEXT);
    `);
    const active = async (input = {}) => {
      const state = {
        goal,
        automation,
        runStatuses: [],
        turnStatuses: [],
        runs: [],
        events: [],
        leaseStatuses: [],
        plans: [],
        discussions: [],
        ...input,
      };
      await database.exec(
        "TRUNCATE public.goals, public.goal_automations, public.runs, public.assistant_turns, public.event_log, public.file_leases, public.plans, public.discussions",
      );
      if (state.goal)
        await database.query("INSERT INTO public.goals VALUES ($1,$2,$3,$4)", [
          state.goal.id,
          state.goal.organizationId,
          state.goal.status,
          state.goal.currentPlanId,
        ]);
      if (state.automation)
        await database.query("INSERT INTO public.goal_automations VALUES ($1,$2,$3,$4,$5)", [
          state.automation.goalId,
          state.automation.organizationId,
          state.automation.status,
          state.automation.planId,
          state.automation.discussionId,
        ]);
      for (const [index, status] of state.runStatuses.entries())
        await database.query("INSERT INTO public.runs VALUES ($1,$2,$3,NULL)", [
          `run_${index}`,
          goal.organizationId,
          status,
        ]);
      for (const run of state.runs)
        await database.query("INSERT INTO public.runs VALUES ($1,$2,$3,$4)", [
          run.id,
          run.organizationId,
          run.status,
          run.failureReason,
        ]);
      for (const event of state.events)
        await database.query("INSERT INTO public.event_log VALUES ($1,$2,$3,$4::jsonb)", [
          event.organizationId,
          event.runId,
          event.type,
          JSON.stringify(event.payload),
        ]);
      for (const status of state.leaseStatuses)
        await database.query("INSERT INTO public.file_leases VALUES ($1)", [status]);
      for (const plan of state.plans)
        await database.query("INSERT INTO public.plans VALUES ($1,$2,$3)", [
          plan.goalId,
          plan.organizationId,
          plan.status,
        ]);
      for (const discussion of state.discussions)
        await database.query("INSERT INTO public.discussions VALUES ($1,$2,$3)", [
          discussion.goalId,
          discussion.organizationId,
          discussion.status,
        ]);
      for (const status of state.turnStatuses)
        await database.query("INSERT INTO public.assistant_turns VALUES ($1)", [status]);
      return Number((await database.query(IDLE_WORK_QUERY)).rows[0].active);
    };

    await t.test("an explicitly paused waiting goal is idle without changing its durable state", async () => {
      assert.equal(await active({ goal: null, automation: null }), 0);
      assert.equal(await active(), 0);
      assert.deepEqual((await database.query("SELECT status FROM public.goals")).rows, [{ status: "paused" }]);
      assert.deepEqual((await database.query("SELECT status FROM public.goal_automations")).rows, [
        { status: "waiting" },
      ]);
      for (const status of ["completed", "failed", "cancelled"]) {
        assert.equal(await active({ automation: { ...automation, status } }), 0);
      }
    });

    await t.test("runnable, mismatched and unknown automations remain blocked", async () => {
      for (const status of [
        "draft",
        "planned",
        "running",
        "blocked",
        "awaiting_approval",
        "completed",
        "cancelled",
        "archived",
        "unknown",
        null,
      ]) {
        assert.equal(await active({ goal: { ...goal, status } }), 1, `waiting with goal ${status}`);
      }
      for (const status of ["planning", "executing", "unknown", "", null]) {
        assert.equal(await active({ automation: { ...automation, status } }), 1, `paused with automation ${status}`);
      }
      for (const mismatch of [
        { goal: null },
        { goal: { ...goal, id: "goal_other" } },
        { goal: { ...goal, organizationId: "org_other" } },
        { automation: { ...automation, organizationId: null } },
      ]) {
        assert.equal(await active(mismatch), 1);
      }
      assert.equal(await active(), 0);
      await database.query("INSERT INTO public.goal_automations VALUES ($1,$2,$3,NULL,NULL)", [
        "orphan",
        goal.organizationId,
        "waiting",
      ]);
      assert.equal(Number((await database.query(IDLE_WORK_QUERY)).rows[0].active), 1);
    });

    await t.test("any planning or discussion history prevents the paused-goal exception", async () => {
      for (const pointer of ["historical", ""]) {
        assert.equal(await active({ goal: { ...goal, currentPlanId: pointer } }), 1);
        assert.equal(await active({ automation: { ...automation, planId: pointer } }), 1);
        assert.equal(await active({ automation: { ...automation, discussionId: pointer } }), 1);
      }
      // Check history even when pointers are null; cross-organization
      // corruption must not hide a historical operation on this Goal ID.
      for (const organizationId of [goal.organizationId, "org_other", null]) {
        for (const status of ["cancelled", "unknown", null]) {
          const record = { goalId: goal.id, organizationId, status };
          assert.equal(await active({ plans: [record] }), 1);
          assert.equal(await active({ discussions: [record] }), 1);
        }
      }
    });

    await t.test("a paused goal cannot hide any existing active run or assistant turn", async () => {
      for (const status of ["queued", "starting", "running", "awaiting_input", "paused"]) {
        assert.equal(await active({ runStatuses: [status] }), 1, `run ${status}`);
      }
      for (const status of ["queued", "waiting", "running"]) {
        assert.equal(await active({ turnStatuses: [status] }), 1, `assistant turn ${status}`);
      }
      assert.equal(
        await active({ runStatuses: ["running", "paused"], turnStatuses: ["queued", "waiting", "running"] }),
        5,
      );
      assert.equal(
        await active({ goal: { ...goal, status: "draft" }, runStatuses: ["running"], turnStatuses: ["waiting"] }),
        3,
      );
    });

    await t.test("disconnected failed runs require the exact existing boolean exit-confirmation evidence", async () => {
      const run = {
        id: "run_disconnected",
        organizationId: goal.organizationId,
        status: "failed",
        failureReason: "daemon_disconnect",
      };
      const event = {
        organizationId: run.organizationId,
        runId: run.id,
        type: "run.failed",
        payload: { process_exit_confirmed: true },
      };
      assert.equal(await active({ runs: [run] }), 1, "absence of file leases cannot establish process exit");
      for (const type of ["run.failed", "run.reconciled"]) {
        assert.equal(await active({ runs: [run], events: [{ ...event, type }] }), 0);
      }
      for (const payload of [{ process_exit_confirmed: false }, { process_exit_confirmed: "true" }, {}, null, true]) {
        assert.equal(await active({ runs: [run], events: [{ ...event, payload }] }), 1);
      }
      for (const mismatch of [{ organizationId: "org_other" }, { runId: "run_other" }, { type: "run.completed" }]) {
        assert.equal(await active({ runs: [run], events: [{ ...event, ...mismatch }] }), 1);
      }
      assert.equal(await active({ runs: [run], events: [event], leaseStatuses: ["held"] }), 1);
      assert.equal(await active({ runs: [run], leaseStatuses: ["held"] }), 2);
    });

    await t.test("any held file lease blocks maintenance independently of run and goal status", async () => {
      assert.equal(await active({ leaseStatuses: ["held"] }), 1);
      assert.equal(await active({ goal: null, automation: null, leaseStatuses: ["held"] }), 1);
      assert.equal(await active({ leaseStatuses: ["released"] }), 0);
    });
  } finally {
    await database.close();
  }
});
