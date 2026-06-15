import { runs } from "@artoo/db";
import {
  apiError,
  AssignRequestSchema,
  CreateDependencyRequestSchema,
  CreateTaskRequestSchema,
  ResolveApprovalRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
  SendMessageRequestSchema,
} from "@artoo/domain";
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { registerIdempotency } from "./idempotency-middleware.js";
import * as approvalService from "./services/approval-service.js";
import * as dagService from "./services/dag-service.js";
import * as lifecycle from "./services/lifecycle-service.js";
import * as messageService from "./services/message-service.js";
import * as runService from "./services/run-service.js";
import * as taskService from "./services/task-service.js";
import { createNodeRegistry, type NodeRegistry } from "./ws/node-registry.js";
import { registerNodeWsRoute } from "./ws/node-ws.js";
import { registerClientWsRoute } from "./ws/client-ws.js";
import { createWsHub, type WsHub } from "./ws/ws-hub.js";

export interface BuildAppOptions {
  /** Inject a registry so tests can observe node registration. */
  nodeRegistry?: NodeRegistry;
  /** Inject the realtime hub so the caller owns the event publisher. */
  wsHub?: WsHub;
}

/**
 * Build the Fastify app for a given {@link ServerContext}. Routes are thin: they
 * validate input with the domain Zod schemas and delegate to services. All
 * business state transitions live in services, never in routes.
 */
export function buildApp(ctx: ServerContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const nodeRegistry = options.nodeRegistry ?? createNodeRegistry();
  const wsHub = options.wsHub ?? createWsHub();

  // Route a queued run's run.start to the node that owns its computer. Tests may
  // pre-set onRunQueued (in-process binding) — only install the registry route
  // when one isn't already provided.
  ctx.onRunQueued ??= async (runId: string): Promise<void> => {
    const run = (await ctx.db.db.select().from(runs).where(eq(runs.id, runId)))[0];
    if (run === undefined) {
      return;
    }
    await nodeRegistry.get(run.computerId)?.dispatchRunStart(runId);
  };

  void app.register(websocket);
  void app.register(async (instance) => {
    registerNodeWsRoute(instance, ctx, nodeRegistry);
    registerClientWsRoute(instance, wsHub);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.httpStatus).send(err.toEnvelope());
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    void reply.status(500).send(apiError("internal_error", message));
  });

  // Tolerate empty JSON bodies (no-body mutations like /ready send an empty body
  // with content-type: application/json) instead of 500; invalid JSON -> 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, raw, done) => {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(AppError.validation("request body is not valid JSON"), undefined);
      }
    },
  );

  registerIdempotency(app, ctx);

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
    return { tasks: await taskService.listTasks(ctx, query.project_id) };
  });

  app.get("/api/v1/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return taskService.getTaskSnapshot(ctx, id);
  });

  app.post("/api/v1/tasks/:id/dependencies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CreateDependencyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid dependency payload", { issues: parsed.error.issues });
    }
    const dependency = await dagService.createDependency(ctx, id, parsed.data);
    void reply.status(201);
    return { dependency };
  });

  app.get("/api/v1/tasks/:id/dag", async (req) => {
    const { id } = req.params as { id: string };
    return { dag: await dagService.getDag(ctx, id) };
  });

  app.post("/api/v1/tasks/:id/ready", async (req) => {
    const { id } = req.params as { id: string };
    return { task: await lifecycle.markReady(ctx, id) };
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
    const parsed = RetryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid retry payload", { issues: parsed.error.issues });
    }
    return { task: await lifecycle.retryTask(ctx, id) };
  });

  app.post("/api/v1/tasks/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid review payload", { issues: parsed.error.issues });
    }
    return { task: await lifecycle.reviewTask(ctx, id, parsed.data) };
  });

  // Dev-only: simulate a node/adapter executing a queued run end to end.
  app.post("/api/v1/dev/runs/:id/mock-execute", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { outcome?: "completed" | "failed" };
    return runService.mockExecuteRun(ctx, id, query.outcome === "failed" ? "failed" : "completed");
  });

  app.get("/api/v1/rooms/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    return { messages: await messageService.listMessages(ctx, id) };
  });

  app.post("/api/v1/rooms/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SendMessageRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid message payload", { issues: parsed.error.issues });
    }
    const message = await messageService.postMessage(ctx, id, parsed.data);
    void reply.status(201);
    return { message };
  });

  app.get("/api/v1/runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { run: await runService.getRun(ctx, id) };
  });

  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return { run: await runService.cancelRun(ctx, id) };
  });

  app.get("/api/v1/approvals", async (req) => {
    const { status } = req.query as { status?: string };
    return { approvals: await approvalService.listApprovals(ctx, status) };
  });

  app.post("/api/v1/approvals/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ResolveApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid approval resolution payload", {
        issues: parsed.error.issues,
      });
    }
    return { approval: await approvalService.resolveApproval(ctx, id, parsed.data) };
  });

  // Dev-only: the platform requesting a high-risk action approval on a running task.
  app.post("/api/v1/dev/tasks/:id/request-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      action?: string;
      risk?: "low" | "medium" | "high";
      summary?: string;
      run_id?: string;
    };
    const approval = await approvalService.requestApproval(ctx, {
      taskId: id,
      runId: body.run_id ?? null,
      action: body.action ?? "git.push",
      risk: body.risk ?? "high",
      summary: body.summary ?? "Push branch to remote",
    });
    void reply.status(201);
    return { approval };
  });

  return app;
}
