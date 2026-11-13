import { type DevicePlatform, DevicePlatformSchema } from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ClaimLimiter } from "./claim-rate-limit.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import * as deviceService from "./services/device-service.js";
import * as presenceService from "./services/presence-service.js";
import type { DeviceConnectionRegistry } from "./ws/device-connections.js";

/** Register pairing, enrollment and reads in the existing authenticated scope. */
export function registerDeviceRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  claimLimiter: ClaimLimiter,
  deviceConnections: DeviceConnectionRegistry,
): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
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

  app.get("/api/v1/devices/pairings/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deviceService.getPairingStatus(rc(req), id);
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
}

/** Keep revocation at its original registration point in the app. */
export function registerDeviceRevocationRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  deviceConnections: DeviceConnectionRegistry,
): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
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
