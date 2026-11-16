import { schedulerCapacityStatus } from "./services/scheduler-capacity-service.js";
import { schedulerExecutionConsumerStatus } from "./services/scheduler-claim-consumer-service.js";
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
import { getSchedulerQueueMetadata, putSchedulerQueueMetadata } from "./services/scheduler-queue-metadata-service.js";
import {
  cancelSchedulerIntent,
  createSchedulerIntent,
  listSchedulerIntents,
} from "./services/scheduler-intent-service.js";
import {
  cancelSchedulerExecutionRequest,
  createSchedulerExecutionRequest,
  listSchedulerExecutionRequests,
} from "./services/scheduler-execution-request-service.js";

const reconcileInput = z.object({ repair: z.boolean() }).strict();
const pinImportInput = z.object({ apply: z.boolean() }).strict();
const cancelIntentInput = z.object({ version: z.literal(1) }).strict();
const cancelExecutionRequestInput = z.object({ version: z.literal(2) }).strict();

export function registerSchedulerModelRoutes(app: FastifyInstance, ctx: ServerContext) {
  app.get("/api/v1/tasks/:id/scheduler-execution-requests", async (request) => {
    const c = requestContext(ctx, request);
    return {
      requests: await listSchedulerExecutionRequests(c, (request.params as { id: string }).id),
      ...(await schedulerExecutionConsumerStatus(c, (request.params as { id: string }).id)),
    };
  });
  app.post("/api/v1/tasks/:id/scheduler-execution-requests", async (request, reply) => {
    const c = requestContext(ctx, request);
    const executionRequest = await createSchedulerExecutionRequest(
      c,
      (request.params as { id: string }).id,
      request.body,
    );
    return reply.status(201).send({
      request: executionRequest,
      ...(await schedulerExecutionConsumerStatus(c, (request.params as { id: string }).id)),
    });
  });
  app.post("/api/v1/tasks/:id/scheduler-execution-requests/:requestId/cancel", async (request) => {
    if (!cancelExecutionRequestInput.safeParse(request.body).success)
      throw AppError.validation("Explicit version 2 cancellation is required");
    const c = requestContext(ctx, request);
    const { id, requestId } = request.params as { id: string; requestId: string };
    return {
      request: await cancelSchedulerExecutionRequest(c, id, requestId),
      ...(await schedulerExecutionConsumerStatus(c, id)),
    };
  });
  app.get("/api/v1/tasks/:id/scheduler-intents", async (request) => {
    const c = requestContext(ctx, request);
    return {
      intents: await listSchedulerIntents(c, (request.params as { id: string }).id),
      active: false,
      execution_authorized: false,
    };
  });
  app.post("/api/v1/tasks/:id/scheduler-intents", async (request, reply) => {
    const c = requestContext(ctx, request);
    const intent = await createSchedulerIntent(c, (request.params as { id: string }).id, request.body);
    return reply.status(201).send({ intent, active: false, execution_authorized: false });
  });
  app.post("/api/v1/tasks/:id/scheduler-intents/:intentId/cancel", async (request) => {
    const input = cancelIntentInput.safeParse(request.body);
    if (!input.success) throw AppError.validation("Explicit version 1 cancellation is required");
    const c = requestContext(ctx, request),
      { id, intentId } = request.params as { id: string; intentId: string };
    return { intent: await cancelSchedulerIntent(c, id, intentId), active: false, execution_authorized: false };
  });
  app.get("/api/v1/tasks/:id/scheduler-queue-metadata", async (request) => {
    const c = requestContext(ctx, request);
    return {
      queue_metadata: await getSchedulerQueueMetadata(c, (request.params as { id: string }).id),
      active: false,
      execution_authorized: false,
    };
  });
  app.put("/api/v1/tasks/:id/scheduler-queue-metadata", async (request) => {
    const c = requestContext(ctx, request);
    return {
      queue_metadata: await putSchedulerQueueMetadata(c, (request.params as { id: string }).id, request.body),
      active: false,
      execution_authorized: false,
    };
  });
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
      return {
        policy: await getSchedulerPolicy(c, kind, (request.params as { id: string }).id),
        active: false,
        capacity_admission: schedulerCapacityStatus(
          c,
          kind === "project" ? (request.params as { id: string }).id : undefined,
        ),
      };
    });
    app.put(`/api/v1/${resource}/:id/scheduling-policy`, async (request) => {
      const c = requestContext(ctx, request);
      return {
        policy: await putSchedulerPolicy(c, kind, (request.params as { id: string }).id, request.body),
        active: false,
        capacity_admission: schedulerCapacityStatus(
          c,
          kind === "project" ? (request.params as { id: string }).id : undefined,
        ),
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
