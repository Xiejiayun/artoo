import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import {
  AgentHistoryEventsQuerySchema,
  AgentHistoryQuerySchema,
  SendMessageRequestSchema,
  apiError,
} from "@artoo/domain";

import { registerAiDataSharingRoutes } from "./ai-data-sharing-routes.js";
import { registerApplicationPublicationRoutes } from "./application-publication-routes.js";
import { registerApprovalAndLeaseRoutes, registerDevelopmentApprovalRoutes } from "./approval-routes.js";
import { registerArtifactRoutes } from "./artifact-routes.js";
import { registerAssistantRoutes } from "./assistant-routes.js";
import { registerApiAuthGuard, registerAuthRoutes, requestContext } from "./auth/auth-routes.js";
import { registerChannelRoutes } from "./channel-routes.js";
import { type ClaimLimiter, DEFAULT_CLAIM_LIMIT, createClaimLimiter } from "./claim-rate-limit.js";
import { registerCollaborationRoutes } from "./collaboration-routes.js";
import { type ArtifactStorageOptions, resolveArtifactStore } from "./content-addressed-blob.js";
import { registerContentModerationRoutes } from "./content-moderation-routes.js";
import type { ServerContext } from "./context.js";
import { registerDeviceRevocationRoutes, registerDeviceRoutes } from "./device-routes.js";
import { registerDiscussionRoutes } from "./discussion-routes.js";
import { AppError } from "./errors.js";
import { registerGoalAutomationRoutes } from "./goal-automation-routes.js";
import { registerGoalRoutes } from "./goal-routes.js";
import { registerIdempotency } from "./idempotency-middleware.js";
import { registerMemoryRoutes } from "./memory-routes.js";
import { wireNodeDispatch, wireRunDispatch } from "./node-dispatch-wiring.js";
import { registerProductReleaseRoutes } from "./product-release-routes.js";
import { registerProductSourceSemanticTransferRoutes } from "./product-source-semantic-transfer-routes.js";
import { registerProductSourceTransferRoutes } from "./product-source-transfer-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerResourceRoutes } from "./resource-routes.js";
import { getAgentHistoryRun, listAgentHistory } from "./services/agent-history-service.js";
import { startGoalBudgetMonitor } from "./services/budget-service.js";
import { listDaemons } from "./services/daemon-service.js";
import { recoverInterruptedRuns } from "./services/execution-recovery-service.js";
import * as messageService from "./services/message-service.js";
import * as presenceService from "./services/presence-service.js";
import * as runService from "./services/run-service.js";
import * as runtimeRegistry from "./services/runtime-registry-service.js";
import { createSourceLifecycleRegistry } from "./services/source-clean-lifecycle-service.js";
import * as syncService from "./services/sync-service.js";
import * as taskService from "./services/task-service.js";
import { registerSkillRoutes } from "./skill-routes.js";
import { registerTaskRoutes } from "./task-routes.js";
import { registerWebStatic } from "./web-static.js";
import { type ClientWsHooks, registerClientWsRoute } from "./ws/client-ws.js";
import { createDeviceConnectionRegistry } from "./ws/device-connections.js";
import { type GraceWindowManager, createGraceWindowManager } from "./ws/grace-window.js";
import { type NodeRegistry, createNodeRegistry } from "./ws/node-registry.js";
import { registerNodeWsRoute } from "./ws/node-ws.js";
import { registerSourceLifecycleWsRoute } from "./ws/source-lifecycle-ws.js";
import { type WsHub, createWsHub } from "./ws/ws-hub.js";

