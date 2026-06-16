/**
 * OIDC client for Google Auth (#34 slice 34-1c). The authorization-URL builder,
 * code exchange, and id_token validation. HTTP (token endpoint + JWKS fetch) is
 * an injected {@link OidcHttp} seam so tests drive an in-process fake provider
 * (see fake-oidc.ts) with no real network or Google credentials; production
 * wires a fetch-backed implementation.
 *
 * id_token validation is hand-rolled on node:crypto (RS256 verify against the
 * provider JWKS) — no third-party JWT dependency — and checks iss / aud / nonce
 * / exp, requires a provider-verified email, and enforces the hosted-domain
 * policy when configured.
 */
import { createPublicKey, verify } from "node:crypto";

import { AppError } from "../errors.js";

export interface OidcTokens {
  idToken: string;
}

export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  hd?: string;
  nonce?: string;
  exp: number;
  iat: number;
}

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export interface Jwks {
  keys: Jwk[];
}

export interface ExchangeCodeInput {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Injected transport for the two network calls (token exchange + JWKS). */
export interface OidcHttp {
  exchangeCode(input: ExchangeCodeInput): Promise<OidcTokens>;
  fetchJwks(jwksUri: string): Promise<Jwks>;
}

export interface BuildAuthorizationUrlInput {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  hostedDomain?: string | undefined;
}

/** Build the IdP authorization URL (auth-code + PKCE S256, scope openid email profile). */
export function buildAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  const url = new URL(input.authorizationEndpoint);
  const params = url.searchParams;
  params.set("response_type", "code");
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("scope", "openid email profile");
  params.set("state", input.state);
  params.set("nonce", input.nonce);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("access_type", "online");
  params.set("prompt", "select_account");
  if (input.hostedDomain !== undefined) {
    params.set("hd", input.hostedDomain);
  }
  return url.toString();
}

export interface ValidateIdTokenOptions {
  issuer: string;
  audience: string;
  nonce: string;
  nowMs: number;
  hostedDomain?: string | undefined;
}

function authError(detail: string): AppError {
  // Internal classification; the callback route turns this into a login redirect.
  return AppError.validation("authentication failed", { reason: detail });
}

interface ParsedJwt {
  header: { alg?: string; kid?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
}

function parseJwt(idToken: string): ParsedJwt {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw authError("id_token is not a JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: ParsedJwt["header"];
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw authError("id_token header/payload not decodable");
  }
  return {
    header,
    payload,
    signingInput: `${headerB64}.${payloadB64}`,
    signature: Buffer.from(signatureB64, "base64url"),
  };
}

/**
 * Validate a Google id_token: RS256 signature against the JWKS key matching the
 * header `kid`, then iss / aud / nonce / exp, a provider-verified email, and the
 * hosted-domain policy when configured. Returns the claims or throws.
 */
export function validateIdToken(idToken: string, jwks: Jwks, opts: ValidateIdTokenOptions): IdTokenClaims {
  const { header, payload, signingInput, signature } = parseJwt(idToken);
  if (header.alg !== "RS256") {
    throw authError("unexpected id_token alg");
  }
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) {
    throw authError("id_token signing key not found in jwks");
  }
  let ok: boolean;
  try {
    const key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
    ok = verify("RSA-SHA256", Buffer.from(signingInput), key, signature);
  } catch {
    throw authError("id_token signature verification error");
  }
  if (!ok) {
    throw authError("id_token signature invalid");
  }

  const claims = payload as unknown as IdTokenClaims;
  if (claims.iss !== opts.issuer) {
    throw authError("id_token issuer mismatch");
  }
  if (claims.aud !== opts.audience) {
    throw authError("id_token audience mismatch");
  }
  if (claims.nonce !== opts.nonce) {
    throw authError("id_token nonce mismatch");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= opts.nowMs) {
    throw authError("id_token expired");
  }
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    throw authError("id_token missing subject");
  }
  if (typeof claims.email !== "string" || claims.email.length === 0) {
    throw authError("id_token missing email");
  }
  if (opts.hostedDomain !== undefined && claims.hd !== opts.hostedDomain) {
    throw authError("id_token hosted-domain not allowed");
  }
  return claims;
}
