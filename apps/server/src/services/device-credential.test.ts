import { describe, expect, it } from "vitest";

import { parseDeviceToken } from "@artoo/domain";

import {
  type RandomSource,
  constantTimeEqualHex,
  generateDeviceToken,
  generatePairingCode,
  hashPairingCode,
  normalizePairingCode,
  sha256Hex,
  verifyDeviceSecret,
  verifyPairingCode,
} from "./device-credential.js";

/** Deterministic byte source: each call yields the next bytes of an increasing
 *  sequence, so successive `bytes()` calls within one operation stay distinct. */
function seqRandom(start = 0): RandomSource {
  let counter = start;
  return {
    bytes(n: number): Buffer {
      const b = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) {
        b[i] = counter & 0xff;
        counter += 1;
      }
      return b;
    },
  };
}

describe("hashing primitives", () => {
  it("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
    expect(sha256Hex("abc")).toHaveLength(64);
  });

  it("constantTimeEqualHex compares canonical 64-hex digests and rejects non-canonical input", () => {
    const h = sha256Hex("x");
    expect(constantTimeEqualHex(h, h)).toBe(true);
    expect(constantTimeEqualHex(h, sha256Hex("y"))).toBe(false);
    // Node's hex decoder is permissive: `h + "zz"` would decode to the same 32
    // bytes as `h`. The canonical-shape guard must reject it BEFORE decoding.
    expect(constantTimeEqualHex(h, `${h}zz`)).toBe(false);
    expect(constantTimeEqualHex(`${h}zz`, h)).toBe(false);
    expect(constantTimeEqualHex(h, h.slice(0, 63))).toBe(false); // truncated width
    expect(constantTimeEqualHex(h, h.slice(0, 60))).toBe(false); // wrong width
    expect(constantTimeEqualHex(`${h.slice(0, 62)}gg`, h)).toBe(false); // non-hex chars
    expect(constantTimeEqualHex("", "")).toBe(false); // empty
    expect(constantTimeEqualHex("zz", "zz")).toBe(false); // non-hex, non-canonical
  });
});

describe("device tokens", () => {
  it("generates a parseable, verifiable token and stores only the hash", () => {
    const tok = generateDeviceToken(seqRandom());
    expect(tok.raw.startsWith("sk_device_")).toBe(true);
    const parsed = parseDeviceToken(tok.raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.lookup).toBe(tok.lookup);
    // secretHash is the sha256 of the secret, not the raw secret itself.
    expect(tok.secretHash).toBe(sha256Hex(parsed!.secret));
    expect(tok.raw).not.toContain(tok.secretHash);
    expect(verifyDeviceSecret(parsed!, tok.secretHash)).toBe(true);
  });

  it("verification depends on the secret, not the lookup (lookup is not an authenticator)", () => {
    const tok = generateDeviceToken(seqRandom(10));
    const parsed = parseDeviceToken(tok.raw)!;
    // Tampered secret with the real lookup => rejected.
    expect(verifyDeviceSecret({ lookup: parsed.lookup, secret: "tampered" }, tok.secretHash)).toBe(false);
    // Real secret with a different lookup => still accepted (lookup is irrelevant to auth).
    expect(verifyDeviceSecret({ lookup: "deadbeef", secret: parsed.secret }, tok.secretHash)).toBe(true);
  });

  it("two generations yield distinct lookups and secrets", () => {
    const a = generateDeviceToken(seqRandom(0));
    const b = generateDeviceToken(seqRandom(100));
    expect(a.lookup).not.toBe(b.lookup);
    expect(a.secretHash).not.toBe(b.secretHash);
  });
});

describe("pairing codes", () => {
  it("HMAC is deterministic, pepper-dependent, and normalization-insensitive", () => {
    const code = "K7QM-9R3T";
    expect(hashPairingCode(code, "pepper-1")).toBe(hashPairingCode(code, "pepper-1"));
    expect(hashPairingCode(code, "pepper-1")).not.toBe(hashPairingCode(code, "pepper-2"));
    // case + separators are canonicalized before hashing.
    expect(hashPairingCode("k7qm 9r3t", "pepper-1")).toBe(hashPairingCode("K7QM-9R3T", "pepper-1"));
    expect(normalizePairingCode("k7qm-9r3t")).toBe("K7QM9R3T");
  });

  it("verifies a code only with the right pepper", () => {
    const hash = hashPairingCode("K7QM-9R3T", "server-pepper");
    expect(verifyPairingCode("k7qm-9r3t", "server-pepper", hash)).toBe(true);
    expect(verifyPairingCode("K7QM-9R3T", "wrong-pepper", hash)).toBe(false);
    expect(verifyPairingCode("XXXX-YYYY", "server-pepper", hash)).toBe(false);
  });

  it("generates grouped codes from an unambiguous alphabet", () => {
    expect(generatePairingCode(seqRandom())).toBe("2345-6789");
    const code = generatePairingCode(seqRandom(40));
    expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    // no ambiguous glyphs
    expect(code).not.toMatch(/[01OIL]/);
  });
});