export interface BuildAppOptions extends ArtifactStorageOptions {
  assistantDispatcher?: boolean;
  /** Production startup invalidates stale persisted presence before listening. */
  resetPresenceOnStart?: boolean;
  /** Live elapsed-budget checks. Defaults to 1 second; false is for deterministic tests. */
  budgetMonitorIntervalMs?: number | false;
  /** Explicit local testing only. Disabled by default, including production. */
  enableDevRoutes?: boolean;
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
  /** Explicit reverse-proxy IPs. Omitted by default so direct clients cannot spoof their source. */
  trustedProxies?: string[];
  /** Allow packaged desktop renderers (file:// -> Origin: null) to call the API. */
  desktopCors?: DesktopCorsOptions;
  /** Inject a disconnect grace-window manager (#115 P2-S3) so tests can drive a
   *  controllable scheduler + short window. Defaults to a real-timer manager. */
  graceWindow?: GraceWindowManager;
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
  const artifactStore = resolveArtifactStore(options);
  const app = Fastify({ logger: false, trustProxy: options.trustedProxies?.length ? options.trustedProxies : false });
  if (options.budgetMonitorIntervalMs !== false) {
    let budgetMonitor: ReturnType<typeof startGoalBudgetMonitor> | undefined;
    app.addHook("onReady", async () => {
      budgetMonitor = startGoalBudgetMonitor(ctx, {
        intervalMs: options.budgetMonitorIntervalMs || 1000,
        onError: (error) => app.log.error(error, "goal budget monitor failed"),
      });
    });
    app.addHook("onClose", async () => {
      await budgetMonitor?.stop();
    });
  }
  const nodeRegistry = options.nodeRegistry ?? createNodeRegistry();
  const sourceLifecycle = createSourceLifecycleRegistry(ctx);
  ctx.sourceLifecycle = sourceLifecycle;
  app.addHook("onClose", async () => {
    sourceLifecycle.close();
  });
  wireNodeDispatch(ctx, nodeRegistry, options, artifactStore);
  registerProductReleaseRoutes(app, ctx, options.assistantDispatcher !== false);
  registerApplicationPublicationRoutes(app, ctx);
  // Recover from durable run rows before accepting new client/node connections.
  const graceWindow =
    options.graceWindow ??
    createGraceWindowManager({
      graceMs: NODE_DISCONNECT_GRACE_MS,
      onExpire: async (computerId, runIds) => {
        for (const runId of runIds) {
          await runService.failRunDaemonDisconnect(ctx, runId, computerId).catch(() => {});
        }
      },
    });
  app.addHook("onReady", async () => {
    await recoverInterruptedRuns(ctx, graceWindow, { resetPresence: options.resetPresenceOnStart ?? true });
  });
  app.addHook("onClose", async () => {
    graceWindow.close?.();
  });
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

  wireRunDispatch(ctx, nodeRegistry);

  void app.register(websocket, {
    options: { handleProtocols: (protocols) => (protocols.has("artoo") ? "artoo" : false) },
  });
  void app.register(async (instance) => {
    registerNodeWsRoute(instance, ctx, nodeRegistry, deviceConnections, graceWindow, artifactStore);
    registerSourceLifecycleWsRoute(instance, ctx, sourceLifecycle);
    registerClientWsRoute(instance, ctx, wsHub, options.clientWsHooks, deviceConnections);
  });

  if (options.desktopCors !== undefined) {
    registerDesktopCors(app, options.desktopCors);
  }

  // Google Auth (#34): the protected-API guard (opt-in via enforceApiAuth) and
  // the /auth/* routes.
  registerApiAuthGuard(app, ctx, ctx.authConfig);
  registerAuthRoutes(app, ctx, {
    config: ctx.authConfig,
    oidcHttp: ctx.oidcHttp,
    onControlLogout: (deviceId) => deviceConnections.closeForDevice(deviceId, 1008, "signed out", "control"),
  });

