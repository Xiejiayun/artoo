import {
  agents,
  computers,
  contextPacks,
  eventLog,
  fileLeases,
  goals,
  projects,
  runs,
  schedulerDecisions,
  tasks,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
} from "@artoo/db";
import type { ServerContext } from "../context.js";
import { loadSchedulerRollout } from "../config/scheduler-rollout.js";
import type { TestServer } from "../test-support.js";

/** Explicit controlled legacy reservation; no process or external Provider. */
export async function fillProjectCapacity(
  server: TestServer,
  ctx: ServerContext = server.ctx,
  projectId = "proj_artoo",
) {
  const now = ctx.clock.nowIso(),
    common = { organizationId: ctx.organizationId, updatedByUserId: "user_owner", updatedAt: now };
  for (const project of await server.db.db.select().from(projects))
    await server.db.db.insert(schedulerProjectPolicies).values({
      ...common,
      projectId: project.id,
      policy: {
        version: 1,
        repo_url: null,
        default_branch: "main",
        max_concurrent_runs: project.id === projectId ? 1 : 64,
      },
    });
  for (const agent of await server.db.db.select().from(agents))
    await server.db.db.insert(schedulerAgentPolicies).values({
      ...common,
      agentId: agent.id,
      policy: {
        version: 1,
        max_concurrent_runs: 64,
        pinned_computer_id: null,
        required_runtimes: [],
        required_labels: [],
      },
    });
  for (const computer of await server.db.db.select().from(computers))
    await server.db.db
      .insert(schedulerComputerPolicies)
      .values({ ...common, computerId: computer.id, policy: { version: 1, max_concurrent_runs: 64, labels: [] } });
  await server.db.db.insert(tasks).values({
    id: "controlled_capacity_blocker",
    organizationId: ctx.organizationId,
    projectId,
    title: "Controlled capacity reservation",
    status: "running",
    createdByType: "user",
    createdById: "user_owner",
    createdAt: now,
    updatedAt: now,
  });
  await server.db.db.insert(runs).values({
    id: "controlled_capacity_blocker_run",
    organizationId: ctx.organizationId,
    taskId: "controlled_capacity_blocker",
    computerId: "computer_local_mock",
    agentInstanceId: "instance_mock_coder",
    runtimeId: "mock",
    status: "running",
    createdAt: now,
  });
  const rollout = loadSchedulerRollout({
    ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
      version: 1,
      workspaces: { [ctx.organizationId]: { flags: { capacity_admission: true } } },
    }),
  });
  ctx.schedulerRollout = rollout;
  server.ctx.schedulerRollout = rollout;
}

/** Snapshot all generic writes an admission rejection must roll back. */
export async function capacityRollbackSnapshot(server: TestServer) {
  const result: unknown[] = [];
  for (const table of [tasks, runs, contextPacks, eventLog, fileLeases, goals, schedulerDecisions]) {
    const rows = await server.db.db.select().from(table);
    result.push(rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  }
  return result;
}

export const projectCapacityConflict = {
  code: "conflict",
  httpStatus: 409,
  details: { reason: "scheduler_capacity_exceeded", kind: "project", limit: 1 },
};
