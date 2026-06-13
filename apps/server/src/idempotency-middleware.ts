import { createHash } from "node:crypto";

import { idempotencyKeys } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";

interface PendingIdempotency {
  scope: string;
  key: string;
  requestHash: string;
}

interface StoredResponse {
  status: number;
  body: unknown;
}

const STATE = Symbol("artoo.idempotency");

/**
 * Request-level idempotency for write endpoints. A POST carrying an
 * `Idempotency-Key` header is deduped on (scope=route, key): a replay with the
 * same body returns the stored response WITHOUT re-running the handler (so no
 * duplicate events); reusing the key with a different body is a conflict.
 *
 * Attempt scoping is the client's responsibility (a fresh key per attempt) — for
 * re-entrant ops like assign/retry the web client generates a new key per call,
 * so a legitimate second assign is NOT deduped against the first (Round 17/18).
 */
export function registerIdempotency(app: FastifyInstance, ctx: ServerContext): void {
  app.addHook("preHandler", async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== "POST") {
      return;
    }
    const key = headerValue(req.headers["idempotency-key"]);
    if (key === undefined) {
      return;
    }
    const scope = `POST:${req.routeOptions.url ?? req.url}`;
    const requestHash = hashRequest(req.body);

    const existing = (
      await ctx.db.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
    )[0];

    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw AppError.conflict("Idempotency-Key reused with a different request body", {
          scope,
          key,
        });
      }
      const stored = existing.responseJson as StoredResponse;
      await reply.status(stored.status).send(stored.body);
      return reply;
    }

    (req as FastifyRequest & { [STATE]?: PendingIdempotency })[STATE] = { scope, key, requestHash };
    return undefined;
  });

  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const pending = (req as FastifyRequest & { [STATE]?: PendingIdempotency })[STATE];
    if (pending === undefined || reply.statusCode >= 400 || typeof payload !== "string") {
      return payload;
    }
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }
    const stored: StoredResponse = { status: reply.statusCode, body };
    try {
      await ctx.db.db.insert(idempotencyKeys).values({
        scope: pending.scope,
        key: pending.key,
        requestHash: pending.requestHash,
        responseJson: stored,
        eventIds: [],
        createdAt: ctx.clock.nowIso(),
      });
    } catch {
      // Concurrent insert with the same key — the other request won the race.
    }
    return payload;
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v !== undefined && v !== "" ? v : undefined;
}

function hashRequest(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex");
}
