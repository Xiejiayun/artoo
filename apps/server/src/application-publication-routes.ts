import type { FastifyInstance } from "fastify";
import type { ServerContext } from "./context.js";
import { requestContext } from "./auth/auth-routes.js";
import { cancelGoalApplicationPublication, getGoalApplicationPublication } from "./services/application-publication-service.js";
import { requireActiveMember } from "./services/member-status.js";

export function registerApplicationPublicationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/v1/goals/:id/application-publication", async req => ({ publication:
    await getGoalApplicationPublication(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.post("/api/v1/goals/:id/application-publication/stop", async req => {
    const actor = requestContext(ctx, req), id = (req.params as { id: string }).id;
    await requireActiveMember(actor);
    // Validate organization ownership even when no publication row exists.
    await getGoalApplicationPublication(actor, id);
    await cancelGoalApplicationPublication(actor, id);
    return { publication: await getGoalApplicationPublication(actor, id) };
  });
}
