import { deviceTokens, organizations, users } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimPairing, createPairing, enrollDeviceComputer, resolveNodeToken, revokeDevice } from "../services/device-service.js";
import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { createSession, provisionUser } from "./auth-service.js";

describe("native and team API authentication", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer({ authConfig: { enforceApiAuth: true } }); });
  afterEach(async () => { await server.close(); });

  async function sessionFor(email: string, role: "owner" | "admin" | "member" = "member") {
    const { userId } = await provisionUser(server.ctx, {
      subject: email, email, emailVerified: true, displayName: email,
    });
    await server.db.db.update(users).set({ role }).where(eq(users.id, userId));
    return { userId, ...(await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId })) };
  }

  async function paired(userId: string) {
    const config = { pepper: server.ctx.deviceAuth.pairingPepper, ttlMs: 600_000 };
    const pairing = await createPairing({ ...server.ctx, actorUserId: userId }, config, { createdByUserId: userId });
    return claimPairing(server.ctx, config, {
      code: pairing.code, platform: "windows", displayName: "Native test", appVersion: "0.1.0",
    });
  }

  it("authenticates session bearers, attributes commands to them, and revokes on logout", async () => {
    const s = await sessionFor("native@example.com");
    const headers = { authorization: `Bearer ${s.raw}` };
    const current = await server.app.inject({ url: "/auth/session", headers });
    expect(current.statusCode).toBe(200);
    expect(current.json().user).toMatchObject({ id: s.userId, role: "member" });
    expect(current.headers["cache-control"]).toBe("no-store");
    const boot = await server.app.inject({ url: "/api/v1/bootstrap", headers });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().actor.id).toBe(s.userId);
    expect((await server.app.inject({ method: "POST", url: "/auth/logout", headers })).statusCode).toBe(204);
    expect((await server.app.inject({ url: "/auth/session", headers })).statusCode).toBe(401);
    expect((await server.app.inject({ url: "/api/v1/bootstrap", headers })).statusCode).toBe(401);
  });

  it("rejects every explicit invalid bearer without falling back to a valid cookie", async () => {
    const s = await sessionFor("cookie@example.com");
    for (const authorization of ["Bearer bogus", "Bearer", "Basic bogus", "Bearer bad extra"]) {
      for (const url of ["/auth/session", "/api/v1/bootstrap", "/auth/logout"]) {
        const response = await server.app.inject({ method: url.endsWith("logout") ? "POST" : "GET", url,
          headers: { authorization }, cookies: { artoo_session: s.raw } });
        expect(response.statusCode, `${authorization} ${url}`).toBe(401);
      }
    }
    expect((await server.app.inject({ url: "/auth/session", cookies: { artoo_session: s.raw } })).statusCode).toBe(200);
  });

  it("runs the owner Web pairing -> native claim -> attributed REST -> logout flow", async () => {
    const owner = await sessionFor("owner@example.com", "owner");
    const pairing = await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings",
      cookies: { artoo_session: owner.raw }, payload: { intended_platform: "windows" } });
    expect(pairing.statusCode).toBe(201);
    const claim = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim",
      payload: { code: pairing.json().code, platform: "windows", display_name: "Native", app_version: "0.1.0" } });
    expect(claim.statusCode).toBe(201);
    const { control_token, node_token, device } = claim.json();
    const headers = { authorization: `Bearer ${control_token}` };
    const identity = await server.app.inject({ url: "/auth/session", headers });
    expect(identity.json()).toMatchObject({ user: { id: owner.userId, role: "owner" }, device_id: device.id });
    const boot = await server.app.inject({ url: "/api/v1/bootstrap", headers });
    expect(boot.statusCode).toBe(200);
    expect(boot.json().actor.id).toBe(owner.userId);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.id}/enroll`, headers })).statusCode)
      .toBe(200);
    expect((await server.app.inject({ url: "/api/v1/bootstrap", headers: { authorization: `Bearer ${node_token}` } })).statusCode)
      .toBe(401);
    expect((await server.app.inject({ method: "POST", url: "/auth/logout", headers })).statusCode).toBe(204);
    expect((await server.app.inject({ url: "/auth/session", headers })).statusCode).toBe(401);
    // Signing out the control application must not shut down compute credentials.
    expect(await resolveNodeToken(server.ctx, node_token)).not.toBeNull();
    expect((await server.app.inject({ url: "/auth/session", cookies: { artoo_session: owner.raw } })).statusCode).toBe(200);
  });

  it.each(["ios", "macos"])("pairs a member's own %s client without granting administrator or compute permissions", async (platform) => {
    const owner = await sessionFor("owner@example.com", "owner");
    const member = await sessionFor("member@example.com");
    const pairing = await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings",
      cookies: { artoo_session: member.raw }, payload: {
        intended_platform: platform, created_by_user_id: owner.userId, enrolled_by_user_id: owner.userId,
        organization_id: "org_other", role: "owner",
      } });
    expect(pairing.statusCode).toBe(201);
    expect(pairing.json().pairing).toMatchObject({ created_by_user_id: member.userId, organization_id: "org_default" });
    const claim = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim",
      payload: { code: pairing.json().code, platform, display_name: "Member device", app_version: "0.1.0",
        enrolled_by_user_id: owner.userId, role: "owner" } });
    expect(claim.statusCode).toBe(201);
    const { control_token, device } = claim.json();
    expect(device).toMatchObject({ enrolled_by_user_id: member.userId, computer_id: null });
    await expect(enrollDeviceComputer({ ...server.ctx, actorUserId: member.userId }, { deviceId: device.id }))
      .rejects.toThrow(/owner or admin/);
    for (const token of [member.raw, control_token]) {
      const headers = { authorization: `Bearer ${token}` };
      const identity = await server.app.inject({ url: "/auth/session", headers });
      expect(identity.statusCode).toBe(200);
      expect(identity.json().user).toMatchObject({ id: member.userId, role: "member" });
      const boot = await server.app.inject({ url: "/api/v1/bootstrap", headers });
      expect(boot.statusCode).toBe(200);
      expect(boot.json().actor.id).toBe(member.userId);
      for (const url of ["/api/v1/projects", "/api/v1/skills/install", `/api/v1/devices/${device.id}/enroll`]) {
        expect((await server.app.inject({ method: "POST", url, headers, payload: {} })).statusCode, url).toBe(403);
      }
      const next = await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", headers, payload: {} });
      expect(next.statusCode).toBe(201);
      expect(next.json().pairing.created_by_user_id).toBe(member.userId);
    }
    if (platform === "macos") {
      const enroll = await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.id}/enroll`,
        cookies: { artoo_session: owner.raw }, payload: {} });
      expect(enroll.statusCode).toBe(200);
      expect(enroll.json().computer_id).toMatch(/^computer_/);
    }
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.id}/revoke`,
      headers: { authorization: `Bearer ${control_token}` } })).statusCode).toBe(200);
    expect((await server.app.inject({ url: "/auth/session", headers: { authorization: `Bearer ${control_token}` } })).statusCode).toBe(401);
  });

  it("keeps pairing identities, claims and device administration inside the current organization", async () => {
    const owner = await sessionFor("owner@example.com", "owner");
    const member = await sessionFor("member@example.com");
    const foreign = { ...server.ctx, organizationId: "org_other", actorUserId: "user_other" };
    await server.db.db.insert(organizations).values({ id: foreign.organizationId, name: "Other team", createdAt: foreign.clock.nowIso() });
    await server.db.db.insert(users).values({ id: foreign.actorUserId, organizationId: foreign.organizationId,
      email: "foreign@example.com", displayName: "Foreign owner", role: "owner", createdAt: foreign.clock.nowIso() });
    const config = { pepper: server.ctx.deviceAuth.pairingPepper, ttlMs: 600_000 };
    await expect(createPairing({ ...server.ctx, actorUserId: member.userId }, config, { createdByUserId: owner.userId }))
      .rejects.toThrow(/current team member/);
    await expect(createPairing({ ...server.ctx, actorUserId: foreign.actorUserId }, config, { createdByUserId: foreign.actorUserId }))
      .rejects.toThrow(/current team member/);
    const code = await createPairing(foreign, config, { createdByUserId: foreign.actorUserId });
    const claimBody = { code: code.code, platform: "macos", display_name: "Foreign device", app_version: "0.1.0" };
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: claimBody })).statusCode).toBe(400);
    const device = await claimPairing(foreign, config, { code: code.code, platform: "macos", displayName: "Foreign device", appVersion: "0.1.0" });
    expect((await server.app.inject({ url: "/auth/session", headers: { authorization: `Bearer ${device.controlToken}` } })).statusCode).toBe(401);
    for (const action of ["enroll", "revoke"]) {
      expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.device.id}/${action}`,
        cookies: { artoo_session: member.raw }, payload: {} })).statusCode).toBe(403);
      expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${device.device.id}/${action}`,
        cookies: { artoo_session: owner.raw }, payload: {} })).statusCode).toBe(404);
    }
  });

  it("rejects expired user and device sessions and revoked devices", async () => {
    const s = await sessionFor("exp@example.com");
    const first = await paired(s.userId);
    const second = await paired(s.userId);
    await revokeDevice(server.ctx, second.device.id);
    await server.db.db.update(deviceTokens).set({ expiresAt: "2026-06-12T00:00:00.000Z" })
      .where(eq(deviceTokens.deviceId, first.device.id));
    server.ctx.clock = fixedClock("2026-06-14T00:00:00.000Z");
    for (const token of [s.raw, first.controlToken, second.controlToken]) {
      expect((await server.app.inject({ url: "/api/v1/bootstrap", headers: { authorization: `Bearer ${token}` } })).statusCode)
        .toBe(401);
    }
  });

  it("allows member task work but denies admin operations and cross-owner device actions", async () => {
    const member = await sessionFor("member@example.com");
    const other = await sessionFor("other@example.com");
    const own = await paired(member.userId);
    const foreign = await paired(other.userId);
    const headers = { authorization: `Bearer ${member.raw}` };
    for (const url of ["/api/v1/skills/install", "/api/v1/projects",
      `/api/v1/devices/${foreign.device.id}/revoke`, `/api/v1/devices/${foreign.device.id}/enroll`]) {
      expect((await server.app.inject({ method: "POST", url, headers, payload: {} })).statusCode, url).toBe(403);
    }
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${own.device.id}/enroll`, headers })).statusCode)
      .toBe(403);
    const task = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers,
      payload: { project_id: "proj_artoo", title: "Member work", acceptance_criteria: ["done"] } });
    expect(task.statusCode).toBe(201);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${own.device.id}/revoke`, headers })).statusCode)
      .toBe(200);
  });

  it("allows an admin to pair and administer another member's device", async () => {
    const admin = await sessionFor("admin@example.com", "admin");
    const member = await sessionFor("member@example.com");
    const foreign = await paired(member.userId);
    const headers = { authorization: `Bearer ${admin.raw}` };
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", headers, payload: {} })).statusCode)
      .toBe(201);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${foreign.device.id}/enroll`, headers })).statusCode)
      .toBe(200);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/devices/${foreign.device.id}/revoke`, headers })).statusCode)
      .toBe(200);
  });

  it("keeps bootstrap, sessions and native permissions aligned after owner policy changes", async () => {
    const former = await sessionFor("former@example.com", "owner");
    const successor = await sessionFor("successor@example.com");
    const admin = await sessionFor("admin@example.com", "admin");
    const native = await paired(former.userId);
    server.ctx.authConfig.ownerEmails = ["successor@example.com"];
    server.ctx.authConfig.allowedEmails = ["former@example.com", "successor@example.com", "admin@example.com"];
    for (const [token, role] of [[former.raw, "member"], [native.controlToken, "member"], [successor.raw, "owner"], [admin.raw, "admin"]]) {
      const headers = { authorization: `Bearer ${token}` };
      for (const url of ["/auth/session", "/api/v1/bootstrap"]) {
        const response = await server.app.inject({ url, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json().user.role, url).toBe(role);
      }
      const pairing = await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", headers, payload: {} });
      expect(pairing.statusCode).toBe(201);
      const adminAction = await server.app.inject({ method: "POST", url: `/api/v1/devices/${native.device.id}/enroll`, headers });
      expect(adminAction.statusCode).toBe(role === "member" ? 403 : 200);
    }
    expect((await server.db.db.select().from(users).where(eq(users.id, former.userId)))[0]?.role).toBe("owner");
    expect((await server.db.db.select().from(users).where(eq(users.id, successor.userId)))[0]?.role).toBe("member");
  });

  it("does not exempt URL prefixes or the wrong method from authentication", async () => {
    for (const url of ["/api/v1/node-secret", "/api/v1/ws-secret", "/api/v1/devices/claim/extra", "/api/v1/devices/claim"]) {
      expect((await server.app.inject({ method: "GET", url })).statusCode, url).toBe(401);
    }
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: {} })).statusCode).toBe(400);
  });
});
