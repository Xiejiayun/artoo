import { appendEvent, projects } from "@artoo/db";
import { ID_PREFIXES } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import { requireAdministrator } from "./auth/request-auth.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { buildEvent } from "./events.js";

function readInput(body: unknown, create: boolean): { name?: string; defaultWorkspace?: string | null } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw AppError.validation("project fields are required");
  }
  const value = body as Record<string, unknown>;
  const result: { name?: string; defaultWorkspace?: string | null } = {};
  if (create || "name" in value) {
    if (typeof value.name !== "string" || value.name.trim().length === 0 || value.name.trim().length > 160) {
      throw AppError.validation("name must contain between 1 and 160 characters");
    }
    result.name = value.name.trim();
  }
  if ("default_workspace" in value) {
    if (value.default_workspace !== null && (typeof value.default_workspace !== "string" || value.default_workspace.includes("\0") || value.default_workspace.length > 4096)) {
      throw AppError.validation("default_workspace must be a path or null");
    }
    result.defaultWorkspace = typeof value.default_workspace === "string" ? value.default_workspace.trim() || null : null;
  }
  if (Object.keys(result).length === 0) throw AppError.validation("no project fields supplied");
  return result;
}

function mapProject(row: typeof projects.$inferSelect) {
  return { id: row.id, name: row.name, default_workspace: row.defaultWorkspace };
}

export function registerProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post("/api/v1/projects", async (request, reply) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const input = readInput(request.body, true);
    const id = c.idGen.generate(ID_PREFIXES.project);
    const project = await c.db.transaction(async (tx) => {
      const [row] = await tx.insert(projects).values({
        id, organizationId: c.organizationId, name: input.name!,
        defaultWorkspace: input.defaultWorkspace ?? null, createdAt: c.clock.nowIso(),
      }).returning();
      await appendEvent(tx, buildEvent(c, {
        type: "project.created", actorType: "user", actorId: c.actorUserId,
        correlationId: id, projectId: id, payload: { project_id: id, name: input.name },
      }));
      return mapProject(row!);
    });
    return reply.status(201).send({ project });
  });
  app.patch("/api/v1/projects/:id", async (request) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const { id } = request.params as { id: string };
    const input = readInput(request.body, false);
    const project = await c.db.transaction(async (tx) => {
      const [row] = await tx.update(projects).set(input)
        .where(and(eq(projects.id, id), eq(projects.organizationId, c.organizationId))).returning();
      if (row === undefined) throw AppError.notFound("project not found");
      await appendEvent(tx, buildEvent(c, {
        type: "project.updated", actorType: "user", actorId: c.actorUserId,
        correlationId: id, projectId: id, payload: { project_id: id, name: row.name },
      }));
      return mapProject(row);
    });
    return { project };
  });
}
