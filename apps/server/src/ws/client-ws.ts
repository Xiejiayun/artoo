import type { FastifyInstance, FastifyRequest } from "fastify";

import { parseCookies } from "../auth/cookies.js";
import { resolveSession } from "../auth/auth-service.js";
import type { ServerContext } from "../context.js";
import { resolveControlToken } from "../services/device-service.js";
import { recordDeviceActivity } from "../services/presence-service.js";
import { collectCatchUp } from "./event-publisher.js";
import type { DeviceConnectionRegistry } from "./device-connections.js";
import type { HubSocket, WsHub } from "./ws-hub.js";

/** The minimal surface of a `ws` WebSocket the client route uses. */
interface RawClientSocket extends HubSocket {
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  close(code: number, reason: string): void;
}

interface ClientFrame {
  type: "subscribe" | "unsubscribe";
  topics: string[];
  /** On subscribe: replay events with cursor > since_cursor (#27 WS recovery). */
  since_cursor?: number;
}

/**
 * The authenticated identity of an `/api/v1/ws` control connection (#28 slice 3b).
 * `user` = a browser session (the #34 cookie); `device` = a paired device's
 * `control_session` token; `dev` = the explicit non-production escape. Slice 3c
 * indexes `device` connections by `deviceId` so a device revoke can close them.
 */
export type ClientIdentity =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "dev" };

export interface ClientWsHooks {
  /**
   * Invoked once a connection authenticates, immediately before it is allowed to
   * register any subscription. Slice 3c uses this to index device sockets for
   * revoke-closes-sockets; in 3b it is an optional observability seam (tests
   * assert the resolved identity here).
   */
  onAuthenticated?: (identity: ClientIdentity, socket: HubSocket) => void;
}

/**
 * Authenticate a control-plane WS upgrade from its request, returning the
 * connection identity or `null` to reject. The function deliberately
 * distinguishes a connection that presents NO credential from one that presents
 * an invalid / unsupported / forbidden credential — only the former may use the
 * dev escape:
 *  1. A `?token=` query param is the forbidden URL-token shape on the control
 *     plane (a token must never land in a URL / access log). Its mere presence
 *     is rejected — even under the dev escape — so a client cannot rely on the
 *     forbidden shape and still pass dev smoke as `dev`.
 *  2. `Authorization: Bearer <control_session>` — a paired device's control
 *     token, validated (revocation-checked) by {@link resolveControlToken}. An
 *     `Authorization` header that is present but not a non-empty Bearer token
 *     (Basic, empty Bearer, …) is rejected, never dev.
 *  3. `Cookie: <sessionCookieName>=<session>` — a browser session, validated by
 *     {@link resolveSession} (the #34 seam). A session cookie whose name is
 *     present but empty / unresolvable is rejected, never dev.
 *  4. Truly no auth-bearing query/header/cookie — accepted as `dev` ONLY when
 *     the non-production control escape is enabled; otherwise rejected.
 *
 * A *presented-but-invalid* credential (bad / expired / revoked / malformed /
 * forbidden-shape) always returns `null`: an explicit auth attempt that failed
 * never silently falls back to the dev escape. This keeps expired/revoked
 * sessions, revoked devices, and the forbidden `?token=` shape fail-closed even
 * in a dev build.
 */
async function authenticateClient(
  ctx: ServerContext,
  req: FastifyRequest,
): Promise<ClientIdentity | null> {
  // (1) The forbidden URL-token shape: any `?token=` presence is a rejected
  // credential attempt, never a dev fall-through.
  if ((req.query as { token?: unknown }).token !== undefined) {
    return null;
  }

  // (2) An Authorization header, when present, MUST be a non-empty Bearer token
  // that resolves to a device control session; any other shape is rejected.
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const bearer = parseBearer(authorization);
    if (bearer === null) {
      return null;
    }
    const device = await resolveControlToken(ctx, bearer);
    return device === null ? null : { kind: "device", deviceId: device.deviceId };
  }

  // (3) A session cookie, when the cookie name is present at all (even empty),
  // is a presented credential: it must resolve or be rejected.
  const cookies = parseCookies(req.headers.cookie);
  if (Object.prototype.hasOwnProperty.call(cookies, ctx.authConfig.sessionCookieName)) {
    const sessionToken = cookies[ctx.authConfig.sessionCookieName];
    if (sessionToken === undefined || sessionToken === "") {
      return null;
    }
    const session = await resolveSession(ctx, sessionToken);
    return session === null ? null : { kind: "user", userId: session.userId };
  }

  // (4) Truly no auth-bearing query/header/cookie: only the explicit
  // non-production escape may accept (an anonymous dev connection).
  return ctx.deviceAuth.devControlEscape ? { kind: "dev" } : null;
}

/** Extract the token from a case-insensitive `Bearer <token>` header, or null. */
function parseBearer(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const trimmed = header.trim();
  const space = trimmed.indexOf(" ");
  if (space < 0 || trimmed.slice(0, space).toLowerCase() !== "bearer") {
    return null;
  }
  const token = trimmed.slice(space + 1).trim();
  return token.length === 0 ? null : token;
}

