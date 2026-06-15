import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

const PROJECT = "proj_artoo";

async function createTask(server: TestServer, title: string): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: PROJECT, title, acceptance_criteria: ["x"] },
  });
  return res.json().task.id as string;
}

interface ProposeBody {
  scope: "task" | "project" | "organization" | "code";
  project_id?: string;
  task_id?: string;
  text?: string;
  payload?: Record<string, unknown>;
  tags?: string[];
  confidence?: number;
}

async function propose(server: TestServer, body: ProposeBody) {
  return server.app.inject({ method: "POST", url: "/api/v1/memories", payload: body });
}

async function transition(server: TestServer, id: string, action: "accept" | "reject") {
  return server.app.inject({ method: "POST", url: `/api/v1/memories/${id}/${action}`, payload: {} });
}

/** Propose then accept, returning the accepted memory id. */
async function accepted(server: TestServer, body: ProposeBody): Promise<string> {
  const id = (await propose(server, body)).json().memory.id as string;
  await transition(server, id, "accept");
  return id;
}

describe("memory propose/curate (#21 Phase B)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("proposes a memory in proposed status", async () => {
    server = await buildTestServer();
    const res = await propose(server, { scope: "project", project_id: PROJECT, text: "prefer async/await" });
    expect(res.statusCode).toBe(201);
    expect(res.json().memory.status).toBe("proposed");
    expect(res.json().memory.scope).toBe("project");
  });

  it("rejects memories with no injectable content (blank text / empty payload)", async () => {
    server = await buildTestServer();
    expect((await propose(server, { scope: "project", project_id: PROJECT })).statusCode).toBe(400);
    expect((await propose(server, { scope: "project", project_id: PROJECT, text: "   " })).statusCode).toBe(400);
    expect(
      (await propose(server, { scope: "project", project_id: PROJECT, payload: {} })).statusCode,
    ).toBe(400);
    const withPayload = await propose(server, {
      scope: "project",
      project_id: PROJECT,
      payload: { rule: "x" },
    });
    expect(withPayload.statusCode).toBe(201);
  });

  it("accepts and rejects via the lifecycle", async () => {
    server = await buildTestServer();
    const a = (await propose(server, { scope: "project", project_id: PROJECT, text: "a" })).json().memory.id;
    expect((await transition(server, a, "accept")).json().memory.status).toBe("accepted");

    const b = (await propose(server, { scope: "project", project_id: PROJECT, text: "b" })).json().memory.id;
    expect((await transition(server, b, "reject")).json().memory.status).toBe("rejected");
  });

  it("rejects illegal transitions with 409 invalid_state", async () => {
    server = await buildTestServer();
    const id = await accepted(server, { scope: "project", project_id: PROJECT, text: "a" });
    const again = await transition(server, id, "accept");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("invalid_state");
  });

  it("404s an unknown memory and 400s an unknown action", async () => {
    server = await buildTestServer();
    expect((await transition(server, "mem_missing", "accept")).statusCode).toBe(404);
    const id = (await propose(server, { scope: "project", project_id: PROJECT, text: "a" })).json().memory.id;
    const bad = await server.app.inject({ method: "POST", url: `/api/v1/memories/${id}/archive`, payload: {} });
    expect(bad.statusCode).toBe(400);
  });

  it("supersedes an accepted memory: links ids, old becomes non-retrievable", async () => {
    server = await buildTestServer();
    const oldId = await accepted(server, { scope: "project", project_id: PROJECT, text: "old rule" });
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/memories/${oldId}/supersede`,
      payload: { scope: "project", project_id: PROJECT, text: "new rule" },
    });
    expect(res.statusCode).toBe(201);
    const newId = res.json().memory.id as string;
    expect(res.json().memory.status).toBe("accepted");
    expect(res.json().memory.supersedes_id).toBe(oldId);
    expect(res.json().superseded.id).toBe(oldId);
    expect(res.json().superseded.status).toBe("superseded");
    expect(res.json().superseded.superseded_by_id).toBe(newId);

    // The old memory is no longer injectable; the new one is.
    const ctx = await server.app.inject({
      method: "GET",
      url: `/api/v1/memories/context?project_id=${PROJECT}`,
    });
    const ids = ctx.json().source_memory_ids as string[];
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it("refuses to supersede a non-accepted memory (409) and rejects invalid replacement (400)", async () => {
    server = await buildTestServer();
    const proposed = (await propose(server, { scope: "project", project_id: PROJECT, text: "p" })).json()
      .memory.id;
    const conflict = await server.app.inject({
      method: "POST",
      url: `/api/v1/memories/${proposed}/supersede`,
      payload: { scope: "project", project_id: PROJECT, text: "x" },
    });
    expect(conflict.statusCode).toBe(409);

    const acceptedId = await accepted(server, { scope: "project", project_id: PROJECT, text: "keep me" });
    const invalid = await server.app.inject({
      method: "POST",
      url: `/api/v1/memories/${acceptedId}/supersede`,
      payload: { scope: "project", project_id: PROJECT, text: "  " },
    });
    expect(invalid.statusCode).toBe(400);
    // old memory untouched + still retrievable
    expect((await server.app.inject({ method: "GET", url: `/api/v1/memories/${acceptedId}` })).json().memory.status).toBe(
      "accepted",
    );
  });

  it("lists and filters by status", async () => {
    server = await buildTestServer();
    await accepted(server, { scope: "project", project_id: PROJECT, text: "a" });
    await propose(server, { scope: "project", project_id: PROJECT, text: "b" });
    const all = (await server.app.inject({ method: "GET", url: "/api/v1/memories" })).json().memories;
    expect(all.length).toBe(2);
    const onlyAccepted = (
      await server.app.inject({ method: "GET", url: "/api/v1/memories?status=accepted" })
    ).json().memories;
    expect(onlyAccepted.length).toBe(1);
    expect(onlyAccepted[0].status).toBe("accepted");
  });
});

describe("memory context retrieval (#21 Phase B)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("returns accepted-only memories ordered by scope priority with source ids", async () => {
    server = await buildTestServer();
    const task = await createTask(server, "t");
    const mTask = await accepted(server, { scope: "task", task_id: task, text: "task mem" });
    const mProj = await accepted(server, { scope: "project", project_id: PROJECT, text: "proj mem" });
    const mOrg = await accepted(server, { scope: "organization", text: "org mem" });
    const mCode = await accepted(server, { scope: "code", project_id: PROJECT, text: "code mem" });
    // noise: a proposed and a rejected memory must be excluded
    await propose(server, { scope: "project", project_id: PROJECT, text: "proposed" });
    const rej = (await propose(server, { scope: "project", project_id: PROJECT, text: "rej" })).json().memory.id;
    await transition(server, rej, "reject");

    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/memories/context?project_id=${PROJECT}&task_id=${task}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().source_memory_ids).toEqual([mTask, mProj, mOrg, mCode]);
    expect((res.json().memories as { status: string }[]).every((m) => m.status === "accepted")).toBe(true);
  });

  it("excludes project/code memories when the project context does not match", async () => {
    server = await buildTestServer();
    await accepted(server, { scope: "project", project_id: PROJECT, text: "proj mem" });
    await accepted(server, { scope: "code", project_id: PROJECT, text: "code mem" });
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/memories/context?project_id=proj_other",
    });
    expect(res.json().source_memory_ids).toEqual([]);
  });

  it("bounds injection with limit", async () => {
    server = await buildTestServer();
    const task = await createTask(server, "t");
    const mTask = await accepted(server, { scope: "task", task_id: task, text: "task mem" });
    await accepted(server, { scope: "project", project_id: PROJECT, text: "proj mem" });
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/memories/context?project_id=${PROJECT}&task_id=${task}&limit=1`,
    });
    expect(res.json().source_memory_ids).toEqual([mTask]);
  });

  it("validates a bad limit", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/memories/context?project_id=${PROJECT}&limit=-1`,
    });
    expect(res.statusCode).toBe(400);
  });
});
