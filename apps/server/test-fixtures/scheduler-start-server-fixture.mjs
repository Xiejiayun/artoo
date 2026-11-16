// Real paired WebSocket + Fastify/PGlite grant services. Inventory and the
// execute-once request are controlled test setup; no live Provider is contacted.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  agentInstances,
  agentRuntimes,
  computers,
  devices,
  deviceTokens,
  fileLeases,
  runs,
  schedulerExecutionRequests,
  schedulerStartGrants,
} from "@artoo/db";
import { createManagedWebSocketTransport } from "../../artood/dist/managed/managed-ws-transport.js";
import { buildTestServer } from "../dist/test-support.js";
import { loadSchedulerRollout } from "../dist/config/scheduler-rollout.js";
import { generateDeviceToken } from "../dist/services/device-credential.js";
import { createSchedulerExecutionRequest } from "../dist/services/scheduler-execution-request-service.js";
import { claimSchedulerExecutionRequest } from "../dist/services/lifecycle-service.js";
import { currentTaskVersion } from "../dist/services/sync-service.js";

const NODE = "computer_local_mock",
  INSTANCE = "ai_scheduler_vertical";
export async function createSchedulerStartServerFixture({
  namespace,
  sourceRepo,
  allocationBase,
  artifactDir,
  machineOs = process.platform,
}) {
  const resources = [],
    incoming = [];
  let server,
    link,
    closed = false,
    dispatches = 0;
  const close = async () => {
    if (closed) return;
    const errors = [];
    try {
      await link?.close();
    } catch (error) {
      errors.push(error);
    }
    if (server) {
      try {
        await server.close();
      } catch (error) {
        errors.push(error);
      }
    } else {
      for (const resource of [...resources].reverse()) {
        try {
          await resource.close();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Scheduler server fixture closure uncertain");
    closed = true;
  };
  try {
    server = await buildTestServer({ artifactDir, onResourceAcquired: (resource) => resources.push(resource) });
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
              ].map((key) => [key, true]),
            ),
          },
        },
      }),
    });
    const db = server.db.db;
    const [seed] = await db.select().from(agentInstances).where(eq(agentInstances.id, "instance_mock_coder"));
    assert.ok(seed);
    await db.update(agentInstances).set({ status: "disabled" }).where(eq(agentInstances.id, seed.id));
    await db.update(computers).set({ os: machineOs, status: "online" }).where(eq(computers.id, NODE));
    await db.insert(agentInstances).values({
      ...seed,
      id: INSTANCE,
      runtime: "codex",
      workspaceRoot: sourceRepo,
      config: {
        concurrency_limit: 2,
        worktree_workspace_base: { version: 1, strategy: "per-run", basePath: allocationBase },
      },
    });
    await db.insert(agentRuntimes).values({
      id: "scheduler-vertical-runtime",
      organizationId: "org_default",
      computerId: NODE,
      runtime: "codex",
      status: "available",
      capabilities: [],
      lastSeenAt: server.ctx.clock.nowIso(),
      metadata: {},
    });
    const token = generateDeviceToken();
    await db.insert(devices).values({
      id: "scheduler-vertical-device",
      organizationId: "org_default",
      displayName: "Controlled paired fixture",
      platform: machineOs === "darwin" ? "macos" : machineOs === "win32" ? "windows" : machineOs,
      appVersion: "fixture",
      computerId: NODE,
      enrolledByUserId: "user_owner",
      trust: "active",
      createdAt: server.ctx.clock.nowIso(),
    });
    await db.insert(deviceTokens).values({
      id: "scheduler-vertical-token",
      organizationId: "org_default",
      deviceId: "scheduler-vertical-device",
      kind: "node",
      tokenLookup: token.lookup,
      tokenHash: token.secretHash,
      status: "active",
      createdAt: server.ctx.clock.nowIso(),
    });
    async function request(method, url, payload, expected = 200) {
      const response = await server.app.inject({ method, url: `/api/v1/${url}`, payload });
      assert.equal(response.statusCode, expected, `${url}: ${response.body}`);
      return response.json();
    }
    for (const [resource, policy] of [
      ["projects/proj_artoo", { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 }],
      [
        "agents/agent_mock_coder",
        {
          version: 1,
          pinned_computer_id: null,
          required_runtimes: ["codex"],
          required_labels: [],
          max_concurrent_runs: 2,
        },
      ],
      [`computers/${NODE}`, { version: 1, labels: [], max_concurrent_runs: 2 }],
    ])
      await request("PUT", `${resource}/scheduling-policy`, policy);
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    link = createManagedWebSocketTransport({
      url: `${address.replace(/^http/, "ws")}/api/v1/node?token=${token.raw}`,
      namespace,
      schedulerStart: true,
      hello: {
        kind: "node.hello",
        node_id: NODE,
        protocol_version: "2026-06-11",
        artood_version: "controlled-fixture",
        machine: { hostname: "controlled-fixture", os: machineOs, arch: process.arch },
        execution_features: ["workspace-allocation.per-run-v1"],
      },
    });
    link.transport.subscribe((message) => incoming.push(message));
    link.start();
    await link.ready;
    const sessionId = link.currentSession.sessionId;
    // Use the real authenticated registry, never a fixture replacement resolver.
    const deadline = performance.now() + 3000;
    while (server.ctx.getPairedNodeSession?.(NODE)?.sessionId !== sessionId) {
      assert.ok(performance.now() < deadline, "Paired registry binding missing after managed ready");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    server.ctx.onRunQueued = async () => {
      dispatches++;
      throw new Error("Scheduler fixture must never dispatch run.start");
    };
    const { task } = await request(
      "POST",
      "tasks",
      {
        project_id: "proj_artoo",
        title: "Native scheduler vertical fixture",
        acceptance_criteria: ["Controlled author closes physically"],
        required_capabilities: ["code.modify"],
      },
      201,
    );
    await request("POST", `tasks/${task.id}/ready`);
    const execution = await createSchedulerExecutionRequest(server.ctx, task.id, {
      version: 2,
      permission: "execute_once",
      request_key: "scheduler-vertical",
      agent_id: "agent_mock_coder",
      base_version: await currentTaskVersion(server.ctx, task.id),
      branch_backed: true,
      write_paths: ["src/fixture.ts"],
    });
    const claimInput = { taskId: task.id, requestId: execution.id, computerId: NODE, sessionId };
    const claimed = await claimSchedulerExecutionRequest(server.ctx, claimInput);
    const input = { taskId: task.id, requestId: execution.id, runId: claimed.run.id };
    return {
      link,
      input,
      close,
      async assertRetained(grantId) {
        const [run] = await db.select().from(runs),
          [request] = await db.select().from(schedulerExecutionRequests);
        const grants = await db.select().from(schedulerStartGrants),
          leases = await db.select().from(fileLeases);
        assert.equal((await db.select().from(runs)).length, 1);
        assert.equal(run.id, input.runId);
        assert.equal(run.requestedByUserId, "user_owner");
        assert.equal(run.status, "queued", "Local process observations have not been written back to the server");
        assert.equal(request.state, "consumed");
        assert.equal(request.consumedRunId, input.runId);
        assert.equal(grants.length, grantId ? 1 : 0);
        if (grantId) assert.equal(grants[0].grantId, grantId);
        assert.equal(leases.length, 1, "Uncertain server reservation must not be released by local admission");
        assert.equal(dispatches, 0);
        assert.equal(
          incoming.some((message) => message.type === "run.start"),
          false,
        );
        return { run_id: run.id, grant_id: grantId, retained_leases: leases.length, dispatches };
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Scheduler fixture setup/closure failed", { cause: error });
    }
    throw error;
  }
}
