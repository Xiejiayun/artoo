/**
 * Device auth storage service (#28 v2-C, slice 2). Owns the device / token /
 * pairing-code tables: create a pairing, atomically claim it into a device with
 * two device-scoped credentials, resolve a presented token to a device, and
 * revoke a device (both credentials at once).
 *
 * Security invariants:
 *  - raw tokens and raw pairing codes are NEVER persisted: only SHA-256 (device
 *    token secret) / HMAC-SHA256 (pairing code) hashes are stored. Raw values
 *    are returned exactly once at issuance.
 *  - the HMAC pepper is passed IN via {@link DevicePairingConfig}; this layer
 *    never reads env. The wire layer loads the pepper from a server secret and
 *    fails closed when it is missing in non-test environments (codex).
 *  - claim is single-use and atomic (a conditional `pending -> claimed` update
 *    inside a transaction), so a code cannot be claimed twice or race two devices.
 *  - revoke flips device trust AND every active credential to `revoked`; closing
 *    live sockets is the wire layer's job (slice 3) — this returns the deviceId.
 */
import { computers, devices, deviceTokens, pairingCodes } from "@artoo/db";
import {
  ID_PREFIXES,
  parseDeviceToken,
  DeviceSchema,
  DeviceTokenSchema,
  PairingCodeSchema,
  type Device,
  type DevicePlatform,
  type DeviceToken,
  type DeviceTokenKind,
  type PairingCode,
} from "@artoo/domain";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import {
  cryptoRandomSource,
  generateDeviceToken,
  generatePairingCode,
  hashPairingCode,
  verifyDeviceSecret,
  type RandomSource,
} from "./device-credential.js";

// ---------------------------------------------------------------------------
// Row -> API mappers (raw secrets / stored hashes never appear in these shapes)
// ---------------------------------------------------------------------------

function mapDevice(row: typeof devices.$inferSelect): Device {
  return DeviceSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    display_name: row.displayName,
    platform: row.platform,
    app_version: row.appVersion,
    computer_id: row.computerId,
    enrolled_by_user_id: row.enrolledByUserId,
    trust: row.trust,
    last_seen_at: row.lastSeenAt,
    created_at: row.createdAt,
    revoked_at: row.revokedAt,
  });
}

function mapDeviceToken(row: typeof deviceTokens.$inferSelect): DeviceToken {
  return DeviceTokenSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    device_id: row.deviceId,
    kind: row.kind,
    status: row.status,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
  });
}

function mapPairingCode(row: typeof pairingCodes.$inferSelect): PairingCode {
  return PairingCodeSchema.parse({
    id: row.id,
    organization_id: row.organizationId,
    status: row.status,
    created_by_user_id: row.createdByUserId,
    intended_platform: row.intendedPlatform,
    expires_at: row.expiresAt,
    claimed_by_device_id: row.claimedByDeviceId,
    created_at: row.createdAt,
    claimed_at: row.claimedAt,
  });
}

