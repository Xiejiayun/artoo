import { eventLog, goalAutomations, goalProductHandoffs } from "@artoo/db";
import { TaskSpecSchema } from "@artoo/domain";
import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { automaticSourceHandoffPlanErrors } from "./services/automatic-product-handoff-service.js";
import { createGoalAutomationDispatcher } from "./services/goal-automation-service.js";

describe("automatic source handoff original request authorization", () => {
  const lifecycle = settledServerFixture<{ server?: TestServer }>(() => ({}));
  const it = lifecycle.it, server = () => lifecycle.current().server!;
  lifecycle.beforeEach(async state => { state.server = await lifecycle.acquire(buildTestServer({
    onResourceAcquired: resource => lifecycle.own(resource) })); });
  lifecycle.afterEach();
  const request = { project_id: "proj_artoo", objective: "Build and publish a journal", execution_mode: "agent_team", release_profile_id: "site" };
  it("records the API user's opt-in separately from system selection and leaves legacy goals fixed", async () => {
    const legacy = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals", payload: request });
    expect(legacy.statusCode).toBe(201); expect(legacy.json().automation.source_handoff).toBeNull();
    const created = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals",
      payload: { ...request, source_handoff: { version: 1, mode: "automatic" } } });
    expect(created.statusCode).toBe(201); const id = created.json().goal.id as string;
    expect(created.json().automation.source_handoff).toEqual({ version: 1, mode: "automatic" });
    const events = await server().db.db.select().from(eventLog).where(eq(eventLog.goalId, id));
    expect(events.find(event => event.type === "goal.product-handoff.authorized")).toMatchObject({ actorType: "user", actorId: "user_owner",
      payload: { source_handoff: { version: 1, mode: "automatic" }, policy_version: server().ctx.aiDataSharingPolicy!.version } });
    expect(events.some(event => event.type === "goal.product-handoff.selected")).toBe(false);
    await expect(server().db.db.update(goalAutomations).set({ sourceHandoff: null }).where(eq(goalAutomations.goalId, id))).rejects.toThrow();
    await expect(server().db.db.update(goalAutomations).set({ sourceHandoff: { version: 1, mode: "automatic" } })
      .where(eq(goalAutomations.goalId, legacy.json().goal.id))).rejects.toThrow();
    const dispatcher = createGoalAutomationDispatcher(server().ctx, async () => {});
    try { await dispatcher.pump(); } finally { await dispatcher.stop(); }
    expect(await server().db.db.select().from(goalProductHandoffs)).toHaveLength(0);
  });
  it("rejects grant version changes and grants without an Agent Team publication request", async () => {
    for (const change of [{ execution_mode: "single_agent" }, { release_profile_id: undefined }, { source_handoff: { version: 2, mode: "automatic" } }]) {
      const response = await server().app.inject({ method: "POST", url: "/api/v1/autonomous-goals",
        payload: { ...request, source_handoff: { version: 1, mode: "automatic" }, ...change } });
      expect(response.statusCode).toBe(400);
    }
  });
  it("requires the supported first-hop four-stage plan without weakening ordinary plan validation", () => {
    const specs = ["research", "design", "implementation", "validation"].map((stage, index) => TaskSpecSchema.parse({ title: stage,
      development_stage: stage, acceptance_criteria: [stage], dependencies: index ? [{ ref: String(index - 1), type: "blocks" }] : [] }));
    expect(automaticSourceHandoffPlanErrors(specs)).toEqual([]);
    expect(automaticSourceHandoffPlanErrors([...specs, specs[3]!])).not.toEqual([]);
    expect(automaticSourceHandoffPlanErrors(specs.map((spec, index) => index === 2 ? { ...spec, dependencies: [{ ref: "0", type: "blocks" as const }] } : spec))).not.toEqual([]);
  });
});
