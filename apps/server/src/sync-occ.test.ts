import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #27 v2-B slice 2b — command optimistic concurrency. A task-scoped command may
 * carry `base_version`, a snapshot version the client hydrated from the task read
 * surface. The server rejects the command if the task has advanced past it. The
 * representative command is task review.
 */
describe("command base_version optimistic concurrency (task review)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function createTask(s: TestServer): Promise<string> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "OCC task",
        acceptance_criteria: ["done"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().task.id as string;
  }

  /** create -> ready -> assign -> mock-execute: lands the task in `review`. */
  async function driveToReview(s: TestServer, taskId: string): Promise<void> {
    await s.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await s.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    const runId = assigned.json().run.id as string;
    await s.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
  }

  async function snapshot(s: TestServer, taskId: string): Promise<{ status: string; roomId: string; version: number }> {
    const snap = await s.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
    expect(snap.statusCode).toBe(200);
    const body = snap.json();
    return { status: body.task.status, roomId: body.room.id, version: body.version_cursor };
  }

  it("GET /tasks/:id exposes a positive task version_cursor", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server);
    const snap = await snapshot(server, taskId);
    expect(Number.isInteger(snap.version)).toBe(true);
    expect(snap.version).toBeGreaterThan(0);
  });

  it("success: a review with the current base_version applies", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server);
    await driveToReview(server, taskId);
    const { status, version } = await snapshot(server, taskId);
    expect(status).toBe("review");

    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted", base_version: version },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().task.status).toBe("done");
  });

  it("stale base_version conflict: the task advanced since the snapshot the client held", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server);
    await driveToReview(server, taskId);
    const before = await snapshot(server, taskId);
    expect(before.status).toBe("review");

    // Advance the task version WITHOUT leaving review: post a message to the task
    // room (message.created carries task_id, bumping the task's event position).
    const msg = await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${before.roomId}/messages`,
      payload: { kind: "text", body: "a concurrent comment" },
    });
    expect(msg.statusCode).toBe(201);
    const after = await snapshot(server, taskId);
    expect(after.version).toBeGreaterThan(before.version);

    // A review pinned to the STALE pre-message version is rejected with a
    // stale_base_version conflict record — and the task is NOT transitioned.
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted", base_version: before.version },
    });
    expect(res.statusCode).toBe(409);
    const err = res.json().error;
    expect(err.code).toBe("conflict");
    expect(err.details.reason).toBe("stale_base_version");
    expect(err.details.base_version).toBe(before.version);
    expect(err.details.current_version).toBeGreaterThan(before.version);
    expect(err.details.resource).toEqual({ type: "task", id: taskId });
    // Task still in review (command did not apply).
    expect((await snapshot(server, taskId)).status).toBe("review");

    // Re-pinning to the fresh version succeeds.
    const retry = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted", base_version: after.version },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().task.status).toBe("done");
  });

  it("backward compatible: a review without base_version skips the OCC check", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server);
    await driveToReview(server, taskId);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a malformed base_version (cannot bypass OCC with garbage)", async () => {
    server = await buildTestServer();
    const taskId = await createTask(server);
    await driveToReview(server, taskId);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted", base_version: "not-a-number" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});