/** Add `ms` to an ISO timestamp, returning ISO. Server-clock driven (injected). */
function isoPlusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function isExpired(expiresAtIso: string, nowIso: string): boolean {
  return Date.parse(expiresAtIso) <= Date.parse(nowIso);
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface DevicePairingConfig {
  /** HMAC pepper for pairing codes. REQUIRED; loaded by the wire layer (which
   *  fails closed when missing outside test/dev). Never read from env here. */
  pepper: string;
  /** Pairing-code lifetime in ms (short — e.g. 5-10 min). */
  ttlMs: number;
  /** Entropy source; defaults to the CSPRNG. Injected for deterministic tests. */
  random?: RandomSource;
}

export interface CreatePairingInput {
  createdByUserId: string;
  intendedPlatform?: DevicePlatform | null;
}

export interface CreatedPairing {
  pairing: PairingCode;
  /** Raw pairing code — show to the initiator ONCE; never persisted or logged. */
  code: string;
}

/** Create a short-lived single-use pairing code. Stores only its HMAC. */
export async function createPairing(
  ctx: ServerContext,
  config: DevicePairingConfig,
  input: CreatePairingInput,
): Promise<CreatedPairing> {
  const random = config.random ?? cryptoRandomSource;
  const code = generatePairingCode(random);
  const now = ctx.clock.nowIso();
  const row = {
    id: ctx.idGen.generate(ID_PREFIXES.pairingCode),
    organizationId: ctx.organizationId,
    codeHash: hashPairingCode(code, config.pepper),
    createdByUserId: input.createdByUserId,
    intendedPlatform: input.intendedPlatform ?? null,
    status: "pending" as const,
    expiresAt: isoPlusMs(now, config.ttlMs),
    claimedByDeviceId: null as string | null,
    createdAt: now,
    claimedAt: null as string | null,
  };
  await ctx.db.db.insert(pairingCodes).values(row);
  return { pairing: mapPairingCode(row), code };
}

export interface ClaimPairingInput {
  code: string;
  platform: DevicePlatform;
  appVersion: string;
  displayName: string;
}

export interface ClaimedDevice {
  device: Device;
  /** Raw control-session token (control plane `/api/v1/ws`) — returned ONCE. */
  controlToken: string;
  /** Raw device-bound node token (goes into `ARTOO_NODE_URL`) — returned ONCE. */
  nodeToken: string;
}

/** Uniform, non-leaking rejection for every claim failure mode (unknown code,
 *  expired, already claimed, lost race) so the caller cannot distinguish them. */
function invalidPairing(): AppError {
  return AppError.validation("invalid or expired pairing code");
}

/**
 * Claim a pairing code into a new device with two device-scoped credentials.
 * Atomic + single-use: the `pending -> claimed` update is conditional inside a
 * transaction, so a second claim (or a race) gets zero rows updated and is
 * rejected. Returns the raw control + node tokens exactly once.
 */
export async function claimPairing(
  ctx: ServerContext,
  config: DevicePairingConfig,
  input: ClaimPairingInput,
): Promise<ClaimedDevice> {
  const displayName = input.displayName.trim();
  const appVersion = input.appVersion.trim();
  if (displayName.length === 0 || appVersion.length === 0) {
    throw AppError.validation("display_name and app_version are required");
  }
  const random = config.random ?? cryptoRandomSource;
  const now = ctx.clock.nowIso();
  const codeHash = hashPairingCode(input.code, config.pepper);

  // Pre-check outside the claim transaction: uniform rejection for unknown /
  // non-pending codes, and an expiry cleanup that must COMMIT (so it cannot live
  // in the claim tx, which rolls back on rejection).
  const existing = (
    await ctx.db.db
      .select()
      .from(pairingCodes)
      .where(and(eq(pairingCodes.codeHash, codeHash), eq(pairingCodes.organizationId, ctx.organizationId)))
  )[0];
  if (existing === undefined || existing.status !== "pending") {
    throw invalidPairing();
  }
  if (isExpired(existing.expiresAt, now)) {
    await ctx.db.db
      .update(pairingCodes)
      .set({ status: "expired" })
      .where(and(eq(pairingCodes.id, existing.id), eq(pairingCodes.status, "pending")));
    throw invalidPairing();
  }
  // A pairing bound to a platform is authoritative: a mismatched claim is
  // rejected (uniform surface) and the code stays pending for a correct-platform
  // retry — it is neither consumed nor marked expired.
  if (existing.intendedPlatform !== null && existing.intendedPlatform !== input.platform) {
    throw invalidPairing();
  }

  return ctx.db.transaction(async (tx) => {
    const device = {
      id: ctx.idGen.generate(ID_PREFIXES.device),
      organizationId: ctx.organizationId,
      displayName,
      platform: input.platform,
      appVersion,
      computerId: null as string | null,
      enrolledByUserId: existing.createdByUserId,
      trust: "active" as const,
      lastSeenAt: null as string | null,
      createdAt: now,
      revokedAt: null as string | null,
    };
    // Insert the device first so the pairing's claimed_by_device_id FK resolves.
    await tx.insert(devices).values(device);

    // Single-use atomic claim: only succeeds while the row is still pending. A
    // concurrent claim that already won leaves 0 rows here and we roll back the
    // device insert by throwing.
    const claimed = await tx
      .update(pairingCodes)
      .set({ status: "claimed", claimedByDeviceId: device.id, claimedAt: now })
      .where(and(eq(pairingCodes.id, existing.id), eq(pairingCodes.status, "pending")))
      .returning({ id: pairingCodes.id });
    if (claimed.length === 0) {
      throw invalidPairing();
    }

    const control = generateDeviceToken(random);
    const node = generateDeviceToken(random);
    await tx.insert(deviceTokens).values([
      buildTokenRow(ctx, device.id, "control_session", control, now),
      buildTokenRow(ctx, device.id, "node", node, now),
    ]);

    return { device: mapDevice(device), controlToken: control.raw, nodeToken: node.raw };
  });
}

function buildTokenRow(
  ctx: ServerContext,
  deviceId: string,
  kind: DeviceTokenKind,
  token: { lookup: string; secretHash: string },
  now: string,
): typeof deviceTokens.$inferInsert {
  return {
    id: ctx.idGen.generate(ID_PREFIXES.deviceToken),
    organizationId: ctx.organizationId,
    deviceId,
    kind,
    tokenLookup: token.lookup,
    tokenHash: token.secretHash,
    status: "active",
    createdAt: now,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Resolution (authentication seam for #27 control plane + #29 compute plane)
// ---------------------------------------------------------------------------

export interface ResolvedDevice {
  deviceId: string;
  /** Set when the device hosts a compute node. */
  computerId: string | null;
  kind: DeviceTokenKind;
}

/**
 * Resolve a presented raw token to its device, or `null` if it is malformed,
 * unknown, the wrong kind, expired, revoked, or belongs to a revoked device.
 * Look up by the non-secret `lookup`, then CONSTANT-TIME verify the secret —
 * the lookup is an index, never an authenticator. Does not write (no lastUsedAt
 * update) so authentication is not a heartbeat write storm (slice 4 throttles).
 */
export async function resolveDeviceToken(
  ctx: ServerContext,
  raw: string,
  kind: DeviceTokenKind,
): Promise<ResolvedDevice | null> {
  const parsed = parseDeviceToken(raw);
  if (parsed === null) {
    return null;
  }
  const token = (
    await ctx.db.db
      .select()
      .from(deviceTokens)
      .where(
        and(
          eq(deviceTokens.tokenLookup, parsed.lookup),
          eq(deviceTokens.organizationId, ctx.organizationId),
        ),
      )
  )[0];
  if (token === undefined || token.kind !== kind || token.status !== "active") {
    return null;
  }
  if (!verifyDeviceSecret(parsed, token.tokenHash)) {
    return null;
  }
  if (token.expiresAt !== null && isExpired(token.expiresAt, ctx.clock.nowIso())) {
    return null;
  }
  const device = (
    await ctx.db.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, token.deviceId), eq(devices.organizationId, ctx.organizationId)))
  )[0];
  if (device === undefined || device.trust !== "active") {
    return null;
  }
  return { deviceId: device.id, computerId: device.computerId, kind: token.kind };
}

export function resolveNodeToken(ctx: ServerContext, raw: string): Promise<ResolvedDevice | null> {
  return resolveDeviceToken(ctx, raw, "node");
}

export function resolveControlToken(ctx: ServerContext, raw: string): Promise<ResolvedDevice | null> {
  return resolveDeviceToken(ctx, raw, "control_session");
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export interface RevokeResult {
  deviceId: string;
  /** True if this call transitioned an active device to revoked (idempotent). */
  revoked: boolean;
}

/**
 * Revoke a device: flip its trust to `revoked` and every active credential to
 * `revoked`, in one transaction. Idempotent (re-revoking returns revoked=false).
 * Dropping live node/control sockets is the wire layer's responsibility.
 */
export async function revokeDevice(ctx: ServerContext, deviceId: string): Promise<RevokeResult> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const device = (
      await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)))
    )[0];
    if (device === undefined) {
      throw AppError.notFound(`device not found: ${deviceId}`, { device_id: deviceId });
    }
    if (device.trust === "revoked") {
      return { deviceId, revoked: false };
    }
    await tx
      .update(devices)
      .set({ trust: "revoked", revokedAt: now })
      .where(and(eq(devices.id, deviceId), eq(devices.organizationId, ctx.organizationId)));
    await tx
      .update(deviceTokens)
      .set({ status: "revoked", revokedAt: now })
      .where(
        and(
          eq(deviceTokens.deviceId, deviceId),
          eq(deviceTokens.organizationId, ctx.organizationId),
          eq(deviceTokens.status, "active"),
        ),
      );
    return { deviceId, revoked: true };
  });
}