/**
 * Register the client realtime endpoint `ws /api/v1/ws` (WS wire format v0.2).
 *
 * #28 slice 3b adds authentication: every connection must resolve to a
 * {@link ClientIdentity} (browser session cookie, device `control_session`
 * token, or the explicit non-production dev escape) BEFORE it is added to the
 * hub or allowed to subscribe. Authentication is async (a DB lookup), so the
 * socket's `message` listener is attached synchronously and any frames that
 * arrive before auth resolves are queued in a bounded buffer; once auth
 * succeeds they are drained, and the socket is registered with the hub. A
 * failed / missing / revoked credential closes the socket with code 1008
 * ("unauthenticated") and it is NEVER added to the hub — so it cannot register
 * a subscription or receive any pushed event.
 *
 * Client frames: {type:subscribe|unsubscribe, topics, since_cursor?}. The server
 * pushes {type:"event", topic, event, cursor} for each subscribed topic, where
 * `cursor` is the monotonic event_log.position. On a subscribe that carries
 * `since_cursor`, the server first subscribes the socket to live delivery, then
 * REPLAYS the matching events appended after that cursor — so a client that was
 * offline reconnects and catches up exactly. Clients dedupe/ordering by cursor.
 */
export function registerClientWsRoute(
  app: FastifyInstance,
  ctx: ServerContext,
  hub: WsHub,
  hooks: ClientWsHooks = {},
  deviceConnections?: DeviceConnectionRegistry,
): void {
  app.get("/api/v1/ws", { websocket: true }, (socket: unknown, req: FastifyRequest) => {
    const raw = socket as RawClientSocket;
    let identity: ClientIdentity | undefined;
    let terminated = false;
    let releaseDeviceConn: (() => void) | undefined;
    const earlyFrames: ClientFrame[] = [];

    const close = (code: number, reason: string): void => {
      if (terminated) {
        return;
      }
      terminated = true;
      raw.close(code, reason);
    };

    const applyFrame = (frame: ClientFrame): void => {
      if (terminated || identity === undefined) {
        return;
      }
      if (frame.type === "subscribe") {
        // Subscribe to live delivery FIRST so nothing is missed during the async
        // catch-up; the client dedupes any boundary overlap by cursor.
        hub.subscribe(raw, frame.topics);
        if (frame.since_cursor !== undefined) {
          void replayCatchUp(raw, ctx, frame.since_cursor, frame.topics);
        }
      } else {
        hub.unsubscribe(raw, frame.topics);
      }
    };

    // Before auth resolves, queue frames in a bounded buffer. An unauthenticated
    // peer cannot make us buffer without limit (a legitimate client sends only a
    // subscribe or two before auth completes).
    const MAX_PREAUTH_FRAMES = 16;
    let dispatch: (frame: ClientFrame) => void = (frame) => {
      if (terminated) {
        return;
      }
      earlyFrames.push(frame);
      if (earlyFrames.length > MAX_PREAUTH_FRAMES) {
        earlyFrames.length = 0;
        close(1008, "too many frames before authentication");
      }
    };

    raw.on("message", (data: unknown) => {
      const frame = parseClientFrame(data);
      if (frame === null) {
        return;
      }
      dispatch(frame);
    });
    raw.on("close", () => {
      terminated = true;
      releaseDeviceConn?.();
      hub.remove(raw);
    });

    void (async () => {
      let result: ClientIdentity | null;
      try {
        result = await authenticateClient(ctx, req);
      } catch {
        // A failing auth path (e.g. a db error) must close, not leave an
        // unauthenticated socket open with a growing queue.
        earlyFrames.length = 0;
        close(1008, "unauthenticated");
        return;
      }
      if (result === null) {
        earlyFrames.length = 0;
        close(1008, "unauthenticated");
        return;
      }
      if (terminated) {
        earlyFrames.length = 0;
        return; // socket already closed during auth (e.g. queue overflow)
      }
      identity = result;
      // Register with the hub ONLY after authentication: until now the socket
      // holds no subscription state and is unknown to the publisher.
      hub.add(raw);
      hooks.onAuthenticated?.(identity, raw);
      // Index a device control socket by device id so a device revoke can close
      // it synchronously (not only reject the next connection).
      if (identity.kind === "device" && deviceConnections !== undefined) {
        releaseDeviceConn = deviceConnections.add(identity.deviceId, {
          close: (code, reason) => close(code, reason),
        });
      }
      // Device-level presence (#28 4c): an accepted control-session connection is
      // authenticated device activity (control token, never the dev escape).
      if (identity.kind === "device") {
        void recordDeviceActivity(ctx, identity.deviceId, "control").catch(() => {});
      }
      dispatch = applyFrame;
      for (const queued of earlyFrames) {
        if (terminated) {
          break;
        }
        applyFrame(queued);
      }
      earlyFrames.length = 0;
    })();
  });
}

async function replayCatchUp(
  socket: HubSocket,
  ctx: ServerContext,
  sinceCursor: number,
  topics: readonly string[],
): Promise<void> {
  try {
    const frames = await collectCatchUp(ctx, sinceCursor, topics);
    for (const frame of frames) {
      socket.send(JSON.stringify(frame));
    }
  } catch {
    // best-effort catch-up; live delivery still converges the client
  }
}

function toText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data !== null && typeof data === "object" && "toString" in data) {
    return String(data);
  }
  return null;
}

function parseClientFrame(data: unknown): ClientFrame | null {
  const text = toText(data);
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const type = (raw as { type?: unknown }).type;
  const topics = (raw as { topics?: unknown }).topics;
  const sinceCursor = (raw as { since_cursor?: unknown }).since_cursor;
  if (
    (type === "subscribe" || type === "unsubscribe") &&
    Array.isArray(topics) &&
    topics.every((topic) => typeof topic === "string")
  ) {
    const frame: ClientFrame = { type, topics: topics as string[] };
    if (type === "subscribe" && typeof sinceCursor === "number" && Number.isFinite(sinceCursor)) {
      frame.since_cursor = sinceCursor;
    }
    return frame;
  }
  return null;
}
