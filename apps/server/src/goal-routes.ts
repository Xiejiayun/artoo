import { CreateGoalRequestSchema, ProposePlanRequestSchema } from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import { assertPreparedManualGoal } from "./config/goal-entry.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { parseOptionalLimit } from "./route-input.js";
import * as auditService from "./services/audit-service.js";
import * as checkpointService from "./services/checkpoint-service.js";
import { stopAutonomousGoalPlanning } from "./services/goal-automation-service.js";
import * as goalService from "./services/goal-service.js";
import * as planService from "./services/plan-service.js";
import * as resumeService from "./services/resume-service.js";
import * as runService from "./services/run-service.js";
import type { NodeRegistry } from "./ws/node-registry.js";

/** Register goal planning and checkpoint routes in the app's existing scope. */
export function registerGoalRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  nodeRegistry: NodeRegistry,
  stopProcess: (requestCtx: ServerContext, runId: string) => Promise<void>,
): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  // V3 #115 — persistent goals: a goal owns a versioned plan that materializes
  // into a task DAG. Human overrides (pause/resume/cancel) and plan accept/reject
  // are thin handlers over goal-service / plan-service; all state transitions and
  // the single-tx idempotent materialization live in the services.
  app.post("/api/v1/goals", async (req, reply) => {
    const parsed = CreateGoalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid goal payload", { issues: parsed.error.issues });
    }
    assertPreparedManualGoal(rc(req), parsed.data.project_id);
    const goal = await goalService.createGoal(rc(req), parsed.data);
    void reply.status(201);
    return { goal };
  });

  app.get("/api/v1/goals", async (req) => {
    const query = req.query as { project_id?: string; status?: string; limit?: string };
    return {
      goals: await goalService.listGoals(rc(req), {
        projectId: query.project_id,
        status: query.status,
        limit: parseOptionalLimit(query.limit),
      }),
    };
  });
  app.get("/api/v1/goals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = await goalService.getGoal(rc(req), id);
    if (goal === null) {
      void reply.status(404);
      throw AppError.notFound(`goal not found: ${id}`);
    }
    return { goal };
  });
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/v1/goals/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const requestCtx = rc(req);
      if (action === "cancel") await stopAutonomousGoalPlanning(requestCtx, id, stopProcess);
      const goal =
        action === "cancel"
          ? await goalService.cancelGoal(requestCtx, id, async (runId) => {
              const run = await runService.getRun(requestCtx, runId);
              if (run.status === "cancelled" || run.status === "completed") return;
              const binding = nodeRegistry.get(run.computer_id);
              if (!binding)
                throw AppError.conflict(
                  "goal paused: an execution computer is offline; reconnect it and retry cancellation",
                );
              if (run.status === "failed" && run.failure_reason === "daemon_disconnect") {
                await binding.dispatchRunStop(runId);
                await runService.failRunDaemonDisconnect(requestCtx, runId, run.computer_id, true);
              } else {
                try {
                  await runService.cancelRun(requestCtx, runId, () => binding.dispatchRunStop(runId));
                } catch (error) {
                  const latest = await runService.getRun(requestCtx, runId);
                  if (!["completed", "cancelled", "failed"].includes(latest.status)) throw error;
                }
              }
            })
          : await (action === "pause" ? goalService.pauseGoal : goalService.resumeGoal)(requestCtx, id);
      if (goal === null) {
        void reply.status(404);
        throw AppError.notFound(`goal not found: ${id}`);
      }
      return { goal };
    });
  }

  app.post("/api/v1/goals/:id/plans", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposePlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid plan payload", { issues: parsed.error.issues });
    }
    const plan = await planService.proposePlan(rc(req), id, parsed.data);
    void reply.status(201);
    return { plan };
  });
  app.get("/api/v1/goals/:id/plans", async (req) => {
    const { id } = req.params as { id: string };
    return { plans: await planService.listPlans(rc(req), id) };
  });
  app.get("/api/v1/plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await planService.getPlan(rc(req), id);
    if (plan === null) {
      void reply.status(404);
      throw AppError.notFound(`plan not found: ${id}`);
    }
    return { plan };
  });
  app.post("/api/v1/plans/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    const result = await planService.acceptPlan(rc(req), id);
    return { plan: result.plan, task_ids: result.task_ids };
  });
  app.post("/api/v1/plans/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await planService.rejectPlan(rc(req), id);
    if (plan === null) {
      void reply.status(404);
      throw AppError.notFound(`plan not found: ${id}`);
    }
    return { plan };
  });

  // V3 #115 P2-S1 — goal checkpoints (read-only surface; checkpoints are written
  // by the materialize / pause / resume hooks, never directly via the API).
  app.get("/api/v1/goals/:id/checkpoints", async (req) => {
    const { id } = req.params as { id: string };
    return { checkpoints: await checkpointService.listCheckpoints(rc(req), id) };
  });
  app.get("/api/v1/goals/:id/audit-bundle", async (req) => {
    const { id } = req.params as { id: string };
    return { bundle: await auditService.getGoalAuditBundle(rc(req), id) };
  });
  app.get("/api/v1/goals/:id/audit-bundle/export", async (req) => {
    const { id } = req.params as { id: string };
    return { export: await auditService.exportGoalAuditBundle(rc(req), id) };
  });
  app.get("/api/v1/checkpoints/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const checkpoint = await checkpointService.getCheckpoint(rc(req), id);
    if (checkpoint === null) {
      void reply.status(404);
      throw AppError.notFound(`checkpoint not found: ${id}`);
    }
    return { checkpoint };
  });

  // V3 #115 P2-S2 — reconcile a goal against its latest checkpoint (resume
  // evaluation: continue/complete runs, open blockers for failed/stale runs, and
  // re-derive the goal to blocked while active blockers exist). The daemon/restart
  // auto-trigger + run.resume protocol are the separate S3 gate.
  app.post("/api/v1/goals/:id/reconcile", async (req) => {
    const { id } = req.params as { id: string };
    return resumeService.reconcileGoalFromCheckpoint(rc(req), id);
  });
}
