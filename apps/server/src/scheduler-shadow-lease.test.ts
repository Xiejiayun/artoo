import {
  agentInstances,
  agentRuntimes,
  eventLog,
  fileLeases,
  projects,
  runs,
  schedulerAgentPolicies,
  schedulerComputerPolicies,
  schedulerProjectPolicies,
  schedulerShadowAttempts,
  schedulerShadowObservations,
  schedulerShadowTaskHeads,
  schedulerTaskProjections,
  tasks,
} from "@artoo/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import {
  cancelSchedulerShadow,
  claimSchedulerShadow,
  finishSchedulerShadow,
  renewSchedulerShadow,
  startSchedulerShadow,
  type ShadowLeaseBindingV1,
} from "./services/scheduler-shadow-lease-service.js";
import { collectSchedulerOccupants, schedulerOccupancy } from "./services/scheduler-shadow-snapshot.js";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";

describe("non-executing shadow lease kernel", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  const projectId = "proj_artoo",
    agentId = "agent_mock_coder",
    instanceId = "instance_mock_coder",
    computerId = "computer_local_mock";
  async function setup() {
    server = await buildTestServer();
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"org_default":{"flags":{"claim_shadow":true}}}}',
    });
    const common = {
      organizationId: "org_default",
      updatedByUserId: "user_owner",
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
        pinned_computer_id: computerId,
        max_concurrent_runs: 2,
        required_runtimes: ["mock"],
        required_labels: ["test"],
      },
    });
    await server.db.db
      .insert(schedulerComputerPolicies)
      .values({ ...common, computerId, policy: { version: 1, max_concurrent_runs: 2, labels: ["test"] } });
  }
  async function ready(id: string) {
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(tasks).values({
      id,
      organizationId: "org_default",
      projectId,
      title: id,
      status: "ready",
      requiredCapabilities: ["code.modify"],
      createdByType: "user",
      createdById: "user_owner",
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }
  const claim = (taskId: string, leaseMs = 30_000) =>
    claimSchedulerShadow(server.ctx, { projectId, taskId, options: { mode: "auto", branchBacked: false }, leaseMs });
  async function claimed(taskId: string, leaseMs = 30_000) {
    const value = await claim(taskId, leaseMs);
    expect(value.kind).toBe("claimed");
    if (!("binding" in value)) throw new Error("Expected a shadow binding");
    return value.binding;
  }
  it("keeps the flag off path and real execution owners untouched", async () => {
    await setup();
    const id = await ready("task_off");
    server.ctx.schedulerRollout = undefined;
    expect(await claim(id)).toEqual({ kind: "disabled", execution_authorized: false });
    expect(await server.db.db.select().from(schedulerShadowTaskHeads)).toEqual([]);
    await setupFlag();
    const before = await server.db.db.select().from(tasks);
    const dispatch = vi.fn();
    server.ctx.onRunQueued = dispatch;
    const binding = await claimed(id);
    expect(binding).toMatchObject({
      version: 1,
      project_id: projectId,
      task_id: id,
      agent_id: agentId,
      agent_instance_id: instanceId,
      computer_id: computerId,
      epoch: 1,
      execution_authorized: false,
    });
    expect((await startSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    expect((await finishSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    expect(await server.db.db.select().from(tasks)).toEqual(before);
    for (const table of [runs, fileLeases, schedulerTaskProjections])
      expect(await server.db.db.select().from(table)).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  async function setupFlag() {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"org_default":{"flags":{"claim_shadow":true}}}}',
    });
  }
  it("counts open shadow reservations at all three capacity levels", async () => {
    await setup();
    const one = await ready("task_one"),
      two = await ready("task_two");
    const binding = await claimed(one);
    expect((await claim(one)).kind).toBe("already_claimed");
    for (const kind of ["project", "agent", "computer"] as const) {
      const table =
        kind === "project"
          ? schedulerProjectPolicies
          : kind === "agent"
            ? schedulerAgentPolicies
            : schedulerComputerPolicies;
      await server.db.db.execute(sql`UPDATE ${table} SET policy = jsonb_set(policy, '{max_concurrent_runs}', '1')`);
      const value = await claim(two);
      expect(value.kind).toBe("ineligible");
      if (!("ranking" in value)) throw new Error("Expected explained exclusion");
      expect(value.ranking.decisions[0]?.reasons).toContain(`${kind}_capacity`);
      await server.db.db.execute(sql`UPDATE ${table} SET policy = jsonb_set(policy, '{max_concurrent_runs}', '2')`);
    }
    expect((await cancelSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    expect((await claim(two)).kind).toBe("claimed");
  });
  it("cannot infer new-path runtime or labels from legacy fallback or policy metadata", async () => {
    await setup();
    const id = await ready("task_inventory");
    await server.db.db.delete(agentRuntimes);
    const missing = await claim(id);
    expect(missing.kind).toBe("ineligible");
    if (!("ranking" in missing)) throw new Error("Expected runtime explanation");
    expect(missing.ranking.decisions[0]?.reasons).toContain("runtime_unconfirmed");
    await server.db.db.insert(agentRuntimes).values({
      id: "runtime_restored",
      organizationId: "org_default",
      computerId,
      runtime: "mock",
      status: "available",
      capabilities: [],
      lastSeenAt: server.ctx.clock.nowIso(),
    });
    await server.db.db.execute(
      sql`UPDATE scheduler_computer_policies SET policy = jsonb_set(policy, '{labels}', '[]')`,
    );
    const labels = await claim(id);
    expect(labels.kind).toBe("ineligible");
    if (!("ranking" in labels)) throw new Error("Expected label explanation");
    expect(labels.ranking.decisions[0]?.reasons).toContain("required_label");
    expect(await server.db.db.select().from(schedulerShadowTaskHeads)).toEqual([]);
  });
  it("checks every scope/owner/attempt/epoch component and rejects regressed clocks", async () => {
    await setup();
    const binding = await claimed(await ready("task_binding"));
    const initial = await server.db.db.select().from(schedulerShadowAttempts);
    for (const field of [
      "project_id",
      "task_id",
      "attempt_id",
      "agent_id",
      "agent_instance_id",
      "computer_id",
      "epoch",
    ] as const) {
      const wrong = { ...binding, [field]: field === "epoch" ? 2 : "foreign" } as ShadowLeaseBindingV1;
      for (const mutate of [startSchedulerShadow, renewSchedulerShadow, finishSchedulerShadow, cancelSchedulerShadow])
        expect((await mutate(server.ctx, wrong)).kind).toBe("stale");
    }
    expect((await renewSchedulerShadow({ ...server.ctx, organizationId: "foreign" }, binding)).kind).toBe("disabled");
    const otherTenant = {
      ...server.ctx,
      organizationId: "foreign",
      schedulerRollout: loadSchedulerRollout({
        ARTOO_SCHEDULER_ROLLOUT: '{"version":1,"workspaces":{"foreign":{"flags":{"claim_shadow":true}}}}',
      }),
    };
    expect((await renewSchedulerShadow(otherTenant, binding)).kind).toBe("stale");
    server.ctx.clock = fixedClock("2026-06-12T23:59:59Z");
    expect((await startSchedulerShadow(server.ctx, binding)).kind).toBe("stale");
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual(initial);
  });
  it("compares timestamp precision in SQL and fences every old mutation after takeover", async () => {
    await setup();
    const id = await ready("task_expiry"),
      binding = await claimed(id);
    await server.db.db.update(schedulerShadowAttempts).set({ expiresAt: "2026-06-13T00:00:00.000500Z" });
    expect((await startSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    server.ctx.clock = fixedClock("2026-06-13T00:00:00.001Z");
    // Keep runtime availability fresh while advancing the server clock.
    expect((await renewSchedulerShadow(server.ctx, binding)).kind).toBe("stale");
    const replacement = await claimed(id);
    expect(replacement.epoch).toBe(2);
    for (const mutate of [startSchedulerShadow, renewSchedulerShadow, finishSchedulerShadow, cancelSchedulerShadow])
      expect((await mutate(server.ctx, binding)).kind).toBe("stale");
    const history = await server.db.db.select().from(schedulerShadowAttempts);
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.epoch === 1)?.state).toBe("expired");
    expect(history.find((row) => row.epoch === 2)?.state).toBe("claimed");
    expect((await server.db.db.select().from(tasks))[0]?.status).toBe("ready");
  });
  it("never shortens a renewal and never revives a terminal shadow lease", async () => {
    await setup();
    const binding = await claimed(await ready("task_renew"));
    const before = (await server.db.db.select().from(schedulerShadowAttempts))[0]!;
    expect((await renewSchedulerShadow(server.ctx, binding, 1000)).kind).toBe("updated");
    expect((await server.db.db.select().from(schedulerShadowAttempts))[0]?.expiresAt).toBe(before.expiresAt);
    expect((await finishSchedulerShadow(server.ctx, binding)).kind).toBe("stale");
    expect((await startSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    expect((await finishSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    expect((await renewSchedulerShadow(server.ctx, binding)).kind).toBe("stale");
    expect((await cancelSchedulerShadow(server.ctx, binding)).kind).toBe("stale");
  });
  it("rejects epoch exhaustion atomically without touching legacy state", async () => {
    await setup();
    const id = await ready("task_overflow");
    await server.db.db
      .insert(schedulerShadowTaskHeads)
      .values({ taskId: id, organizationId: "org_default", projectId, epoch: Number.MAX_SAFE_INTEGER });
    await expect(claim(id)).rejects.toThrow("epoch exhausted");
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual([]);
    expect((await server.db.db.select().from(tasks))[0]?.status).toBe("ready");
    await expect(server.db.db.update(schedulerShadowTaskHeads).set({ epoch: sql`9007199254740992` })).rejects.toThrow();
  });
  it("rejects a mismatched shadow head before expiration or ineligible early return", async () => {
    await setup();
    const id = await ready("task_corrupt_scope");
    await claimed(id);
    await server.db.db
      .insert(projects)
      .values({ id: "proj_other", organizationId: "org_default", name: "Other", createdAt: server.ctx.clock.nowIso() });
    await server.db.db.update(schedulerShadowTaskHeads).set({ projectId: "proj_other" });
    await server.db.db.update(schedulerShadowAttempts).set({ expiresAt: "2026-06-13T00:00:00.000500Z" });
    await server.db.db.delete(schedulerProjectPolicies);
    server.ctx.clock = fixedClock("2026-06-13T00:00:00.001Z");
    const before = await server.db.db.select().from(schedulerShadowAttempts);
    await expect(claim(id)).rejects.toThrow("identity/version mismatch");
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual(before);
  });
  it("cannot issue a new epoch behind its persisted server-clock history", async () => {
    await setup();
    const id = await ready("task_clock");
    const binding = await claimed(id);
    expect((await cancelSchedulerShadow(server.ctx, binding)).kind).toBe("updated");
    server.ctx.clock = fixedClock("2026-06-12T23:59:59Z");
    await expect(claim(id)).rejects.toThrow("server clock regressed");
    expect((await server.db.db.select().from(schedulerShadowTaskHeads))[0]?.epoch).toBe(1);
  });
  it("counts uncertain physical closure without write leases and dedupes a real Run against its shadow", async () => {
    await setup();
    const id = await ready("task_real"),
      second = await ready("task_later");
    await claimed(id);
    await server.db.db.insert(runs).values({
      id: "run_unconfirmed",
      organizationId: "org_default",
      taskId: id,
      computerId,
      agentInstanceId: instanceId,
      runtimeId: "mock",
      status: "failed",
      failureReason: "daemon_disconnect",
      createdAt: server.ctx.clock.nowIso(),
    });
    await server.db.db.update(tasks).set({ status: "assigned" }).where(eq(tasks.id, id));
    expect(await collectSchedulerOccupants(server.ctx, server.db.db)).toMatchObject([
      { key: "run:run_unconfirmed", task_id: id },
    ]);
    const value = await claim(second);
    expect(value.kind).toBe("claimed");
    if (!("snapshot" in value)) throw new Error("Expected capacity snapshot");
    expect(value.snapshot.occupancy).toEqual({ project: 1, agents: { [agentId]: 1 }, computers: { [computerId]: 1 } });
    await server.db.db.insert(eventLog).values({
      organizationId: "org_default",
      id: "event_closed",
      schemaVersion: "1",
      type: "run.reconciled",
      runId: "run_unconfirmed",
      actorType: "system",
      actorId: "node",
      correlationId: "run_unconfirmed",
      occurredAt: server.ctx.clock.nowIso(),
      payload: { process_exit_confirmed: true },
    });
    expect(await collectSchedulerOccupants(server.ctx, server.db.db)).toEqual([]);
  });
  it("captures an explained comparison at real assignment and never reconstructs its inputs later", async () => {
    await setup();
    await server.db.db.delete(schedulerProjectPolicies);
    const submitted = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: projectId,
        title: "Observe original assignment",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(submitted.statusCode).toBe(201);
    const id = submitted.json().task.id;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(200);
    const [saved] = await server.db.db.select().from(schedulerShadowObservations);
    expect(saved).toMatchObject({
      taskId: id,
      projectId,
      snapshot: { project_policy: null, occupancy: { project: 0 } },
      ranking: { selected_agent_instance_id: null, execution_authorized: false },
      revalidation: { selected_agent_instance_id: instanceId },
    });
    expect(saved?.ranking.decisions[0]?.reasons).toContain("project_policy_missing");
    expect(saved?.snapshot.candidates.map((c) => c.agent_instance_id)).toEqual([instanceId]);
    expect(await server.db.db.select().from(schedulerShadowAttempts)).toEqual([]);
    await server.db.db.insert(schedulerProjectPolicies).values({
      projectId,
      organizationId: "org_default",
      updatedByUserId: "user_owner",
      updatedAt: server.ctx.clock.nowIso(),
      policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
    });
    const observed = await server.app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/scheduler-shadow-observations`,
    });
    expect(observed.statusCode).toBe(200);
    expect(observed.json()).toMatchObject({
      execution_authorized: false,
      observations: [
        { differs: true, actual_agent_instance_id: instanceId, snapshot: saved!.snapshot, ranking: saved!.ranking },
      ],
    });
    expect(
      (await server.app.inject({ method: "GET", url: "/api/v1/projects/foreign/scheduler-shadow-observations" }))
        .statusCode,
    ).toBe(404);
  });
  it("rolls observations back with failed admission and keeps default-off assignment unchanged", async () => {
    await setup();
    await server.db.db
      .update(agentInstances)
      .set({ config: { worktree_workspace_base: "invalid-relative-base" } })
      .where(eq(agentInstances.id, instanceId));
    server.ctx.supportsExecutionFeature = () => true;
    const id = await ready("task_rollback");
    const rejected = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "auto", branch_backed: true },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await server.db.db.select().from(schedulerShadowObservations)).toEqual([]);
    expect(await server.db.db.select().from(runs)).toEqual([]);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]?.status).toBe("ready");
    server.ctx.schedulerRollout = undefined;
    const assigned = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "auto" },
    });
    expect(assigned.statusCode).toBe(200);
    expect(await server.db.db.select().from(schedulerShadowObservations)).toEqual([]);
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });
});

it("counts dedicated namespaces and shared participant Agents only once per operation", () => {
  const projectId = "proj_artoo",
    agentId = "agent_mock_coder",
    computerId = "computer_local_mock";
  expect(
    schedulerOccupancy(projectId, [
      { key: "run:same", project_id: projectId, task_id: "task", computer_id: computerId, agent_ids: [agentId] },
      {
        key: "design_review:same",
        project_id: "other_project",
        task_id: null,
        computer_id: computerId,
        agent_ids: [agentId, agentId, "reviewer"],
      },
    ]),
  ).toEqual({ project: 1, computers: { [computerId]: 2 }, agents: { [agentId]: 2, reviewer: 1 } });
});
