import { afterEach, describe, expect, it } from "vitest";

import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

async function runningTask(server: TestServer): Promise<{ taskId: string; runId: string }> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "approval task",
      acceptance_criteria: ["ok"],
      required_capabilities: ["code.modify"],
    },
  });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto" },
  });
  const runId = assigned.json().run.id as string;
  // drive the run to running so the task is 'running' and can request approval
  await ingestRunEvent(server.ctx, {
    runId,
    nodeId: "computer_local_mock",
    sequence: 0,
    event: { kind: "lifecycle", phase: "started" },
  });
  return { taskId, runId };
}

async function status(server: TestServer, taskId: string): Promise<string> {
  const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
  return snap.json().task.status as string;
}

describe("approval platform-gate", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("request moves task to awaiting_approval; approve returns it to running", async () => {
    server = await buildTestServer();
    const { taskId, runId } = await runningTask(server);

    const requested = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/tasks/${taskId}/request-approval`,
      payload: { action: "git.push", risk: "high", summary: "Push branch", run_id: runId },
    });
    expect(requested.statusCode).toBe(201);
    const approvalId = requested.json().approval.id as string;
    expect(requested.json().approval.status).toBe("pending");
    expect(await status(server, taskId)).toBe("awaiting_approval");

    const list = await server.app.inject({ method: "GET", url: "/api/v1/approvals?status=pending" });
    expect((list.json().approvals as { id: string }[]).map((a) => a.id)).toContain(approvalId);

    const resolved = await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      payload: { decision: "approved", comment: "ok" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().approval.status).toBe("approved");
    expect(await status(server, taskId)).toBe("running");
  });

  it("reject moves the task to blocked", async () => {
    server = await buildTestServer();
    const { taskId } = await runningTask(server);
    const requested = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/tasks/${taskId}/request-approval`,
      payload: { action: "external.post", risk: "high", summary: "Post comment" },
    });
    const approvalId = requested.json().approval.id as string;

    const resolved = await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      payload: { decision: "rejected" },
    });
    expect(resolved.json().approval.status).toBe("rejected");
    expect(await status(server, taskId)).toBe("blocked");
  });
});
