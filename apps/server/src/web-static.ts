/**
 * Serve the built web SPA same-origin with the API/auth/WS routes (#34 closeout),
 * so HttpOnly SameSite=Lax session cookies work in the merge-critical production
 * topology (web + /auth + /api on one origin). Split Vite/server is only
 * dev-proxy coverage.
 *
 * Registered only when `distDir` contains a built `index.html`; otherwise a no-op
 * so server tests and unbuilt dev flows are unchanged (the dist path is
 * configurable + disablable via env). @fastify/static serves real files (path
 * traversal safe); the not-found handler does the SPA fallback ONLY for browser
 * navigation (GET/HEAD that Accepts html on non-API/non-auth paths). API/auth
 * 404s stay JSON, unknown /api/v1 paths never fall to index.html, and the node /
 * client WebSocket routes are matched before this layer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import fastifyStatic from "@fastify/static";
import { apiError } from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

function isSpaNavigation(req: FastifyRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  const path = req.url.split("?")[0] ?? "";
  if (path.startsWith("/api/") || path.startsWith("/auth/")) {
    return false;
  }
  return (req.headers.accept ?? "").includes("text/html");
}

export function registerWebStatic(app: FastifyInstance, distDir: string | undefined): void {
  if (distDir === undefined || distDir.trim() === "" || !existsSync(join(distDir, "index.html"))) {
    return;
  }
  void app.register(fastifyStatic, { root: distDir, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (isSpaNavigation(req)) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.status(404).send(apiError("not_found", `route not found: ${req.method} ${req.url}`));
  });
}
