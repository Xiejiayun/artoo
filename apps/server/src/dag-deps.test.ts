import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(server: TestServer, title: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title, acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

async function addDependency(
  server: TestServer,
  dependentId: string,
  prerequisiteId: string,
  type: string,
): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${dependentId}/dependencies`,
    payload: { depends_on_task_id: prerequisiteId, type },
  });
  return res.json().dependency.id as string;
}

async function listDeps(server: TestServer, taskId: string) {
  const res = await server.app.inject({
    method: "GET",
    url: `/api/v1/tasks/${taskId}/dependencies`,
  });
  return res.json().dependencies as { id: string; from_task_id: string; to_task_id: string; type: string }[];
}

describe("task DAG dependency list + delete", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("lists a task's prerequisites (edges where it is the dependent)", async () => {
    server = await buildTestServer();
    const p1 = await createTask(server, "p1");
    const p2 = await createTask(server, "p2");
    const dependent = await createTask(server, "dependent");
    await addDependency(server, dependent, p1, "blocks");
    await addDependency(server, dependent, p2, "artifact_required");

    const deps = await listDeps(server, dependent);
    expect(deps).toHaveLength(2);
    expect(deps.every((d) => d.to_task_id === dependent)).toBe(true);
    expect(deps.map((d) => d.from_task_id).sort()).toEqual([p1, p2].sort());
    // The prerequisite itself has no prerequisites.
    expect(await listDeps(server, p1)).toHaveLength(0);
  });

  it("deletes a prerequisite edge and removes it from the list", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq");
    const dependent = await createTask(server, "dependent");
    const depId = await addDependency(server, dependent, prereq, "blocks");

    const del = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${dependent}/dependencies/${depId}`,
    });
    expect(del.statusCode).toBe(204);
    expect(await listDeps(server, dependent)).toHaveLength(0);
  });

  it("404 on unknown dependency, 400 when the edge is not the task's", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, "prereq");
    const dependent = await createTask(server, "dependent");
    const depId = await addDependency(server, dependent, prereq, "blocks");

    const missing = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${dependent}/dependencies/dep_does_not_exist`,
    });
    expect(missing.statusCode).toBe(404);

    // The edge belongs to `dependent`, not `prereq`.
    const wrongOwner = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/tasks/${prereq}/dependencies/${depId}`,
    });
    expect(wrongOwner.statusCode).toBe(400);
    // The edge survives the rejected delete.
    expect(await listDeps(server, dependent)).toHaveLength(1);
  });
});
