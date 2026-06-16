/**
 * Google Auth storage service (#34 slice 34-1b). Owns the OAuth flow lifecycle,
 * user provisioning from a verified provider identity, and server-owned
 * revocable sessions. Pure of HTTP — the endpoints (34-1c) call these.
 *
 * Security invariants:
 *  - `state` is round-tripped through the IdP and looked up by its hash; the
 *    flow is single-use (atomic `pending -> consumed`) with a short TTL.
 *  - the callback is bound to the initiating browser: a high-entropy
 *    `flow_binding` lives only in the client's HttpOnly cookie and is verified
 *    (constant-time, against its stored hash) BEFORE the state is consumed
 *    (codex hard requirement #2).
 *  - sessions store only `{lookup, sha256(secret)}`; the raw token is the cookie
 *    value, verified in constant time. Revocation is durable.
 *  - all failure modes use a uniform non-enumerating error.
 */
import { oauthFlows, sessions, userIdentities, users } from "@artoo/db";
import { ID_PREFIXES } from "@artoo/domain";
import { and, eq, isNull } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { cryptoRandomSource, type RandomSource } from "../services/device-credential.js";
import {
  constantTimeEqualHex,
  generateOpaqueToken,
  generatePkce,
  generateSessionToken,
  parseSessionToken,
  sanitizeReturnTo,
  sha256Hex,
} from "./oidc-security.js";

const PROVIDER = "google" as const;

function isoPlusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function isExpired(expiresAtIso: string, nowIso: string): boolean {
  return Date.parse(expiresAtIso) <= Date.parse(nowIso);
}

/** Uniform non-enumerating rejection for every OAuth-flow failure mode. */
function invalidFlow(): AppError {
  return AppError.validation("invalid or expired authentication flow");
}

// ---------------------------------------------------------------------------
// OAuth flow
// ---------------------------------------------------------------------------

export interface OauthFlowConfig {
  /** Flow lifetime in ms (short — e.g. 5-10 min). */
  flowTtlMs: number;
  /** Entropy source; defaults to the CSPRNG. */
  random?: RandomSource;
}

export interface StartedFlow {
  /** CSRF token round-tripped through the IdP. */
  state: string;
  /** Replay-binding nonce echoed in the id_token. */
  nonce: string;
  /** PKCE S256 code_challenge sent to the IdP. */
  codeChallenge: string;
  /** High-entropy secret for the HttpOnly flow cookie (binds callback to client). */
  flowBinding: string;
  /** Sanitized same-origin return path. */
  returnTo: string;
}

/** Begin an OAuth flow: persist its server-side state and return the values the
 *  start endpoint needs (state/nonce/challenge -> IdP, flowBinding -> cookie). */
export async function createOauthFlow(
  ctx: ServerContext,
  config: OauthFlowConfig,
  input: { returnTo?: string | undefined },
): Promise<StartedFlow> {
  const random = config.random ?? cryptoRandomSource;
  const now = ctx.clock.nowIso();
  const state = generateOpaqueToken(random);
  const nonce = generateOpaqueToken(random);
  const flowBinding = generateOpaqueToken(random);
  const { verifier, challenge } = generatePkce(random);
  const returnTo = sanitizeReturnTo(input.returnTo);
  await ctx.db.db.insert(oauthFlows).values({
    id: ctx.idGen.generate(ID_PREFIXES.oauthFlow),
    organizationId: ctx.organizationId,
    provider: PROVIDER,
    stateHash: sha256Hex(state),
    nonce,
    codeVerifier: verifier,
    flowBindingHash: sha256Hex(flowBinding),
    returnTo,
    status: "pending",
    createdAt: now,
    expiresAt: isoPlusMs(now, config.flowTtlMs),
    consumedAt: null,
  });
  return { state, nonce, codeChallenge: challenge, flowBinding, returnTo };
}

