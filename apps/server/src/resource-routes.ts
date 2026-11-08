import { agentInstances, agentRuntimes, agents, appendEvent, computers, runs } from "@artoo/db";
import { ID_PREFIXES, WorktreeBaseConfigurationSchema, type WorktreeBaseConfiguration } from "@artoo/domain";
import { validateWorktreeBaseConfiguration, WorkspaceAllocationError } from "@artoo/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requestContext } from "./auth/auth-routes.js";
import { requireAdministrator } from "./auth/request-auth.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { buildEvent } from "./events.js";
import { mapAgent, mapAgentInstance } from "./mappers.js";
import { unconfirmedDisconnectRunIds } from "./services/execution-state.js";

const WORKTREE_BASE_KEY = "worktree_workspace_base";
const WORKTREE_FEATURE = "workspace-allocation.per-run-v1";

async function changeWorktreeBase(c: ServerContext, id: string, setting: WorktreeBaseConfiguration | undefined) {
  return c.db.transaction(async (tx) => {
    // Serializes configuration edits. Allocation assignment must share this lock
    // when that separate integration is enabled.
    const [instance] = await tx.select().from(agentInstances).where(and(
      eq(agentInstances.id, id), eq(agentInstances.organizationId, c.organizationId),
    )).for("update");
    if (!instance) throw AppError.notFound("agent instance not found");
    // Lock order: instance FOR UPDATE, then actor FOR SHARE. Recheck after any
    // instance wait; the actor lock protects authorization through this commit.
    await requireAdministrator(c, tx);
    const [computer] = await tx.select().from(computers).where(and(
      eq(computers.id, instance.computerId), eq(computers.organizationId, c.organizationId),
    ));
    if (!computer) throw AppError.notFound("computer not found");
    if (instance.config === null || typeof instance.config !== "object" || Array.isArray(instance.config)) {
      throw AppError.conflict("Stored agent instance configuration is invalid");
    }
    const currentConfig = instance.config as Record<string, unknown>;
    if (setting !== undefined) {
      try { validateWorktreeBaseConfiguration(setting, computer.os); }
      catch (error) {
        if (error instanceof WorkspaceAllocationError) throw AppError.validation(error.message, { reason: error.code });
        throw error;
      }
    }
    const active = await tx.select({ id: runs.id }).from(runs).where(and(
      eq(runs.agentInstanceId, id), eq(runs.organizationId, c.organizationId),
      inArray(runs.status, ["queued", "starting", "running", "awaiting_input", "paused"]),
    ));
    if (active.length > 0) throw AppError.conflict("Stop the active run before changing this agent instance");
    if ((await unconfirmedDisconnectRunIds(c, tx, { agentInstanceId: id })).length > 0) {
      throw AppError.conflict("Confirm the disconnected process has stopped before changing this agent instance");
    }
    // Check the current session after the asynchronous database guards. Clearing
    // a setting does not need an online node or a feature claim.
    if (setting !== undefined && c.supportsExecutionFeature?.(computer.id, WORKTREE_FEATURE) !== true) {
      throw AppError.conflict("The current execution computer session does not support per-run workspace allocation");
    }
    const hadSetting = Object.hasOwn(currentConfig, WORKTREE_BASE_KEY);
    const before = currentConfig[WORKTREE_BASE_KEY];
    if (setting === undefined ? !hadSetting : hadSetting && isDeepStrictEqual(before, setting)) {
      return { agent_instance: mapAgentInstance(instance) };
    }
    const config = { ...currentConfig };
    if (setting === undefined) delete config[WORKTREE_BASE_KEY];
    else config[WORKTREE_BASE_KEY] = setting;
    const [updated] = await tx.update(agentInstances).set({ config }).where(and(
      eq(agentInstances.id, id), eq(agentInstances.organizationId, c.organizationId),
    )).returning();
    await appendEvent(tx, buildEvent(c, {
      type: "agent_instance.updated", actorType: "user", actorId: c.actorUserId, correlationId: id,
      payload: { agent_instance_id: id, computer_id: computer.id,
        worktree_workspace_base: { before: hadSetting ? before : null, after: setting ?? null } },
    }));
    return { agent_instance: mapAgentInstance(updated!) };
  });
}

