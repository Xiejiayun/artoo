import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { getProjectControlView } from "./services/control-view-service.js";

export function registerControlViewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/v1/projects/:id/control-view", async (request) => {
    const { id } = request.params as { id: string };
    return getProjectControlView(requestContext(ctx, request), id, request.query);
  });
}
