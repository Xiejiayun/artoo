import { agentInstances, agentRuntimes, agents, appendEvent, computers, runs } from "@artoo/db";
import { ID_PREFIXES } from "@artoo/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { posix, win32 } from "node:path";
import { requestContext } from "./auth/auth-routes.js";
import { requireAdministrator } from "./auth/request-auth.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { buildEvent } from "./events.js";
import { mapAgent, mapAgentInstance } from "./mappers.js";

export function registerResourceRoutes(app: FastifyInstance, ctx: ServerContext): void {
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
      const capabilities = input.capabilities ?? available;
      if (!Array.isArray(capabilities) || capabilities.some((value) => typeof value !== "string" || !available.includes(value))) {
        throw AppError.validation("capabilities must be supported by the advertised runtime");
      }
      const now = c.clock.nowIso();
      const agentId = c.idGen.generate(ID_PREFIXES.agent);
      const [agent] = await tx.insert(agents).values({
        id: agentId, organizationId: c.organizationId, displayName, kind: "coding",
        status: "idle", capabilities: [...new Set(capabilities)], createdAt: now,
      }).returning();
      const [instance] = await tx.insert(agentInstances).values({
        id: c.idGen.generate(ID_PREFIXES.agentInstance), organizationId: c.organizationId,
        computerId, agentId, runtime, status: "idle", workspaceRoot, config: {}, createdAt: now,
      }).returning();
      await appendEvent(tx, buildEvent(c, {
        type: "agent_instance.created", actorType: "user", actorId: c.actorUserId, correlationId: instance!.id,
        payload: { agent_instance_id: instance!.id, computer_id: computerId, runtime },
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
