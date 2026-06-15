import { afterEach, describe, expect, it } from "vitest";

import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(server: TestServer): Promise<{ taskId: string; roomId: string }> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "audit me",
      acceptance_criteria: ["bundle has evidence"],
      required_capabilities: ["code.modify"],
    },
  });
  const body = created.json();
  return { taskId: body.task.id as string, roomId: body.room.id as string };
}

async function taskWithEvidence(
  server: TestServer,
): Promise<{ taskId: string; roomId: string; runId: string }> {
  const { taskId, roomId } = await createTask(server);
  await server.app.inject({
    method: "POST",
    url: `/api/v1/rooms/${roomId}/messages`,
    payload: { kind: "text", body: "user evidence" },
  });
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
  await server.app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approvalId}/resolve`,
    payload: { decision: "approved", comment: "ok" },
  });
  await ingestRunEvent(server.ctx, {
    runId,
    nodeId: "computer_local_mock",
    sequence: 1,
    event: {
      kind: "artifact",
      artifactType: "patch",
      uri: "file://mock/changes.patch",
      checksum: "sha256:abc",
    },
  });
  await ingestRunEvent(server.ctx, {
    runId,
    nodeId: "computer_local_mock",
    sequence: 2,
    event: { kind: "lifecycle", phase: "completed" },
  });
  return { taskId, roomId, runId };
}

describe("task audit bundle", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("exports deterministic task evidence with globally ordered events", async () => {
    server = await buildTestServer();
    const { taskId, roomId, runId } = await taskWithEvidence(server);

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle`,
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json().bundle;

    expect(bundle.task.id).toBe(taskId);
    expect(bundle.room.id).toBe(roomId);
    expect(bundle.runs).toHaveLength(1);
    expect(bundle.runs[0].id).toBe(runId);
    expect(bundle.runs[0].status).toBe("completed");
    expect(bundle.scheduler_decisions).toHaveLength(1);
    expect(bundle.scheduler_decisions[0].reason).toBe("capability_match_and_idle");
    expect(bundle.approvals).toHaveLength(1);
    expect(bundle.approvals[0].status).toBe("approved");
    expect(bundle.artifacts).toHaveLength(1);
    expect(bundle.artifacts[0]).toMatchObject({
      run_id: runId,
      type: "patch",
      uri: "file://mock/changes.patch",
      checksum: "sha256:abc",
    });
    expect((bundle.messages as { body: string }[]).map((m) => m.body)).toContain("user evidence");

    const positions = (bundle.events as { position: number }[]).map((event) => event.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
    expect((bundle.events as { type: string }[]).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "task.created",
        "room.created",
        "message.created",
        "task.assigned",
        "run.started",
        "approval.requested",
        "approval.resolved",
        "artifact.created",
        "run.completed",
      ]),
    );

    const second = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle`,
    });
    expect(second.json().bundle).toEqual(bundle);
  });

  it("returns 404 for a missing task", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/tasks/task_missing/audit-bundle",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});
