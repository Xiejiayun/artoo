/**
 * OIDC/OAuth security primitives for Google Auth (#34 slice 34-1a). PURE except
 * for an injectable {@link RandomSource}; no IO, no env reads.
 *
 * These are the security-critical building blocks the auth-code + PKCE flow is
 * assembled from (storage, endpoints, and the fake OIDC provider come in
 * 34-1b/c): a strict same-origin `return_to` sanitizer (open-redirect defense),
 * PKCE S256, and high-entropy opaque tokens used for `state`, `nonce`, the
 * client flow-binding, and session secrets. SHA-256 hashing + constant-time
 * compare are reused from the #28 device-credential helpers so the at-rest story
 * is identical.
 */
import { createHash } from "node:crypto";

import { cryptoRandomSource, type RandomSource } from "../services/device-credential.js";

const MAX_RETURN_TO = 2048;
// A backslash (authority/path confusion) or any control char (incl DEL).
const UNSAFE_CHARS = /[\\\x00-\x1f\x7f]/;

/**
 * Sanitize an OAuth `return_to` into a safe SAME-ORIGIN relative path (codex
 * hard requirement #1). The value is validated on its DECODED form (to catch
 * percent-encoded path confusion) and must be a path beginning with exactly one
 * `/` with no authority, scheme, backslash, or control character; anything else
 * falls back to `/`. On success the ORIGINAL (still-encoded, header-safe) value
 * is returned. The web client also sanitizes (defense in depth) but the server
 * is authoritative for encoded inputs.
 *
 * Rejects: absolute URLs, protocol-relative `//host`, `/\` and `\` confusion,
 * `scheme://`, encoded variants that decode to any of the above, and over-long
 * values.
 */
export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_TO) {
    return "/";
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/"; // malformed percent-encoding
  }
  if (!decoded.startsWith("/")) {
    return "/"; // not a relative path (absolute URL, scheme-relative word, etc.)
  }
  if (decoded.startsWith("//") || decoded.startsWith("/\\")) {
    return "/"; // protocol-relative or backslash authority confusion
  }
  if (decoded.includes("://") || UNSAFE_CHARS.test(decoded)) {
    return "/";
  }
  return raw;
}

/**
 * A high-entropy URL-safe opaque token. Used for `state`, `nonce`, the client
 * flow-binding secret, and session secrets. Store only a hash (see
 * {@link sha256Hex}) and compare in constant time.
 */
export function generateOpaqueToken(random: RandomSource = cryptoRandomSource, bytes = 32): string {
  return random.bytes(bytes).toString("base64url");
}

export interface Pkce {
  /** The PKCE code_verifier (kept server-side in the oauth_flow row). */
  verifier: string;
  /** base64url(SHA-256(verifier)) — sent to the IdP as code_challenge (S256). */
  challenge: string;
}

/** Generate a PKCE verifier + its S256 challenge. */
export function generatePkce(random: RandomSource = cryptoRandomSource): Pkce {
  const verifier = random.bytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

// Re-export the at-rest hashing + constant-time compare so auth storage uses the
// exact same primitives as #28 device credentials.
export { constantTimeEqualHex, sha256Hex } from "../services/device-credential.js";
