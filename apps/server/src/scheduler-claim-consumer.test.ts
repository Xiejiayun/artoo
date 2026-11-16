import { randomUUID } from "node:crypto";
import {
  agentInstances,
  agentRuntimes,
  computers,
  devices,
  deviceTokens,
  runs,
  schedulerExecutionRequests,
  schedulerStartGrants,
  schedulerRequestStopIntents,
} from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createSchedulerExecutionRequest } from "./services/scheduler-execution-request-service.js";
import { currentTaskVersion } from "./services/sync-service.js";
import { putSchedulerPolicy } from "./services/scheduler-policy-service.js";
import {
  pollSchedulerExecution,
  schedulerExecutionConsumerStatus,
} from "./services/scheduler-claim-consumer-service.js";
import { requestSchedulerRunStop, schedulerRequestStopRequested } from "./services/scheduler-run-service.js";
import { prepareSchedulerStartProposal } from "./services/scheduler-start-proposal-service.js";
import { getProjectControlView } from "./services/control-view-service.js";

let server: TestServer;
afterEach(async () => {
  await server?.close();
});
const computerId = "computer_local_mock";
async function setup() {
  server = await buildTestServer();
  const session = {
    computerId,
    deviceId: "poll-device",
    tokenLookup: "controlled-poll-lookup",
    sessionId: randomUUID(),
  };
  server.ctx.schedulerRollout = loadSchedulerRollout({
    ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
      version: 1,
      workspaces: {
        org_default: {
          flags: Object.fromEntries(
            [
              "execution_requests",
              "daemon_claim",
              "isolated_workspaces",
              "capacity_admission",
              "unified_enqueue",
              "attempt_credentials",
            ].map((flag) => [flag, true]),
          ),
        },
      },
    }),
  });
  await server.db.db.update(computers).set({ os: "linux" }).where(eq(computers.id, computerId));
  const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
  await server.db.db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed!.id));
  // Controlled advertised runtime only; no CLI, Provider or process is invoked.
  await server.db.db.insert(agentInstances).values({
    ...seed!,
    id: "poll-instance",
    runtime: "codex",
    workspaceRoot: "/fixture/repository",
    config: {
      concurrency_limit: 2,
      worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "/fixture/attempts" },
    },
  });
  await server.db.db.insert(agentRuntimes).values({
    id: "poll-runtime",
    organizationId: server.ctx.organizationId,
    computerId,
    runtime: "codex",
    status: "available",
    capabilities: [],
    lastSeenAt: server.ctx.clock.nowIso(),
    metadata: {},
  });
  await server.db.db.insert(devices).values({
    id: session.deviceId,
    organizationId: server.ctx.organizationId,
    displayName: "Controlled poll node",
    platform: "linux",
    appVersion: "fixture",
    computerId,
    enrolledByUserId: "user_owner",
    trust: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db.insert(deviceTokens).values({
    id: "poll-token",
    organizationId: server.ctx.organizationId,
    deviceId: session.deviceId,
    kind: "node",
    tokenLookup: session.tokenLookup,
    tokenHash: "fixture-not-an-authenticated-token",
    status: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  server.ctx.getPairedNodeSession = (id) => (id === computerId ? { ...session } : undefined);
  server.ctx.supportsExecutionFeature = (id, feature) =>
    id === computerId && feature === "workspace-allocation.per-run-v1";
  server.ctx.supportsSchedulerClaim = (id) => id === computerId;
  server.ctx.onRunQueued = vi.fn(async () => {});
  for (const [kind, id, policy] of [
    ["project", "proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
    [
      "agent",
      "agent_mock_coder",
      {
        version: 1,
        pinned_computer_id: null,
        required_runtimes: ["codex"],
        required_labels: [],
        max_concurrent_runs: 2,
      },
    ],
    ["computer", computerId, { version: 1, labels: [], max_concurrent_runs: 2 }],
  ] as const)
    await putSchedulerPolicy(server.ctx, kind, id, policy);
  return { computerId, sessionId: session.sessionId };
}
async function stage(title: string) {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title, acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
  });
  const taskId = created.json().task.id as string;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
  const request = await createSchedulerExecutionRequest(server.ctx, taskId, {
    version: 2,
    permission: "execute_once",
    request_key: "one",
    agent_id: "agent_mock_coder",
    base_version: await currentTaskVersion(server.ctx, taskId),
    branch_backed: true,
    write_paths: [`src/${taskId}.ts`],
  });
  return { taskId, request };
}

it("polls original-user permission once, replays only the queued assignment and never dispatches ordinary Run start", async () => {
  const identity = await setup(),
    { taskId, request } = await stage("One permitted task");
  expect(await schedulerExecutionConsumerStatus(server.ctx, taskId)).toEqual({
    consumer_available: true,
    execution_authorized: false,
  });
  const daemon = {
    ...server.ctx,
    actorUserId: "daemon-not-the-authorizing-user",
    automationActor: { type: "system" as const, id: "goal_runner" as const },
  };
  const first = await pollSchedulerExecution(daemon, identity);
  expect(first.assignment).toMatchObject({ task_id: taskId, request_id: request.id });
  const rows = await server.db.db.select().from(runs);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.requestedByUserId).toBe("user_owner");
  expect((await pollSchedulerExecution(daemon, identity)).assignment).toEqual(first.assignment);
  expect(await server.db.db.select().from(runs)).toEqual(rows);
  expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(0);
  expect(server.ctx.onRunQueued).not.toHaveBeenCalled();
  await expect(pollSchedulerExecution(daemon, { ...identity, sessionId: randomUUID() })).rejects.toThrow(
    "current negotiated",
  );
});

it("keeps default-off permissions pending and reports actual consumer availability", async () => {
  const identity = await setup(),
    { taskId, request } = await stage("Disabled project");
  server.ctx.schedulerRollout = undefined;
  expect(await schedulerExecutionConsumerStatus(server.ctx, taskId)).toEqual({
    consumer_available: false,
    execution_authorized: false,
  });
  expect((await pollSchedulerExecution(server.ctx, identity)).assignment).toBeNull();
  expect(
    (
      await server.db.db.select().from(schedulerExecutionRequests).where(eq(schedulerExecutionRequests.id, request.id))
    )[0]!.state,
  ).toBe("pending");
  expect(await server.db.db.select().from(runs)).toHaveLength(0);
});

it("records Stop between claim and grant without granting physical execution or inventing closure", async () => {
  const identity = await setup(),
    { taskId, request } = await stage("Stop before grant");
  const result = await pollSchedulerExecution(server.ctx, identity),
    runId = result.assignment!.run_id;
  expect(await requestSchedulerRunStop(server.ctx, runId)).toEqual({ stop_requested: true });
  expect(await schedulerRequestStopRequested(server.ctx, server.db.db, request.id)).toBe(true);
  expect(await server.db.db.select().from(schedulerRequestStopIntents)).toHaveLength(1);
  expect((await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!.status).toBe("queued");
  const view = await getProjectControlView(server.ctx, "proj_artoo", { limit: 100 });
  expect(view.execution_consumer).toEqual({ consumer_available: true, execution_authorized: false });
  expect(view.tasks.find((entry) => entry.task.id === taskId)).toMatchObject({
    latest_run: { id: runId, status: "queued" },
    execution_lease: null,
    execution_request: { id: request.id, stop_requested: true, consumed_run_id: runId },
  });
  await expect(
    prepareSchedulerStartProposal(server.ctx, { ...identity, taskId, requestId: request.id }),
  ).rejects.toThrow();
  expect(await server.db.db.select().from(schedulerStartGrants)).toHaveLength(0);
});
