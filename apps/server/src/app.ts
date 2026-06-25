import { runs } from "@artoo/db";
import {
  AcquireLeaseRequestSchema,
  apiError,
  AssignRequestSchema,
  CreateBlockerRequestSchema,
  CreateDecisionRequestSchema,
  CreateDependencyRequestSchema,
  CreateGoalRequestSchema,
  CreateHandoffRequestSchema,
  CreateTaskRequestSchema,
  type DevicePlatform,
  DevicePlatformSchema,
  InstallSkillRequestSchema,
  LeaseStatusSchema,
  MemoryScopeSchema,
  MemoryStatusSchema,
  MemoryTransitionRequestSchema,
  type MemoryTrigger,
  ProposeMemoryRequestSchema,
  ProposePlanRequestSchema,
  ResolveApprovalRequestSchema,
  RetryRequestSchema,
  ReviewRequestSchema,
  SendMessageRequestSchema,
  UpdateBlockerRequestSchema,
  UpdateDecisionRequestSchema,
  UpdateHandoffRequestSchema,
} from "@artoo/domain";
import websocket from "@fastify/websocket";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { ServerContext } from "./context.js";
import { registerApiAuthGuard, registerAuthRoutes, requestContext } from "./auth/auth-routes.js";
import { AppError } from "./errors.js";
import { createClaimLimiter, DEFAULT_CLAIM_LIMIT, type ClaimLimiter } from "./claim-rate-limit.js";
import { registerIdempotency } from "./idempotency-middleware.js";
import * as auditService from "./services/audit-service.js";
import * as approvalService from "./services/approval-service.js";
import * as collaborationService from "./services/collaboration-service.js";
import * as dagService from "./services/dag-service.js";
import * as deviceService from "./services/device-service.js";
import * as goalService from "./services/goal-service.js";
import * as leaseService from "./services/lease-service.js";
import * as lifecycle from "./services/lifecycle-service.js";
import * as memoryService from "./services/memory-service.js";
import * as messageService from "./services/message-service.js";
import * as planService from "./services/plan-service.js";
import * as presenceService from "./services/presence-service.js";
import * as runService from "./services/run-service.js";
import * as runtimeRegistry from "./services/runtime-registry-service.js";
import * as skillService from "./services/skill-service.js";
import * as syncService from "./services/sync-service.js";
import * as taskService from "./services/task-service.js";
import { createNodeRegistry, type NodeRegistry } from "./ws/node-registry.js";
import { createDeviceConnectionRegistry } from "./ws/device-connections.js";
import { registerNodeWsRoute } from "./ws/node-ws.js";
import { registerClientWsRoute, type ClientWsHooks } from "./ws/client-ws.js";
import { createWsHub, type WsHub } from "./ws/ws-hub.js";
import { registerWebStatic } from "./web-static.js";

export interface BuildAppOptions {
  /** Inject a registry so tests can observe node registration. */
  nodeRegistry?: NodeRegistry;
  /** Inject the realtime hub so the caller owns the event publisher. */
  wsHub?: WsHub;
  /** Serve the built web SPA from this dir (same-origin #34). Omit/absent dir = off. */
  webDistDir?: string;
  /** Control-WS lifecycle hooks (#28 slice 3b identity tagging; slice 3c indexes
   *  device sockets for revoke-closes-sockets). */
  clientWsHooks?: ClientWsHooks;
  /** Inject a claim rate-limiter (#28 4b) so tests can use a tight bound. */
  claimLimiter?: ClaimLimiter;
  /** Allow packaged desktop renderers (file:// -> Origin: null) to call the API. */
  desktopCors?: DesktopCorsOptions;
}

export interface DesktopCorsOptions {
  allowedOrigins: string[];
}

/**
 * Build the Fastify app for a given {@link ServerContext}. Routes are thin: they
 * validate input with the domain Zod schemas and delegate to services. All
 * business state transitions live in services, never in routes.
 */
