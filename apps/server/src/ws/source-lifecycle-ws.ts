import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { parseDeviceToken, SOURCE_LIFECYCLE_ROUTE_V1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { SourceLifecycleParentMessageV1Schema, encodeSourceLifecycleServerMessageV1,
  SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1,
  SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1, SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1,
  type SourceLifecycleServerMessageV1 } from "@artoo/protocol";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { resolveNodeToken } from "../services/device-service.js";
import type { SourceLifecycleRegistry } from "../services/source-clean-lifecycle-service.js";
import type { RawServerSocket } from "./ws-node-transport.js";

/** A lifecycle observer is neither an execution-node registration nor a fallback
 * for a disconnected daemon. Its one-use challenge exists only on this socket. */
export function registerSourceLifecycleWsRoute(app: FastifyInstance, ctx: ServerContext, registry: SourceLifecycleRegistry) {
  app.get(SOURCE_LIFECYCLE_ROUTE_V1, { websocket: true }, (socket: unknown, request: FastifyRequest) => {
    const raw = socket as RawServerSocket;
    let active = true, pending = 0, sequence = 0, replyBytes = 0;
    let wakePlannedWait: (() => void) | undefined;
    let observer: ReturnType<SourceLifecycleRegistry["open"]> | undefined;
    const replies = new Map<number, { requestId: string; exact: string; response: string }>();
    const requestIds = new Set<string>();
    function close() {
      if (!active) return;
      active = false; wakePlannedWait?.(); observer?.close(); replies.clear(); requestIds.clear(); raw.close(1008, "Source lifecycle unavailable");
    }
    raw.on("close", () => { active = false; wakePlannedWait?.(); observer?.close(); replies.clear(); requestIds.clear(); });
    async function send(encoded: string) {
      if (!active || raw.readyState !== 1) throw Error("Original lifecycle socket is closed");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Original lifecycle send expired")), 10000);
        try { raw.send(encoded, error => { clearTimeout(timer); error ? reject(error) : resolve(); }); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
    }
    async function awaitPlannedStop(secret: string, replyByteBudget: number) {
      const original = observer;
      if (!original) throw Error("Original observer unavailable");
      const deadline = performance.now() + 24 * 60 * 60 * 1000;
      while (active && raw.readyState === 1 && performance.now() < deadline) {
        // Only absence of an accepted H6 origin is retryable. Credential,
        // session, lineage and authorization errors terminate this request.
        if (await original.isReadyForPlannedStop(secret)) {
          if (!active || raw.readyState !== 1) throw Error("Original lifecycle socket is closed");
          return original.prepareStop(secret, replyByteBudget);
        }
        if (!active || raw.readyState !== 1) break;
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); if (wakePlannedWait === finish) wakePlannedWait = undefined; resolve(); };
          const timer = setTimeout(finish, Math.min(1000, Math.max(1, deadline - performance.now())));
          timer.unref(); wakePlannedWait = finish;
        });
      }
      if (!active || raw.readyState !== 1) throw Error("Original lifecycle socket is closed");
      throw AppError.conflict("Timed out waiting for an independently accepted H6 clean transition");
    }
    // Install the listener synchronously. An early frame queues behind this
    // exact authentication promise, never behind a later replacement socket.
    let chain = (async () => {
      const token = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : "";
      const resolved = await resolveNodeToken(ctx, token), parsed = parseDeviceToken(token);
      if (!active || !resolved?.computerId || !parsed) throw Error("Paired node credential required");
      observer = registry.open({ computerId: resolved.computerId, deviceId: resolved.deviceId, tokenLookup: parsed.lookup }, () => active && raw.readyState === 1);
      await send(encodeSourceLifecycleServerMessageV1({ ...observer.hello, type: "node.source-lifecycle.opened.v1" }));
    })().catch(close);
    raw.on("message", data => {
      if (!active || ++pending > 32) { close(); return; }
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.isBuffer(data) ? Buffer.from(data) : undefined;
      if (!bytes || bytes.length > SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1) { close(); return; }
      chain = chain.then(async () => {
        try {
          if (!active || !observer) throw Error("Original observer unavailable");
          const value = SourceLifecycleParentMessageV1Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
          if (value.observer_id !== observer.hello.observer_id) throw Error("Observer identity changed");
          const exact = canonical(value), prior = replies.get(value.sequence);
          if (prior) {
            if (prior.exact !== exact || prior.requestId !== value.request_id) throw Error("Changed lifecycle retransmission");
            await send(prior.response); return;
          }
          if (value.sequence !== sequence + 1 || requestIds.has(value.request_id) || replies.size >= 128)
            throw Error("Out-of-order lifecycle operation or exhausted original observer");
          // Exact retransmission above reuses the already charged string. Reserve
          // space before invoking any service, including small mutating controls.
          const remaining = SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1 - replyBytes;
          if (remaining < SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1)
            throw Error("Original lifecycle retained reply byte budget exhausted");
          const replyByteBudget = Math.min(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1, remaining);
          const reply = { version: 1 as const, observer_id: value.observer_id, request_id: value.request_id, sequence: value.sequence };
          let response: SourceLifecycleServerMessageV1;
          try {
            if (value.type === "node.source-lifecycle.bind.v1") response = { ...reply, type: "node.source-lifecycle.bound.v1",
              payload: await observer.bindLaunch(value.challenge, value.payload) };
            else if (value.type === "node.source-clean-stop.prepare.v1") response = { ...reply, type: "node.source-clean-stop.prepared.v1",
              payload: await observer.prepareStop(value.challenge, replyByteBudget) };
            else if (value.type === "node.source-clean-stop.await-prepare.v1") response = { ...reply, type: "node.source-clean-stop.prepared.v1",
              payload: await awaitPlannedStop(value.challenge, replyByteBudget) };
            else if (value.type === "node.source-clean-stop.commit.v1") response = { ...reply, type: "node.source-clean-stop.committed.v1",
              payload: await observer.commitStop(value.challenge, value.payload) };
            else response = { ...reply, type: "node.source-clean-restart.claimed.v1", payload: await observer.claimRestart(value.challenge, value.payload.stop_id, replyByteBudget) };
          } catch (error) {
            response = { ...reply, type: "node.source-lifecycle.error.v1", message: error instanceof AppError ? error.message.slice(0, 500) : "Clean lifecycle prerequisites could not be confirmed" };
          }
          const encoded = encodeSourceLifecycleServerMessageV1(response), replyBytesLength = Buffer.byteLength(encoded, "utf8");
          if (replyBytesLength > remaining) throw Error("Original lifecycle retained reply byte budget exceeded");
          replies.set(value.sequence, { requestId: value.request_id, exact, response: encoded }); replyBytes += replyBytesLength;
          requestIds.add(value.request_id); sequence = value.sequence;
          await send(encoded);
        } finally { pending--; }
      }).catch(close);
    });
  });
}
