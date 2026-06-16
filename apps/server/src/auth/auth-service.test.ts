import { oauthFlows, sessions, userIdentities, users } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RandomSource } from "../services/device-credential.js";
import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import {
  type OauthFlowConfig,
  type SessionConfig,
  consumeOauthFlow,
  createOauthFlow,
  createSession,
  provisionUser,
  resolveSession,
  revokeSession,
} from "./auth-service.js";
import { parseSessionToken, sha256Hex } from "./oidc-security.js";

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

const LATER = "2026-06-13T03:00:00.000Z"; // > any TTL after the fixed test clock

describe("auth-service: OAuth flow", () => {
  let server: TestServer;
  let config: OauthFlowConfig;
  beforeEach(async () => {
    server = await buildTestServer();
    config = { flowTtlMs: 600_000, random: seqRandom() };
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates a flow storing only hashes, and consumes it with the right state + binding", async () => {
    const { ctx, db } = server;
    const started = await createOauthFlow(ctx, config, { returnTo: "/board" });
    expect(started.state).toBeTruthy();
    expect(started.flowBinding).toBeTruthy();
    expect(started.returnTo).toBe("/board");

    const row = (await db.db.select().from(oauthFlows))[0]!;
    expect(row.status).toBe("pending");
    expect(row.stateHash).toBe(sha256Hex(started.state));
    expect(row.flowBindingHash).toBe(sha256Hex(started.flowBinding));
    // raw state/binding are never persisted
    expect(JSON.stringify(row)).not.toContain(started.state);
    expect(JSON.stringify(row)).not.toContain(started.flowBinding);

    const consumed = await consumeOauthFlow(ctx, {
      state: started.state,
      flowBinding: started.flowBinding,
    });
    expect(consumed.nonce).toBe(started.nonce);
    expect(consumed.returnTo).toBe("/board");
    expect((await db.db.select().from(oauthFlows))[0]!.status).toBe("consumed");
  });

  it("rejects wrong state, wrong flow-binding, and double-consume", async () => {
    const { ctx } = server;
    const started = await createOauthFlow(ctx, config, { returnTo: "/" });
    await expect(
      consumeOauthFlow(ctx, { state: "wrong", flowBinding: started.flowBinding }),
    ).rejects.toThrow(/invalid or expired/);
    await expect(
      consumeOauthFlow(ctx, { state: started.state, flowBinding: "wrong-binding" }),
    ).rejects.toThrow(/invalid or expired/);
    await consumeOauthFlow(ctx, { state: started.state, flowBinding: started.flowBinding });
    await expect(
      consumeOauthFlow(ctx, { state: started.state, flowBinding: started.flowBinding }),
    ).rejects.toThrow(/invalid or expired/);
  });

  it("rejects an expired flow and marks it expired", async () => {
    const { ctx, db } = server;
    const started = await createOauthFlow(ctx, config, { returnTo: "/" });
    const laterCtx = { ...ctx, clock: fixedClock(LATER) };
    await expect(
      consumeOauthFlow(laterCtx, { state: started.state, flowBinding: started.flowBinding }),
    ).rejects.toThrow(/invalid or expired/);
    expect((await db.db.select().from(oauthFlows))[0]!.status).toBe("expired");
  });

  it("sanitizes return_to at flow creation", async () => {
    const { ctx, db } = server;
    await createOauthFlow(ctx, config, { returnTo: "https://evil.com" });
    expect((await db.db.select().from(oauthFlows))[0]!.returnTo).toBe("/");
  });
});

describe("auth-service: provisionUser", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates, matches by subject, links a verified email, and rejects unverified", async () => {
    const { ctx, db } = server;
    const a = await provisionUser(ctx, {
      subject: "google-sub-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice",
    });
    expect(a.created).toBe(true);
    const userRow = (await db.db.select().from(users).where(eq(users.id, a.userId)))[0]!;
    expect(userRow.email).toBe("alice@example.com");
    expect(userRow.role).toBe("member");

    // same subject -> match, no new user
    const a2 = await provisionUser(ctx, {
      subject: "google-sub-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice",
    });
    expect(a2).toEqual({ userId: a.userId, created: false });

    // new subject, same verified email -> link to the existing user
    const linked = await provisionUser(ctx, {
      subject: "google-sub-2",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice Alt",
    });
    expect(linked).toEqual({ userId: a.userId, created: false });
    const identities = await db.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.userId, a.userId));
    expect(identities.map((i) => i.subject).sort()).toEqual(["google-sub-1", "google-sub-2"]);

    // unverified email -> rejected (no create, no link)
    await expect(
      provisionUser(ctx, {
        subject: "google-sub-3",
        email: "bob@example.com",
        emailVerified: false,
        displayName: "Bob",
      }),
    ).rejects.toThrow(/not verified/);
  });
});

describe("auth-service: sessions", () => {
  let server: TestServer;
  let userId: string;
  const config: SessionConfig = { ttlMs: 3_600_000, random: seqRandom(50) };
  beforeEach(async () => {
    server = await buildTestServer();
    const provisioned = await provisionUser(server.ctx, {
      subject: "s",
      email: "sess@example.com",
      emailVerified: true,
      displayName: "Sess",
    });
    userId = provisioned.userId;
  });
  afterEach(async () => {
    await server.close();
  });

  it("creates a resolvable session and rejects tampered/garbage tokens", async () => {
    const { ctx } = server;
    const s = await createSession(ctx, config, { userId });
    expect(s.raw.startsWith("sk_session_")).toBe(true);
    expect(await resolveSession(ctx, s.raw)).toEqual({ userId, sessionId: s.sessionId });

    expect(await resolveSession(ctx, "garbage")).toBeNull();
    const parsed = parseSessionToken(s.raw)!;
    expect(await resolveSession(ctx, `sk_session_${parsed.lookup}_${parsed.secret}x`)).toBeNull();
  });

  it("revokes a session (idempotent) so it no longer resolves", async () => {
    const { ctx } = server;
    const s = await createSession(ctx, config, { userId });
    expect((await revokeSession(ctx, s.sessionId)).revoked).toBe(true);
    expect(await resolveSession(ctx, s.raw)).toBeNull();
    expect((await revokeSession(ctx, s.sessionId)).revoked).toBe(false);
  });

  it("does not resolve an expired session", async () => {
    const { ctx } = server;
    const s = await createSession(ctx, { ttlMs: 1000, random: seqRandom(80) }, { userId });
    const laterCtx = { ...ctx, clock: fixedClock(LATER) };
    expect(await resolveSession(laterCtx, s.raw)).toBeNull();
    // never persists the raw secret
    const row = (await server.db.db.select().from(sessions).where(eq(sessions.id, s.sessionId)))[0]!;
    const parsed = parseSessionToken(s.raw)!;
    expect(JSON.stringify(row)).not.toContain(parsed.secret);
  });
});
