/**
 * Google Auth HTTP surface (#34 slice 34-1c): the `/auth/*` routes and the
 * protected-API guard. Thin — they orchestrate the OIDC client + auth-service +
 * cookies; all crypto/storage policy lives in those layers.
 *
 *  GET  /auth/google/start    -> set HttpOnly flow cookie, 302 to the IdP
 *  GET  /auth/google/callback -> verify flow binding, exchange code, validate
 *                                id_token, provision user, set session cookie,
 *                                302 to return_to (or to login on any failure)
 *  GET  /auth/session         -> 200 {user} | 401
 *  POST /auth/logout          -> revoke + clear cookie, 204
 *
 * Cookies are HttpOnly + SameSite=Lax (+ Secure in prod). The web client never
 * sees the authorization code or the raw tokens.
 */
import { users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ServerContext } from "../context.js";
import type { AuthConfig } from "./auth-config.js";
import {
  consumeOauthFlow,
  createOauthFlow,
  createSession,
  provisionUser,
  resolveSession,
  revokeSession,
} from "./auth-service.js";
import { clearCookie, parseCookies, serializeCookie } from "./cookies.js";
import { buildAuthorizationUrl, validateIdToken, type OidcHttp } from "./oidc-client.js";

export interface AuthDeps {
  config: AuthConfig;
  oidcHttp: OidcHttp;
}

interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function unauthorized(): { error: { code: string; message: string; details: Record<string, unknown> } } {
  return { error: { code: "unauthorized", message: "authentication required", details: {} } };
}

/** Resolve the session cookie to a user, or null. */
async function currentUser(
  ctx: ServerContext,
  config: AuthConfig,
  req: FastifyRequest,
): Promise<SessionUser | null> {
  const raw = parseCookies(req.headers.cookie)[config.sessionCookieName];
  if (raw === undefined) {
    return null;
  }
  const resolved = await resolveSession(ctx, raw);
  if (resolved === null) {
    return null;
  }
  const row = (
    await ctx.db.db
      .select()
      .from(users)
      .where(and(eq(users.id, resolved.userId), eq(users.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined) {
    return null;
  }
  return { id: row.id, email: row.email, name: row.displayName };
}

function redirect(reply: FastifyReply, url: string): null {
  void reply.header("location", url).status(302);
  return null;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ServerContext, deps: AuthDeps): void {
  const { config, oidcHttp } = deps;

  app.get("/auth/google/start", async (req, reply) => {
    const returnTo = (req.query as { return_to?: string }).return_to;
    const started = await createOauthFlow(ctx, { flowTtlMs: config.flowTtlMs }, { returnTo });
    void reply.header(
      "set-cookie",
      serializeCookie(config.flowCookieName, started.flowBinding, {
        secure: config.secureCookies,
        maxAgeMs: config.flowTtlMs,
      }),
    );
    return redirect(
      reply,
      buildAuthorizationUrl({
        authorizationEndpoint: config.google.authorizationEndpoint,
        clientId: config.google.clientId,
        redirectUri: config.google.redirectUri,
        state: started.state,
        nonce: started.nonce,
        codeChallenge: started.codeChallenge,
        hostedDomain: config.hostedDomain,
      }),
    );
  });

  app.get("/auth/google/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string };
    const flowBinding = parseCookies(req.headers.cookie)[config.flowCookieName];
    const clearFlow = clearCookie(config.flowCookieName, { secure: config.secureCookies });
    try {
      if (!q.code || !q.state || flowBinding === undefined) {
        throw new Error("missing callback parameters");
      }
      const flow = await consumeOauthFlow(ctx, { state: q.state, flowBinding });
      const tokens = await oidcHttp.exchangeCode({
        tokenEndpoint: config.google.tokenEndpoint,
        code: q.code,
        codeVerifier: flow.codeVerifier,
        clientId: config.google.clientId,
        clientSecret: config.google.clientSecret,
        redirectUri: config.google.redirectUri,
      });
      const jwks = await oidcHttp.fetchJwks(config.google.jwksUri);
      const claims = validateIdToken(tokens.idToken, jwks, {
        issuer: config.google.issuer,
        audience: config.google.clientId,
        nonce: flow.nonce,
        nowMs: Date.parse(ctx.clock.nowIso()),
        hostedDomain: config.hostedDomain,
      });
      const { userId } = await provisionUser(ctx, {
        subject: claims.sub,
        email: claims.email,
        emailVerified: claims.email_verified,
        displayName: claims.name ?? claims.email,
      });
      const session = await createSession(ctx, { ttlMs: config.sessionTtlMs }, { userId });
      void reply.header("set-cookie", [
        clearFlow,
        serializeCookie(config.sessionCookieName, session.raw, {
          secure: config.secureCookies,
          maxAgeMs: config.sessionTtlMs,
        }),
      ]);
      return redirect(reply, flow.returnTo);
    } catch {
      // Any failure (bad binding, expired flow, token/id_token error, unverified
      // email) clears the flow cookie and returns to the login page.
      void reply.header("set-cookie", clearFlow);
      return redirect(reply, "/?auth_error=1");
    }
  });

  app.get("/auth/session", async (req, reply) => {
    const user = await currentUser(ctx, config, req);
    if (user === null) {
      void reply.status(401);
      return unauthorized();
    }
    return { user };
  });

  app.post("/auth/logout", async (req, reply) => {
    const raw = parseCookies(req.headers.cookie)[config.sessionCookieName];
    if (raw !== undefined) {
      const resolved = await resolveSession(ctx, raw);
      if (resolved !== null) {
        await revokeSession(ctx, resolved.sessionId);
      }
    }
    void reply.header("set-cookie", clearCookie(config.sessionCookieName, { secure: config.secureCookies }));
    void reply.status(204);
    return null;
  });
}

/**
 * Protected-API guard. When `enforceApiAuth` is on, REST `/api/v1` routes require
 * a valid session and return **401** (not 403) for missing/expired sessions, so
 * the web client's global 401 handler kicks the user back to login. The node /
 * client WebSocket routes are excluded (they carry their own device/session
 * auth), as are the `/auth/*` routes. Off by default so existing unauthenticated
 * dev/test flows keep working.
 */
export function registerApiAuthGuard(app: FastifyInstance, ctx: ServerContext, config: AuthConfig): void {
  if (!config.enforceApiAuth) {
    return;
  }
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/v1/")) {
      return;
    }
    if (path.startsWith("/api/v1/node") || path.startsWith("/api/v1/ws")) {
      return;
    }
    const user = await currentUser(ctx, config, req);
    if (user === null) {
      await reply.status(401).send(unauthorized());
    }
  });
}
