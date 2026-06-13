import { apiError, AssignRequestSchema, CreateTaskRequestSchema, ReviewRequestSchema } from "@artoo/domain";
import Fastify, { type FastifyInstance } from "fastify";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import * as lifecycle from "./services/lifecycle-service.js";
import * as runService from "./services/run-service.js";
import * as taskService from "./services/task-service.js";

/**
 * Build the Fastify app for a given {@link ServerContext}. Routes are thin: they
 * validate input with the domain Zod schemas and delegate to services. All
 * business state transitions live in services, never in routes.
 */
export function buildApp(ctx: ServerContext): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.httpStatus).send(err.toEnvelope());
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    void reply.status(500).send(apiError("internal_error", message));
  });

  app.get("/api/v1/bootstrap", async () => taskService.bootstrap(ctx));

  app.post("/api/v1/tasks", async (req, reply) => {
    const parsed = CreateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid task payload", { issues: parsed.error.issues });
    }
    const result = await taskService.createTask(ctx, parsed.data);
    void reply.status(201);
    return result;
  });

  app.get("/api/v1/tasks", async (req) => {
    const query = req.query as { project_id?: string };
    if (query.project_id === undefined || query.project_id === "") {
      throw AppError.validation("project_id query parameter is required");
    }
    return taskService.listTasks(ctx, query.project_id);
  });

  app.get("/api/v1/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return taskService.getTaskSnapshot(ctx, id);
  });

  app.post("/api/v1/tasks/:id/ready", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.markReady(ctx, id);
  });

  app.post("/api/v1/tasks/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = AssignRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid assign payload", { issues: parsed.error.issues });
    }
    return lifecycle.assignTask(ctx, id, parsed.data);
  });

  app.post("/api/v1/tasks/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    return lifecycle.retryTask(ctx, id);
  });

  app.post("/api/v1/tasks/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid review payload", { issues: parsed.error.issues });
    }
    return lifecycle.reviewTask(ctx, id, parsed.data);
  });

  // Dev-only: simulate a node/adapter executing a queued run end to end.
  app.post("/api/v1/dev/runs/:id/mock-execute", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { outcome?: "completed" | "failed" };
    return runService.mockExecuteRun(ctx, id, query.outcome === "failed" ? "failed" : "completed");
  });

  return app;
}
