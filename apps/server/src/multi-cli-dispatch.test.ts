import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentInstances,
  agentRuntimes,
  agents,
  goals,
  projectSquads,
  runs,
  schedulerDecisions,
  tasks,
} from "@artoo/db";
import {
  SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1,
  type CliDiscoveryInventoryV1,
  type SingleTurnTextRuntimeId,
} from "@artoo/domain";
import {
  type NodeToServerMessage,
  type NodeTransport,
  type ServerToNodeMessage,
  type Unsubscribe,
} from "@artoo/protocol";

import { attachNodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

function createInMemoryNodeTransport() {
  const sent: ServerToNodeMessage[] = [];
  const handlers = new Set<(message: NodeToServerMessage) => void>();
  const transport: NodeTransport = {
    async send(message) {
      sent.push(message);
    },
    subscribe(handler): Unsubscribe {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() {
      handlers.clear();
    },
  };
  return {
    transport,
    sent,
    emit(message: NodeToServerMessage) {
      for (const handler of [...handlers]) handler(message);
    },
  };
}

function makeDiscovery(runtime: SingleTurnTextRuntimeId, ready: boolean): CliDiscoveryInventoryV1 {
  return {
    version: 1,
    observed_at: "2026-11-18T00:00:00.000Z",
    entries: [
      {
        id: "codex",
        display_name: "Codex",
        install_status: "installed",
        execution_status: "existing_runtime",
        version: "0.55.0",
        reason_code: "existing_runtime",
        reason: "已就绪（既有运行时）",
        can_verify: false,
        can_dispatch: true,
      },
      {
        id: runtime,
        display_name: runtime === "copilot" ? "GitHub Copilot CLI" : "Antigravity CLI",
        install_status: "installed",
        execution_status: ready ? "ready_single_turn" : "installed_unverified",
        version: runtime === "copilot" ? "1.0.109" : "1.5.8",
        reason_code: ready ? "single_turn_no_tools_only" : "verification_required",
        reason: ready ? "已就绪 · 仅手动单轮" : "已安装，未验证",
        can_verify: true,
        can_dispatch: ready,
      },
    ],
  };
}

async function seedSingleTurnInstance(
  server: TestServer,
  runtime: SingleTurnTextRuntimeId = "copilot",
  opts: { withRuntimeRow?: boolean; caps?: string[]; computerId?: string } = {},
) {
  const suffix = randomUUID().slice(0, 8);
  const computerId = opts.computerId ?? "computer_local_mock";
  const agentId = `agent_${runtime}_${suffix}`;
  const instanceId = `ai_${runtime}_${suffix}`;

  await server.db.db.insert(agents).values({
    id: agentId,
    organizationId: server.ctx.organizationId,
    displayName: `${runtime} Single Turn`,
    kind: "coding",
    status: "idle",
    capabilities: [],
    createdAt: "2026-06-13T00:00:00.000Z",
  });
  await server.db.db.insert(agentInstances).values({
    id: instanceId,
    organizationId: server.ctx.organizationId,
    agentId,
    computerId,
    projectId: "proj_artoo",
    runtime,
    modelProfileId: null,
    effortProfileId: null,
    workspaceRoot: "C:\\workspaces\\demo",
    status: "idle",
    config: {},
    createdAt: "2026-06-13T00:00:00.000Z",
  });
  const [squad] = await server.db.db.select().from(projectSquads).where(eq(projectSquads.projectId, "proj_artoo"));
  if (squad) {
    const existingIds = Array.isArray(squad.agentIds) ? squad.agentIds : [];
    await server.db.db
      .update(projectSquads)
      .set({ agentIds: [...existingIds, agentId] })
      .where(eq(projectSquads.projectId, squad.projectId));
  }
  if (opts.withRuntimeRow !== false) {
    await server.db.db
      .insert(agentRuntimes)
      .values({
        id: `rt_${runtime}_${suffix}`,
        organizationId: server.ctx.organizationId,
        computerId,
        runtime,
        version: "1.0.109",
        status: "available",
        capabilities: opts.caps ?? [],
        lastSeenAt: "2026-06-13T00:00:00.000Z",
        metadata: {},
      })
      .onConflictDoUpdate({
        target: [agentRuntimes.computerId, agentRuntimes.runtime],
        set: {
          status: "available",
          capabilities: opts.caps ?? [],
          lastSeenAt: "2026-06-13T00:00:00.000Z",
        },
      });
  }
  return { agentId, instanceId, computerId };
}

async function createTask(server: TestServer, opts: { capabilities?: string[]; goalId?: string } = {}) {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title: "Standalone text prompt",
      description: "Answer with hello only.",
      acceptance_criteria: ["text"],
      required_capabilities: opts.capabilities ?? [],
    },
  });
  const taskId = created.json().task.id as string;
  if (opts.goalId) {
    await server.db.db.update(tasks).set({ goalId: opts.goalId }).where(eq(tasks.id, taskId));
  }
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  return taskId;
}

