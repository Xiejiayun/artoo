import { agentInstances, agents, projects } from "@artoo/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { enqueueAssistantTurn } from "./services/assistant-service.js";
import { createChannel } from "./services/channel-service.js";
import { startDiscussion } from "./services/discussion-service.js";
import { createGoal } from "./services/goal-service.js";
import { scheduleTask } from "./services/scheduler.js";
import { putProjectSquad } from "./services/team-resource-service.js";

let server: TestServer;
afterEach(async () => {
  await server?.close();
});
const participants = [
  { agent_instance_id: "instance_mock_coder", role: "Implementation" },
  { agent_instance_id: "squad-review-instance", role: "Review" },
];
const selection = {
  mode: "manual" as const,
  projectId: "proj_artoo",
  agentInstanceId: "instance_mock_coder",
  branchBacked: false,
};

async function setup() {
  server = await buildTestServer();
  const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
  const [instance] = await server.db.db
    .select()
    .from(agentInstances)
    .where(eq(agentInstances.id, "instance_mock_coder"));
  await server.db.db.insert(agents).values({ ...agent!, id: "squad-review-agent", displayName: "Reviewer" });
  await server.db.db
    .insert(agentInstances)
    .values({ ...instance!, id: "squad-review-instance", agentId: "squad-review-agent" });
  const channel = await createChannel(server.ctx, {
    project_id: "proj_artoo",
    name: "Squad collaboration",
    description: "",
  });
  const goal = await createGoal(server.ctx, {
    project_id: "proj_artoo",
    title: "Shared team selection",
    objective: "Plan and execute using the configured team",
  });
  return { channel, goal };
}
const converse = (roomId: string) =>
  enqueueAssistantTurn(server.ctx, roomId, {
    body: "Review the shared requirements",
    client_request_id: "squad-conversation",
    agent_instance_id: "instance_mock_coder",
  });
const discuss = (goalId: string) => startDiscussion(server.ctx, goalId, { participants, rounds: 1, max_minutes: 5 });
const select = () => scheduleTask(server.db.db, server.ctx, ["code.modify"], selection);

it("keeps legacy binding and admits explicit organization-wide Squad members across all three owners", async () => {
  const { channel, goal } = await setup();
  expect((await select()).selected.agent_instance_id).toBe("instance_mock_coder");
  await server.db.db
    .update(agentInstances)
    .set({ projectId: null })
    .where(
      inArray(
        agentInstances.id,
        participants.map((participant) => participant.agent_instance_id),
      ),
    );
  await expect(select()).rejects.toThrow();
  await expect(converse(channel.id)).rejects.toThrow("squad");
  await expect(discuss(goal.id)).rejects.toThrow("squad");
  await putProjectSquad(server.ctx, "proj_artoo", {
    version: 1,
    expected_revision: 0,
    agent_ids: ["agent_mock_coder", "squad-review-agent"],
  });
  expect((await select()).selected.agent_instance_id).toBe("instance_mock_coder");
  expect((await converse(channel.id)).turn.status).toBe("queued");
  expect((await discuss(goal.id)).participants).toEqual(participants);
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Manual shared worker",
      required_capabilities: ["code.modify"],
      acceptance_criteria: ["Produce the requested change"],
    },
  });
  const taskId = created.json().task.id;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "manual", agent_instance_id: "instance_mock_coder" },
  });
  expect(assigned.statusCode).toBe(200);
  expect(assigned.json().run.agent_instance_id).toBe("instance_mock_coder");
});

it("treats an explicit empty Squad as removal even for legacy project-bound instances", async () => {
  const { channel, goal } = await setup();
  await putProjectSquad(server.ctx, "proj_artoo", { version: 1, expected_revision: 0, agent_ids: [] });
  await expect(select()).rejects.toThrow();
  await expect(converse(channel.id)).rejects.toThrow("squad");
  await expect(discuss(goal.id)).rejects.toThrow("squad");
});

it("never borrows another project's instance or selects a deleted logical Agent", async () => {
  const { channel, goal } = await setup();
  await putProjectSquad(server.ctx, "proj_artoo", {
    version: 1,
    expected_revision: 0,
    agent_ids: ["agent_mock_coder", "squad-review-agent"],
  });
  await server.db.db.insert(projects).values({
    id: "squad-other-project",
    organizationId: server.ctx.organizationId,
    name: "Other project",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db
    .update(agentInstances)
    .set({ projectId: "squad-other-project" })
    .where(eq(agentInstances.id, "instance_mock_coder"));
  await expect(select()).rejects.toThrow();
  await expect(converse(channel.id)).rejects.toThrow("squad");
  await expect(discuss(goal.id)).rejects.toThrow("squad");
  await server.db.db
    .update(agentInstances)
    .set({ projectId: null })
    .where(eq(agentInstances.id, "instance_mock_coder"));
  await server.db.db
    .update(agents)
    .set({ deletedAt: server.ctx.clock.nowIso() })
    .where(eq(agents.id, "agent_mock_coder"));
  await expect(select()).rejects.toThrow();
  await expect(converse(channel.id)).rejects.toThrow("squad");
  await expect(discuss(goal.id)).rejects.toThrow("squad");
  await expect(
    scheduleTask(server.db.db, { ...server.ctx, organizationId: "foreign-organization" }, [], selection),
  ).rejects.toThrow();
});
