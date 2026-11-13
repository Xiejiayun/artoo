import {
  CreateBlockerRequestSchema,
  CreateDecisionRequestSchema,
  CreateHandoffRequestSchema,
  UpdateBlockerRequestSchema,
  UpdateDecisionRequestSchema,
  UpdateHandoffRequestSchema,
} from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import * as collaborationService from "./services/collaboration-service.js";

/** Register in the app's existing scope so authentication and idempotency apply. */
export function registerCollaborationRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  // V3 #114 — team discussion records. Decisions, handoffs, and blockers are
  // first-class rows so the UI/audit can answer "what did the team decide",
  // "who waits on whom", and "what is blocking" from records, not thread text.
  // room_id is always the path param; bodies never carry it.
  app.post("/api/v1/rooms/:roomId/decisions", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = CreateDecisionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid decision payload", { issues: parsed.error.issues });
    }
    const decision = await collaborationService.createDecision(rc(req), { room_id: roomId, ...parsed.data });
    void reply.status(201);
    return { decision };
  });
  app.get("/api/v1/rooms/:roomId/decisions", async (req) => {
    const { roomId } = req.params as { roomId: string };
    return { decisions: await collaborationService.listDecisions(rc(req), roomId) };
  });
  app.patch("/api/v1/decisions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateDecisionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid decision update", { issues: parsed.error.issues });
    }
    const decision = await collaborationService.setDecisionStatus(rc(req), id, parsed.data.status, {
      superseded_by_id: parsed.data.superseded_by_id,
    });
    if (decision === null) {
      void reply.status(404);
      throw AppError.notFound(`decision ${id} not found`);
    }
    return { decision };
  });

  app.post("/api/v1/rooms/:roomId/handoffs", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = CreateHandoffRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid handoff payload", { issues: parsed.error.issues });
    }
    const handoff = await collaborationService.createHandoff(rc(req), { room_id: roomId, ...parsed.data });
    void reply.status(201);
    return { handoff };
  });
  app.get("/api/v1/rooms/:roomId/handoffs", async (req) => {
    const { roomId } = req.params as { roomId: string };
    return { handoffs: await collaborationService.listHandoffs(rc(req), roomId) };
  });
  app.patch("/api/v1/handoffs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateHandoffRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid handoff update", { issues: parsed.error.issues });
    }
    const handoff = await collaborationService.setHandoffStatus(rc(req), id, parsed.data.status, {
      next_action: parsed.data.next_action,
      latest_status: parsed.data.latest_status,
    });
    if (handoff === null) {
      void reply.status(404);
      throw AppError.notFound(`handoff ${id} not found`);
    }
    return { handoff };
  });

  // Who-waits-on-whom edges from open handoff records (org-wide, or one room).
  app.get("/api/v1/rooms/:roomId/who-waits", async (req) => {
    const { roomId } = req.params as { roomId: string };
    return { edges: await collaborationService.whoWaitsOnWhom(rc(req), roomId) };
  });
  app.get("/api/v1/who-waits", async (req) => ({
    edges: await collaborationService.whoWaitsOnWhom(rc(req)),
  }));

  app.post("/api/v1/rooms/:roomId/blockers", async (req, reply) => {
    const { roomId } = req.params as { roomId: string };
    const parsed = CreateBlockerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid blocker payload", { issues: parsed.error.issues });
    }
    const blocker = await collaborationService.createBlocker(rc(req), { room_id: roomId, ...parsed.data });
    void reply.status(201);
    return { blocker };
  });
  app.get("/api/v1/rooms/:roomId/blockers", async (req) => {
    const { roomId } = req.params as { roomId: string };
    return { blockers: await collaborationService.listBlockers(rc(req), roomId) };
  });
  app.patch("/api/v1/blockers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateBlockerRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid blocker update", { issues: parsed.error.issues });
    }
    const blocker = await collaborationService.setBlockerStatus(rc(req), id, parsed.data.status, {
      mitigation: parsed.data.mitigation,
      next_action: parsed.data.next_action,
    });
    if (blocker === null) {
      void reply.status(404);
      throw AppError.notFound(`blocker ${id} not found`);
    }
    return { blocker };
  });
}
