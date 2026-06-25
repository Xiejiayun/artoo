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

  it("needs_more_info leaves the task awaiting approval and can later approve", async () => {
    server = await buildTestServer();
    const { taskId } = await runningTask(server);
    const requested = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/tasks/${taskId}/request-approval`,
      payload: { action: "git.push", risk: "high", summary: "Need details" },
    });
    const approvalId = requested.json().approval.id as string;

    const moreInfo = await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      payload: { decision: "needs_more_info", comment: "explain risk" },
    });
    expect(moreInfo.statusCode).toBe(200);
    expect(moreInfo.json().approval.status).toBe("needs_more_info");
    expect(await status(server, taskId)).toBe("awaiting_approval");

    const approved = await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      payload: { decision: "approved" },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().approval.status).toBe("approved");
    expect(await status(server, taskId)).toBe("running");
  });

  it("auto-resolves a linked blocker when the approval is decided (#114)", async () => {
    server = await buildTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "blocked-by-approval task",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
      },
    });
    const taskId = created.json().task.id as string;
    const roomId = created.json().room.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    const runId = assigned.json().run.id as string;
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 0,
      event: { kind: "lifecycle", phase: "started" },
    });
    const requested = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/tasks/${taskId}/request-approval`,
      payload: { action: "git.push", risk: "high", summary: "Push branch", run_id: runId },
    });
    const approvalId = requested.json().approval.id as string;

    // A blocker explicitly linked to this approval as its deterministic source.
    const blockerRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/blockers`,
      payload: {
        task_id: taskId,
        type: "approval",
        owner_type: "agent",
        owner_id: "SkywalkerClaude",
        source_kind: "approval",
        source_id: approvalId,
        summary: "waiting on git.push approval",
      },
    });
    const blockerId = blockerRes.json().blocker.id as string;
    expect(blockerRes.json().blocker.status).toBe("open");

    await server.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${approvalId}/resolve`,
      payload: { decision: "approved", comment: "ok" },
    });

    const blockers = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/blockers` });
    const blocker = (blockers.json().blockers as { id: string; status: string }[]).find((b) => b.id === blockerId);
    expect(blocker?.status).toBe("resolved");

    // And the audit bundle carries the decision-trail record for the task.
    const bundle = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}/audit-bundle` });
    expect((bundle.json().bundle.blockers as { id: string }[]).map((b) => b.id)).toContain(blockerId);
  });
});
