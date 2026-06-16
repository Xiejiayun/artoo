import { runs } from "@artoo/db";
import {
  AcquireLeaseRequestSchema,
  apiError,
  AssignRequestSchema,
  CreateDependencyRequestSchema,
  CreateTaskRequestSchema,
  InstallSkillRequestSchema,
  LeaseStatusSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  MemoryTransitionRequestSchema,
  type MemoryTrigger,
  ProposeMemoryRequestSchema,
  ResolveApprovalRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
  SendMessageRequestSchema,
} from "@artoo/domain";
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";

import type { ServerContext } from "./context.js";
import { registerApiAuthGuard, registerAuthRoutes } from "./auth/auth-routes.js";
import { AppError } from "./errors.js";
import { registerIdempotency } from "./idempotency-middleware.js";
import * as auditService from "./services/audit-service.js";
import * as approvalService from "./services/approval-service.js";
import * as dagService from "./services/dag-service.js";
import * as leaseService from "./services/lease-service.js";
import * as lifecycle from "./services/lifecycle-service.js";
import * as memoryService from "./services/memory-service.js";
import * as messageService from "./services/message-service.js";
import * as runService from "./services/run-service.js";
import * as runtimeRegistry from "./services/runtime-registry-service.js";
import * as skillService from "./services/skill-service.js";
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

  // Google Auth (#34): the protected-API guard (opt-in via enforceApiAuth) and
  // the /auth/* routes.
  registerApiAuthGuard(app, ctx, ctx.authConfig);
  registerAuthRoutes(app, ctx, { config: ctx.authConfig, oidcHttp: ctx.oidcHttp });

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

  app.get("/api/v1/tasks/:id/audit-bundle", async (req) => {
    const { id } = req.params as { id: string };
    return { bundle: await auditService.getTaskAuditBundle(ctx, id) };
  });

  app.get("/api/v1/tasks/:id/audit-bundle/export", async (req) => {
    const { id } = req.params as { id: string };
    return { export: await auditService.exportTaskAuditBundle(ctx, id) };
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

  app.get("/api/v1/tasks/:id/dependencies", async (req) => {
    const { id } = req.params as { id: string };
    return { dependencies: await dagService.listDependencies(ctx, id) };
  });

  app.delete("/api/v1/tasks/:id/dependencies/:dependencyId", async (req, reply) => {
    const { id, dependencyId } = req.params as { id: string; dependencyId: string };
    await dagService.deleteDependency(ctx, id, dependencyId);
    void reply.status(204);
    return null;
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

  // Runtime registry (#15 Part 2): the runtimes a computer last advertised via
  // heartbeat, with status + last_seen_at for the scheduler to filter (Part 3).
  app.get("/api/v1/computers/:id/runtimes", async (req) => {
    const { id } = req.params as { id: string };
    return { runtimes: await runtimeRegistry.listComputerRuntimes(ctx, id) };
  });

  // Skill registry (#24): durable installs/read APIs over the v1alpha1 manifest contract.
  app.post("/api/v1/skills/install", async (req, reply) => {
    const parsed = InstallSkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid skill install payload", { issues: parsed.error.issues });
    }
    const skill = await skillService.installSkill(ctx, parsed.data);
    void reply.status(201);
    return { skill };
  });

  app.get("/api/v1/skills", async (req) => {
    const q = req.query as { project_id?: string; enabled?: string };
    let enabled: boolean | undefined;
    if (q.enabled !== undefined && q.enabled !== "") {
      if (q.enabled !== "true" && q.enabled !== "false") {
        throw AppError.validation("enabled filter must be 'true' or 'false'", { enabled: q.enabled });
      }
      enabled = q.enabled === "true";
    }
    return {
      skills: await skillService.listSkillInstalls(ctx, {
        projectId: q.project_id,
        enabled,
      }),
    };
  });

  app.get("/api/v1/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { skill: await skillService.getSkillInstall(ctx, id) };
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

  // Concurrency control (#12): file leases over workspace paths.
  app.post("/api/v1/leases", async (req, reply) => {
    const parsed = AcquireLeaseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid lease payload", { issues: parsed.error.issues });
    }
    const lease = await leaseService.acquireLease(ctx, parsed.data);
    void reply.status(201);
    return { lease };
  });

  app.delete("/api/v1/leases/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { lease: await leaseService.releaseLease(ctx, id) };
  });

  app.get("/api/v1/projects/:id/leases", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = req.query as { status?: string };
    if (status !== undefined && status !== "") {
      const parsed = LeaseStatusSchema.safeParse(status);
      if (!parsed.success) {
        throw AppError.validation("invalid lease status filter", { status });
      }
      return { leases: await leaseService.listLeases(ctx, id, parsed.data) };
    }
    return { leases: await leaseService.listLeases(ctx, id) };
  });

  // Memory (#14 Phase B): propose/curate memories + accepted-only retrieval.
  app.post("/api/v1/memories", async (req, reply) => {
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory payload", { issues: parsed.error.issues });
    }
    const memory = await memoryService.proposeMemory(ctx, parsed.data);
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
      memories: await memoryService.listMemories(ctx, {
        scope: q.scope,
        status: q.status,
        projectId: q.project_id,
        taskId: q.task_id,
        tag: q.tag,
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
    return memoryService.selectForContext(
      ctx,
      { projectId: q.project_id, taskId: q.task_id },
      limit,
    );
  });

  app.get("/api/v1/memories/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { memory: await memoryService.getMemory(ctx, id) };
  });

  app.post("/api/v1/memories/:id/supersede", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory replacement payload", { issues: parsed.error.issues });
    }
    const result = await memoryService.supersedeMemory(ctx, id, parsed.data);
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
    const memory = await memoryService.transitionMemory(ctx, id, action as MemoryTrigger, parsed.data);
    return { memory };
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
