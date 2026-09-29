import { SendAssistantTurnRequestSchema } from "@artoo/domain";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import { requestContext } from "./auth/auth-routes.js";
import { AppError } from "./errors.js";
import { cancelAssistantTurn, createAssistantDispatcher, enqueueAssistantTurn, listAssistantTurns, retryAssistantTurn } from "./services/assistant-service.js";

export function registerAssistantRoutes(app: FastifyInstance, ctx: ServerContext, options: {
  enabled?: boolean;
  stopProcess: (ctx: ServerContext, runId: string) => Promise<void>;
}): void {
  const dispatcher = createAssistantDispatcher(ctx, (error) => app.log.error(error, "assistant dispatcher failed"));
  if (options.enabled !== false) app.addHook("onReady", async () => { dispatcher.start(); });
  app.addHook("onClose", async () => { await dispatcher.stop(); });
  app.get("/api/v1/rooms/:id/assistant-turns", async (req) => {
    const root = (req.query as { thread_root_id?: unknown }).thread_root_id;
    if (root !== undefined && (typeof root !== "string" || root.length === 0)) throw AppError.validation("Invalid assistant thread root");
    return { turns: await listAssistantTurns(requestContext(ctx, req), (req.params as { id: string }).id, root) };
  });
  app.post("/api/v1/rooms/:id/assistant-turns", async (req, reply) => {
    const parsed = SendAssistantTurnRequestSchema.safeParse(req.body);
    if (!parsed.success) throw AppError.validation("Invalid assistant request", { issues: parsed.error.issues });
    const result = await enqueueAssistantTurn(requestContext(ctx, req), (req.params as { id: string }).id, parsed.data);
    if (options.enabled !== false) void dispatcher.pump();
    return reply.status(201).send(result);
  });
  app.post("/api/v1/assistant-turns/:id/cancel", async (req) => {
    const current = requestContext(ctx, req);
    return { turn: await cancelAssistantTurn(current, (req.params as { id: string }).id, (runId) => options.stopProcess(current, runId)) };
  });
  app.post("/api/v1/assistant-turns/:id/retry", async (req) => {
    const turn = await retryAssistantTurn(requestContext(ctx, req), (req.params as { id: string }).id);
    if (options.enabled !== false) void dispatcher.pump();
    return { turn };
  });
}
