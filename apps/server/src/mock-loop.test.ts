import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function assignAndGetRunId(server: TestServer): Promise<{ taskId: string; runId: string }> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Mock loop task",
      acceptance_criteria: ["works"],
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
  return { taskId, runId: assigned.json().run.id as string };
}

async function eventCount(server: TestServer, runId: string): Promise<number> {
  const res = await server.db.db.execute(
    sql`select count(*)::int as c from event_log where run_id = ${runId}`,
  );
  return (res.rows[0] as { c: number }).c;
}

describe("mock run loop", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("drives create -> ready -> assign -> run -> review -> accept -> done", async () => {
    server = await buildTestServer();
    const { taskId, runId } = await assignAndGetRunId(server);

    const exec = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/runs/${runId}/mock-execute`,
    });
    expect(exec.statusCode).toBe(200);
    expect(exec.json()).toMatchObject({ runStatus: "completed", taskStatus: "review" });

    const snap = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })).json();
    expect(snap.task.status).toBe("review");
    expect(snap.runs[0].status).toBe("completed");
    expect(snap.artifacts).toHaveLength(1);
    expect(snap.artifacts[0].type).toBe("report");

    // task.assigned carries run_id too; then the run lifecycle events follow.
    const rows = (
      await server.db.db.execute(
        sql`select type from event_log where run_id = ${runId} order by position`,
      )
    ).rows as { type: string }[];
    const types = rows.map((r) => r.type);
    expect(types).toEqual([
      "task.assigned",
      "run.started",
      "run.output",
      "artifact.created",
      "run.completed",
    ]);

    const review = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "accepted" },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe("done");
  });

  it("review with changes_requested returns the task to ready", async () => {
    server = await buildTestServer();
    const { taskId, runId } = await assignAndGetRunId(server);
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    const review = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/review`,
      payload: { outcome: "changes_requested", comment: "tweak it" },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe("ready");
  });

  it("dedups replayed run events (no duplicate events on re-ingest)", async () => {
    server = await buildTestServer();
    const { runId } = await assignAndGetRunId(server);
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    const before = await eventCount(server, runId);
    // re-run the same sequence: every (node,run,sequence) already ingested
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    const after = await eventCount(server, runId);
    expect(after).toBe(before);
  });

  it("recovers a failed run: failed -> blocked -> retry -> ready", async () => {
    server = await buildTestServer();
    const { taskId, runId } = await assignAndGetRunId(server);
    const exec = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/runs/${runId}/mock-execute?outcome=failed`,
    });
    expect(exec.json()).toMatchObject({ runStatus: "failed", taskStatus: "blocked" });

    const retry = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe("ready");

    // a fresh assign creates a NEW run (runs are never reused)
    const reassign = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });
    expect(reassign.statusCode).toBe(200);
    expect(reassign.json().run.id).not.toBe(runId);
  });
});
