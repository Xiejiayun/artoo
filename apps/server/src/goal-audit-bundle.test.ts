// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";
import { getGoalAuditBundle } from "./services/audit-service.js";
import { createGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";

const SPECS = [
  { title: "a", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] },
  { title: "b", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] },
];

/**
 * #140 (deferred P4) — the goal-level audit bundle consolidates a goal's full
 * evidence chain (goal + plans + checkpoints + child task bundles + goal event
 * stream), deterministically and org-scoped, composing the existing per-task
 * audit bundle rather than replacing it.
 */
describe("goal audit bundle #140", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** A running goal (draft→planned→running via first-plan accept) with two child tasks. */
  async function runningGoal(): Promise<{ goalId: string; taskIds: string[] }> {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "G", objective: "obj" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: SPECS });
    const taskIds = (await acceptPlan(server.ctx, plan.id)).task_ids;
    return { goalId: goal.id, taskIds };
  }

  const getBundle = (goalId: string) =>
    server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}/audit-bundle` });
  const getExport = (goalId: string) =>
    server.app.inject({ method: "GET", url: `/api/v1/goals/${goalId}/audit-bundle/export` });

  it("consolidates goal + plans + checkpoints + child task bundles + goal events", async () => {
    const { goalId, taskIds } = await runningGoal();
    // Drive the first child task through a completed run so it carries real run/artifact evidence.
    const executed = taskIds[0]!;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${executed}/ready` });
    const runId = (
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${executed}/assign`, payload: { mode: "auto" } })
    ).json().run.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });

    const res = await getBundle(goalId);
    expect(res.statusCode).toBe(200);
    const bundle = res.json().bundle;

    // Goal row = lifecycle + budgets + retry_count + provenance.
    expect(bundle.goal.id).toBe(goalId);
    expect(bundle.goal.status).toBe("running");
    expect(bundle.goal.retry_count).toBe(0);
    expect(bundle.goal.current_plan_id).not.toBeNull();

    // Plans: the accepted, materialized first plan.
    expect(bundle.plans).toHaveLength(1);
    expect(bundle.plans[0].status).toBe("accepted");
    expect(bundle.plans[0].version).toBe(1);
    expect(bundle.plans[0].materialized_at).not.toBeNull();

    // Checkpoints: the materialize marker.
    expect(bundle.checkpoints.some((c: { type: string }) => c.type === "dag_materialized")).toBe(true);

    // Child tasks: full per-task audit bundles, one per materialized task.
    expect(bundle.tasks).toHaveLength(2);
    for (const child of bundle.tasks) {
      expect(taskIds).toContain(child.task.id);
      expect(Array.isArray(child.runs)).toBe(true);
      expect(Array.isArray(child.events)).toBe(true);
    }
    const executedBundle = bundle.tasks.find((t: { task: { id: string } }) => t.task.id === executed);
    expect(executedBundle.runs.some((r: { status: string }) => r.status === "completed")).toBe(true);
    expect(executedBundle.artifacts.length).toBeGreaterThanOrEqual(1);

    // Goal-level event stream = goal lifecycle + materialization provenance
    // (task.created). Child run-execution detail (assign/run/artifact) stays
    // inside the child bundles above — not flattened into the goal stream.
    const types = bundle.events.map((e: { type: string }) => e.type);
    expect(types).toContain("goal.created");
    expect(types).toContain("goal.plan_materialized");
    expect(types).toContain("task.created"); // materialization provenance
    for (const runLevel of ["task.assigned", "run.started", "run.completed", "artifact.created"]) {
      expect(types).not.toContain(runLevel);
    }
  });

  it("exports a deterministic v1alpha1 envelope with a stable bundle hash", async () => {
    const { goalId } = await runningGoal();
    const first = (await getExport(goalId)).json().export;
    const second = (await getExport(goalId)).json().export;

    expect(first.schema_version).toBe("v1alpha1");
    expect(first.signing.status).toBe("deferred");
    expect(first.signature).toBeNull();
    expect(first.bundle_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    // The bundle content is deterministic, so its hash is stable across exports.
    expect(second.bundle_sha256).toBe(first.bundle_sha256);
  });

  it("404s an unknown goal", async () => {
    expect((await getBundle("goal_nope")).statusCode).toBe(404);
  });

  it("does not mount a goal from another organization (org-scope safety)", async () => {
    const { goalId } = await runningGoal();
    // A context scoped to a different org must not read this org's goal.
    await expect(
      getGoalAuditBundle({ ...server.ctx, organizationId: "org_other" }, goalId),
    ).rejects.toThrow(/goal not found/);
  });

  it("returns an empty-shaped bundle for a fresh draft goal", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Draft" });
    const bundle = (await getBundle(goal.id)).json().bundle;
    expect(bundle.goal.status).toBe("draft");
    expect(bundle.plans).toEqual([]);
    expect(bundle.checkpoints).toEqual([]);
    expect(bundle.tasks).toEqual([]);
    expect(bundle.events.map((e: { type: string }) => e.type)).toContain("goal.created");
    expect(bundle.events.every((e: { type: string }) => e.type.startsWith("goal."))).toBe(true);
  });
});
