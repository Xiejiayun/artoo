import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

async function createTask(server: TestServer, body: Record<string, unknown> = {}): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "t", acceptance_criteria: ["x"], ...body },
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

describe("task DAG dependencies", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("creates a dependency (dependent depends on prerequisite)", async () => {
    server = await buildTestServer();
    const prereq = await createTask(server, { title: "prereq" });
    const dependent = await createTask(server, { title: "dependent" });
    const res = await addDependency(server, dependent, prereq, "blocks");
    expect(res.statusCode).toBe(201);
    expect(res.json().dependency).toMatchObject({
      from_task_id: prereq,
      to_task_id: dependent,
      type: "blocks",
    });
  });

  it("rejects self-dependency (400) and cycles (409)", async () => {
    server = await buildTestServer();
    const a = await createTask(server, { title: "a" });
    const b = await createTask(server, { title: "b" });

    expect((await addDependency(server, a, a)).statusCode).toBe(400);

    await addDependency(server, a, b); // a depends on b
    const cycle = await addDependency(server, b, a); // b depends on a -> cycle
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().error.code).toBe("conflict");
  });

  it("returns a DAG snapshot of the subtree with edges", async () => {
    server = await buildTestServer();
    const parent = await createTask(server, { title: "parent" });
    const child1 = await createTask(server, { title: "child1", parent_task_id: parent });
    const child2 = await createTask(server, { title: "child2", parent_task_id: parent });
    await addDependency(server, child2, child1, "blocks"); // child2 depends on child1

    const dag = (await server.app.inject({ method: "GET", url: `/api/v1/tasks/${parent}/dag` })).json()
      .dag;
    expect(dag.root_task_id).toBe(parent);
    expect((dag.nodes as { task_id: string }[]).map((n) => n.task_id).sort()).toEqual(
      [parent, child1, child2].sort(),
    );
    expect(dag.edges).toHaveLength(1);
    expect(dag.edges[0]).toMatchObject({
      from_task_id: child1,
      to_task_id: child2,
      type: "blocks",
    });
  });
});
