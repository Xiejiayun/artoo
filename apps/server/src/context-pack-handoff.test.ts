import { artifacts, contextPacks, taskDependencies } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("versioned task handoff context", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  async function post(url: string, payload?: unknown) {
    const response = await server.app.inject({ method: "POST", url: `/api/v1/${url}`, ...(payload ? { payload } : {}) });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  }
  it("carries the source goal/plan and only the accepted predecessor attempt, without signed URLs or metadata", async () => {
    server = await buildTestServer();
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Product", objective: "A persistent journal", acceptance_criteria: ["Entries survive restart"] });
    const plan = await proposePlan(server.ctx, goal.id, { rationale: "Specify before building", task_specs: [
      { title: "Design", acceptance_criteria: ["Define persistence"] },
      { title: "Build", acceptance_criteria: ["Tests pass"], dependencies: [{ ref: "0", type: "blocks" }], expected_artifacts: [{ type: "patch", description: "Implementation" }] },
    ] });
    const [first, second] = (await acceptPlan(server.ctx, plan.id)).task_ids;
    await post(`tasks/${first}/ready`);
    const oldRun = (await post(`tasks/${first}/assign`, { mode: "auto" })).run.id;
    await post(`dev/runs/${oldRun}/mock-execute`);
    await post(`tasks/${first}/review`, { outcome: "changes_requested", comment: "Revise the data model" });
    const acceptedRun = (await post(`tasks/${first}/assign`, { mode: "auto" })).run.id;
    await post(`dev/runs/${acceptedRun}/mock-execute`);
    await server.db.db.update(artifacts).set({ uri: "https://private.invalid/result?token=must-not-leak", metadata: { secret: "must-not-leak" } }).where(eq(artifacts.runId, acceptedRun));
    await post(`tasks/${first}/review`, { outcome: "accepted" });
    const run = (await post(`tasks/${second}/assign`, { mode: "auto" })).run;
    const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    const payload = ContextPackSchema.parse(stored!.payload);
    expect(payload.goal_context).toEqual({ version: 1, goal_id: goal.id, objective: goal.objective,
      acceptance_criteria: ["Entries survive restart"], plan: { id: plan.id, version: 1, rationale: plan.rationale, spec_ref: "1" } });
    expect(payload.artifacts.expected).toEqual(["patch: Implementation"]);
    const entry = payload.dependency_context!.entries[0]!;
    expect(entry).toMatchObject({ task_id: first, status: "done", run_id: acceptedRun, artifacts_truncated: false });
    expect(entry.artifacts).toHaveLength(1);
    expect(entry.artifacts[0]).toMatchObject({ run_id: acceptedRun, content_path: expect.stringMatching(/^\/api\/v1\/artifacts\/.+\/content$/) });
    expect(JSON.stringify(payload)).not.toContain(oldRun);
    expect(JSON.stringify(payload)).not.toContain("must-not-leak");
  });

  it("never imports unfinished deliverables or cross-project dependency data", async () => {
    server = await buildTestServer();
    const upstream = (await post("tasks", { project_id: "proj_artoo", title: "Not accepted", acceptance_criteria: ["Done"] })).task;
    const downstream = (await post("tasks", { project_id: "proj_artoo", title: "Consumer", acceptance_criteria: ["Done"] })).task;
    const foreignProject = (await post("projects", { name: "Other project" })).project;
    const foreignTask = (await post("tasks", { project_id: foreignProject.id, title: "Private design", acceptance_criteria: ["Done"] })).task;
    for (const fromTaskId of [upstream.id, foreignTask.id]) await server.db.db.insert(taskDependencies).values({
      id: `dep_${fromTaskId}`, organizationId: server.ctx.organizationId, fromTaskId, toTaskId: downstream.id, type: "soft_context", createdAt: server.ctx.clock.nowIso(),
    });
    await post(`tasks/${upstream.id}/ready`);
    const runId = (await post(`tasks/${upstream.id}/assign`, { mode: "auto" })).run.id;
    await post(`dev/runs/${runId}/mock-execute`);
    await post(`tasks/${downstream.id}/ready`);
    const run = (await post(`tasks/${downstream.id}/assign`, { mode: "auto" })).run;
    const [stored] = await server.db.db.select().from(contextPacks).where(and(eq(contextPacks.id, run.context_pack_id), eq(contextPacks.taskId, downstream.id)));
    const payload = ContextPackSchema.parse(stored!.payload);
    expect(payload.goal_context).toBeUndefined();
    expect(payload.dependency_context!.entries).toHaveLength(1);
    expect(payload.dependency_context!.entries[0]).toMatchObject({ task_id: upstream.id, status: "review", run_id: null, artifacts: [] });
    expect(JSON.stringify(payload)).not.toContain("Private design");
  });
});
