/**
 * In-process fake OIDC provider for #34 tests. Generates an RSA keypair, serves
 * its public key as JWKS, mints signed id_tokens, and implements {@link OidcHttp}
 * so the OAuth callback path can be exercised end to end with no real network or
 * Google credentials. Test-only — never wired in production.
 */
import { generateKeyPairSync, sign } from "node:crypto";

import type { ExchangeCodeInput, Jwk, Jwks, OidcHttp, OidcTokens } from "./oidc-client.js";

export interface FakeIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  hd?: string;
}

export interface FakeOidcProvider {
  issuer: string;
  audience: string;
  jwks: Jwks;
  http: OidcHttp;
  /** Stage a code so the token exchange mints an id_token for this identity/nonce. */
  stageCode(code: string, identity: FakeIdentity, nonce: string, expSeconds?: number): void;
  /** Mint a signed id_token directly (for validateIdToken unit tests). */
  signIdToken(claims: Record<string, unknown>): string;
}

export interface FakeOidcOptions {
  issuer: string;
  audience: string;
  nowMs: number;
  kid?: string;
}

export function createFakeOidcProvider(opts: FakeOidcOptions): FakeOidcProvider {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = opts.kid ?? "fake-key-1";
  const exported = publicKey.export({ format: "jwk" }) as { kty?: string; n?: string; e?: string };
  const jwk: Jwk = {
    kid,
    kty: exported.kty ?? "RSA",
    n: exported.n ?? "",
    e: exported.e ?? "",
    alg: "RS256",
    use: "sig",
  };
  const jwks: Jwks = { keys: [jwk] };
  const staged = new Map<string, { identity: FakeIdentity; nonce: string; exp: number }>();

  function signIdToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  return {
    issuer: opts.issuer,
    audience: opts.audience,
    jwks,
    signIdToken,
    stageCode(code, identity, nonce, expSeconds) {
      staged.set(code, {
        identity,
        nonce,
        exp: expSeconds ?? Math.floor(opts.nowMs / 1000) + 3600,
      });
    },
    http: {
      // eslint-disable-next-line @typescript-eslint/require-await
      async exchangeCode(input: ExchangeCodeInput): Promise<OidcTokens> {
        const entry = staged.get(input.code);
        if (entry === undefined) {
          throw new Error("fake-oidc: unknown authorization code");
        }
        const idToken = signIdToken({
          iss: opts.issuer,
          aud: opts.audience,
          sub: entry.identity.sub,
          email: entry.identity.email,
          email_verified: entry.identity.email_verified,
          ...(entry.identity.name !== undefined ? { name: entry.identity.name } : {}),
          ...(entry.identity.hd !== undefined ? { hd: entry.identity.hd } : {}),
          nonce: entry.nonce,
          iat: Math.floor(opts.nowMs / 1000),
          exp: entry.exp,
        });
        return { idToken };
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetchJwks(): Promise<Jwks> {
        return jwks;
      },
    },
  };
}
