import {
  agentInstances,
  fileLeases,
  projects,
  runs,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
  tasks,
} from "@artoo/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { assignTask } from "./services/lifecycle-service.js";
import {
  assertSchedulerCapacity,
  lockSchedulerCapacity,
  persistRunReservation,
  schedulerCapacityStatus,
} from "./services/scheduler-capacity-service.js";
import { putSchedulerPolicy } from "./services/scheduler-policy-service.js";
import { collectSchedulerOccupants } from "./services/scheduler-shadow-snapshot.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import {
  capacityRollbackSnapshot,
  fillProjectCapacity,
  projectCapacityConflict,
} from "./test-fixtures/scheduler-capacity.js";

describe("shared real execution capacity admission", () => {
  let server: TestServer;
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
  });
  const projectId = "proj_artoo",
    computerId = "computer_local_mock",
    agentId = "agent_mock_coder",
    instanceId = "instance_mock_coder";
  async function setup() {
    server = await buildTestServer();
    const common = {
      organizationId: server.ctx.organizationId,
      updatedByUserId: server.ctx.actorUserId,
      updatedAt: server.ctx.clock.nowIso(),
    };
    await server.db.db.insert(schedulerProjectPolicies).values({
      ...common,
      projectId,
      policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
    });
    await server.db.db.insert(schedulerAgentPolicies).values({
      ...common,
      agentId,
      policy: {
        version: 1,
        pinned_computer_id: null,
        max_concurrent_runs: 2,
        required_runtimes: [],
        required_labels: [],
      },
    });
    await server.db.db
      .insert(schedulerComputerPolicies)
      .values({ ...common, computerId, policy: { version: 1, max_concurrent_runs: 2, labels: [] } });
    enable();
  }
  function enable(projectsConfig?: Record<string, { capacity_admission: boolean }>) {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: { org_default: { flags: { capacity_admission: true }, projects: projectsConfig } },
      }),
    });
  }
  async function task(id: string, project = projectId) {
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(tasks).values({
      id,
      organizationId: server.ctx.organizationId,
      projectId: project,
      title: id,
      status: "ready",
      createdByType: "user",
      createdById: "user_owner",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }
  const values = (id: string, taskId: string) => ({
    id,
    taskId,
    organizationId: "org_default",
    computerId,
    agentInstanceId: instanceId,
    runtimeId: "mock",
    status: "queued" as const,
    createdAt: server.ctx.clock.nowIso(),
  });
  const reserve = (id: string, taskId: string) =>
    server.db.transaction((tx) => persistRunReservation(server.ctx, tx, values(id, taskId)));

  it("adds no capacity reads when the organization is off", async () => {
    await setup();
    server.ctx.schedulerRollout = undefined;
    const id = await task("off");
    await server.db.transaction(async (tx) => {
      const execute = vi.spyOn(tx, "execute"),
        select = vi.spyOn(tx, "select");
      await persistRunReservation(server.ctx, tx, values("off_run", id));
      expect(execute).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
    });
    expect(schedulerCapacityStatus(server.ctx, projectId)).toEqual({
      version: 1,
      shared_quotas_enabled: false,
      project_quota_enabled: false,
    });
  });
  it.each(["project", "computer", "agent"] as const)(
    "enforces the %s quota against committed Run reservations",
    async (kind) => {
      await setup();
      const table =
        kind === "project"
          ? schedulerProjectPolicies
          : kind === "computer"
            ? schedulerComputerPolicies
            : schedulerAgentPolicies;
      await server.db.db.update(table).set({ policy: sql`jsonb_set(policy,'{max_concurrent_runs}','1')` });
      const first = await task("first"),
        second = await task("second");
      await reserve("first_run", first);
      await expect(reserve("second_run", second)).rejects.toMatchObject({
        code: "conflict",
        details: { reason: "scheduler_capacity_exceeded", kind, occupied: 1, limit: 1 },
      });
      expect(await server.db.db.select().from(runs)).toHaveLength(1);
    },
  );
  it("rejects missing policies, bare handles, stale snapshots and foreign bindings", async () => {
    await setup();
    const id = await task("guarded");
    await expect(lockSchedulerCapacity(server.ctx, server.db.db)).rejects.toMatchObject({
      details: { reason: "scheduler_capacity_transaction" },
    });
    await expect(
      server.db.db.transaction((tx) => persistRunReservation(server.ctx, tx, values("stale", id)), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toMatchObject({ details: { reason: "scheduler_capacity_transaction" } });
    await server.db.db.delete(schedulerComputerPolicies);
    await expect(reserve("missing", id)).rejects.toMatchObject({
      details: { reason: "scheduler_capacity_missing_policy" },
    });
    await expect(
      server.db.transaction((tx) =>
        assertSchedulerCapacity(server.ctx, tx, {
          key: "review:foreign",
          projectId,
          computerId: "other-computer",
          participantInstanceIds: [instanceId],
        }),
      ),
    ).rejects.toMatchObject({ details: { reason: "scheduler_capacity_binding" } });
    expect(await server.db.db.select().from(runs)).toEqual([]);
  });
  it("keeps shared quotas across opted-out projects while leaving their project quota inactive", async () => {
    await setup();
    const [project] = await server.db.db.select().from(projects).where(eq(projects.id, projectId));
    await server.db.db.insert(projects).values({ ...project!, id: "other_project" });
    await server.db.db.insert(schedulerProjectPolicies).values({
      projectId: "other_project",
      organizationId: "org_default",
      policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 1 },
      updatedByUserId: "user_owner",
      updatedAt: server.ctx.clock.nowIso(),
    });
    await server.db.db.update(agentInstances).set({ projectId: null }).where(eq(agentInstances.id, instanceId));
    enable({ other_project: { capacity_admission: false } });
    await reserve("other_one", await task("other_one", "other_project"));
    await reserve("other_two", await task("other_two", "other_project"));
    await expect(reserve("enabled_run", await task("enabled_task"))).rejects.toMatchObject({
      details: { kind: "computer", reason: "scheduler_capacity_exceeded" },
    });
    expect(schedulerCapacityStatus(server.ctx, "other_project")).toEqual({
      version: 1,
      shared_quotas_enabled: true,
      project_quota_enabled: false,
    });
  });
  it("retains held resources and unconfirmed disconnects after logical termination", async () => {
    await setup();
    const id = await task("uncertain");
    await reserve("uncertain_run", id);
    await server.db.db
      .update(runs)
      .set({ status: "failed", failureReason: "daemon_disconnect" })
      .where(eq(runs.id, "uncertain_run"));
    await server.db.db.insert(fileLeases).values({
      id: "held_capacity",
      organizationId: "org_default",
      projectId,
      taskId: id,
      runId: "uncertain_run",
      path: "retained",
      mode: "write",
      holderType: "run",
      holderId: "uncertain_run",
      status: "held",
      acquiredAt: server.ctx.clock.nowIso(),
      createdAt: server.ctx.clock.nowIso(),
    });
    const occupants = await collectSchedulerOccupants(server.ctx, server.db.db);
    expect(occupants).toMatchObject([
      {
        key: "run:uncertain_run",
        agent_instance_ids: [instanceId],
        evidence: expect.arrayContaining(["held_file_lease", "unconfirmed_disconnect"]),
      },
    ]);
    await server.db.db
      .update(schedulerProjectPolicies)
      .set({ policy: sql`jsonb_set(policy,'{max_concurrent_runs}','1')` });
    await expect(reserve("after_failure", await task("after_failure"))).rejects.toMatchObject(projectCapacityConflict);
    await server.db.db.update(fileLeases).set({ status: "released" });
    expect(await collectSchedulerOccupants(server.ctx, server.db.db)).toMatchObject([
      { evidence: ["unconfirmed_disconnect"] },
    ]);
    await expect(reserve("still_uncertain", await task("still_uncertain"))).rejects.toMatchObject(
      projectCapacityConflict,
    );
  });
  it("allows an exact counted replay after quota lowering, rejecting changed participant identity", async () => {
    await setup();
    await reserve("one", await task("one_task"));
    await reserve("two", await task("two_task"));
    await putSchedulerPolicy(server.ctx, "project", projectId, {
      version: 1,
      repo_url: null,
      default_branch: "main",
      max_concurrent_runs: 1,
    });
    const replay = { key: "run:one", taskId: "one_task", projectId, computerId, participantInstanceIds: [instanceId] };
    await server.db.transaction((tx) => assertSchedulerCapacity(server.ctx, tx, replay));
    const [instance] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, instanceId));
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "same_agent_other_instance" });
    await expect(
      server.db.transaction((tx) =>
        assertSchedulerCapacity(server.ctx, tx, { ...replay, participantInstanceIds: ["same_agent_other_instance"] }),
      ),
    ).rejects.toMatchObject({ details: { reason: "scheduler_capacity_binding" } });
    await expect(reserve("three", await task("three_task"))).rejects.toMatchObject(projectCapacityConflict);
  });
  it("rolls back ordinary assignment and its audit/context/resources without dispatch at capacity", async () => {
    server = await buildTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: projectId,
        title: "Actual assignment capacity",
        acceptance_criteria: ["Preserve all original assignment writes"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    await server.db.db
      .update(agentInstances)
      .set({ config: { concurrency_limit: 64 } })
      .where(eq(agentInstances.id, instanceId));
    await fillProjectCapacity(server);
    const before = await capacityRollbackSnapshot(server),
      dispatch = vi.fn();
    server.ctx.onRunQueued = dispatch;
    await expect(assignTask(server.ctx, taskId, { mode: "auto", write_paths: ["src/capacity"] })).rejects.toMatchObject(
      projectCapacityConflict,
    );
    expect(await capacityRollbackSnapshot(server)).toEqual(before);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
