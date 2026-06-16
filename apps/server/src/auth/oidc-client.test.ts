import { describe, expect, it } from "vitest";

import { createFakeOidcProvider, type FakeOidcProvider } from "./fake-oidc.js";
import { buildAuthorizationUrl, validateIdToken, type ValidateIdTokenOptions } from "./oidc-client.js";

const ISS = "https://accounts.google.com";
const AUD = "client-123.apps.googleusercontent.com";
const NOW_MS = Date.parse("2026-06-13T00:00:00.000Z");
const NOW_S = Math.floor(NOW_MS / 1000);

function provider(kid?: string): FakeOidcProvider {
  return createFakeOidcProvider({ issuer: ISS, audience: AUD, nowMs: NOW_MS, ...(kid !== undefined ? { kid } : {}) });
}

function token(p: FakeOidcProvider, claims: Record<string, unknown> = {}): string {
  return p.signIdToken({
    iss: ISS,
    aud: AUD,
    sub: "sub-1",
    email: "a@example.com",
    email_verified: true,
    nonce: "nonce-1",
    iat: NOW_S,
    exp: NOW_S + 3600,
    ...claims,
  });
}

const OPTS: ValidateIdTokenOptions = { issuer: ISS, audience: AUD, nonce: "nonce-1", nowMs: NOW_MS };

describe("buildAuthorizationUrl", () => {
  it("builds an auth-code + PKCE S256 url with the expected params", () => {
    const url = new URL(
      buildAuthorizationUrl({
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientId: AUD,
        redirectUri: "https://app.example/auth/google/callback",
        state: "st",
        nonce: "no",
        codeChallenge: "ch",
        hostedDomain: "example.com",
      }),
    );
    const p = url.searchParams;
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe(AUD);
    expect(p.get("scope")).toBe("openid email profile");
    expect(p.get("code_challenge")).toBe("ch");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("st");
    expect(p.get("nonce")).toBe("no");
    expect(p.get("hd")).toBe("example.com");
  });
});

describe("validateIdToken", () => {
  it("accepts a correctly signed token and returns claims", () => {
    const p = provider();
    const claims = validateIdToken(token(p), p.jwks, OPTS);
    expect(claims.sub).toBe("sub-1");
    expect(claims.email).toBe("a@example.com");
    expect(claims.email_verified).toBe(true);
  });

  it("rejects wrong issuer / audience / nonce / expiry / missing email", () => {
    const p = provider();
    expect(() => validateIdToken(token(p, { iss: "https://evil" }), p.jwks, OPTS)).toThrow(/authentication failed/);
    expect(() => validateIdToken(token(p, { aud: "other-client" }), p.jwks, OPTS)).toThrow();
    expect(() => validateIdToken(token(p, { nonce: "wrong" }), p.jwks, OPTS)).toThrow();
    expect(() => validateIdToken(token(p, { exp: NOW_S - 10 }), p.jwks, OPTS)).toThrow();
    expect(() => validateIdToken(token(p, { email: "" }), p.jwks, OPTS)).toThrow();
  });

  it("rejects a token whose kid is not in the JWKS", () => {
    const signer = provider("other-kid");
    const verifier = provider("fake-key-1");
    expect(() => validateIdToken(token(signer), verifier.jwks, OPTS)).toThrow(/authentication failed/);
  });

  it("rejects a token signed by a different key (signature invalid)", () => {
    const signer = provider(); // kid fake-key-1, key A
    const verifier = provider(); // kid fake-key-1, key B (different)
    expect(() => validateIdToken(token(signer), verifier.jwks, OPTS)).toThrow(/authentication failed/);
  });

  it("enforces the hosted-domain policy when configured", () => {
    const p = provider();
    const withHd = { ...OPTS, hostedDomain: "example.com" };
    expect(validateIdToken(token(p, { hd: "example.com" }), p.jwks, withHd).hd).toBe("example.com");
    expect(() => validateIdToken(token(p), p.jwks, withHd)).toThrow(); // no hd claim
    expect(() => validateIdToken(token(p, { hd: "evil.com" }), p.jwks, withHd)).toThrow();
  });
});

describe("exchangeCode (fake provider)", () => {
  it("mints an id_token for a staged code that then validates", async () => {
    const p = provider();
    p.stageCode("code-1", { sub: "sub-9", email: "z@example.com", email_verified: true }, "nonce-x");
    const tokens = await p.http.exchangeCode({
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      code: "code-1",
      codeVerifier: "verifier",
      clientId: AUD,
      clientSecret: "secret",
      redirectUri: "https://app.example/auth/google/callback",
    });
    const claims = validateIdToken(tokens.idToken, p.jwks, {
      issuer: ISS,
      audience: AUD,
      nonce: "nonce-x",
      nowMs: NOW_MS,
    });
    expect(claims.sub).toBe("sub-9");
    expect(claims.email).toBe("z@example.com");
  });
});