export interface ConsumedFlow {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

/**
 * Consume an OAuth flow on callback: look up by `state`, reject if missing /
 * expired / already consumed, verify the `flow_binding` cookie BEFORE consuming
 * (codex req #2), then atomically transition `pending -> consumed` (single-use).
 * Returns the nonce + PKCE verifier + return path for the token exchange.
 */
export async function consumeOauthFlow(
  ctx: ServerContext,
  input: { state: string; flowBinding: string },
): Promise<ConsumedFlow> {
  const now = ctx.clock.nowIso();
  const stateHash = sha256Hex(input.state);

  // Pre-check + expiry cleanup outside the consuming transaction (which rolls
  // back on rejection), mirroring #28 claimPairing.
  const flow = (
    await ctx.db.db
      .select()
      .from(oauthFlows)
      .where(and(eq(oauthFlows.stateHash, stateHash), eq(oauthFlows.organizationId, ctx.organizationId)))
  )[0];
  if (flow === undefined || flow.status !== "pending") {
    throw invalidFlow();
  }
  if (isExpired(flow.expiresAt, now)) {
    await ctx.db.db
      .update(oauthFlows)
      .set({ status: "expired" })
      .where(and(eq(oauthFlows.id, flow.id), eq(oauthFlows.status, "pending")));
    throw invalidFlow();
  }
  // Bind the callback to the initiating browser BEFORE consuming the state.
  if (!constantTimeEqualHex(sha256Hex(input.flowBinding), flow.flowBindingHash)) {
    throw invalidFlow();
  }

  const consumed = await ctx.db.db
    .update(oauthFlows)
    .set({ status: "consumed", consumedAt: now })
    .where(and(eq(oauthFlows.id, flow.id), eq(oauthFlows.status, "pending")))
    .returning({ id: oauthFlows.id });
  if (consumed.length === 0) {
    throw invalidFlow(); // lost the race to a concurrent callback
  }
  return { nonce: flow.nonce, codeVerifier: flow.codeVerifier, returnTo: flow.returnTo };
}

// ---------------------------------------------------------------------------
// User provisioning
// ---------------------------------------------------------------------------

export interface ProvisionInput {
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
}

export interface ProvisionedUser {
  userId: string;
  created: boolean;
}

/**
 * Resolve a Google identity to a user. Matches an existing `user_identities`
 * row by (provider, subject); otherwise links to an existing user iff the email
 * is provider-verified (account linking), else creates a new `member` user. An
 * unverified email that collides with an existing account is rejected (no
 * silent takeover).
 */
export async function provisionUser(
  ctx: ServerContext,
  input: ProvisionInput,
): Promise<ProvisionedUser> {
  const now = ctx.clock.nowIso();
  return ctx.db.transaction(async (tx) => {
    const identity = (
      await tx
        .select()
        .from(userIdentities)
        .where(
          and(
            eq(userIdentities.provider, PROVIDER),
            eq(userIdentities.subject, input.subject),
            eq(userIdentities.organizationId, ctx.organizationId),
          ),
        )
    )[0];
    if (identity !== undefined) {
      return { userId: identity.userId, created: false };
    }
    // New provisioning (link OR create) requires a provider-verified email, so
    // an unverified address can never establish or attach to an account.
    if (!input.emailVerified) {
      throw AppError.validation("provider email is not verified");
    }

    const byEmail = (
      await tx
        .select()
        .from(users)
        .where(and(eq(users.email, input.email), eq(users.organizationId, ctx.organizationId)))
    )[0];
    if (byEmail !== undefined) {
      await tx.insert(userIdentities).values(identityRow(ctx, byEmail.id, input, now));
      return { userId: byEmail.id, created: false };
    }

    const userId = ctx.idGen.generate(ID_PREFIXES.user);
    await tx.insert(users).values({
      id: userId,
      organizationId: ctx.organizationId,
      email: input.email,
      displayName: input.displayName.trim() || input.email,
      role: "member",
      createdAt: now,
    });
    await tx.insert(userIdentities).values(identityRow(ctx, userId, input, now));
    return { userId, created: true };
  });
}

function identityRow(
  ctx: ServerContext,
  userId: string,
  input: ProvisionInput,
  now: string,
): typeof userIdentities.$inferInsert {
  return {
    id: ctx.idGen.generate(ID_PREFIXES.userIdentity),
    organizationId: ctx.organizationId,
    userId,
    provider: PROVIDER,
    subject: input.subject,
    email: input.email,
    createdAt: now,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionConfig {
  /** Session lifetime in ms. */
  ttlMs: number;
  random?: RandomSource;
}

export interface CreatedSession {
  /** Raw session token — set as the cookie ONCE; never persisted. */
  raw: string;
  sessionId: string;
  expiresAt: string;
}

export async function createSession(
  ctx: ServerContext,
  config: SessionConfig,
  input: { userId: string },
): Promise<CreatedSession> {
  const random = config.random ?? cryptoRandomSource;
  const token = generateSessionToken(random);
  const id = ctx.idGen.generate(ID_PREFIXES.session);
  const now = ctx.clock.nowIso();
  const expiresAt = isoPlusMs(now, config.ttlMs);
  await ctx.db.db.insert(sessions).values({
    id,
    organizationId: ctx.organizationId,
    userId: input.userId,
    tokenLookup: token.lookup,
    tokenHash: token.secretHash,
    createdAt: now,
    expiresAt,
    lastSeenAt: null,
    revokedAt: null,
  });
  return { raw: token.raw, sessionId: id, expiresAt };
}

export interface ResolvedSession {
  userId: string;
  sessionId: string;
}

/**
 * Resolve a raw session token to its user, or `null` if malformed, unknown,
 * revoked, expired, or tampered. Look up by the non-secret `lookup`, then
 * CONSTANT-TIME verify the secret. Does not write (no lastSeen update) so auth
 * is not a write storm.
 */
export async function resolveSession(
  ctx: ServerContext,
  raw: string,
): Promise<ResolvedSession | null> {
  const parsed = parseSessionToken(raw);
  if (parsed === null) {
    return null;
  }
  const row = (
    await ctx.db.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenLookup, parsed.lookup), eq(sessions.organizationId, ctx.organizationId)))
  )[0];
  if (row === undefined || row.revokedAt !== null) {
    return null;
  }
  if (!constantTimeEqualHex(sha256Hex(parsed.secret), row.tokenHash)) {
    return null;
  }
  if (isExpired(row.expiresAt, ctx.clock.nowIso())) {
    return null;
  }
  return { userId: row.userId, sessionId: row.id };
}

/** Revoke a session (logout). Idempotent: re-revoking returns revoked=false. */
export async function revokeSession(
  ctx: ServerContext,
  sessionId: string,
): Promise<{ revoked: boolean }> {
  const now = ctx.clock.nowIso();
  const res = await ctx.db.db
    .update(sessions)
    .set({ revokedAt: now })
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.organizationId, ctx.organizationId),
        isNull(sessions.revokedAt),
      ),
    )
    .returning({ id: sessions.id });
  return { revoked: res.length > 0 };
}
