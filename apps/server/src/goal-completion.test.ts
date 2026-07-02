// @vitest-environment node
import { eventLog } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";
import { createGoal, getGoal } from "./services/goal-service.js";
import { acceptPlan, proposePlan } from "./services/plan-service.js";

const SPECS = [
  { title: "first", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"], dependencies: [] },
  {
    title: "second",
    acceptance_criteria: ["ok"],
    required_capabilities: ["test.run"],
    dependencies: [{ ref: "0", type: "blocks" }],
  },
];

describe("goal aggregate completion #138", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  async function runAndAccept(taskId: string): Promise<void> {
    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    if (snap.json().task.status === "backlog") {
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    }
    const runId = (
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } })
    ).json().run.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    const reviewed = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted" },
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().task.status).toBe("done");
  }

  it("completes a running goal once all materialized tasks are done", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "complete me" });
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: SPECS });
    const [firstTaskId, secondTaskId] = (await acceptPlan(server.ctx, plan.id)).task_ids;

    await runAndAccept(firstTaskId!);
    expect((await getGoal(server.ctx, goal.id))?.status).toBe("running");
    const second = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${secondTaskId}` });
    expect(second.json().task.status).toBe("ready");

    await runAndAccept(secondTaskId!);
    expect((await getGoal(server.ctx, goal.id))?.status).toBe("completed");

    const completedEvents = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.goalId, goal.id), eq(eventLog.type, "goal.completed")));
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.payload).toMatchObject({ trigger: "all_tasks_terminal" });
  });
});