// ---------------------------------------------------------------------------
// Enrollment: device <-> computer binding (#28 slice 4a)
// ---------------------------------------------------------------------------

/** Desktop platforms that may host a local `artood` compute node. Mobile
 *  clients are remote control surfaces only (v2 roadmap), so they never enroll a
 *  local computer. */
const NODE_HOST_PLATFORMS: ReadonlySet<DevicePlatform> = new Set<DevicePlatform>(["windows", "macos"]);

export interface EnrollDeviceComputerInput {
  deviceId: string;
  /** Computer display name; defaults to the device's display name. */
  displayName?: string;
  /** Reported hostname; defaults to the device's display name. */
  hostname?: string;
  /** Reported OS; defaults to the device platform. */
  os?: string;
  /** Reported CPU arch; defaults to "unknown" until the node heartbeat refines it. */
  arch?: string;
}

export interface EnrollResult {
  deviceId: string;
  computerId: string;
  /** True when this call created the binding; false when it already existed (idempotent). */
  created: boolean;
}

/**
 * Link a desktop device to a compute `computers` row so its `node` token can
 * bind on `/api/v1/node`. Until this runs, claimPairing leaves `computer_id`
 * null and node-ws fails closed on the unlinked token — this is the real-flow
 * enrollment seam that lets a production node token connect.
 *
 * Fail-closed and idempotent:
 *  - an unknown device is `notFound`; a revoked device is rejected (no binding a
 *    dead identity to a fresh computer);
 *  - mobile platforms are rejected — they do not host local nodes;
 *  - re-enrolling an already-linked device returns the existing computer without
 *    creating a second row.
 *
 * The created computer starts in `enrolling`; its real `online` status, resources,
 * and capabilities are filled in by the node heartbeat (#29), not here.
 */
