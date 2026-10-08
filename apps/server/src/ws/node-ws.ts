import { computers } from "@artoo/db";
import { randomUUID } from "node:crypto";
import type { NodeHello, NodeToServerMessage, NodeTransport } from "@artoo/protocol";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerContext } from "../context.js";
import { attachNodeBinding, type NodeBinding } from "../node-binding.js";
import { resolveNodeToken } from "../services/device-service.js";
import { QUALIFIED_RECEIPT_PROFILE, requireQualifiedReceiptSchema } from "../services/run-event-receipt.js";
import { recordDeviceActivity } from "../services/presence-service.js";
import { activeRunIdsForComputer, activeSnapshotRunIdsForComputer, unconfirmedProcessRunIdsForComputer } from "../services/run-service.js";
import { recordHeartbeatRuntimes } from "../services/runtime-registry-service.js";
import type { GraceWindowManager } from "./grace-window.js";
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
  app: FastifyInstance, ctx: ServerContext, registry: NodeRegistry,
  deviceConnections?: DeviceConnectionRegistry, graceWindow?: GraceWindowManager,
): void {
  const disconnectSnapshots = new Map<string, Promise<string[]>>();
  app.get("/api/v1/node", { websocket: true }, (socket: unknown, req: FastifyRequest) => {
    const raw = socket as RawServerSocket;
    const token = (req.query as { token?: string }).token;
    const transport = createServerNodeTransport(raw);
    let binding: NodeBinding | undefined, nodeId: string | undefined, auth: NodeAuth | undefined;
    let terminated = false, registered = false, managedRequested = false;
    let releaseDeviceConn: (() => void) | undefined;
    let initializationTimer: ReturnType<typeof setTimeout> | undefined;
    let initializationDeadline: number | undefined;
    let managed: { id: string; nonce: string; active: boolean; firstPongPending: boolean } | undefined;
    const earlyQueue: NodeToServerMessage[] = [];
    const close = (code: number, reason: string): void => {
      if (terminated) return;
      terminated = true; clearTimeout(initializationTimer); earlyQueue.length = 0;
      raw.close(code, reason);
    };
    function armManagedInitialization(): void {
      if (initializationTimer !== undefined) return;
      initializationDeadline = performance.now() + 10000;
      initializationTimer = setTimeout(() => close(1008, "managed session initialization expired"), 10000);
    }
    function activate(): void {
      if (terminated || registered || !binding || !nodeId || !auth) return;
      if (managedRequested && !managed?.active) return;
      if (managedRequested && (raw.readyState !== 1 || initializationDeadline === undefined || performance.now() >= initializationDeadline)) {
        close(1008, "managed session closed or initialization expired before activation"); return;
      }
      registered = true; clearTimeout(initializationTimer);
      registry.register(nodeId, binding);
      void setComputerOnline(ctx, nodeId);
      if (auth.mode === "device") void recordDeviceActivity(ctx, auth.deviceId, "node").catch(() => {});
      const resumeSnapshot = graceWindow?.disarm(nodeId) ?? [];
      const pendingSnapshot = disconnectSnapshots.get(nodeId);
      disconnectSnapshots.delete(nodeId);
      const resumeNodeId = nodeId, resumeBinding = binding;
      void (async () => {
        const captured = pendingSnapshot === undefined ? [] : await pendingSnapshot;
        const active = await activeSnapshotRunIdsForComputer(ctx, resumeNodeId, [...new Set([...resumeSnapshot, ...captured])]);
        const uncertain = await unconfirmedProcessRunIdsForComputer(ctx, resumeNodeId);
        for (const runId of [...new Set([...active, ...uncertain])]) {
          if (registry.get(resumeNodeId) !== resumeBinding || terminated) break;
          await resumeBinding.dispatchRunResume(runId).catch(() => {});
        }
      })().catch(() => {});
    }
    function attach(features: readonly string[] | undefined, gated: boolean): void {
      const privateTransport: NodeTransport = gated ? {
        send: (message) => transport.send(message), close: () => transport.close(),
        subscribe: (handler) => transport.subscribe((message) => {
          if (terminated) return;
          if (message.kind !== "run.event" && message.kind !== "command.ack") return;
          if (!registered || !managed?.active || registry.get(nodeId!) !== binding) {
            close(1008, "managed application frame before current session activation"); return;
          }
          handler(message);
        }),
      } : transport;
      const computerId = nodeId!;
      binding = attachNodeBinding(ctx, privateTransport, computerId, features,
        () => !terminated && registered && registry.get(computerId) === binding && (!gated || managed?.active === true));
    }
    async function initializeManaged(message: NodeHello): Promise<void> {
      const request = message.managed_receipts!;
      if (request.version !== 1 || request.required_contract !== QUALIFIED_RECEIPT_PROFILE) {
        close(1008, "unsupported managed receipt request"); return;
      }
      try {
        await requireQualifiedReceiptSchema(ctx);
        if (terminated) return;
        if (raw.readyState !== 1 || initializationDeadline === undefined || performance.now() >= initializationDeadline) {
          close(1008, "managed session closed or initialization expired"); return;
        }
        managed = { id: randomUUID(), nonce: request.nonce, active: false, firstPongPending: false };
        attach(message.execution_features, true);
        await transport.send({ kind: "command", id: `session:${managed.id}`, idempotency_key: `session:${managed.id}`,
          type: "node.session.ready", payload: { version: 1, node_id: nodeId!, hello_nonce: managed.nonce,
            session_id: managed.id, receipt_contract: QUALIFIED_RECEIPT_PROFILE, sequence_max: 2147483647,
            liveness: { probe_interval_ms: 10000, probe_timeout_ms: 10000 } } });
        // Registration deliberately waits for the first authenticated probe/pong.
      } catch { close(1008, "managed receipt session initialization failed"); }
    }
    const handleMessage = (message: NodeToServerMessage): void => {
      const currentAuth = auth;
      if (terminated || currentAuth === undefined) return;
      if (nodeId === undefined && message.kind !== "node.hello") { close(1008, "node.hello required"); return; }
      if (message.kind === "node.hello") {
        if (nodeId !== undefined) return;
        const computerId = helloComputerId(currentAuth, message.node_id);
        if (computerId === null) { close(1008, "node.hello node_id does not match credential"); return; }
        nodeId = computerId;
        managedRequested = message.managed_receipts !== undefined;
        if (managedRequested) { armManagedInitialization(); void initializeManaged(message); }
        else { attach(message.execution_features, false); activate(); }
        return;
      }
      if (message.kind === "node.session.probe") {
        const session = managed;
        if (!managedRequested || !session || message.node_id !== nodeId || message.session_id !== session.id
          || (registered && registry.get(nodeId!) !== binding)) { close(1008, "managed probe session mismatch"); return; }
        if (!session.active && session.firstPongPending) return;
        if (!session.active) session.firstPongPending = true;
        void transport.send({ kind: "command", id: `pong:${session.id}:${message.probe_id}`,
          idempotency_key: `pong:${session.id}:${message.probe_id}`, type: "node.session.pong",
          payload: { node_id: nodeId!, session_id: session.id, probe_id: message.probe_id } }).then(() => {
          if (terminated || managed !== session) return;
          if (raw.readyState !== 1 || (!registered && (initializationDeadline === undefined || performance.now() >= initializationDeadline))) {
            close(1008, "managed pong completed after closing or initialization expiry"); return;
          }
          session.active = true; activate();
        }, () => close(1008, "managed pong write failed"));
        return;
      }
      if (managedRequested && (!managed?.active || !registered || registry.get(nodeId!) !== binding)) {
        close(1008, "managed application frame before current session activation"); return;
      }
      if (message.kind === "node.heartbeat") {
        void touchHeartbeat(ctx, nodeId!);
        void recordHeartbeatRuntimes(ctx, nodeId!, message.runtimes).catch(() => {});
        if (currentAuth.mode === "device") void recordDeviceActivity(ctx, currentAuth.deviceId, "node").catch(() => {});
      }
    };
    const MAX_PREAUTH_FRAMES = 16;
    let dispatch: (message: NodeToServerMessage) => void = (message) => {
      if (terminated) return;
      if (message.kind === "node.hello" && message.managed_receipts !== undefined) armManagedInitialization();
      earlyQueue.push(message);
      if (earlyQueue.length > MAX_PREAUTH_FRAMES) { earlyQueue.length = 0; close(1008, "too many frames before authentication"); }
    };
    const unsubscribe = transport.subscribe((message) => dispatch(message));
    void (async () => {
      let result: NodeAuth | null;
      try { result = await authenticateNodeToken(ctx, token); }
      catch { earlyQueue.length = 0; close(1008, "node authentication error"); return; }
      if (result === null) { earlyQueue.length = 0; close(1008, "invalid node credential"); return; }
      if (terminated) { earlyQueue.length = 0; return; }
      auth = result;
      if (result.mode === "device" && deviceConnections !== undefined) releaseDeviceConn = deviceConnections.add(result.deviceId, { close });
      dispatch = handleMessage;
      for (const queued of earlyQueue) {
        if (terminated) break;
        handleMessage(queued);
        // Only legacy replay may precede async auth completion. Managed peers
        // have no business-frame authority until ready plus the first pong.
        if (!managedRequested && (queued.kind === "run.event" || queued.kind === "command.ack")) binding?.receive(queued);
      }
      earlyQueue.length = 0;
    })();
    raw.on("close", () => {
      terminated = true; clearTimeout(initializationTimer); earlyQueue.length = 0;
      releaseDeviceConn?.(); unsubscribe(); binding?.close();
      // A failed private handshake must never unregister another live binding.
      if (registered && nodeId !== undefined && binding !== undefined && registry.unregister(nodeId, binding)) {
        void setComputerOffline(ctx, nodeId);
        if (graceWindow !== undefined) {
          const closedNodeId = nodeId, capture = activeRunIdsForComputer(ctx, closedNodeId);
          disconnectSnapshots.set(closedNodeId, capture);
          void (async () => {
            const snapshot = await capture;
            if (disconnectSnapshots.get(closedNodeId) !== capture) return;
            disconnectSnapshots.delete(closedNodeId);
            if (registry.get(closedNodeId) === undefined) graceWindow.arm(closedNodeId, snapshot);
          })().catch(() => {});
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
