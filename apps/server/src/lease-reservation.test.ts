import { integrationQueue } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { failRunStart, ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const PROJECT = "proj_artoo";
const NODE = "computer_local_mock";

async function createReadyTask(
  server: TestServer,
  body: Record<string, unknown> = {},
): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: PROJECT,
      title: "t",
      acceptance_criteria: ["x"],
      required_capabilities: ["code.modify"],
      ...body,
    },
  });
  const id = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
  return id;
}

async function assign(server: TestServer, taskId: string, writePaths?: string[]) {
  return server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto", ...(writePaths ? { write_paths: writePaths } : {}) },
  });
}

async function heldLeasesForRun(server: TestServer, runId: string) {
  const res = await server.app.inject({
    method: "GET",
    url: `/api/v1/projects/${PROJECT}/leases?status=held`,
  });
  return (res.json().leases as { holder_id: string; holder_type: string; path: string; mode: string }[]).filter(
    (l) => l.holder_id === runId,
  );
}

describe("#20 run-start lease reservation", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reserves write leases (holder=run) for the run's write_paths and records workspace", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task, ["src/foo"]);
    expect(res.statusCode).toBe(200);
    const runId = res.json().run.id as string;
    expect(res.json().run.workspace_branch ?? null).toBeNull(); // ordinary workspace in Phase A

    const leases = await heldLeasesForRun(server, runId);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ holder_type: "run", path: "src/foo", mode: "write" });
  });

  it("dedupes case-only duplicate write_paths to one canonical lowercase lease", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task, ["Src/Foo", "src/foo"]);
    const runId = res.json().run.id as string;
    const leases = await heldLeasesForRun(server, runId);
    expect(leases).toHaveLength(1);
    expect(leases[0]?.path).toBe("src/foo");
  });

  it("aborts the whole assign on a conflicting write lease: 409, no run, task stays ready", async () => {
    server = await buildTestServer();
    // A foreign held write lease on src/foo (holder = task).
    const blocker = await createReadyTask(server, { required_capabilities: [] });
    const acq = await server.app.inject({
      method: "POST",
      url: "/api/v1/leases",
      payload: { task_id: blocker, path: "src/foo", mode: "write" },
    });
    expect(acq.statusCode).toBe(201);

    const task = await createReadyTask(server);
    const res = await assign(server, task, ["src/foo/bar.ts"]); // overlaps src/foo
    expect(res.statusCode).toBe(409);

    const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${task}` });
    expect(snap.json().task.status).toBe("ready"); // rolled back, recoverable
    expect(snap.json().runs).toHaveLength(0); // no orphan run
  });

  it("missing write_paths is a back-compat no-op (no leases reserved)", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const res = await assign(server, task);
    expect(res.statusCode).toBe(200);
    expect(await heldLeasesForRun(server, res.json().run.id as string)).toHaveLength(0);
  });
});

describe("#20 lease release on terminal run states", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("releases the run's leases when the run completes", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task, ["src/foo"])).json().run.id as string;
    expect(await heldLeasesForRun(server, runId)).toHaveLength(1);

    await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
    expect(await heldLeasesForRun(server, runId)).toHaveLength(0);
  });

  it("releases the run's leases when the run fails", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task, ["src/foo"])).json().run.id as string;

    await server.app.inject({
      method: "POST",
      url: `/api/v1/dev/runs/${runId}/mock-execute?outcome=failed`,
    });
    expect(await heldLeasesForRun(server, runId)).toHaveLength(0);
  });

  it("releases the run's leases when the run is cancelled", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task, ["src/foo"])).json().run.id as string;

    const cancelled = await server.app.inject({
      method: "POST",
      url: `/api/v1/runs/${runId}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(await heldLeasesForRun(server, runId)).toHaveLength(0);
  });

  it("releases the run's leases on rejected run.start recovery", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task, ["src/foo"])).json().run.id as string;

    await failRunStart(server.ctx, runId, "process_start_failed", "adapter rejected");
    expect(await heldLeasesForRun(server, runId)).toHaveLength(0);
  });
});

describe("#20 artifact integration queue", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("enqueues patch/pull_request artifacts only, not reports", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task)).json().run.id as string;
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: NODE,
      sequence: 1,
      event: { kind: "lifecycle", phase: "started" },
    });
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: NODE,
      sequence: 2,
      event: { kind: "artifact", artifactType: "patch", uri: "file://changes.patch" },
    });
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: NODE,
      sequence: 3,
      event: { kind: "artifact", artifactType: "report", uri: "file://report.md" },
    });

    const queue = await server.db.db
      .select()
      .from(integrationQueue)
      .where(eq(integrationQueue.organizationId, "org_default"));
    expect(queue).toHaveLength(1); // only the patch
    expect(queue[0]?.status).toBe("queued");
    expect(queue[0]?.runId).toBe(runId);
    expect(queue[0]?.artifactRef).toBeTruthy();
  });

  it("does not enqueue a duplicate on replayed artifact events", async () => {
    server = await buildTestServer();
    const task = await createReadyTask(server);
    const runId = (await assign(server, task)).json().run.id as string;
    await ingestRunEvent(server.ctx, {
      runId,
      nodeId: NODE,
      sequence: 1,
      event: { kind: "lifecycle", phase: "started" },
    });
    const artifact = {
      runId,
      nodeId: NODE,
      sequence: 2,
      event: { kind: "artifact", artifactType: "patch", uri: "file://changes.patch" } as const,
    };
    await ingestRunEvent(server.ctx, artifact);
    await ingestRunEvent(server.ctx, artifact);

    const queue = await server.db.db
      .select()
      .from(integrationQueue)
      .where(eq(integrationQueue.organizationId, "org_default"));
    expect(queue).toHaveLength(1);
  });
});