export function registerResourceRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.patch("/api/v1/agent-instances/:id/worktree-workspace-base", async (request) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const { id } = request.params as { id: string };
    const parsed = WorktreeBaseConfigurationSchema.safeParse(request.body);
    if (!parsed.success) throw AppError.validation("worktree workspace base requires only version 1, per-run strategy and basePath");
    return changeWorktreeBase(c, id, parsed.data);
  });

  app.delete("/api/v1/agent-instances/:id/worktree-workspace-base", async (request) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const { id } = request.params as { id: string };
    if (request.body !== undefined && (request.body === null || typeof request.body !== "object"
      || Array.isArray(request.body) || Object.keys(request.body).length !== 0)) {
      throw AppError.validation("Deleting a worktree workspace base does not accept configuration data");
    }
    return changeWorktreeBase(c, id, undefined);
  });

  app.post("/api/v1/computers/:id/instances", async (request, reply) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const { id: computerId } = request.params as { id: string };
    const input = (request.body ?? {}) as Record<string, unknown>;
    if (typeof input.runtime !== "string" || !input.runtime.trim()) throw AppError.validation("runtime is required");
    if (typeof input.workspace_root !== "string" || input.workspace_root.includes("\0") || input.workspace_root.length > 4096 || !(posix.isAbsolute(input.workspace_root) || win32.isAbsolute(input.workspace_root))) {
      throw AppError.validation("workspace_root must be an absolute path on the execution computer");
    }
    const runtime = input.runtime.trim();
    const workspaceRoot = input.workspace_root;
    const existingAgentId = input.agent_id;
    if (existingAgentId !== undefined && (typeof existingAgentId !== "string" || !existingAgentId.trim() || existingAgentId.length > 128)) {
      throw AppError.validation("agent_id must identify an existing agent");
    }
    if (existingAgentId !== undefined && (input.display_name !== undefined || input.capabilities !== undefined)) {
      throw AppError.validation("An existing agent retains its name and declared capabilities");
    }
    const displayName = typeof input.display_name === "string" ? input.display_name.trim() : runtime;
    if (!displayName || displayName.length > 160) throw AppError.validation("display_name must contain between 1 and 160 characters");
    const result = await c.db.transaction(async (tx) => {
      const [computer] = await tx.select().from(computers).where(and(eq(computers.id, computerId), eq(computers.organizationId, c.organizationId)));
      if (!computer) throw AppError.notFound("computer not found");
      if (computer.status === "disabled") throw AppError.conflict("computer is disabled");
      const [registered] = await tx.select().from(agentRuntimes).where(and(
        eq(agentRuntimes.computerId, computerId), eq(agentRuntimes.organizationId, c.organizationId), eq(agentRuntimes.runtime, runtime),
      ));
      if (!registered || registered.status !== "available") throw AppError.conflict("The computer must advertise an available runtime before it can be configured");
      const available = registered.capabilities as string[];
      // Separate workspaces can retain the same logical contributor. Selecting
      // an existing identity never edits its declarations or crosses an org.
      const [existingAgent] = typeof existingAgentId === "string" ? await tx.select().from(agents).where(and(
        eq(agents.id, existingAgentId), eq(agents.organizationId, c.organizationId),
      )).for("share") : [];
      if (existingAgentId !== undefined && !existingAgent) throw AppError.notFound("agent not found");
      const capabilities = existingAgent?.capabilities ?? input.capabilities ?? available;
      if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string" || !available.includes(value))) {
        throw AppError.validation("capabilities must be supported by the advertised runtime");
      }
      await requireAdministrator(c, tx);
      const now = c.clock.nowIso();
      const agent = existingAgent ?? (await tx.insert(agents).values({
        id: c.idGen.generate(ID_PREFIXES.agent), organizationId: c.organizationId, displayName, kind: "coding",
        status: "idle", capabilities: [...new Set(capabilities)], createdAt: now,
      }).returning())[0]!;
      const [instance] = await tx.insert(agentInstances).values({
        id: c.idGen.generate(ID_PREFIXES.agentInstance), organizationId: c.organizationId,
        computerId, agentId: agent.id, runtime, status: "idle", workspaceRoot, config: {}, createdAt: now,
      }).returning();
      await appendEvent(tx, buildEvent(c, {
        type: "agent_instance.created", actorType: "user", actorId: c.actorUserId, correlationId: instance!.id,
        payload: { agent_instance_id: instance!.id, computer_id: computerId, runtime,
          ...(existingAgent ? { agent_id: existingAgent.id } : {}) },
      }));
      return { agent: mapAgent(agent!), agent_instance: mapAgentInstance(instance!) };
    });
    return reply.status(201).send(result);
  });

  app.patch("/api/v1/agent-instances/:id", async (request) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const { id } = request.params as { id: string };
    const input = (request.body ?? {}) as { enabled?: unknown };
    if (typeof input.enabled !== "boolean") throw AppError.validation("enabled must be a boolean");
    const enabled = input.enabled;
    return c.db.transaction(async (tx) => {
      const [instance] = await tx.select().from(agentInstances).where(and(eq(agentInstances.id, id), eq(agentInstances.organizationId, c.organizationId)));
      if (!instance) throw AppError.notFound("agent instance not found");
      const active = await tx.select({ id: runs.id }).from(runs).where(and(
        eq(runs.agentInstanceId, id), eq(runs.organizationId, c.organizationId),
        inArray(runs.status, ["queued", "starting", "running", "awaiting_input", "paused"]),
      ));
      if (active.length > 0) throw AppError.conflict("Stop the active run before changing this agent instance");
      const [updated] = await tx.update(agentInstances).set({ status: enabled ? "idle" : "disabled" }).where(eq(agentInstances.id, id)).returning();
      await appendEvent(tx, buildEvent(c, {
        type: "agent_instance.updated", actorType: "user", actorId: c.actorUserId, correlationId: id,
        payload: { agent_instance_id: id, enabled },
      }));
      return { agent_instance: mapAgentInstance(updated!) };
    });
  });
}