  // Per-request service context bound to the authenticated session user (when the
  // guard enforced auth); falls back to the base ctx otherwise. REST handlers use
  // `rc(req)` so services attribute to the logged-in user, never a shared actor.
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  const stopProcess = async (requestCtx: ServerContext, runId: string): Promise<void> => {
    const run = await runService.getRun(requestCtx, runId);
    const binding = nodeRegistry.get(run.computer_id);
    if (binding) return binding.dispatchRunStop(runId);
    if (options.enableDevRoutes === true && run.runtime_id === "mock") return;
    throw AppError.conflict("Execution computer is offline; process stop cannot be confirmed");
  };
  registerContentModerationRoutes(app, ctx, (id) => deviceConnections.closeForDevice(id, 1008, "member suspended"));
  registerAiDataSharingRoutes(app, ctx, stopProcess);
  registerAssistantRoutes(app, ctx, { enabled: options.assistantDispatcher, stopProcess });
  registerChannelRoutes(app, ctx);
  registerDiscussionRoutes(app, ctx, { enabled: options.assistantDispatcher, stopProcess });
  registerGoalAutomationRoutes(app, ctx, { enabled: options.assistantDispatcher, stopProcess });

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
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, raw, done) => {
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
  });

  // Credential-issuance routes return raw codes/tokens once and must never have
  // those bodies persisted by the idempotency store (#28 invariant) — exempt them.
  registerIdempotency(app, ctx, new Set(["/api/v1/devices/pairings", "/api/v1/devices/claim"]));

  app.get("/api/v1/bootstrap", async (req) =>
    taskService.bootstrap(rc(req), (id) => nodeRegistry.get(id) !== undefined),
  );
  registerProjectRoutes(app, ctx);
  registerResourceRoutes(app, ctx, (computerId, deviceIds) => {
    for (const id of deviceIds) deviceConnections.closeForDevice(id, 1008, "computer deleted");
    const binding = nodeRegistry.get(computerId);
    binding?.disconnect?.();
    binding?.close();
    nodeRegistry.unregister(computerId);
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      if (await ctx.db.healthCheck()) return { status: "ready" };
    } catch {
      /* A readiness response never exposes database details. */
    }
    return reply.status(503).send({ status: "unavailable" });
  });

  // #27 v2-B slice 2a — read cursor. Clients use this as the hydration/tail
  // baseline for WS since_cursor; command base_version comes from resource reads.
  app.get("/api/v1/sync/cursor", async (req) => ({ cursor: await syncService.currentCursor(rc(req)) }));

  registerDeviceRoutes(app, ctx, claimLimiter, deviceConnections);

  // Agent/computer presence (#113): server-synthesized read model. A computer's
  // live connection is its registered daemon node (nodeRegistry); the service
  // gathers the rest from runs/tasks/runtime/computer/device facts.
  const isLive = (computerId: string): boolean => nodeRegistry.get(computerId) !== undefined;
  app.get("/api/v1/daemons", async (req) => ({
    daemons: await listDaemons(
      rc(req),
      isLive,
      (id) => graceWindow.isArmed(id),
      (id) => nodeRegistry.get(id)?.workspaceRoots,
    ),
  }));
  app.get("/api/v1/agent-instances/presence", async (req) => ({
    presence: await presenceService.listAgentInstancePresence(rc(req), isLive),
  }));
  app.get("/api/v1/agents/:id/history", async (req) => {
    const parsed = AgentHistoryQuerySchema.safeParse(req.query);
    if (!parsed.success) throw AppError.validation("Invalid history query", { issues: parsed.error.issues });
    return listAgentHistory(rc(req), (req.params as { id: string }).id, parsed.data);
  });
  app.get("/api/v1/agents/:id/history/:runId", async (req) => {
    const parsed = AgentHistoryEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) throw AppError.validation("Invalid history events query", { issues: parsed.error.issues });
    const { id, runId } = req.params as { id: string; runId: string };
    return getAgentHistoryRun(rc(req), id, runId, parsed.data);
  });
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

  registerCollaborationRoutes(app, ctx);

  registerGoalRoutes(app, ctx, nodeRegistry, stopProcess);

  registerDeviceRevocationRoutes(app, ctx, deviceConnections);

  registerTaskRoutes(app, ctx);

  // Dev-only: simulate a node/adapter executing a queued run end to end.
  if (options.enableDevRoutes === true)
    app.post("/api/v1/dev/runs/:id/mock-execute", async (req) => {
      const { id } = req.params as { id: string };
      const query = req.query as { outcome?: "completed" | "failed" };
      return runService.mockExecuteRun(rc(req), id, query.outcome === "failed" ? "failed" : "completed");
    });

  app.get("/api/v1/rooms/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    return messageService.listMessagePage(
      rc(req),
      id,
      req.query as { limit?: string; before?: string; after?: string; thread_root_id?: string; q?: unknown },
    );
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
  app.get("/api/v1/runs/:id/usage", async (req) => ({
    usage: await runService.getRunUsage(rc(req), (req.params as { id: string }).id),
  }));

  // Runtime registry (#15 Part 2): the runtimes a computer last advertised via
  // heartbeat, with status + last_seen_at for the scheduler to filter (Part 3).
  app.get("/api/v1/computers/:id/runtimes", async (req) => {
    const { id } = req.params as { id: string };
    return { runtimes: await runtimeRegistry.listComputerRuntimes(rc(req), id) };
  });

  registerSkillRoutes(app, ctx);

  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const { id } = req.params as { id: string };
    const requestCtx = rc(req);
    return {
      run: await runService.cancelRun(requestCtx, id, async () => {
        const run = await runService.getRun(requestCtx, id);
        const binding = nodeRegistry.get(run.computer_id);
        if (binding) return binding.dispatchRunStop(id);
        // Explicit dev mocks have no external process to stop.
        if (options.enableDevRoutes === true && run.runtime_id === "mock") return;
        throw AppError.conflict(
          "execution computer is offline; cancellation cannot be confirmed and write leases remain active",
        );
      }),
    };
  });

  registerApprovalAndLeaseRoutes(app, ctx);

  registerMemoryRoutes(app, ctx);

  // Dev-only: the platform requesting a high-risk action approval on a running task.
  if (options.enableDevRoutes === true) registerDevelopmentApprovalRoutes(app, ctx);

  // Static web SPA last: the API/auth/WS routes above are matched first; this only
  if (artifactStore) {
    registerArtifactRoutes(app, ctx, artifactStore);
    registerProductSourceTransferRoutes(app, ctx, artifactStore);
    registerProductSourceSemanticTransferRoutes(app, ctx, artifactStore);
  }
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
      firstHeader(req.headers["access-control-request-headers"]) ?? "Accept, Content-Type, Idempotency-Key",
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

// #115 P2-S3: how long a disconnected node's active runs are protected before
// being failed with `daemon_disconnect`. In-memory (dogfood); see grace-window.ts.
const NODE_DISCONNECT_GRACE_MS = 30 * 1000;
