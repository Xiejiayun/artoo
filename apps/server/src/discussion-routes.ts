import { StartDiscussionRequestSchema } from "@artoo/domain";
import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { cancelDiscussion, createDiscussionDispatcher, getDiscussion, listDiscussions, proposeDiscussionPlan, startDiscussion } from "./services/discussion-service.js";

export function registerDiscussionRoutes(app: FastifyInstance, ctx: ServerContext, options: {
  enabled?: boolean; stopProcess: (ctx: ServerContext, runId: string) => Promise<void>;
}) {
  const worker = createDiscussionDispatcher(ctx, options.stopProcess, (error) => app.log.error(error, "discussion dispatcher failed"));
  if (options.enabled !== false) app.addHook("onReady", async () => { worker.start(); });
  app.addHook("onClose", async () => { await worker.stop(); });
  app.get("/api/v1/goals/:id/discussions", async (req) => ({ discussions: await listDiscussions(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.post("/api/v1/goals/:id/discussions", async (req, reply) => {
    const parsed = StartDiscussionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.validation("Invalid discussion request", { issues: parsed.error.issues });
    const discussion = await startDiscussion(requestContext(ctx, req), (req.params as { id: string }).id, parsed.data);
    if (options.enabled !== false) void worker.pump().catch((error) => app.log.error(error));
    return reply.status(201).send({ discussion });
  });
  app.get("/api/v1/discussions/:id", async (req) => ({ discussion: await getDiscussion(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.post("/api/v1/discussions/:id/cancel", async (req) => ({ discussion: await cancelDiscussion(requestContext(ctx, req), (req.params as { id: string }).id, options.stopProcess) }));
  app.post("/api/v1/discussions/:id/propose-plan", async (req) => proposeDiscussionPlan(requestContext(ctx, req), (req.params as { id: string }).id));
}
