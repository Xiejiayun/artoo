import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { artifacts, tasks } from "@artoo/db";

import { buildTestServer, type TestServer } from "./test-support.js";
import { ingestRunEvent } from "./services/run-service.js";

async function createTask(
  server: TestServer,
  title: string,
  capabilities: string[] = [],
): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title,
      acceptance_criteria: ["x"],
      required_capabilities: capabilities,
    },
  });
  return res.json().task.id as string;
}

async function addDependency(server: TestServer, dependentId: string, prereqId: string, type: string) {
  return server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${dependentId}/dependencies`,
    payload: { depends_on_task_id: prereqId, type },
  });
}

/** Force a prerequisite straight to `done` (bypasses the run loop) for gate setup. */
async function forceDone(server: TestServer, taskId: string): Promise<void> {
  await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
}

async function addArtifact(server: TestServer, taskId: string, type: string): Promise<void> {
  const row = (await server.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
  if (row === undefined) {
    throw new Error(`addArtifact: task not found: ${taskId}`);
  }
  await server.db.db.insert(artifacts).values({
    id: `artifact_${taskId}_${type}`,
    organizationId: row.organizationId,
    taskId,
    runId: null,
    type,
    uri: `file://evidence/${type}`,
    metadata: {},
    checksum: null,
    createdAt: "2026-06-15T00:00:00.000Z",
  });
}

async function ready(server: TestServer, taskId: string) {
  return server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
}

async function status(server: TestServer, taskId: string): Promise<string> {
  const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
  return snap.json().task.status as string;
}

describe("DAG evidence gates (markReady)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("artifact_required: not ready until the prerequisite has an artifact", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq");
    const dependent = await createTask(server, "dependent");
    await addDependency(server, dependent, prereq, "artifact_required");
    await forceDone(server, prereq);

    // done but no artifact -> gated
    const gated = await ready(server, dependent);
    expect(gated.statusCode).toBe(409);
    expect(gated.json().error.code).toBe("invalid_state");

    await addArtifact(server, prereq, "report");
    expect((await ready(server, dependent)).statusCode).toBe(200);
  });

  it("contract_required: a plain artifact is not enough; needs a contract artifact", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq");
    const dependent = await createTask(server, "dependent");
    await addDependency(server, dependent, prereq, "contract_required");
    await forceDone(server, prereq);
    await addArtifact(server, prereq, "report");

    // a report artifact does not satisfy contract_required
    expect((await ready(server, dependent)).statusCode).toBe(409);

    await addArtifact(server, prereq, "contract");
    expect((await ready(server, dependent)).statusCode).toBe(200);
  });

  it("review_required: done alone satisfies (no extra evidence)", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq");
    const dependent = await createTask(server, "dependent");
    await addDependency(server, dependent, prereq, "review_required");
    await forceDone(server, prereq);

    expect((await ready(server, dependent)).statusCode).toBe(200);
  });
});

describe("DAG evidence gates (auto-unlock)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it.each([ ["artifact_required", "report"], ["contract_required", "contract"] ] as const)(
    "does not unlock %s using an older failed attempt's %s", async (dependencyType, artifactType) => {
      server = await buildTestServer();
      const prereq = await createTask(server, "Versioned upstream", ["code.modify"]);
      const dependent = await createTask(server, "Downstream waits for current evidence");
      expect((await addDependency(server, dependent, prereq, dependencyType)).statusCode).toBe(201);
      expect((await ready(server, prereq)).statusCode).toBe(200);
      const old = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${prereq}/assign`, payload: { mode: "auto" } });
      expect(old.statusCode, old.body).toBe(200);
      const oldRun = old.json().run;
      expect((await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${oldRun.id}/mock-execute?outcome=failed` })).statusCode).toBe(200);
      // Controlled persisted evidence, not a physical cross-computer test.
      await server.db.db.insert(artifacts).values({ id: `obsolete_${oldRun.id}`, organizationId: server.ctx.organizationId,
        taskId: prereq, runId: oldRun.id, type: artifactType, uri: "file://obsolete/evidence", metadata: {}, createdAt: server.ctx.clock.nowIso() });
      expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${prereq}/retry` })).statusCode).toBe(200);
      const retried = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${prereq}/assign`, payload: { mode: "auto" } });
      expect(retried.statusCode, retried.body).toBe(200);
      const run = retried.json().run;
      for (const [sequence, phase] of (["started", "completed"] as const).entries()) {
        await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computer_id, sequence, event: { kind: "lifecycle", phase } });
      }
      expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${prereq}/review`, payload: { outcome: "accepted" } })).statusCode).toBe(200);
      expect(await status(server, prereq)).toBe("done");
      expect(await status(server, dependent)).toBe("backlog");
      expect((await ready(server, dependent)).statusCode).toBe(409);
      await server.db.db.insert(artifacts).values({ id: `current_${run.id}`, organizationId: server.ctx.organizationId,
        taskId: prereq, runId: run.id, type: artifactType, uri: "file://current/evidence", metadata: {}, createdAt: server.ctx.clock.nowIso() });
      expect((await ready(server, dependent)).statusCode).toBe(200);
    },
  );

  it("auto-unlocks an artifact_required dependent once the prerequisite run produces an artifact", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq", ["code.modify"]);
    const dependent = await createTask(server, "dependent");
    await addDependency(server, dependent, prereq, "artifact_required");

    // Happy path: ready -> assign -> mock-execute (emits a report artifact) -> review accept -> done.
    await ready(server, prereq);
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${prereq}/assign`,
      payload: { mode: "auto" },
    });
    const runId = assigned.json().run.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${prereq}/review`,
      payload: { outcome: "accepted" },
    });

    expect(await status(server, prereq)).toBe("done");
    // The run produced a report artifact, so the artifact_required gate is satisfied.
    expect(await status(server, dependent)).toBe("ready");
  });
});
