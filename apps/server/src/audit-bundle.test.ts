import { afterEach, describe, expect, it } from "vitest";

import { stableJson } from "./services/audit-service.js";
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

  it("redacts credential-shaped values from the exported bundle", async () => {
    server = await buildTestServer();
    const { taskId, roomId } = await createTask(server);

    await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${roomId}/messages`,
      payload: {
        kind: "text",
        body: "token dump: ARTOO_TOKEN=sk_agent_abc123secret and Authorization: Bearer rawbearertoken1234567890",
        payload: {
          note: "keep this evidence",
          token: "plain-structured-token",
          nested: {
            api_key: "sk-proj-1234567890abcdefghijklmnop",
            diagnostic: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123456",
          },
        },
      },
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
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 1,
      event: {
        kind: "output",
        stream: "stdout",
        text: "OPENAI_API_KEY=sk-1234567890abcdefghijklmnopqr",
      },
    });
    await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/tasks/${taskId}/request-approval`,
      payload: {
        action: "git.push",
        risk: "high",
        summary: "push with secret ghp_1234567890abcdefghijklmnopqrstuvwxyz",
        run_id: runId,
      },
    });
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: "computer_local_mock",
      sequence: 2,
      event: {
        kind: "artifact",
        artifactType: "log_bundle",
        uri: "file://mock/logs?credential=sk_machine_secret123",
      },
    });

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle`,
    });
    expect(res.statusCode).toBe(200);
    const bundle = res.json().bundle;
    const serialized = JSON.stringify(bundle);

    expect(serialized).not.toContain("sk_agent_abc123secret");
    expect(serialized).not.toContain("rawbearertoken1234567890");
    expect(serialized).not.toContain("plain-structured-token");
    expect(serialized).not.toContain("sk-proj-1234567890abcdefghijklmnop");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("sk-1234567890abcdefghijklmnopqr");
    expect(serialized).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("sk_machine_secret123");
    expect(serialized).toContain("<redacted:secret>");
    expect(serialized).toContain("<redacted:jwt>");
    expect(serialized).toContain("keep this evidence");

    const message = (bundle.messages as { body: string; payload: Record<string, unknown> }[]).find((m) =>
      m.body.includes("token dump"),
    );
    expect(message?.body).toContain("ARTOO_TOKEN=<redacted:secret>");
    expect(message?.body).toContain("Authorization: Bearer <redacted:secret>");
    expect(message?.payload.note).toBe("keep this evidence");
    expect(message?.payload.token).toBe("<redacted:secret>");
  });

  it("exports an unsigned deterministic audit bundle proof over the redacted evidence", async () => {
    server = await buildTestServer();
    const { taskId } = await taskWithEvidence(server);

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle/export`,
    });
    expect(res.statusCode).toBe(200);
    const exported = res.json().export;

    expect(exported.schema_version).toBe("v1alpha1");
    expect(exported.exported_at).toBe("2026-06-13T00:00:00.000Z");
    expect(exported.signature).toBeNull();
    expect(exported.signing).toEqual({
      status: "deferred",
      reason: "v1 does not manage signing keys yet",
    });
    expect(exported.bundle.task.id).toBe(taskId);
    expect(exported.bundle_sha256).toMatch(/^sha256:[a-f0-9]{64}$/);

    const bundleRes = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle`,
    });
    expect(exported.bundle).toEqual(bundleRes.json().bundle);

    const expected = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableJson(exported.bundle)),
    );
    const expectedHex = [...new Uint8Array(expected)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(exported.bundle_sha256).toBe(`sha256:${expectedHex}`);

    const second = await server.app.inject({
      method: "GET",
      url: `/api/v1/tasks/${taskId}/audit-bundle/export`,
    });
    expect(second.json().export).toEqual(exported);
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
