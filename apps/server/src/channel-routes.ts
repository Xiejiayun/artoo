import { CreateChannelRequestSchema } from "@artoo/domain";
import type { FastifyInstance } from "fastify";
import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import * as channels from "./services/channel-service.js";
import { getMessage } from "./services/message-service.js";

export function registerChannelRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get("/api/v1/channels", async (request) => {
    const { project_id } = request.query as { project_id?: unknown };
    if (typeof project_id !== "string" || !project_id) throw AppError.validation("project_id is required");
    return { channels: await channels.listChannels(requestContext(ctx, request), project_id) };
  });
  app.post("/api/v1/channels", async (request, reply) => {
    const input = CreateChannelRequestSchema.safeParse(request.body);
    if (!input.success) throw AppError.validation("Invalid channel", { issues: input.error.issues });
    return reply.status(201).send({ channel: await channels.createChannel(requestContext(ctx, request), input.data) });
  });
  app.get("/api/v1/members", async (request) => ({ members: await channels.listMembers(requestContext(ctx, request)) }));
  app.get("/api/v1/notifications", async (request) => ({ notifications: await channels.listNotifications(requestContext(ctx, request)) }));
  app.post("/api/v1/notifications/:id/read", async (request) => ({ notification: await channels.markNotificationRead(requestContext(ctx, request), (request.params as { id: string }).id) }));
  app.get("/api/v1/rooms/:id/messages/:messageId", async (request) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    return { message: await getMessage(requestContext(ctx, request), id, messageId) };
  });
}
