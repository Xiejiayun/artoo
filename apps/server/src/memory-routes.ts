import {
  MemoryScopeSchema,
  MemoryStatusSchema,
  MemoryTransitionRequestSchema,
  type MemoryTrigger,
  ProposeMemoryRequestSchema,
} from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { parseOptionalLimit } from "./route-input.js";
import * as memoryService from "./services/memory-service.js";

/** Register memory curation and accepted context reads in the existing scope. */
export function registerMemoryRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  // Memory (#14 Phase B): propose/curate memories + accepted-only retrieval.
  app.post("/api/v1/memories", async (req, reply) => {
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory payload", { issues: parsed.error.issues });
    }
    const memory = await memoryService.proposeMemory(rc(req), parsed.data);
    void reply.status(201);
    return { memory };
  });

  app.get("/api/v1/memories", async (req) => {
    const q = req.query as {
      scope?: string;
      status?: string;
      project_id?: string;
      task_id?: string;
      tag?: string;
      limit?: string;
      q?: unknown;
    };
    if (q.scope !== undefined && q.scope !== "") {
      const parsed = MemoryScopeSchema.safeParse(q.scope);
      if (!parsed.success) {
        throw AppError.validation("invalid memory scope filter", { scope: q.scope });
      }
    }
    if (q.status !== undefined && q.status !== "") {
      const parsed = MemoryStatusSchema.safeParse(q.status);
      if (!parsed.success) {
        throw AppError.validation("invalid memory status filter", { status: q.status });
      }
    }
    return {
      memories: await memoryService.listMemories(rc(req), {
        scope: q.scope,
        status: q.status,
        projectId: q.project_id,
        taskId: q.task_id,
        tag: q.tag,
        limit: parseOptionalLimit(q.limit),
        q: q.q,
      }),
    };
  });

  // Static `/context` is matched ahead of the `/:id` param route by Fastify.
  app.get("/api/v1/memories/context", async (req) => {
    const q = req.query as { project_id?: string; task_id?: string; limit?: string };
    let limit: number | undefined;
    if (q.limit !== undefined && q.limit !== "") {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        throw AppError.validation("limit must be a non-negative integer", { limit: q.limit });
      }
    }
    return memoryService.selectForContext(rc(req), { projectId: q.project_id, taskId: q.task_id }, limit);
  });

  app.get("/api/v1/memories/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { memory: await memoryService.getMemory(rc(req), id) };
  });

  app.post("/api/v1/memories/:id/supersede", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory replacement payload", { issues: parsed.error.issues });
    }
    const result = await memoryService.supersedeMemory(rc(req), id, parsed.data);
    void reply.status(201);
    return result;
  });

  app.post("/api/v1/memories/:id/:action", async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== "accept" && action !== "reject") {
      throw AppError.validation(`unknown memory action: ${action}`, { action });
    }
    const parsed = MemoryTransitionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid memory transition payload", { issues: parsed.error.issues });
    }
    const memory = await memoryService.transitionMemory(rc(req), id, action as MemoryTrigger, parsed.data);
    return { memory };
  });
}