export async function enrollDeviceComputer(
  ctx: ServerContext,
  input: EnrollDeviceComputerInput,
): Promise<EnrollResult> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const device = (
      await tx
        .select()
        .from(devices)
        .where(and(eq(devices.id, input.deviceId), eq(devices.organizationId, ctx.organizationId)))
    )[0];
    if (device === undefined) {
      throw AppError.notFound(`device not found: ${input.deviceId}`, { device_id: input.deviceId });
    }
    if (device.trust !== "active") {
      throw AppError.conflict(`device is revoked: ${input.deviceId}`, { device_id: input.deviceId });
    }
    if (!NODE_HOST_PLATFORMS.has(device.platform as DevicePlatform)) {
      throw AppError.validation(
        `device platform ${device.platform} cannot host a local node; mobile clients are remote control surfaces`,
        { device_id: input.deviceId, platform: device.platform },
      );
    }
    // Idempotent: an already-linked device returns its existing computer.
    if (device.computerId !== null) {
      return { deviceId: device.id, computerId: device.computerId, created: false };
    }

    const computerId = ctx.idGen.generate(ID_PREFIXES.computer);
    const displayName = input.displayName?.trim() || device.displayName;
    await tx.insert(computers).values({
      id: computerId,
      organizationId: ctx.organizationId,
      displayName,
      hostname: input.hostname?.trim() || device.displayName,
      os: input.os?.trim() || device.platform,
      arch: input.arch?.trim() || "unknown",
      status: "enrolling",
      lastHeartbeatAt: null,
      resources: {},
      capabilities: [],
      createdAt: now,
    });
    await tx
      .update(devices)
      .set({ computerId })
      .where(and(eq(devices.id, device.id), eq(devices.organizationId, ctx.organizationId)));

    return { deviceId: device.id, computerId, created: true };
  });
}