export function buildApp(ctx: ServerContext, options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const nodeRegistry = options.nodeRegistry ?? createNodeRegistry();
  const wsHub = options.wsHub ?? createWsHub();
  // Index of live device sockets (node + control) so a revoke can close them.
  // When a device's last live socket drops, emit a presence offline transition
  // (#28 4c). Revoke handles its own offline event, so closeForDevice does not.
  const deviceConnections = createDeviceConnectionRegistry({
    onDeviceOffline: (deviceId) => {
      void presenceService.markDeviceOffline(ctx, deviceId, "disconnect").catch(() => {});
    },
  });
  // Bounded attempts for the public (unauthenticated) claim route.
  const claimLimiter = options.claimLimiter ?? createClaimLimiter(DEFAULT_CLAIM_LIMIT);

  // Route a queued run's run.start to the node that owns its computer. Tests may
  // pre-set onRunQueued (in-process binding) — only install the registry route
  // when one isn't already provided.
  ctx.onRunQueued ??= async (runId: string): Promise<void> => {
    const run = (await ctx.db.db.select().from(runs).where(eq(runs.id, runId)))[0];
    if (run === undefined) {
      return;
    }
    await nodeRegistry.get(run.computerId)?.dispatchRunStart(runId);
  };

  void app.register(websocket);
  void app.register(async (instance) => {
    registerNodeWsRoute(instance, ctx, nodeRegistry, deviceConnections);
    registerClientWsRoute(instance, ctx, wsHub, options.clientWsHooks, deviceConnections);
  });

  if (options.desktopCors !== undefined) {
    registerDesktopCors(app, options.desktopCors);
  }

  // Google Auth (#34): the protected-API guard (opt-in via enforceApiAuth) and
  // the /auth/* routes.
  registerApiAuthGuard(app, ctx, ctx.authConfig);
  registerAuthRoutes(app, ctx, { config: ctx.authConfig, oidcHttp: ctx.oidcHttp });

  // Per-request service context bound to the authenticated session user (when the
  // guard enforced auth); falls back to the base ctx otherwise. REST handlers use
  // `rc(req)` so services attribute to the logged-in user, never a shared actor.
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      void reply.status(err.httpStatus).send(err.toEnvelope());
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    void reply.status(500).send(apiError("internal_error", message));
  });

  // Tolerate empty JSON bodies (no-body mutations like /ready send an empty body
  // with content-type: application/json) instead of 500; invalid JSON -> 400.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, raw, done) => {
      const text = typeof raw === "string" ? raw.trim() : "";
      if (text === "") {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        done(AppError.validation("request body is not valid JSON"), undefined);
      }
    },
  );

  // Credential-issuance routes return raw codes/tokens once and must never have
  // those bodies persisted by the idempotency store (#28 invariant) — exempt them.
  registerIdempotency(app, ctx, new Set(["/api/v1/devices/pairings", "/api/v1/devices/claim"]));

  app.get("/api/v1/bootstrap", async (req) => taskService.bootstrap(rc(req)));

  // #27 v2-B slice 2a — read cursor. Clients use this as the hydration/tail
  // baseline for WS since_cursor; command base_version comes from resource reads.
  app.get("/api/v1/sync/cursor", async (req) => ({ cursor: await syncService.currentCursor(rc(req)) }));

  // #28 v2-C slice 4b — device pairing/enroll/list/revoke HTTP surface. The
  // pairing HMAC pepper comes from ctx.deviceAuth (never an env read here). The
  // pairing config TTL is short — codes are single-use and time-boxed.
  const pairingConfig = (): deviceService.DevicePairingConfig => ({
    pepper: ctx.deviceAuth.pairingPepper,
    ttlMs: DEVICE_PAIRING_TTL_MS,
  });

  // Create a single-use pairing code (an authenticated user initiates pairing).
  app.post("/api/v1/devices/pairings", async (req, reply) => {
    const body = (req.body ?? {}) as { intended_platform?: unknown };
    const c = rc(req);
    const result = await deviceService.createPairing(c, pairingConfig(), {
      createdByUserId: c.actorUserId,
      intendedPlatform: readDevicePlatform(body.intended_platform),
    });
    void reply.status(201);
    return result;
  });

  // Claim a pairing code into a device + credentials. The CODE is the authority
  // here (the unpaired client has no session yet), so this route is exempt from
  // the #34 session guard. Because it is public, every attempt — right or wrong —
  // is rate-limited by source BEFORE the code is examined, so the limiter cannot
  // be used as an oracle for whether a code exists.
  app.post("/api/v1/devices/claim", async (req, reply) => {
    if (!claimLimiter.tryConsume(claimSource(req), Date.parse(ctx.clock.nowIso()))) {
      throw AppError.rateLimited("too many pairing attempts; slow down");
    }
    const body = (req.body ?? {}) as {
      code?: unknown;
      platform?: unknown;
      app_version?: unknown;
      display_name?: unknown;
    };
    if (typeof body.code !== "string" || typeof body.platform !== "string") {
      throw AppError.validation("code and platform are required");
    }
    const { device, controlToken, nodeToken } = await deviceService.claimPairing(rc(req), pairingConfig(), {
      code: body.code,
      platform: requireDevicePlatform(body.platform),
      appVersion: typeof body.app_version === "string" ? body.app_version : "",
      displayName: typeof body.display_name === "string" ? body.display_name : "",
    });
    void reply.status(201);
    return { device, control_token: controlToken, node_token: nodeToken };
  });

  // Link a desktop device to a computer so its node token can bind (#28 4a).
  app.post("/api/v1/devices/:id/enroll", async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await deviceService.enrollDeviceComputer(rc(req), {
      deviceId: id,
      displayName: typeof body.display_name === "string" ? body.display_name : undefined,
      hostname: typeof body.hostname === "string" ? body.hostname : undefined,
      os: typeof body.os === "string" ? body.os : undefined,
      arch: typeof body.arch === "string" ? body.arch : undefined,
    });
    return { device_id: result.deviceId, computer_id: result.computerId, created: result.created };
  });

  app.get("/api/v1/devices", async (req) => ({ devices: await deviceService.listDevices(rc(req)) }));

  // Device presence (#28 4c): combines last_seen_at, device trust, and live
  // socket state so the read agrees with the emitted transition events.
  app.get("/api/v1/devices/:id/presence", async (req) => {
    const { id } = req.params as { id: string };
    const hasLiveConnection = deviceConnections.countForDevice(id) > 0;
    return { presence: await presenceService.devicePresence(rc(req), id, { hasLiveConnection }) };
  });

  // Agent/computer presence (#113): server-synthesized read model. A computer's
  // live connection is its registered daemon node (nodeRegistry); the service
  // gathers the rest from runs/tasks/runtime/computer/device facts.
  const isLive = (computerId: string): boolean => nodeRegistry.get(computerId) !== undefined;
  app.get("/api/v1/agent-instances/presence", async (req) => ({
    presence: await presenceService.listAgentInstancePresence(rc(req), isLive),
  }));
  app.get("/api/v1/agent-instances/:id/presence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const presence = await presenceService.agentInstancePresence(rc(req), id, isLive);
    if (presence === null) {
      void reply.status(404);
      throw AppError.notFound(`agent instance ${id} not found`);
    }
    return { presence };
  });
  app.get("/api/v1/computers/presence", async (req) => ({
    presence: await presenceService.listComputerPresence(rc(req), isLive),
  }));
  app.get("/api/v1/computers/:id/presence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const presence = await presenceService.computerPresence(rc(req), id, isLive);
    if (presence === null) {
      void reply.status(404);
      throw AppError.notFound(`computer ${id} not found`);
    }
    return { presence };
  });

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

  // V3 #115 — persistent goals: a goal owns a versioned plan that materializes
  // into a task DAG. Human overrides (pause/resume/cancel) and plan accept/reject
  // are thin handlers over goal-service / plan-service; all state transitions and
  // the single-tx idempotent materialization live in the services.
  app.post("/api/v1/goals", async (req, reply) => {
    const parsed = CreateGoalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid goal payload", { issues: parsed.error.issues });
    }
    const goal = await goalService.createGoal(rc(req), parsed.data);
    void reply.status(201);
    return { goal };
  });
  app.get("/api/v1/goals", async (req) => {
    const query = req.query as { project_id?: string; status?: string };
    return { goals: await goalService.listGoals(rc(req), { projectId: query.project_id, status: query.status }) };
  });
  app.get("/api/v1/goals/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = await goalService.getGoal(rc(req), id);
    if (goal === null) {
      void reply.status(404);
      throw AppError.notFound(`goal not found: ${id}`);
    }
    return { goal };
  });
  for (const action of ["pause", "resume", "cancel"] as const) {
    app.post(`/api/v1/goals/:id/${action}`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const fn = action === "pause" ? goalService.pauseGoal : action === "resume" ? goalService.resumeGoal : goalService.cancelGoal;
      const goal = await fn(rc(req), id);
      if (goal === null) {
        void reply.status(404);
        throw AppError.notFound(`goal not found: ${id}`);
      }
      return { goal };
    });
  }

  app.post("/api/v1/goals/:id/plans", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposePlanRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid plan payload", { issues: parsed.error.issues });
    }
    const plan = await planService.proposePlan(rc(req), id, parsed.data);
    void reply.status(201);
    return { plan };
  });
  app.get("/api/v1/goals/:id/plans", async (req) => {
    const { id } = req.params as { id: string };
    return { plans: await planService.listPlans(rc(req), id) };
  });
  app.get("/api/v1/plans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await planService.getPlan(rc(req), id);
    if (plan === null) {
      void reply.status(404);
      throw AppError.notFound(`plan not found: ${id}`);
    }
    return { plan };
  });
  app.post("/api/v1/plans/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    const result = await planService.acceptPlan(rc(req), id);
    return { plan: result.plan, task_ids: result.task_ids };
  });
  app.post("/api/v1/plans/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const plan = await planService.rejectPlan(rc(req), id);
    if (plan === null) {
      void reply.status(404);
      throw AppError.notFound(`plan not found: ${id}`);
    }
    return { plan };
  });

  // Revoke a device: both its credentials flip to revoked AND every live socket
  // (node + control) it holds is closed — revocation is immediate, not just a
  // future-reconnect rejection.
  app.post("/api/v1/devices/:id/revoke", async (req) => {
    const { id } = req.params as { id: string };
    const result = await deviceService.revokeDevice(rc(req), id);
    const closed = deviceConnections.closeForDevice(id, 1008, "device revoked");
    // Emit the offline transition ONLY when the revoke actually closed a live
    // socket. If the device was already disconnected, the last-disconnect edge
    // already emitted offline — gating on `closed > 0` prevents a double-emit.
    if (result.revoked && closed > 0) {
      void presenceService.markDeviceOffline(rc(req), id, "revoked").catch(() => {});
    }
    return { device_id: result.deviceId, revoked: result.revoked, connections_closed: closed };
  });

  app.post("/api/v1/tasks", async (req, reply) => {
    const parsed = CreateTaskRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid task payload", { issues: parsed.error.issues });
    }
    const result = await taskService.createTask(rc(req), parsed.data);
    void reply.status(201);
    return result;
  });

  app.get("/api/v1/tasks", async (req) => {
    const query = req.query as { project_id?: string };
    if (query.project_id === undefined || query.project_id === "") {
      throw AppError.validation("project_id query parameter is required");
    }
    return { tasks: await taskService.listTasks(rc(req), query.project_id) };
  });

  app.get("/api/v1/tasks/:id", async (req) => {
    const { id } = req.params as { id: string };
    return taskService.getTaskSnapshot(rc(req), id);
  });

  app.get("/api/v1/tasks/:id/audit-bundle", async (req) => {
    const { id } = req.params as { id: string };
    return { bundle: await auditService.getTaskAuditBundle(rc(req), id) };
  });

  app.get("/api/v1/tasks/:id/audit-bundle/export", async (req) => {
    const { id } = req.params as { id: string };
    return { export: await auditService.exportTaskAuditBundle(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/dependencies", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = CreateDependencyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid dependency payload", { issues: parsed.error.issues });
    }
    const dependency = await dagService.createDependency(rc(req), id, parsed.data);
    void reply.status(201);
    return { dependency };
  });

  app.get("/api/v1/tasks/:id/dependencies", async (req) => {
    const { id } = req.params as { id: string };
    return { dependencies: await dagService.listDependencies(rc(req), id) };
  });

  app.delete("/api/v1/tasks/:id/dependencies/:dependencyId", async (req, reply) => {
    const { id, dependencyId } = req.params as { id: string; dependencyId: string };
    await dagService.deleteDependency(rc(req), id, dependencyId);
    void reply.status(204);
    return null;
  });

  app.get("/api/v1/tasks/:id/dag", async (req) => {
    const { id } = req.params as { id: string };
    return { dag: await dagService.getDag(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/ready", async (req) => {
    const { id } = req.params as { id: string };
    return { task: await lifecycle.markReady(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/assign", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = AssignRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid assign payload", { issues: parsed.error.issues });
    }
    return lifecycle.assignTask(rc(req), id, parsed.data);
  });

  app.post("/api/v1/tasks/:id/retry", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = RetryRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid retry payload", { issues: parsed.error.issues });
    }
    return { task: await lifecycle.retryTask(rc(req), id) };
  });

  app.post("/api/v1/tasks/:id/review", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ReviewRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid review payload", { issues: parsed.error.issues });
    }
    // base_version (#27 v2-B slice 2) is an optional optimistic-concurrency hint
    // carried alongside the command body, not part of the domain ReviewRequest.
    return { task: await lifecycle.reviewTask(rc(req), id, parsed.data, readBaseVersion(req.body)) };
  });

  // Dev-only: simulate a node/adapter executing a queued run end to end.
  app.post("/api/v1/dev/runs/:id/mock-execute", async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { outcome?: "completed" | "failed" };
    return runService.mockExecuteRun(rc(req), id, query.outcome === "failed" ? "failed" : "completed");
  });

  app.get("/api/v1/rooms/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    return { messages: await messageService.listMessages(rc(req), id) };
  });

  app.post("/api/v1/rooms/:id/messages", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = SendMessageRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid message payload", { issues: parsed.error.issues });
    }
    const message = await messageService.postMessage(rc(req), id, parsed.data);
    void reply.status(201);
    return { message };
  });

  app.get("/api/v1/runs/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { run: await runService.getRun(rc(req), id) };
  });

  // Runtime registry (#15 Part 2): the runtimes a computer last advertised via
  // heartbeat, with status + last_seen_at for the scheduler to filter (Part 3).
  app.get("/api/v1/computers/:id/runtimes", async (req) => {
    const { id } = req.params as { id: string };
    return { runtimes: await runtimeRegistry.listComputerRuntimes(rc(req), id) };
  });

  // Skill registry (#24): durable installs/read APIs over the v1alpha1 manifest contract.
  app.post("/api/v1/skills/install", async (req, reply) => {
    const parsed = InstallSkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid skill install payload", { issues: parsed.error.issues });
    }
    const skill = await skillService.installSkill(rc(req), parsed.data);
    void reply.status(201);
    return { skill };
  });

  app.get("/api/v1/skills", async (req) => {
    const q = req.query as { project_id?: string; enabled?: string };
    let enabled: boolean | undefined;
    if (q.enabled !== undefined && q.enabled !== "") {
      if (q.enabled !== "true" && q.enabled !== "false") {
        throw AppError.validation("enabled filter must be 'true' or 'false'", { enabled: q.enabled });
      }
      enabled = q.enabled === "true";
    }
    return {
      skills: await skillService.listSkillInstalls(rc(req), {
        projectId: q.project_id,
        enabled,
      }),
    };
  });

  app.get("/api/v1/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { skill: await skillService.getSkillInstall(rc(req), id) };
  });

  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    return { run: await runService.cancelRun(rc(req), id) };
  });

  app.get("/api/v1/approvals", async (req) => {
    const { status } = req.query as { status?: string };
    return { approvals: await approvalService.listApprovals(rc(req), status) };
  });

  app.post("/api/v1/approvals/:id/resolve", async (req) => {
    const { id } = req.params as { id: string };
    const parsed = ResolveApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid approval resolution payload", {
        issues: parsed.error.issues,
      });
    }
    return { approval: await approvalService.resolveApproval(rc(req), id, parsed.data) };
  });

  // Concurrency control (#12): file leases over workspace paths.
  app.post("/api/v1/leases", async (req, reply) => {
    const parsed = AcquireLeaseRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid lease payload", { issues: parsed.error.issues });
    }
    const lease = await leaseService.acquireLease(rc(req), parsed.data);
    void reply.status(201);
    return { lease };
  });

  app.delete("/api/v1/leases/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { lease: await leaseService.releaseLease(rc(req), id) };
  });

  app.get("/api/v1/projects/:id/leases", async (req) => {
    const { id } = req.params as { id: string };
    const { status } = req.query as { status?: string };
    if (status !== undefined && status !== "") {
      const parsed = LeaseStatusSchema.safeParse(status);
      if (!parsed.success) {
        throw AppError.validation("invalid lease status filter", { status });
      }
      return { leases: await leaseService.listLeases(rc(req), id, parsed.data) };
    }
    return { leases: await leaseService.listLeases(rc(req), id) };
  });

  // Memory (#14 Phase B): propose/curate memories + accepted-only retrieval.
  app.post("/api/v1/memories", async (req, reply) => {
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory payload", { issues: parsed.error.issues });
    }
    const memory = await memoryService.proposeMemory(rc(req), parsed.data);
    void reply.status(201);
    return { memory };
  });

  app.get("/api/v1/memories", async (req) => {
    const q = req.query as {
      scope?: string;
      status?: string;
      project_id?: string;
      task_id?: string;
      tag?: string;
    };
    if (q.scope !== undefined && q.scope !== "") {
      const parsed = MemoryScopeSchema.safeParse(q.scope);
      if (!parsed.success) {
        throw AppError.validation("invalid memory scope filter", { scope: q.scope });
      }
    }
    if (q.status !== undefined && q.status !== "") {
      const parsed = MemoryStatusSchema.safeParse(q.status);
      if (!parsed.success) {
        throw AppError.validation("invalid memory status filter", { status: q.status });
      }
    }
    return {
      memories: await memoryService.listMemories(rc(req), {
        scope: q.scope,
        status: q.status,
        projectId: q.project_id,
        taskId: q.task_id,
        tag: q.tag,
      }),
    };
  });

  // Static `/context` is matched ahead of the `/:id` param route by Fastify.
  app.get("/api/v1/memories/context", async (req) => {
    const q = req.query as { project_id?: string; task_id?: string; limit?: string };
    let limit: number | undefined;
    if (q.limit !== undefined && q.limit !== "") {
      limit = Number(q.limit);
      if (!Number.isInteger(limit) || limit < 0) {
        throw AppError.validation("limit must be a non-negative integer", { limit: q.limit });
      }
    }
    return memoryService.selectForContext(
      rc(req),
      { projectId: q.project_id, taskId: q.task_id },
      limit,
    );
  });

  app.get("/api/v1/memories/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { memory: await memoryService.getMemory(rc(req), id) };
  });

  app.post("/api/v1/memories/:id/supersede", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProposeMemoryRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid memory replacement payload", { issues: parsed.error.issues });
    }
    const result = await memoryService.supersedeMemory(rc(req), id, parsed.data);
    void reply.status(201);
    return result;
  });

  app.post("/api/v1/memories/:id/:action", async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    if (action !== "accept" && action !== "reject") {
      throw AppError.validation(`unknown memory action: ${action}`, { action });
    }
    const parsed = MemoryTransitionRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw AppError.validation("invalid memory transition payload", { issues: parsed.error.issues });
    }
    const memory = await memoryService.transitionMemory(rc(req), id, action as MemoryTrigger, parsed.data);
    return { memory };
  });

  // Dev-only: the platform requesting a high-risk action approval on a running task.
  app.post("/api/v1/dev/tasks/:id/request-approval", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      action?: string;
      risk?: "low" | "medium" | "high";
      summary?: string;
      run_id?: string;
    };
    const approval = await approvalService.requestApproval(rc(req), {
      taskId: id,
      runId: body.run_id ?? null,
      action: body.action ?? "git.push",
      risk: body.risk ?? "high",
      summary: body.summary ?? "Push branch to remote",
    });
    void reply.status(201);
    return { approval };
  });

  // Static web SPA last: the API/auth/WS routes above are matched first; this only
  // adds file serving + an SPA navigation fallback (no-op when no built dist).
  registerWebStatic(app, options.webDistDir);

  return app;
}

