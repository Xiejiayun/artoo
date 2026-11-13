import {
  AssignRequestSchema,
  CreateDependencyRequestSchema,
  CreateTaskRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
} from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { parseOptionalLimit } from "./route-input.js";
import * as auditService from "./services/audit-service.js";
import * as dagService from "./services/dag-service.js";
import * as lifecycle from "./services/lifecycle-service.js";
import { AssignOwnedResultRequestSchema } from "./services/owned-result-service.js";
import * as taskService from "./services/task-service.js";

/** Register task lifecycle, DAG and audit reads in the existing app scope. */
export function registerTaskRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  app.post("/api/v1/tasks", async (req, reply) => {
    const parsed = CreateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid task payload", { issues: parsed.error.issues });
    }
    const result = await taskService.createTask(rc(req), parsed.data);
    void reply.status(201);
    return result;
  });

  app.get("/api/v1/tasks", async (req) => {
    const query = req.query as { project_id?: string; limit?: string; q?: unknown };
    if (query.project_id === undefined || query.project_id === "") {
      throw AppError.validation("project_id query parameter is required");
    }
    return { tasks: await taskService.listTasks(rc(req), query.project_id, parseOptionalLimit(query.limit), query.q) };
  });

  app.get("/api/v1/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return taskService.getTaskSnapshot(rc(req), id);
  });

  app.get("/api/v1/tasks/:id/audit-bundle", async (req) => {
    const { id } = req.params as { id: string };
    return { bundle: await auditService.getTaskAuditBundle(rc(req), id) };
  });

  app.get("/api/v1/tasks/:id/audit-bundle/export", async (req) => {
    const { id } = req.params as { id: string };
    return { export: await auditService.exportTaskAuditBundle(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/dependencies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CreateDependencyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid dependency payload", { issues: parsed.error.issues });
    }
    const dependency = await dagService.createDependency(rc(req), id, parsed.data);
    void reply.status(201);
    return { dependency };
  });

  app.get("/api/v1/tasks/:id/dependencies", async (req) => {
    const { id } = req.params as { id: string };
    return { dependencies: await dagService.listDependencies(rc(req), id) };
  });

  app.delete("/api/v1/tasks/:id/dependencies/:dependencyId", async (req, reply) => {
    const { id, dependencyId } = req.params as { id: string; dependencyId: string };
    await dagService.deleteDependency(rc(req), id, dependencyId);
    void reply.status(204);
    return null;
  });

  app.get("/api/v1/tasks/:id/dag", async (req) => {
    const { id } = req.params as { id: string };
    return { dag: await dagService.getDag(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/ready", async (req) => {
    const { id } = req.params as { id: string };
    return { task: await lifecycle.markReady(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = AssignRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid assign payload", { issues: parsed.error.issues });
    }
    return lifecycle.assignTask(rc(req), id, parsed.data);
  });

  app.post("/api/v1/tasks/:id/assign-owned-result", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = AssignOwnedResultRequestSchema.safeParse(req.body);
    if (!parsed.success)
      throw AppError.validation("Invalid fixed-input result assignment", { issues: parsed.error.issues });
    return lifecycle.assignTask(
      rc(req),
      id,
      {
        mode: "manual",
        agent_instance_id: parsed.data.agent_instance_id,
        branch_backed: true,
        ...(parsed.data.write_paths ? { write_paths: parsed.data.write_paths } : {}),
      },
      undefined,
      undefined,
      parsed.data,
    );
  });

  app.post("/api/v1/tasks/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = RetryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid retry payload", { issues: parsed.error.issues });
    }
    return { task: await lifecycle.retryTask(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid review payload", { issues: parsed.error.issues });
    }
    // base_version (#27 v2-B slice 2) is an optional optimistic-concurrency hint
    // carried alongside the command body, not part of the domain ReviewRequest.
    return { task: await lifecycle.reviewTask(rc(req), id, parsed.data, readBaseVersion(req.body)) };
  });
}

/**
 * Read the optional `base_version` optimistic-concurrency hint from a command
 * body (#27 v2-B slice 2). Returns the value when it is a non-negative integer,
 * `undefined` when absent (no OCC check), and rejects a present-but-malformed
 * value so a client cannot silently bypass concurrency control with garbage.
 */
function readBaseVersion(body: unknown): number | undefined {
  if (body === null || typeof body !== "object" || !("base_version" in body)) {
    return undefined;
  }
  const value = (body as { base_version?: unknown }).base_version;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw AppError.validation("base_version must be a non-negative integer", { base_version: value });
  }
  return value;
}
