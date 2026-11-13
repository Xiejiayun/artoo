import { AcquireLeaseRequestSchema, LeaseStatusSchema, ResolveApprovalRequestSchema } from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { parseOptionalLimit } from "./route-input.js";
import * as approvalService from "./services/approval-service.js";
import * as leaseService from "./services/lease-service.js";

/** Register approval decisions and file leases in the existing app scope. */
export function registerApprovalAndLeaseRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  app.get("/api/v1/approvals", async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    return { approvals: await approvalService.listApprovals(rc(req), status, parseOptionalLimit(limit)) };
  });

  app.post("/api/v1/tasks/:id/execution-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = (req.body ?? {}) as Record<string, unknown>;
    if (typeof input.summary !== "string" || !["low", "medium", "high"].includes(String(input.risk)))
      throw AppError.validation("summary and risk are required");
    const approval = await approvalService.requestExecutionApproval(rc(req), id, {
      summary: input.summary,
      risk: input.risk as "low" | "medium" | "high",
    });
    return reply.status(201).send({ approval });
  });

  app.post("/api/v1/approvals/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ResolveApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid approval resolution payload", {
        issues: parsed.error.issues,
      });
    }
    return { approval: await approvalService.resolveApproval(rc(req), id, parsed.data) };
  });

  // Concurrency control (#12): file leases over workspace paths.
  app.post("/api/v1/leases", async (req, reply) => {
    const parsed = AcquireLeaseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid lease payload", { issues: parsed.error.issues });
    }
    const lease = await leaseService.acquireLease(rc(req), parsed.data);
    void reply.status(201);
    return { lease };
  });

  app.delete("/api/v1/leases/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { lease: await leaseService.releaseLease(rc(req), id) };
  });

  app.get("/api/v1/projects/:id/leases", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = req.query as { status?: string };
    if (status !== undefined && status !== "") {
      const parsed = LeaseStatusSchema.safeParse(status);
      if (!parsed.success) {
        throw AppError.validation("invalid lease status filter", { status });
      }
      return { leases: await leaseService.listLeases(rc(req), id, parsed.data) };
    }
    return { leases: await leaseService.listLeases(rc(req), id) };
  });
}

/** The app only calls this registrar when development routes are enabled. */
export function registerDevelopmentApprovalRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  app.post("/api/v1/dev/tasks/:id/request-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      action?: string;
      risk?: "low" | "medium" | "high";
      summary?: string;
      run_id?: string;
    };
    const approval = await approvalService.requestApproval(rc(req), {
      taskId: id,
      runId: body.run_id ?? null,
      action: body.action ?? "git.push",
      risk: body.risk ?? "high",
      summary: body.summary ?? "Push branch to remote",
    });
    void reply.status(201);
    return { approval };
  });
}