describe("T17 Multi-CLI session discovery & Contract 1 positive dispatch gates", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports cli_discovery: null for legacy connected daemons, updates session snapshot via heartbeat/refresh/verify, and clears on disconnect", async () => {
    server = await buildTestServer();
    const { transport, sent, emit } = createInMemoryNodeTransport();
    const binding = attachNodeBinding(
      server.ctx,
      transport,
      "computer_local_mock",
      [SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1],
      () => true,
      [],
      [],
      [],
      () => false,
      "win32",
    );
    server.nodeRegistry.register("computer_local_mock", binding);

    // Before cli_discovery is reported (legacy node compatibility) -> null.
    const beforeRuntimes = await server.app.inject({
      method: "GET",
      url: "/api/v1/computers/computer_local_mock/runtimes",
    });
    expect(beforeRuntimes.statusCode).toBe(200);
    expect(beforeRuntimes.json().cli_discovery).toBeNull();
    const beforeDaemons = await server.app.inject({ method: "GET", url: "/api/v1/daemons" });
    expect(beforeDaemons.json().daemons[0]?.cli_discovery).toBeNull();

    // Heartbeat snapshot is kept in session memory and reflected cleanly.
    const initial = makeDiscovery("copilot", false);
    binding.setCliDiscovery?.(initial);
    const afterHeartbeat = await server.app.inject({
      method: "GET",
      url: "/api/v1/computers/computer_local_mock/runtimes",
    });
    expect(afterHeartbeat.json().cli_discovery).toEqual(initial);
    expect(binding.isSingleTurnRuntimeReady?.("copilot")).toBe(false);

    // Refresh route sends cli.discovery.refresh.v1 and awaits cli.discovery.snapshot.v1.
    const refreshPromise = server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/cli-discovery/refresh",
    });
    await new Promise((r) => setTimeout(r, 10));
    const refreshCmd = sent.find((m) => m.type === "cli.discovery.refresh.v1");
    expect(refreshCmd).toBeDefined();
    const refreshed = makeDiscovery("copilot", false);
    if (refreshCmd && refreshCmd.type === "cli.discovery.refresh.v1") {
      emit({
        kind: "cli.discovery.snapshot.v1",
        node_id: "computer_local_mock",
        request_id: refreshCmd.payload.request_id,
        cli_discovery: refreshed,
      });
    }
    const refreshRes = await refreshPromise;
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().cli_discovery).toEqual(refreshed);

    // Verify route sends cli.verify.v1 and updates ready_single_turn on verified result.
    const verifyPromise = server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/cli-discovery/verify",
      payload: { runtime: "copilot" },
    });
    await new Promise((r) => setTimeout(r, 10));
    const verifyCmd = sent.find((m) => m.type === "cli.verify.v1");
    expect(verifyCmd).toBeDefined();
    const readyInventory = makeDiscovery("copilot", true);
    if (verifyCmd && verifyCmd.type === "cli.verify.v1") {
      emit({
        kind: "cli.verify.result.v1",
        node_id: "computer_local_mock",
        request_id: verifyCmd.payload.request_id,
        outcome: {
          version: 1,
          runtime: "copilot",
          status: "verified",
          verified_at: "2026-11-18T00:00:05.000Z",
          version_observed: "1.0.109",
          message: "验证通过（无工具纯文本会话）",
        },
        cli_discovery: readyInventory,
      });
    }
    const verifyRes = await verifyPromise;
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().outcome.status).toBe("verified");
    expect(binding.isSingleTurnRuntimeReady?.("copilot")).toBe(true);

    // Disconnecting drops session-only discovery state cleanly back to null.
    binding.close();
    server.nodeRegistry.unregister("computer_local_mock", binding);
    const afterDisconnect = await server.app.inject({
      method: "GET",
      url: "/api/v1/computers/computer_local_mock/runtimes",
    });
    expect(afterDisconnect.json().cli_discovery).toBeNull();
  });

  it("blocks instance creation for unverified or capability/worktree-equipped single-turn runtimes", async () => {
    server = await buildTestServer();
    const { transport } = createInMemoryNodeTransport();
    const binding = attachNodeBinding(
      server.ctx,
      transport,
      "computer_local_mock",
      [SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1],
      () => true,
      [],
      [],
      [],
      () => false,
      "win32",
    );
    server.nodeRegistry.register("computer_local_mock", binding);
    await server.db.db.insert(agentRuntimes).values({
      id: "rt_copilot",
      organizationId: server.ctx.organizationId,
      computerId: "computer_local_mock",
      runtime: "copilot",
      version: "1.0.109",
      status: "available",
      capabilities: [],
      lastSeenAt: "2026-06-13T00:00:00.000Z",
      metadata: {},
    });

    // Unverified in session -> 409 conflict.
    binding.setCliDiscovery?.(makeDiscovery("copilot", false));
    const unverifiedRes = await server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: { runtime: "copilot", workspace_root: "C:\\workspaces\\demo" },
    });
    expect(unverifiedRes.statusCode).toBe(409);

    // Verified -> non-empty capabilities and worktree_workspace_base are rejected.
    binding.setCliDiscovery?.(makeDiscovery("copilot", true));
    const withCaps = await server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: {
        runtime: "copilot",
        workspace_root: "C:\\workspaces\\demo",
        capabilities: ["code.modify"],
      },
    });
    expect(withCaps.statusCode).toBe(400);

    const withWorktree = await server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: {
        runtime: "copilot",
        workspace_root: "C:\\workspaces\\demo",
        worktree_workspace_base: { version: 1, strategy: "per-run", basePath: "C:\\wt" },
      },
    });
    expect(withWorktree.statusCode).toBe(400);

    // Valid empty-capability single-turn instance creation succeeds.
    const validRes = await server.app.inject({
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: {
        runtime: "copilot",
        workspace_root: "C:\\workspaces\\demo",
        display_name: "Copilot Plain Text",
      },
    });
    expect(validRes.statusCode).toBe(201);
    expect(validRes.json().agent_instance.runtime).toBe("copilot");
  });

  it("enforces Contract 1 negative and positive dispatch gates across assign and dispatchRunStart", async () => {
    server = await buildTestServer();
    const { transport, sent } = createInMemoryNodeTransport();
    const binding = attachNodeBinding(
      server.ctx,
      transport,
      "computer_local_mock",
      [SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1],
      () => true,
      [],
      [],
      [],
      () => false,
      "win32",
    );
    server.nodeRegistry.register("computer_local_mock", binding);
    binding.setCliDiscovery?.(makeDiscovery("copilot", true));

    // Disable all seeded instances so copilot is the ONLY active instance in the squad.
    await server.db.db.update(agentInstances).set({ status: "disabled" });

    const { instanceId: copilotInstanceId } = await seedSingleTurnInstance(server, "copilot");

    // 1) Auto mode NEVER schedules single-turn runtime even with empty capabilities.
    const autoTask = await createTask(server, { capabilities: [] });
    const autoRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${autoTask}/assign`,
      payload: { mode: "auto" },
    });
    expect(autoRes.statusCode).toBe(409);

    // 2) Manual pin fails if capabilities non-empty.
    const capTask = await createTask(server, { capabilities: ["code.read"] });
    const capRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${capTask}/assign`,
      payload: { mode: "manual", agent_instance_id: copilotInstanceId },
    });
    expect(capRes.statusCode).toBe(409);
    expect(capRes.json().error.details.reason).toBe("single_turn_no_tools_only");

    // 3) Manual pin fails if branch_backed.
    const branchTask = await createTask(server);
    const branchRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${branchTask}/assign`,
      payload: { mode: "manual", agent_instance_id: copilotInstanceId, branch_backed: true },
    });
    expect(branchRes.statusCode).toBe(409);
    expect(branchRes.json().error.details.reason).toBe("single_turn_no_tools_only");

    // 4) Manual pin fails if goal-linked.
    await server.db.db.insert(goals).values({
      id: "goal_t17",
      organizationId: server.ctx.organizationId,
      projectId: "proj_artoo",
      ownerUserId: server.ctx.actorUserId,
      title: "Goal",
      objective: "Goal desc",
      status: "draft",
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
    });
    const goalTask = await createTask(server, { goalId: "goal_t17" });
    const goalRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${goalTask}/assign`,
      payload: { mode: "manual", agent_instance_id: copilotInstanceId },
    });
    expect(goalRes.statusCode).toBe(409);
    expect(goalRes.json().error.details.reason).toBe("single_turn_no_tools_only");

    // 5) Manual pin fails if CLI verification is reverted to installed_unverified.
    binding.setCliDiscovery?.(makeDiscovery("copilot", false));
    const unverifiedTask = await createTask(server);
    const unverifiedRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${unverifiedTask}/assign`,
      payload: { mode: "manual", agent_instance_id: copilotInstanceId },
    });
    expect(unverifiedRes.statusCode).toBe(409);
    expect(unverifiedRes.json().error.details.reason).toBe("single_turn_runtime_unverified");

    // 6) Positive path: manual pin + standalone plain text + verified session -> assigns & dispatches run.start.
    binding.setCliDiscovery?.(makeDiscovery("copilot", true));
    const okTask = await createTask(server);
    const okRes = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${okTask}/assign`,
      payload: { mode: "manual", agent_instance_id: copilotInstanceId },
    });
    expect(okRes.statusCode).toBe(200);
    const runId = okRes.json().run.id as string;

    // Auto-wired onRunQueued already delivered the initial clean run.start frame.
    const autoStartCmd = sent.find((m) => m.type === "run.start");
    expect(autoStartCmd).toBeDefined();
    if (autoStartCmd && autoStartCmd.type === "run.start") {
      expect(autoStartCmd.payload.runtime).toBe("copilot");
      expect(autoStartCmd.payload.policy_snapshot.filesystem_write_scope).toEqual([]);
      expect(autoStartCmd.payload.artifact_rules.paths).toEqual([]);
    }
    sent.length = 0;

    // Tampered state (e.g. if scheduler decision had mode=auto, or unverified discovery) must block at sendRunStart.
    const decisionId = (await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!.schedulerDecisionId!;
    await server.db.db.update(schedulerDecisions).set({ mode: "auto" }).where(eq(schedulerDecisions.id, decisionId));
    await expect(binding.dispatchRunStart(runId)).rejects.toThrow(/manual agent-instance/i);
    expect(sent).toHaveLength(0);

    // Restoring manual decision but revoking ready_single_turn must still block at sendRunStart.
    await server.db.db.update(schedulerDecisions).set({ mode: "manual" }).where(eq(schedulerDecisions.id, decisionId));
    binding.setCliDiscovery?.(makeDiscovery("copilot", false));
    await expect(binding.dispatchRunStart(runId)).rejects.toThrow(/connection verification is not ready/i);
    expect(sent).toHaveLength(0);

    // Restoring ready_single_turn allows dispatchRunStart with empty write scope.
    binding.setCliDiscovery?.(makeDiscovery("copilot", true));
    await binding.dispatchRunStart(runId);
    const startCmd = sent.find((m) => m.type === "run.start");
    expect(startCmd).toBeDefined();
    if (startCmd && startCmd.type === "run.start") {
      expect(startCmd.payload.runtime).toBe("copilot");
      expect(startCmd.payload.policy_snapshot.filesystem_write_scope).toEqual([]);
      expect(startCmd.payload.artifact_rules.paths).toEqual([]);
    }
  });

  it("never applies missing-agent_runtimes fallback to single-turn runtimes even in manual mode", async () => {
    server = await buildTestServer();
    const { transport } = createInMemoryNodeTransport();
    const binding = attachNodeBinding(
      server.ctx,
      transport,
      "computer_local_mock",
      [SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1],
      () => true,
      [],
      [],
      [],
      () => false,
      "win32",
    );
    server.nodeRegistry.register("computer_local_mock", binding);
    binding.setCliDiscovery?.(makeDiscovery("agy", true));

    const { instanceId } = await seedSingleTurnInstance(server, "agy", { withRuntimeRow: false });
    const taskId = await createTask(server);
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "manual", agent_instance_id: instanceId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.reason).toBe("single_turn_runtime_unavailable");
  });
});
