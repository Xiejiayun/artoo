import { computers } from "@artoo/db";
import type { NodeToServerMessage } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerContext } from "../context.js";
import { attachNodeBinding, type NodeBinding } from "../node-binding.js";
import { resolveNodeToken } from "../services/device-service.js";
import { recordDeviceActivity } from "../services/presence-service.js";
import { recordHeartbeatRuntimes } from "../services/runtime-registry-service.js";
import type { NodeRegistry } from "./node-registry.js";
import type { DeviceConnectionRegistry } from "./device-connections.js";
import { createServerNodeTransport, type RawServerSocket } from "./ws-node-transport.js";

/** Authenticated identity of a `/api/v1/node` connection (#28 slice 3a). */
type NodeAuth = { mode: "dev" } | { mode: "device"; deviceId: string; computerId: string };

/**
 * Authenticate a node connection's `?token=`. Returns:
 *  - `{mode:"dev"}` when the legacy escape is enabled (non-production + explicit
 *    flag) and the token matches — preserving the v1 `node.hello` -> computer
 *    mapping;
 *  - `{mode:"device"}` when a real device node token resolves to a device that is
 *    LINKED to a computer;
 *  - `null` otherwise, INCLUDING an unlinked device token (`computerId === null`),
 *    which fails closed until the device<->computer enrollment slice exists. This
 *    is what prevents a production node token from binding an arbitrary computer.
 */
async function authenticateNodeToken(
  ctx: ServerContext,
  token: string | undefined,
): Promise<NodeAuth | null> {
  if (token === undefined || token === "") {
    return null;
  }
  const { devNodeToken } = ctx.deviceAuth;
  if (devNodeToken !== null && token === devNodeToken) {
    return { mode: "dev" };
  }
  const resolved = await resolveNodeToken(ctx, token);
  if (resolved === null || resolved.computerId === null) {
    return null;
  }
  return { mode: "device", deviceId: resolved.deviceId, computerId: resolved.computerId };
}

/**
 * The computer id a node.hello may register, or null to reject. The dev escape
 * trusts hello's node_id (v1). A device connection must present a node_id equal
 * to its credential's linked computer.
 */
function helloComputerId(auth: NodeAuth, helloNodeId: string): string | null {
  if (auth.mode === "dev") {
    return helloNodeId;
  }
  return helloNodeId === auth.computerId ? auth.computerId : null;
}

/**
 * Register the node protocol WebSocket endpoint `ws /api/v1/node`. The `?token=`
 * is authenticated (#28 slice 3a): a valid dev escape or a computer-linked device
 * node token, else the connection is closed. Because authentication is async, the
 * transport (and its socket 'message' listener) is attached synchronously and
 * early frames are queued, then drained once auth resolves. `node.hello` must be
 * the first app frame and its node_id must be consistent with the credential.
 */
export function registerNodeWsRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: NodeRegistry,
  deviceConnections?: DeviceConnectionRegistry,
): void {
  app.get("/api/v1/node", { websocket: true }, (socket: unknown, req: FastifyRequest) => {
    const raw = socket as RawServerSocket;
    const token = (req.query as { token?: string }).token;

    const transport = createServerNodeTransport(raw);
    let binding: NodeBinding | undefined;
    let nodeId: string | undefined;
    let auth: NodeAuth | undefined;
    let terminated = false;
    let releaseDeviceConn: (() => void) | undefined;
    const earlyQueue: NodeToServerMessage[] = [];

    const close = (code: number, reason: string): void => {
      if (terminated) {
        return;
      }
      terminated = true;
      raw.close(code, reason);
    };

    const handleMessage = (message: NodeToServerMessage): void => {
      const currentAuth = auth;
      if (terminated || currentAuth === undefined) {
        return;
      }
      if (nodeId === undefined && message.kind !== "node.hello") {
        close(1008, "node.hello required");
        return;
      }
      if (message.kind === "node.hello") {
        if (nodeId !== undefined) {
          return; // already registered; ignore duplicate hello
        }
        const computerId = helloComputerId(currentAuth, message.node_id);
        if (computerId === null) {
          close(1008, "node.hello node_id does not match credential");
          return;
        }
        nodeId = computerId;
        void setComputerOnline(ctx, nodeId);
        // Device-level presence (#28 4c): an accepted authenticated device node
        // connection is device activity. Dev-escape nodes carry no device identity.
        if (currentAuth.mode === "device") {
          void recordDeviceActivity(ctx, currentAuth.deviceId, "node").catch(() => {});
        }
        binding = attachNodeBinding(ctx, transport);
        registry.register(nodeId, binding);
      } else if (message.kind === "node.heartbeat") {
        const sessionNodeId = nodeId;
        if (sessionNodeId === undefined) {
          close(1008, "node.hello required");
          return;
        }
        // Persist advertised runtime capabilities (#15 Part 2). Best-effort: a db
        // hiccup must not tear down the node connection. The accepted hello's
        // nodeId is the session/computer key; heartbeat node_id is not trusted.
        void touchHeartbeat(ctx, sessionNodeId);
        void recordHeartbeatRuntimes(ctx, sessionNodeId, message.runtimes).catch(() => {});
        // Device presence refresh (#28 4c) — throttled inside the service so a
        // heartbeat cadence does not become a write/event storm.
        if (currentAuth.mode === "device") {
          void recordDeviceActivity(ctx, currentAuth.deviceId, "node").catch(() => {});
        }
      }
      // command.ack / run.event are consumed by the binding's own subscription.
    };

    // Queue frames until auth resolves, then dispatch live. The queue is bounded:
    // an unauthenticated peer cannot make us buffer without limit (a legitimate
    // node sends only node.hello before auth completes).
    const MAX_PREAUTH_FRAMES = 16;
    let dispatch: (message: NodeToServerMessage) => void = (message) => {
      if (terminated) {
        return;
      }
      earlyQueue.push(message);
      if (earlyQueue.length > MAX_PREAUTH_FRAMES) {
        earlyQueue.length = 0;
        close(1008, "too many frames before authentication");
      }
    };
    const unsubscribe = transport.subscribe((message) => {
      dispatch(message);
    });

    void (async () => {
      let result: NodeAuth | null;
      try {
        result = await authenticateNodeToken(ctx, token);
      } catch {
        // A failing auth path (e.g. db error) must close, not leave an
        // unauthenticated socket open with a growing queue.
        earlyQueue.length = 0;
        close(1008, "node authentication error");
        return;
      }
      if (result === null) {
        earlyQueue.length = 0;
        close(1008, "invalid node credential");
        return;
      }
      if (terminated) {
        earlyQueue.length = 0;
        return; // socket already closed during auth (e.g. queue overflow)
      }
      auth = result;
      // Index this live socket by device id so a device revoke can close it
      // (not only reject a future reconnect). Dev-escape connections carry no
      // device identity and are not indexed.
      if (result.mode === "device" && deviceConnections !== undefined) {
        releaseDeviceConn = deviceConnections.add(result.deviceId, {
          close: (code, reason) => close(code, reason),
        });
      }
      dispatch = handleMessage;
      for (const queued of earlyQueue) {
        if (terminated) {
          break;
        }
        handleMessage(queued);
      }
      earlyQueue.length = 0;
    })();

    raw.on("close", () => {
      terminated = true;
      releaseDeviceConn?.();
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
