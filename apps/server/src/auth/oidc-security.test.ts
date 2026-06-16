import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RandomSource } from "../services/device-credential.js";
import { generateOpaqueToken, generatePkce, sanitizeReturnTo } from "./oidc-security.js";

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

describe("sanitizeReturnTo", () => {
  it("accepts same-origin relative paths and preserves their encoding", () => {
    expect(sanitizeReturnTo("/board")).toBe("/board");
    expect(sanitizeReturnTo("/board?tab=runs#x")).toBe("/board?tab=runs#x");
    expect(sanitizeReturnTo("/a/b-c_d.e")).toBe("/a/b-c_d.e");
    // valid path with an encoded space — returned verbatim (header-safe encoding kept)
    expect(sanitizeReturnTo("/board%20x")).toBe("/board%20x");
  });

  it("rejects open-redirect and path-confusion vectors, falling back to /", () => {
    const vectors = [
      "https://evil.com",
      "http://evil.com/x",
      "//evil.com",
      "/\\evil.com",
      "\\evil.com",
      "javascript:alert(1)",
      "evil.com",
      "/%2F%2Fevil.com", // decodes to ///evil.com
      "/%5Cevil.com", // decodes to /\evil.com
      "%2F%2Fevil.com", // decodes to //evil.com
      `/path${String.fromCharCode(1)}ctrl`, // real control char (U+0001)
      "/has://scheme",
      "%zz", // malformed percent-encoding
      "",
    ];
    for (const bad of vectors) {
      expect(sanitizeReturnTo(bad)).toBe("/");
    }
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo(`/${"a".repeat(3000)}`)).toBe("/"); // over-long
  });
});

describe("generateOpaqueToken", () => {
  it("produces a deterministic URL-safe token from the injected source", () => {
    const tok = generateOpaqueToken(seqRandom(), 32);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateOpaqueToken(seqRandom(), 32)).toBe(tok); // deterministic
    expect(generateOpaqueToken(seqRandom(100), 32)).not.toBe(tok);
  });
});

describe("generatePkce", () => {
  it("derives the S256 challenge as base64url(sha256(verifier))", () => {
    const { verifier, challenge } = generatePkce(seqRandom());
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(createHash("sha256").update(verifier, "utf8").digest("base64url"));
    expect(verifier).not.toBe(challenge);
  });
});
