import { eventLog } from "@artoo/db";
import { ProjectControlViewV1Schema, type ProjectControlViewV1 } from "@artoo/domain";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getProjectControlView } from "./services/control-view-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

let server: TestServer;
const endpoint = "/api/v1/projects/proj_artoo/control-view";
beforeEach(async () => { server = await buildTestServer(); });
afterEach(async () => { await server.close(); });

async function createTask(title: string): Promise<string> {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title, description: "Read-only control view regression",
    acceptance_criteria: ["Preserve real state"], required_capabilities: ["code.modify"],
  } });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().task.id;
}

async function read(query = ""): Promise<ProjectControlViewV1> {
  const response = await server.app.inject({ method: "GET", url: `${endpoint}${query}` });
  expect(response.statusCode, response.body).toBe(200);
  return ProjectControlViewV1Schema.parse(response.json());
}

it("keeps full project totals while paging tied task timestamps without overlaps", async () => {
  await createTask("First bounded row");
  await createTask("Second bounded row");
  await createTask("Third bounded row");
  const full = await read("?limit=100");
  const expected = full.tasks.map((entry) => entry.task.id).sort().reverse();
  const ids: string[] = [];
  let page = await read("?limit=1");
  for (;;) {
    expect(page.summary).toEqual(full.summary);
    expect(page.tasks).toHaveLength(1);
    ids.push(...page.tasks.map((entry) => entry.task.id));
    if (!page.page.has_more) break;
    expect(page.page.next_after).not.toBeNull();
    page = await read(`?limit=1&after=${encodeURIComponent(page.page.next_after!)}`);
  }
  expect(ids).toEqual(expected);
  expect(new Set(ids).size).toBe(ids.length);
  expect(page.page.next_after).toBeNull();
  expect(full.summary.total_tasks).toBe(expected.length);
});

it("retains failed latest Run history and exposes capacity only as an explicit observation", async () => {
  const id = await createTask("Failure stays an attempt");
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
  const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } });
  expect(assigned.statusCode, assigned.body).toBe(200);
  const run = assigned.json().run;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${run.id}/mock-execute?outcome=failed` })).statusCode).toBe(200);
  const eventsBefore = await server.db.db.select().from(eventLog);
  const ordinary = await read("?limit=100");
  const row = ordinary.tasks.find((entry) => entry.task.id === id)!;
  expect(row.latest_run).toMatchObject({ id: run.id, status: "failed", failure_reason: "mock failure" });
  expect(row.task.status).not.toBe("failed");
  expect(row.execution_lease).toBeNull();
  expect(row.last_assignment).toMatchObject({ run_id: run.id, mode: "auto" });
  expect(ordinary.capacity).toMatchObject({ occupied: null, source: "not_requested" });
  const capacity = await read("?capacity=true");
  expect(capacity.capacity.source).toBe("reservation_snapshot");
  expect(capacity.capacity.occupied).toEqual(expect.any(Number));
  expect(capacity.cost_budget_enabled).toBe(false);
  expect(capacity).not.toHaveProperty("credentials");
  expect(await server.db.db.select().from(eventLog)).toEqual(eventsBefore);
});

it("rejects malformed or foreign cursors, invalid bounds and cross-organization reads", async () => {
  const foreign = Buffer.from(JSON.stringify({ version: 1, organization_id: "foreign", project_id: "proj_artoo", last_task_id: "any" })).toString("base64url");
  for (const query of ["limit=0", "limit=101", "limit=NaN", "capacity=yes", "extra=1", "after=broken", `after=${foreign}`]) {
    expect((await server.app.inject({ method: "GET", url: `${endpoint}?${query}` })).statusCode, query).toBe(400);
  }
  expect((await server.app.inject({ method: "GET", url: "/api/v1/projects/missing/control-view" })).statusCode).toBe(404);
  await expect(getProjectControlView({ ...server.ctx, organizationId: "foreign" }, "proj_artoo", {})).rejects.toThrow("Project not found");
});
