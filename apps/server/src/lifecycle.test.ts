import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(
  server: TestServer,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "t", acceptance_criteria: ["done"], ...body },
  });
  return res.json().task.id as string;
}

describe("task lifecycle: ready + assign", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("backlog -> ready -> assigned creates a queued run on the idle mock instance", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server, { required_capabilities: ["code.modify"] });

    const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe("ready");

    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(200);
    const body = assigned.json();
    expect(body.run.status).toBe("queued");
    expect(body.run.agent_instance_id).toBe("instance_mock_coder");
    expect(body.scheduler_decision.reason).toBe("capability_match_and_idle");

    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(snap.json().task.status).toBe("assigned");
    expect(snap.json().task.assignee_type).toBe("agent");
    expect(snap.json().runs).toHaveLength(1);
  });

  it("rejects /ready when acceptance criteria are empty", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server, { acceptance_criteria: [] });
    const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    expect(ready.statusCode).toBe(400);
    expect(ready.json().error.code).toBe("validation_error");
  });

  it("rejects /assign when the task is not ready (still backlog)", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server, {});
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().error.code).toBe("invalid_state");
  });

  it("returns runtime_unavailable when no idle instance covers the required capabilities", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server, { required_capabilities: ["browser.navigate"] });
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().error.code).toBe("runtime_unavailable");
    // task stays ready so it can be retried/rescheduled
    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(snap.json().task.status).toBe("ready");
  });
});
