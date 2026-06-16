/**
 * Device credential crypto (#28 v2-C, slice 1). PURE except for an injectable
 * {@link RandomSource}; no DB and no env reads. Per codex's constraint the
 * pepper is passed IN — config loading and the fail-closed-if-missing policy
 * live in the service/wire layer (slices 2-3), never here.
 *
 * Entropy split (codex-ratified):
 *  - device tokens (`sk_device_<lookup>_<secret>`) carry a high-entropy,
 *    machine-generated `secret` → SHA-256(secret) is sufficient; verification is
 *    constant-time. `lookup` is an index hint, NOT an authenticator.
 *  - pairing codes are low-entropy human-transcribed strings → HMAC-SHA256 with
 *    a server pepper (so a DB leak alone does not make offline guessing cheap),
 *    backed by short TTL + bounded attempts enforced downstream.
 *
 * Raw tokens/codes are returned ONCE at generation and never persisted; only the
 * hash (+ non-secret lookup) is stored.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { formatDeviceToken, type ParsedDeviceToken } from "@artoo/domain";

/** Entropy seam — inject a deterministic source in tests; defaults to CSPRNG. */
export interface RandomSource {
  bytes(n: number): Buffer;
}

export const cryptoRandomSource: RandomSource = {
  bytes: (n: number): Buffer => randomBytes(n),
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hmacSha256Hex(input: string, key: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("hex");
}

/**
 * Constant-time compare of two 256-bit hex digests (SHA-256 / HMAC-SHA256).
 *
 * Both inputs are validated against a canonical 64-char hex shape BEFORE
 * decoding. Node's hex decoder is permissive — it silently drops trailing
 * non-hex characters and truncates odd-length input — so checking only the
 * decoded Buffer length would let `digest + "zz"` decode to the same 32 bytes
 * as `digest` and compare equal. Non-canonical or wrong-width input returns
 * false; canonical equal-width input is compared with {@link timingSafeEqual}.
 */
const HEX_256 = /^[0-9a-f]{64}$/i;

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (!HEX_256.test(a) || !HEX_256.test(b)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------------------
// Device tokens (high-entropy)
// ---------------------------------------------------------------------------

export interface GeneratedDeviceToken {
  /** `sk_device_<lookup>_<secret>` — return to the device ONCE; never persist. */
  raw: string;
  /** Non-secret index hint (underscore-free hex). Persist + index. */
  lookup: string;
  /** SHA-256(secret) hex. Persist this; the raw secret is never stored. */
  secretHash: string;
}

/**
 * Generate a device token: `lookup` = 6 random bytes as hex (12 chars,
 * underscore-free), `secret` = 32 random bytes base64url (~256-bit). The caller
 * persists {lookup, secretHash} and hands `raw` to the device a single time.
 */
export function generateDeviceToken(random: RandomSource = cryptoRandomSource): GeneratedDeviceToken {
  const lookup = random.bytes(6).toString("hex");
  const secret = random.bytes(32).toString("base64url");
  return {
    raw: formatDeviceToken(lookup, secret),
    lookup,
    secretHash: sha256Hex(secret),
  };
}

/** Constant-time verify a presented token's `secret` against a stored hash. */
export function verifyDeviceSecret(parsed: ParsedDeviceToken, storedSecretHash: string): boolean {
  return constantTimeEqualHex(sha256Hex(parsed.secret), storedSecretHash);
}

// ---------------------------------------------------------------------------
// Pairing codes (low-entropy → HMAC with server pepper)
// ---------------------------------------------------------------------------

/** Crockford-ish alphabet with ambiguous glyphs (0/O, 1/I/L) removed. */
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export interface PairingCodeFormat {
  groups: number;
  perGroup: number;
}

export const DEFAULT_PAIRING_FORMAT: PairingCodeFormat = { groups: 2, perGroup: 4 };

/**
 * Generate a human-transcribable pairing code (e.g. `K7QM-9R3T`). The raw code
 * is shown once to the initiator; only its HMAC is stored. Modulo bias over a
 * 31-char alphabet is acceptable here because codes are short-lived and
 * attempt-bounded downstream (codex guardrail).
 */
export function generatePairingCode(
  random: RandomSource = cryptoRandomSource,
  format: PairingCodeFormat = DEFAULT_PAIRING_FORMAT,
): string {
  const n = format.groups * format.perGroup;
  const buf = random.bytes(n);
  const chars: string[] = [];
  for (let i = 0; i < n; i += 1) {
    if (i > 0 && i % format.perGroup === 0) {
      chars.push("-");
    }
    const byte = buf[i] ?? 0;
    chars.push(PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length] ?? PAIRING_ALPHABET[0]!);
  }
  return chars.join("");
}

/**
 * HMAC-SHA256(code, pepper) hex. The pepper is a server secret supplied by the
 * caller — this function neither reads env nor decides what to do when it is
 * missing (that policy is fail-closed in the service layer).
 */
export function hashPairingCode(code: string, pepper: string): string {
  return hmacSha256Hex(normalizePairingCode(code), pepper);
}

/** Constant-time verify a presented pairing code against a stored HMAC. */
export function verifyPairingCode(code: string, pepper: string, storedHash: string): boolean {
  return constantTimeEqualHex(hashPairingCode(code, pepper), storedHash);
}

/** Canonicalize user-entered codes: uppercase, strip separators/whitespace, so
 *  `k7qm-9r3t`, `K7QM 9R3T`, and `K7QM9R3T` all verify identically. */
export function normalizePairingCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
