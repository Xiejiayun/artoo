import { agentInstances, agents, computerAdmissions, contextPacks, fileLeases, runs, users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import {
  createLogicalAgent,
  getLogicalAgentConfiguration,
  getProjectSquad,
  putLogicalAgentConfiguration,
  putProjectSquad,
  putComputerAdmission,
} from "./services/team-resource-service.js";
import { scheduleTask } from "./services/scheduler.js";

let server: TestServer;
afterEach(async () => {
  await server?.close();
});
const configuration = {
  version: 1 as const,
  display_name: "Team reviewer",
  kind: "reviewer" as const,
  capabilities: ["code.review" as const],
  role: "review",
  description: "Review changes",
  instructions: "Read the accepted requirements and report concrete findings.",
};

it("creates a logical Agent independently of a machine, preserves creation replay after edits, and rejects stale edits", async () => {
  server = await buildTestServer();
  const input = { version: 1, request_key: "team-reviewer", configuration };
  const first = await createLogicalAgent(server.ctx, input);
  expect(first.agent).toMatchObject({ kind: "reviewer", display_name: "Team reviewer", status: "offline" });
  expect(
    await server.db.db.select().from(agentInstances).where(eq(agentInstances.agentId, first.agent.id)),
  ).toHaveLength(0);
  const changed = await putLogicalAgentConfiguration(server.ctx, first.agent.id, {
    version: 1,
    expected_revision: 1,
    configuration: { ...configuration, instructions: "A revised instruction" },
  });
  expect(changed.revision).toBe(2);
  expect((await createLogicalAgent(server.ctx, input)).agent.id).toBe(first.agent.id);
  await expect(
    createLogicalAgent(server.ctx, { ...input, configuration: { ...configuration, role: "another" } }),
  ).rejects.toThrow("reused");
  await expect(
    putLogicalAgentConfiguration(server.ctx, first.agent.id, { version: 1, expected_revision: 1, configuration }),
  ).rejects.toThrow("changed");
  expect((await getLogicalAgentConfiguration(server.ctx, first.agent.id)).revision).toBe(2);
  expect(await server.db.db.select().from(agents).where(eq(agents.id, first.agent.id))).toHaveLength(1);
});

it("uses explicit logical Squad membership for an unbound instance while retaining the legacy default", async () => {
  server = await buildTestServer();
  const initial = await getProjectSquad(server.ctx, "proj_artoo");
  expect(initial).toMatchObject({ source: "legacy_instances", revision: 0 });
  expect(initial.agent_ids).toContain("agent_mock_coder");
  await server.db.db
    .update(agentInstances)
    .set({ projectId: null })
    .where(eq(agentInstances.id, "instance_mock_coder"));
  const options = { mode: "auto" as const, projectId: "proj_artoo", branchBacked: false };
  await expect(scheduleTask(server.db.db, server.ctx, ["code.modify"], options)).rejects.toThrow();
  const squad = await putProjectSquad(server.ctx, "proj_artoo", {
    version: 1,
    expected_revision: 0,
    agent_ids: ["agent_mock_coder"],
  });
  expect(squad).toMatchObject({ revision: 1, source: "configured" });
  expect((await scheduleTask(server.db.db, server.ctx, ["code.modify"], options)).selected.agent_id).toBe(
    "agent_mock_coder",
  );
  await expect(
    putProjectSquad(server.ctx, "proj_artoo", { version: 1, expected_revision: 0, agent_ids: [] }),
  ).rejects.toThrow("changed");
  await expect(
    putProjectSquad(server.ctx, "proj_artoo", { version: 1, expected_revision: 1, agent_ids: ["foreign"] }),
  ).rejects.toThrow("unavailable");
});

it("drains only new assignments and freezes logical guidance into the original Run context", async () => {
  server = await buildTestServer();
  const old = await getLogicalAgentConfiguration(server.ctx, "agent_mock_coder");
  const configured = await putLogicalAgentConfiguration(server.ctx, "agent_mock_coder", {
    version: 1,
    expected_revision: 0,
    configuration: { ...old.configuration, role: "builder", instructions: "Original frozen guidance" },
  });
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "A real assigned task",
      required_capabilities: ["code.modify"],
      acceptance_criteria: ["Produce the requested change"],
    },
  });
  const taskId = created.json().task.id;
  const ready = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  expect(ready.statusCode, ready.body).toBe(200);
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto" },
  });
  expect(assigned.statusCode).toBe(200);
  const run = assigned.json().run;
  const before = await server.db.db.select().from(runs).where(eq(runs.id, run.id));
  const leases = await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, run.id));
  const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
  expect(pack!.payload).toMatchObject({
    agent_configuration: { revision: configured.revision, role: "builder", instructions: "Original frozen guidance" },
  });
  expect(
    await putComputerAdmission(server.ctx, "computer_local_mock", {
      version: 1,
      expected_revision: 0,
      state: "draining",
    }),
  ).toMatchObject({ state: "draining", revision: 1 });
  expect(await server.db.db.select().from(runs).where(eq(runs.id, run.id))).toEqual(before);
  expect(await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, run.id))).toEqual(leases);
  expect((await server.db.db.select().from(computerAdmissions))[0]!.state).toBe("draining");
  await putLogicalAgentConfiguration(server.ctx, "agent_mock_coder", {
    version: 1,
    expected_revision: configured.revision,
    configuration: { ...configured.configuration, instructions: "New guidance applies to a later Run" },
  });
  expect(
    (await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id)))[0]!.payload,
  ).toEqual(pack!.payload);
  await expect(
    scheduleTask(server.db.db, server.ctx, ["code.modify"], {
      mode: "auto",
      projectId: "proj_artoo",
      branchBacked: false,
    }),
  ).rejects.toThrow();
});

it("enforces organization scope and administrator authority on every team edit", async () => {
  server = await buildTestServer();
  await server.db.db.insert(users).values({
    id: "team_member",
    organizationId: server.ctx.organizationId,
    displayName: "Member",
    email: "member@example.com",
    role: "member",
    createdAt: server.ctx.clock.nowIso(),
  });
  const member = { ...server.ctx, actorUserId: "team_member" };
  await expect(createLogicalAgent(member, { version: 1, request_key: "no", configuration })).rejects.toThrow();
  await expect(
    putProjectSquad(member, "proj_artoo", { version: 1, expected_revision: 0, agent_ids: [] }),
  ).rejects.toThrow();
  await expect(
    getLogicalAgentConfiguration({ ...server.ctx, organizationId: "another-org" }, "agent_mock_coder"),
  ).rejects.toThrow();
  expect(
    await server.db.db
      .select()
      .from(agents)
      .where(
        and(eq(agents.organizationId, server.ctx.organizationId), eq(agents.displayName, configuration.display_name)),
      ),
  ).toHaveLength(0);
});
