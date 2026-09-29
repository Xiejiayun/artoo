import { artifacts, plans, runs, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createGoal, getGoal } from "./services/goal-service.js";
import { acceptPlan, getPlan, proposePlan } from "./services/plan-service.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const plainSpec = () => ({ title: "Build", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"] });
const controls = [
  { field: "approval_gates", value: ["human_before_write"] },
  { field: "write_scopes", value: ["src/**"] },
] as const;

describe("preview plan policy boundaries", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  const post = (url: string, payload: Record<string, unknown> = {}) => server.app.inject({ method: "POST", url, payload });
  async function draftPlan() {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Plan policy" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: [plainSpec()] });
    return { goalId: goal.id, planId: plan.id };
  }
  async function storedSpec(planId: string, extra: Record<string, unknown>) {
    await server.db.db.update(plans).set({ taskSpecs: [{ ...plainSpec(), ...extra }] }).where(eq(plans.id, planId));
  }
  async function finish(runId: string, phase: "failed" | "completed") {
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId, nodeId: "computer_local_mock", sequence: 1, event: { kind: "lifecycle", phase } });
  }
  function rejectsControl(response: { statusCode: number; json: () => any }, field: string) {
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("validation_error");
    expect(response.json().error.details.field).toBe(`task_specs[0].${field}`);
  }

  it.each(controls)("rejects unsupported $field on proposal without persisting a plan", async ({ field, value }) => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Unsupported policy" });
    const response = await post(`/api/v1/goals/${goal.id}/plans`, { task_specs: [{ ...plainSpec(), [field]: value }] });
    rejectsControl(response, field);
    expect(await server.db.db.select().from(plans)).toHaveLength(0);
    expect(await server.db.db.select().from(tasks)).toHaveLength(0);
  });

  it.each(controls)("rejects legacy proposed $field at acceptance and rolls back materialization", async ({ field, value }) => {
    const { goalId, planId } = await draftPlan();
    await storedSpec(planId, { [field]: value });
    rejectsControl(await post(`/api/v1/plans/${planId}/accept`), field);
    expect((await getPlan(server.ctx, planId))?.status).toBe("proposed");
    expect((await getGoal(server.ctx, goalId))?.status).toBe("draft");
    expect(await server.db.db.select().from(tasks)).toHaveLength(0);
  });

  it.each(controls)("rejects legacy accepted $field before assignment and both retry paths, while keeping history readable", async ({ field, value }) => {
    const { goalId, planId } = await draftPlan();
    const taskId = (await acceptPlan(server.ctx, planId)).task_ids[0]!;
    await post(`/api/v1/tasks/${taskId}/ready`);
    await storedSpec(planId, { [field]: value });
    rejectsControl(await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" }), field);
    rejectsControl(await post(`/api/v1/plans/${planId}/accept`), field);
    expect((await server.app.inject({ url: `/api/v1/plans/${planId}` })).statusCode).toBe(200);
    expect(await server.db.db.select().from(runs)).toHaveLength(0);

    await storedSpec(planId, {});
    const firstRun = (await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" })).json().run.id as string;
    await finish(firstRun, "failed");
    await storedSpec(planId, { [field]: value });
    rejectsControl(await post(`/api/v1/tasks/${taskId}/retry`), field);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("blocked");
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(0);

    await storedSpec(planId, {});
    expect((await post(`/api/v1/tasks/${taskId}/retry`)).statusCode).toBe(200);
    const secondRun = (await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" })).json().run.id as string;
    await finish(secondRun, "completed");
    await storedSpec(planId, { [field]: value });
    rejectsControl(await post(`/api/v1/tasks/${taskId}/review`, { outcome: "changes_requested" }), field);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("review");
    expect((await getGoal(server.ctx, goalId))?.retry_count).toBe(1);
    expect((await post(`/api/v1/tasks/${taskId}/review`, { outcome: "accepted" })).statusCode).toBe(200);
  });

  it("preserves expected_artifacts as advisory plan metadata without treating it as automatic acceptance", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Advisory artifacts" });
    const expected = [{ type: "report", description: "Review the final report manually" }];
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: [{ ...plainSpec(), expected_artifacts: expected }] });
    const taskId = (await acceptPlan(server.ctx, plan.id)).task_ids[0]!;
    expect((await getPlan(server.ctx, plan.id))?.task_specs[0]?.expected_artifacts).toEqual(expected);
    await post(`/api/v1/tasks/${taskId}/ready`);
    const runId = (await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" })).json().run.id as string;
    await finish(runId, "completed");
    expect(await server.db.db.select().from(artifacts)).toHaveLength(0);
    const reviewed = await post(`/api/v1/tasks/${taskId}/review`, { outcome: "accepted" });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().task.status).toBe("done");
  });

  it("fails closed when a stored task cannot resolve its source specification", async () => {
    const { planId } = await draftPlan();
    const taskId = (await acceptPlan(server.ctx, planId)).task_ids[0]!;
    await post(`/api/v1/tasks/${taskId}/ready`);
    await server.db.db.update(tasks).set({ sourcePlanSpecRef: "999" }).where(eq(tasks.id, taskId));
    const response = await post(`/api/v1/tasks/${taskId}/assign`, { mode: "auto" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Cannot verify");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });
});
