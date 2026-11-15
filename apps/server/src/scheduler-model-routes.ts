import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requestContext } from "./auth/auth-routes.js";
import { requireAdministrator } from "./auth/request-auth.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { getSchedulerPolicy, putSchedulerPolicy } from "./services/scheduler-policy-service.js";
import { listSchedulerReconciliations, reconcileSchedulerProject } from "./services/scheduler-projection-service.js";
import { listSchedulerShadowObservations } from "./services/scheduler-shadow-observation-service.js";
import { importSchedulerAgentPins } from "./services/scheduler-pin-import-service.js";

const reconcileInput = z.object({ repair: z.boolean() }).strict();
const pinImportInput = z.object({ apply: z.boolean() }).strict();

export function registerSchedulerModelRoutes(app: FastifyInstance, ctx: ServerContext) {
  app.post("/api/v1/scheduler/agent-pin-import", async (request) => {
    const c = requestContext(ctx, request),
      input = pinImportInput.safeParse(request.body);
    if (!input.success) throw AppError.validation("apply must be an explicit boolean");
    return { import: await importSchedulerAgentPins(c, input.data.apply), active: false };
  });
  app.get("/api/v1/projects/:id/scheduler-shadow-observations", async (request) => {
    const c = requestContext(ctx, request);
    return {
      observations: await listSchedulerShadowObservations(c, (request.params as { id: string }).id),
      execution_authorized: false,
    };
  });
  for (const [resource, kind] of [
    ["projects", "project"],
    ["agents", "agent"],
    ["computers", "computer"],
  ] as const) {
    app.get(`/api/v1/${resource}/:id/scheduling-policy`, async (request) => {
      const c = requestContext(ctx, request);
      return { policy: await getSchedulerPolicy(c, kind, (request.params as { id: string }).id), active: false };
    });
    app.put(`/api/v1/${resource}/:id/scheduling-policy`, async (request) => {
      const c = requestContext(ctx, request);
      return {
        policy: await putSchedulerPolicy(c, kind, (request.params as { id: string }).id, request.body),
        active: false,
      };
    });
  }
  app.get("/api/v1/projects/:id/scheduler-reconciliations", async (request) => {
    const c = requestContext(ctx, request);
    return { reconciliations: await listSchedulerReconciliations(c, (request.params as { id: string }).id) };
  });
  app.post("/api/v1/projects/:id/scheduler-reconciliations", async (request) => {
    const c = requestContext(ctx, request);
    await requireAdministrator(c);
    const input = reconcileInput.safeParse(request.body);
    if (!input.success) throw AppError.validation("repair must be an explicit boolean");
    return {
      reconciliation: await reconcileSchedulerProject(
        c,
        (request.params as { id: string }).id,
        input.data.repair,
        true,
      ),
    };
  });
}
