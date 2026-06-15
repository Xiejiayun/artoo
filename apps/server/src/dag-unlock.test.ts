import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(server: TestServer, body: Record<string, unknown> = {}): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "t",
      acceptance_criteria: ["done"],
      required_capabilities: ["code.modify"],
      ...body,
    },
  });
  return res.json().task.id as string;
}

async function addDependency(
  server: TestServer,
  dependentId: string,
  prerequisiteId: string,
  type = "blocks",
) {
  return server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${dependentId}/dependencies`,
    payload: { depends_on_task_id: prerequisiteId, type },
  });
}

async function status(server: TestServer, taskId: string): Promise<string> {
  const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
  return snap.json().task.status as string;
}

/** create -> ready -> assign -> mock-execute (lands the task in `review`). */
async function driveToReview(server: TestServer, taskId: string): Promise<void> {
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto" },
  });
  const runId = assigned.json().run.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
}

async function driveToDone(server: TestServer, taskId: string): Promise<void> {
  await driveToReview(server, taskId);
  await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/review`,
    payload: { outcome: "accepted" },
  });
}

describe("DAG auto-unlock on prerequisite done", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("auto-unlocks a backlog dependent (-> ready) when its blocking prerequisite is accepted", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, { title: "prereq" });
    const dependent = await createTask(server, { title: "dependent" });
    expect((await addDependency(server, dependent, prereq)).statusCode).toBe(201);

    // The dependent cannot be readied manually while the blocker is open.
    const early = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${dependent}/ready`,
    });
    expect(early.statusCode).toBe(409);
    expect(await status(server, dependent)).toBe("backlog");

    // Driving the prerequisite to done auto-unlocks the dependent.
    await driveToDone(server, prereq);
    expect(await status(server, prereq)).toBe("done");
    expect(await status(server, dependent)).toBe("ready");
  });

  it("does not auto-unlock while only one of two prerequisites is done", async () => {
    server = await buildTestServer();
    const p1 = await createTask(server, { title: "p1" });
    const p2 = await createTask(server, { title: "p2" });
    const dependent = await createTask(server, { title: "dependent" });
    await addDependency(server, dependent, p1);
    await addDependency(server, dependent, p2);

    await driveToDone(server, p1);
    expect(await status(server, dependent)).toBe("backlog"); // p2 still open

    await driveToDone(server, p2);
    expect(await status(server, dependent)).toBe("ready"); // both done -> unlocked
  });

  it("gates manual ready on non-soft dependencies, but not soft_context", async () => {
    server = await buildTestServer();
    const artifactPrereq = await createTask(server, { title: "artifact prereq" });
    const artifactDependent = await createTask(server, { title: "artifact dependent" });
    await addDependency(server, artifactDependent, artifactPrereq, "artifact_required");

    const gated = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${artifactDependent}/ready`,
    });
    expect(gated.statusCode).toBe(409);
    expect(gated.json().error.code).toBe("invalid_state");

    const softPrereq = await createTask(server, { title: "soft prereq" });
    const softDependent = await createTask(server, { title: "soft dependent" });
    await addDependency(server, softDependent, softPrereq, "soft_context");
    const softReady = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${softDependent}/ready`,
    });
    expect(softReady.statusCode).toBe(200);
    expect(softReady.json().task.status).toBe("ready");
  });
});

describe("DAG aggregate review (parent gated on children)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("blocks accepting a parent until every child is done", async () => {
    server = await buildTestServer();
    const parent = await createTask(server, { title: "parent" });
    const child = await createTask(server, { title: "child", parent_task_id: parent });

    await driveToReview(server, parent); // parent now in review, child still backlog
    const rejected = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${parent}/review`,
      payload: { outcome: "accepted" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.code).toBe("invalid_state");
    expect(await status(server, parent)).toBe("review");

    await driveToDone(server, child);
    const accepted = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${parent}/review`,
      payload: { outcome: "accepted" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().task.status).toBe("done");
  });
});

describe("DAG block propagation on prerequisite failure", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("emits dag.node.blocked for a downstream dependent when its prerequisite run fails", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, { title: "prereq" });
    const dependent = await createTask(server, { title: "dependent" });
    await addDependency(server, dependent, prereq);

    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${prereq}/ready` });
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${prereq}/assign`,
      payload: { mode: "auto" },
    });
    const runId = assigned.json().run.id as string;
    const exec = await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/runs/${runId}/mock-execute?outcome=failed`,
    });
    expect(exec.json()).toMatchObject({ taskStatus: "blocked" });

    // The dependent stays in backlog (block is advisory, not a status change)...
    expect(await status(server, dependent)).toBe("backlog");
    // ...but a dag.node.blocked event was recorded against the dependent.
    const rows = (
      await server.db.db.execute(
        sql`select task_id from event_log where type = 'dag.node.blocked'`,
      )
    ).rows as { task_id: string }[];
    expect(rows.map((r) => r.task_id)).toContain(dependent);
  });
});
