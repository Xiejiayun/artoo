import { agentInstances, agents, computers, eventLog, runs, schedulerAgentPolicies, users } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("explicit initial Agent pin import", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  const request = (apply: boolean) =>
    server.app.inject({ method: "POST", url: "/api/v1/scheduler/agent-pin-import", payload: { apply } });
  it("previews an unambiguous binding, audits import and preserves later explicit unpinning", async () => {
    server = await buildTestServer();
    const before = await server.db.db.select().from(agentInstances);
    expect((await request(false)).json().import.results).toEqual([
      { agent_id: "agent_mock_coder", computer_ids: ["computer_local_mock"], status: "planned" },
    ]);
    expect(await server.db.db.select().from(schedulerAgentPolicies)).toEqual([]);
    expect((await request(true)).json().import.results[0].status).toBe("imported");
    const [saved] = await server.db.db.select().from(schedulerAgentPolicies);
    expect(saved).toMatchObject({
      organizationId: "org_default",
      updatedByUserId: "user_owner",
      policy: { pinned_computer_id: "computer_local_mock" },
    });
    const audit = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "scheduler.policy.imported"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "user",
      actorId: "user_owner",
      payload: { execution_authorized: false },
    });
    await server.db.db.update(schedulerAgentPolicies).set({ policy: { ...saved!.policy, pinned_computer_id: null } });
    expect((await request(true)).json().import.results[0].status).toBe("preserved");
    expect((await server.db.db.select().from(schedulerAgentPolicies))[0]?.policy.pinned_computer_id).toBeNull();
    expect(await server.db.db.select().from(agentInstances)).toEqual(before);
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });
  it("reports ambiguous/missing bindings and requires the current administrator", async () => {
    server = await buildTestServer();
    const [computer] = await server.db.db.select().from(computers),
      [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(computers).values({ ...computer!, id: "computer_second" });
    await server.db.db
      .insert(agentInstances)
      .values({ ...instance!, id: "instance_second", computerId: "computer_second" });
    await server.db.db.insert(agents).values({
      id: "agent_missing",
      organizationId: "org_default",
      displayName: "Unbound",
      kind: "mock",
      status: "idle",
      capabilities: [],
      createdAt: server.ctx.clock.nowIso(),
    });
    const result = await request(true);
    expect(result.statusCode).toBe(200);
    expect(result.json().import.results).toEqual([
      { agent_id: "agent_missing", computer_ids: [], status: "missing" },
      { agent_id: "agent_mock_coder", computer_ids: ["computer_local_mock", "computer_second"], status: "ambiguous" },
    ]);
    expect(await server.db.db.select().from(schedulerAgentPolicies)).toEqual([]);
    await server.db.db.update(users).set({ role: "member" }).where(eq(users.id, "user_owner"));
    expect((await request(false)).statusCode).toBe(403);
    expect((await request(true)).statusCode).toBe(403);
    expect(
      (await server.app.inject({ method: "POST", url: "/api/v1/scheduler/agent-pin-import", payload: {} })).statusCode,
    ).toBe(400);
  });
});