function registerDesktopCors(app: FastifyInstance, options: DesktopCorsOptions): void {
  const allowedOrigins = new Set(options.allowedOrigins);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/v1/") && !path.startsWith("/auth/")) {
      return;
    }
    const origin = firstHeader(req.headers.origin);
    const allowedOrigin = origin === undefined ? undefined : allowDesktopOrigin(origin, allowedOrigins);
    if (allowedOrigin === undefined) {
      return;
    }

    reply.header("Access-Control-Allow-Origin", allowedOrigin);
    reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    reply.header(
      "Access-Control-Allow-Headers",
      firstHeader(req.headers["access-control-request-headers"]) ??
        "Accept, Content-Type, Idempotency-Key",
    );
    reply.header("Access-Control-Max-Age", "600");
    reply.header("Vary", "Origin");

    if (req.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function allowDesktopOrigin(origin: string, allowedOrigins: Set<string>): string | undefined {
  if (allowedOrigins.has("*")) {
    return "*";
  }
  return allowedOrigins.has(origin) ? origin : undefined;
}

/**
 * Read the optional `base_version` optimistic-concurrency hint from a command
 * body (#27 v2-B slice 2). Returns the value when it is a non-negative integer,
 * `undefined` when absent (no OCC check), and rejects a present-but-malformed
 * value so a client cannot silently bypass concurrency control with garbage.
 */
function readBaseVersion(body: unknown): number | undefined {
  if (body === null || typeof body !== "object" || !("base_version" in body)) {
    return undefined;
  }
  const value = (body as { base_version?: unknown }).base_version;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw AppError.validation("base_version must be a non-negative integer", { base_version: value });
  }
  return value;
}

/** Pairing code lifetime (#28 4b): short and single-use. */
const DEVICE_PAIRING_TTL_MS = 10 * 60 * 1000;

/** Rate-limit key for a claim attempt: the request source IP (fallback "unknown"). */
function claimSource(req: FastifyRequest): string {
  return req.ip && req.ip !== "" ? req.ip : "unknown";
}

/** Parse a required device platform from a command body, rejecting unknown values. */
function requireDevicePlatform(value: string): DevicePlatform {
  const parsed = DevicePlatformSchema.safeParse(value);
  if (!parsed.success) {
    throw AppError.validation(`unsupported device platform: ${value}`, { platform: value });
  }
  return parsed.data;
}

/** Parse an optional intended platform: undefined/null/empty -> null (any). */
function readDevicePlatform(value: unknown): DevicePlatform | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw AppError.validation("intended_platform must be a string", { intended_platform: value });
  }
  return requireDevicePlatform(value);
}
