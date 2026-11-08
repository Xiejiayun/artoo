import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import { requestContext } from "./auth/auth-routes.js";
import { createProductReleaseDispatcher, getGoalProductRelease } from "./services/product-release-service.js";

export function registerProductReleaseRoutes(app: FastifyInstance, ctx: ServerContext, enabled = true): void {
  const dispatcher = createProductReleaseDispatcher(ctx, (error) => app.log.error(error, "product release delivery failed"));
  if (enabled) app.addHook("onReady", async () => { dispatcher.start(); });
  app.addHook("onClose", async () => { await dispatcher.stop(); });
  app.get("/api/v1/goals/:id/release", async (req) => ({ release: await getGoalProductRelease(requestContext(ctx, req), (req.params as { id: string }).id) }));
}
