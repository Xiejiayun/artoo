import { agentInstances, agents, contextPacks, eventLog, messages, tasks } from "@artoo/db";
import { AgentHistoryPageSchema, AgentHistoryDetailSchema, AgentHistoryQuerySchema, AgentHistoryEventsQuerySchema } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { getAgentHistoryRun, listAgentHistory } from "./services/agent-history-service.js";
import { ingestRunEvent } from "./services/run-service.js";

let server: TestServer;
beforeEach(async () => { server = await buildTestServer(); });
afterEach(async () => { await server.close(); });
const base = "/api/v1/agents/agent_mock_coder/history";
async function execution(title: string, outcome = "completed") {
  const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title, description: "Original request 原文", acceptance_criteria: ["Preserve history"], required_capabilities: ["code.modify"],
  } });
  expect(created.statusCode).toBe(201);
  const id = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
  const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } });
  expect(assigned.statusCode, assigned.body).toBe(200);
  const run = assigned.json().run;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${run.id}/mock-execute?outcome=${outcome}` })).statusCode).toBe(200);
  return run;
}

it("paginates tied timestamps, filters executions and reloads original requests and all durable events", async () => {
  const r1 = await execution("First"), r2 = await execution("Second");
  const first = await server.app.inject({ method: "GET", url: `${base}?limit=1` });
  expect(first.statusCode, first.body).toBe(200);
  const p1 = AgentHistoryPageSchema.parse(first.json());
  expect(p1.runs.map(row => row.run.id)).toEqual([r2.id]);
  expect(p1.next_before_run_id).toBe(r2.id);
  const p2 = (await server.app.inject({ method: "GET", url: `${base}?limit=1&before_run_id=${r2.id}` })).json();
  expect(p2.runs.map((row: { run: { id: string } }) => row.run.id)).toEqual([r1.id]);
  expect(p2.next_before_run_id).toBeNull();
  expect((await server.app.inject({ method: "GET", url: `${base}?status=failed` })).json().runs).toEqual([]);
  expect((await server.app.inject({ method: "GET", url: `${base}?project_id=other` })).json().runs).toEqual([]);
  await server.db.db.update(tasks).set({ title: "Changed title", description: "Changed request" }).where(eq(tasks.id, r1.task_id));
  const details = AgentHistoryDetailSchema.parse((await server.app.inject({ method: "GET", url: `${base}/${r1.id}?limit=2` })).json());
  expect(details.request).toMatchObject({ title: "First", description: "Original request 原文" });
  expect(details).not.toHaveProperty("context_pack");
  let page = details;
  const ids = details.events.map(e => e.id);
  while (page.next_before !== null) {
    page = AgentHistoryDetailSchema.parse((await server.app.inject({ method: "GET", url: `${base}/${r1.id}?limit=2&before=${page.next_before}` })).json());
    ids.push(...page.events.map(e => e.id));
  }
  const full = AgentHistoryDetailSchema.parse((await server.app.inject({ method: "GET", url: `${base}/${r1.id}` })).json());
  expect(ids).toEqual(full.events.map(e => e.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(full.events.map(e => e.type)).toEqual(expect.arrayContaining(["run.started", "run.output", "run.completed"]));
  expect((await server.app.inject({ method: "GET", url: `${base}/${r1.id}` })).json()).toEqual(full);
});

it("keeps final answers, failures and deleted resource history without mixing identities or organizations", async () => {
  const run = await execution("Audit");
  // Completed runs may deliver their final answer after their lifecycle frame.
  await ingestRunEvent(server.ctx, { runId: run.id, nodeId: run.computer_id, sequence: 10, event: { kind: "answer", text: "Late answer" } });
  const [agent] = await server.db.db.select().from(agents);
  await server.db.db.insert(agents).values({ ...agent!, id: "other_agent" });
  expect((await server.app.inject({ method: "GET", url: `/api/v1/agents/other_agent/history/${run.id}` })).statusCode).toBe(404);
  expect((await server.app.inject({ method: "GET", url: `/api/v1/agents/other_agent/history?instance_id=instance_mock_coder` })).statusCode).toBe(404);
  await expect(listAgentHistory({ ...server.ctx, organizationId: "foreign" }, "agent_mock_coder", AgentHistoryQuerySchema.parse({}))).rejects.toThrow("Agent not found");
  await expect(getAgentHistoryRun({ ...server.ctx, organizationId: "foreign" }, "agent_mock_coder", run.id, AgentHistoryEventsQuerySchema.parse({}))).rejects.toThrow("Agent execution not found");
  await server.db.db.update(agentInstances).set({ deletedAt: server.ctx.clock.nowIso(), status: "disabled" });
  await server.db.db.update(agents).set({ deletedAt: server.ctx.clock.nowIso() });
  expect((await server.app.inject({ method: "GET", url: base })).json().runs).toHaveLength(1);
  const events = (await server.app.inject({ method: "GET", url: `${base}/${run.id}` })).json().events;
  expect(events).toContainEqual(expect.objectContaining({ type: "message.created", response_text: "Late answer" }));
  await server.db.db.update(messages).set({ moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: "user_owner" }).where(eq(messages.runId, run.id));
  const moderated = (await server.app.inject({ method: "GET", url: `${base}/${run.id}` })).json();
  expect(JSON.stringify(moderated)).not.toContain("Late answer");
  await server.db.db.update(contextPacks).set({ payload: {} }).where(eq(contextPacks.id, run.context_pack_id));
  expect((await server.app.inject({ method: "GET", url: `${base}/${run.id}` })).json().request).toBeNull();
  expect((await server.db.db.select().from(eventLog)).length).toBeGreaterThan(0);
});

it("validates bounds, unknown filters, foreign cursors and missing resources", async () => {
  for (const query of ["limit=0", "limit=101", "limit=NaN", "status=bogus", "unknown=1", "before_run_id=missing"]) {
    expect((await server.app.inject({ method: "GET", url: `${base}?${query}` })).statusCode, query).toBe(400);
  }
  const run = await execution("Bounds");
  for (const query of ["before=-1", "before=1.5", "before=9007199254740992", "limit=101"]) {
    expect((await server.app.inject({ method: "GET", url: `${base}/${run.id}?${query}` })).statusCode, query).toBe(400);
  }
  expect((await server.app.inject({ method: "GET", url: "/api/v1/agents/missing/history" })).statusCode).toBe(404);
  expect((await server.app.inject({ method: "GET", url: `${base}?instance_id=missing` })).statusCode).toBe(404);
});

it("retains failed execution reasons and requires authentication when enabled", async () => {
  const run = await execution("Failed operation", "failed");
  const failed = AgentHistoryPageSchema.parse((await server.app.inject({ method: "GET", url: `${base}?status=failed&instance_id=instance_mock_coder` })).json());
  expect(failed.runs.map(row => row.run.id)).toEqual([run.id]);
  expect(failed.runs[0]!.run.failure_reason).toBe("mock failure");
  const detail = AgentHistoryDetailSchema.parse((await server.app.inject({ method: "GET", url: `${base}/${run.id}` })).json());
  expect(detail.events).toContainEqual(expect.objectContaining({ type: "run.failed", payload: expect.objectContaining({ failure_reason: "mock failure" }) }));
  const authenticated = await buildTestServer({ authConfig: { enforceApiAuth: true } });
  try {
    expect((await authenticated.app.inject({ method: "GET", url: base })).statusCode).toBe(401);
    expect((await authenticated.app.inject({ method: "GET", url: `${base}/${run.id}` })).statusCode).toBe(401);
  } finally { await authenticated.close(); }
});
