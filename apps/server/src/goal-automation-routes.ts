import { CreateAutonomousGoalRequestSchema } from "@artoo/domain";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import { requestContext } from "./auth/auth-routes.js";
import { AppError } from "./errors.js";
import { createAutonomousGoal, createGoalAutomationDispatcher, getGoalAutomation } from "./services/goal-automation-service.js";

export function registerGoalAutomationRoutes(app: FastifyInstance, ctx: ServerContext, options: {
  enabled?: boolean; stopProcess: (ctx: ServerContext, runId: string) => Promise<void>;
}) {
  const worker = createGoalAutomationDispatcher(ctx, options.stopProcess, (error) => app.log.error(error, "goal automation failed"));
  if (options.enabled !== false) app.addHook("onReady", async () => { worker.start(); });
  app.addHook("onClose", async () => { await worker.stop(); });
  app.post("/api/v1/autonomous-goals", async (req, reply) => {
    const parsed = CreateAutonomousGoalRequestSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.validation("Invalid autonomous goal request", { issues: parsed.error.issues });
    const result = await createAutonomousGoal(requestContext(ctx, req), parsed.data);
    if (options.enabled !== false) void worker.pump().catch((error) => app.log.error(error));
    return reply.status(201).send(result);
  });
  app.get("/api/v1/goals/:id/automation", async (req) => ({ automation: await getGoalAutomation(requestContext(ctx, req), (req.params as { id: string }).id) }));
}
