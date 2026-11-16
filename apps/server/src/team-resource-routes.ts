import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { createLogicalAgent, getLogicalAgentConfiguration, putLogicalAgentConfiguration, getProjectSquad, putProjectSquad, getComputerAdmission, putComputerAdmission } from "./services/team-resource-service.js";

export function registerTeamResourceRoutes(app: FastifyInstance, ctx: ServerContext) {
  app.post("/api/v1/agents", async (req, reply) => reply.status(201).send(await createLogicalAgent(requestContext(ctx, req), req.body)));
  app.get("/api/v1/agents/:id/configuration", async (req) => ({ configuration: await getLogicalAgentConfiguration(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.put("/api/v1/agents/:id/configuration", async (req) => ({ configuration: await putLogicalAgentConfiguration(requestContext(ctx, req), (req.params as { id: string }).id, req.body) }));
  app.get("/api/v1/projects/:id/squad", async (req) => ({ squad: await getProjectSquad(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.put("/api/v1/projects/:id/squad", async (req) => ({ squad: await putProjectSquad(requestContext(ctx, req), (req.params as { id: string }).id, req.body) }));
  app.get("/api/v1/computers/:id/admission", async (req) => ({ admission: await getComputerAdmission(requestContext(ctx, req), (req.params as { id: string }).id) }));
  app.put("/api/v1/computers/:id/admission", async (req) => ({ admission: await putComputerAdmission(requestContext(ctx, req), (req.params as { id: string }).id, req.body) }));
}
