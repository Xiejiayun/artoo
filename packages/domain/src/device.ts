/**
 * Device auth contract (#28 v2-C). A *device* is one client install (a control
 * surface plus, on desktop, a compute-node host) — distinct from a human user
 * and from an agent.
 *
 * Pure domain: record schemas (snake_case wire shape), the device-token string
 * FORMAT (`sk_device_<lookup>_<secret>`), and a deterministic presence helper.
 * Crypto (hashing / HMAC / constant-time compare / entropy), storage tables,
 * pairing / revoke APIs, and wire validation live server-side (slices 2-4) and
 * are intentionally NOT here: this layer stays free of `node:crypto`, DB, and
 * env reads. Per codex's constraint, pepper / randomness / clock / idgen are
 * passed in by the downstream service/wire layer, which owns config + failure
 * policy.
 *
 * Keys are snake_case (record/wire shape). `.passthrough()` only preserves
 * unknown forward-compat fields; known optionals are declared explicitly.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const DevicePlatformSchema = z.enum(["windows", "macos", "android", "ios"]);
export const DEVICE_PLATFORMS = DevicePlatformSchema.options;
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

export const DeviceTrustSchema = z.enum(["active", "revoked"]);
export const DEVICE_TRUSTS = DeviceTrustSchema.options;
export type DeviceTrust = z.infer<typeof DeviceTrustSchema>;

/** The two credential CLASSES bound to one device identity (codex-ratified). */
export const DeviceTokenKindSchema = z.enum(["control_session", "node"]);
export const DEVICE_TOKEN_KINDS = DeviceTokenKindSchema.options;
export type DeviceTokenKind = z.infer<typeof DeviceTokenKindSchema>;

export const DeviceTokenStatusSchema = z.enum(["active", "revoked"]);
export const DEVICE_TOKEN_STATUSES = DeviceTokenStatusSchema.options;
export type DeviceTokenStatus = z.infer<typeof DeviceTokenStatusSchema>;

export const PairingCodeStatusSchema = z.enum(["pending", "claimed", "expired", "cancelled"]);
export const PAIRING_CODE_STATUSES = PairingCodeStatusSchema.options;
export type PairingCodeStatus = z.infer<typeof PairingCodeStatusSchema>;

export const DevicePresenceStateSchema = z.enum(["online", "stale", "offline"]);
export const DEVICE_PRESENCE_STATES = DevicePresenceStateSchema.options;
export type DevicePresenceState = z.infer<typeof DevicePresenceStateSchema>;

// ---------------------------------------------------------------------------
// Record schemas — NO raw secret and NO stored hash are ever part of these
// API/wire shapes. The hash + lookup are storage-internal (slice 2).
// ---------------------------------------------------------------------------

export const DeviceSchema = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    display_name: z.string(),
    platform: DevicePlatformSchema,
    app_version: z.string(),
    /** Set when this device hosts a compute node (maps to a `computers` row). */
    computer_id: z.string().nullable(),
    enrolled_by_user_id: z.string(),
    trust: DeviceTrustSchema,
    last_seen_at: z.string().nullable(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .passthrough();
export type Device = z.infer<typeof DeviceSchema>;

/** Metadata view of a credential. The raw token and its stored hash are NEVER
 *  represented here — they do not leave issuance (raw) / storage (hash). */
export const DeviceTokenSchema = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    device_id: z.string(),
    kind: DeviceTokenKindSchema,
    status: DeviceTokenStatusSchema,
    created_at: z.string(),
    last_used_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    revoked_at: z.string().nullable(),
  })
  .passthrough();
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;

/** Metadata view of a pairing code. The raw code and its HMAC are NEVER here. */
export const PairingCodeSchema = z
  .object({
    id: z.string(),
    organization_id: z.string(),
    status: PairingCodeStatusSchema,
    created_by_user_id: z.string(),
    intended_platform: DevicePlatformSchema.nullable(),
    expires_at: z.string(),
    claimed_by_device_id: z.string().nullable(),
    created_at: z.string(),
    claimed_at: z.string().nullable(),
  })
  .passthrough();
export type PairingCode = z.infer<typeof PairingCodeSchema>;

export const DevicePresenceSchema = z
  .object({
    device_id: z.string(),
    state: DevicePresenceStateSchema,
    last_seen_at: z.string().nullable(),
  })
  .passthrough();
export type DevicePresence = z.infer<typeof DevicePresenceSchema>;

// ---------------------------------------------------------------------------
// Device-token string FORMAT — pure string ops, no crypto / no entropy.
//   sk_device_<lookup>_<secret>
// `lookup` is a NON-SECRET index hint (underscore-free); `secret` is the
// high-entropy authenticator (URL-safe base64url, may itself contain `_`). The
// server resolves a row by `lookup`, then constant-time-verifies `secret`
// against the stored hash. Parsing here authenticates NOTHING.
// ---------------------------------------------------------------------------

export const DEVICE_TOKEN_PREFIX = "sk_device_";

const LOOKUP_SEGMENT = /^[A-Za-z0-9-]+$/; // underscore-free so the first `_` splits cleanly
const SECRET_SEGMENT = /^[A-Za-z0-9_-]+$/; // URL-safe base64url body

export function formatDeviceToken(lookup: string, secret: string): string {
  return `${DEVICE_TOKEN_PREFIX}${lookup}_${secret}`;
}

export interface ParsedDeviceToken {
  lookup: string;
  secret: string;
}

/**
 * Parse `sk_device_<lookup>_<secret>` into its segments, or `null` if the input
 * does not match the shape. The first `_` after the prefix splits lookup|secret;
 * since `lookup` is underscore-free this is unambiguous even when `secret`
 * contains `_`. Pure and non-authenticating.
 */
export function parseDeviceToken(raw: string): ParsedDeviceToken | null {
  if (!raw.startsWith(DEVICE_TOKEN_PREFIX)) {
    return null;
  }
  const body = raw.slice(DEVICE_TOKEN_PREFIX.length);
  const sep = body.indexOf("_");
  if (sep <= 0 || sep >= body.length - 1) {
    return null;
  }
  const lookup = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  if (!LOOKUP_SEGMENT.test(lookup) || !SECRET_SEGMENT.test(secret)) {
    return null;
  }
  return { lookup, secret };
}

// ---------------------------------------------------------------------------
// Presence — deterministic derivation from a last-seen timestamp. PURE; `now`
// and the windows are injected (no clock read here), mirroring runtime.ts.
// ---------------------------------------------------------------------------

export interface PresenceWindows {
  /** <= onlineWithinMs since last_seen => online. */
  onlineWithinMs: number;
  /** <= staleWithinMs (and > onlineWithinMs) => stale; beyond => offline. */
  staleWithinMs: number;
}

/**
 * Derive a device's presence state from its last-seen timestamp. `null`/missing
 * or unparseable timestamps are `offline` (safe default). Exactly at a boundary
 * counts as the tighter state (<= is inclusive).
 */
export function derivePresenceState(
  lastSeenIso: string | null | undefined,
  nowIso: string,
  windows: PresenceWindows,
): DevicePresenceState {
  if (lastSeenIso == null) {
    return "offline";
  }
  const lastSeen = Date.parse(lastSeenIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(lastSeen) || Number.isNaN(now)) {
    return "offline";
  }
  const age = now - lastSeen;
  if (age <= windows.onlineWithinMs) {
    return "online";
  }
  if (age <= windows.staleWithinMs) {
    return "stale";
  }
  return "offline";
}
