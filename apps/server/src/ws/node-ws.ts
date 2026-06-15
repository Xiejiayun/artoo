import { computers } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerContext } from "../context.js";
import { attachNodeBinding, type NodeBinding } from "../node-binding.js";
import { recordHeartbeatRuntimes } from "../services/runtime-registry-service.js";
import type { NodeRegistry } from "./node-registry.js";
import { createServerNodeTransport, type RawServerSocket } from "./ws-node-transport.js";

/**
 * Register the node protocol WebSocket endpoint `ws /api/v1/node` (WS wire format
 * v0.1). Missing/empty token rejects the connection. `node.hello` must be the
 * first app frame; only after it is accepted does the server register the
 * transport (so no run.start can be dispatched to a node that hasn't said hello).
 */
export function registerNodeWsRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: NodeRegistry,
): void {
  app.get("/api/v1/node", { websocket: true }, (socket: unknown, req: FastifyRequest) => {
    const raw = socket as RawServerSocket;
    const token = (req.query as { token?: string }).token;
    if (token === undefined || token === "") {
      raw.close(1008, "missing node token");
      return;
    }

    const transport = createServerNodeTransport(raw);
    let binding: NodeBinding | undefined;
    let nodeId: string | undefined;

    const unsubscribe = transport.subscribe((message) => {
      if (nodeId === undefined && message.kind !== "node.hello") {
        raw.close(1008, "node.hello required");
        return;
      }
      if (message.kind === "node.hello") {
        if (nodeId !== undefined) {
          return; // already registered; ignore duplicate hello
        }
        nodeId = message.node_id;
        void setComputerOnline(ctx, nodeId);
        binding = attachNodeBinding(ctx, transport);
        registry.register(nodeId, binding);
      } else if (message.kind === "node.heartbeat") {
        const sessionNodeId = nodeId;
        if (sessionNodeId === undefined) {
          raw.close(1008, "node.hello required");
          return;
        }
        void touchHeartbeat(ctx, sessionNodeId);
        // Persist advertised runtime capabilities (#15 Part 2). Best-effort: a db
        // hiccup must not tear down the node connection. The accepted hello's
        // nodeId is the session/computer key; heartbeat node_id is not trusted.
        void recordHeartbeatRuntimes(ctx, sessionNodeId, message.runtimes).catch(() => {});
      }
      // command.ack / run.event are consumed by the binding's own subscription.
    });

    raw.on("close", () => {
      unsubscribe();
      binding?.close();
      if (nodeId !== undefined) {
        const removedCurrent = registry.unregister(nodeId, binding);
        if (removedCurrent) {
          void setComputerOffline(ctx, nodeId);
        }
      }
    });
  });
}

// Presence updates are best-effort: a closing/unavailable db must never crash the
// connection lifecycle, so failures are swallowed.
async function setComputerOnline(ctx: ServerContext, nodeId: string): Promise<void> {
  await updatePresence(ctx, nodeId, { status: "online", lastHeartbeatAt: ctx.clock.nowIso() });
}

async function touchHeartbeat(ctx: ServerContext, nodeId: string): Promise<void> {
  await updatePresence(ctx, nodeId, { lastHeartbeatAt: ctx.clock.nowIso() });
}

async function setComputerOffline(ctx: ServerContext, nodeId: string): Promise<void> {
  await updatePresence(ctx, nodeId, { status: "offline" });
}

async function updatePresence(
  ctx: ServerContext,
  nodeId: string,
  patch: Partial<{ status: string; lastHeartbeatAt: string }>,
): Promise<void> {
  try {
    await ctx.db.db
      .update(computers)
      .set(patch)
      .where(and(eq(computers.id, nodeId), eq(computers.organizationId, ctx.organizationId)));
  } catch {
    // best-effort presence; ignore (e.g. db shutting down on disconnect)
  }
}
