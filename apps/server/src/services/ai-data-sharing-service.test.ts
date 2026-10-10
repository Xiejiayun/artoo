import { aiDataSharingConsents, users } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAiDataSharingPolicy } from "../config/ai-data-sharing.js";
import { buildTestServer, type TestServer } from "../test-support.js";
import { aiDataSharingState, grantAiDataSharingConsent, requireAiSharingAuthorization, revokeAiDataSharingConsent } from "./ai-data-sharing-service.js";

const policy = () => buildAiDataSharingPolicy({ mode: "external", providers: [
  { id: "test", name: "Test AI recipient", privacy_url: "https://provider.example.com/privacy" },
] });
let server: TestServer;
beforeEach(async () => { server = await buildTestServer(); server.ctx.aiDataSharingPolicy = policy(); });
afterEach(async () => { await server?.close(); });

describe("durable AI sharing permission", () => {
  it("requires actual permission and isolates it by user and organization", async () => {
    expect((await aiDataSharingState(server.ctx)).consent).toBeNull();
    await expect(requireAiSharingAuthorization(server.ctx)).rejects.toMatchObject({ code: "ai_consent_required", httpStatus: 428 });
    const accepted = await grantAiDataSharingConsent(server.ctx, policy().version);
    expect(accepted.consent?.id).toBeTruthy();
    expect((await requireAiSharingAuthorization(server.ctx)).consentId).toBe(accepted.consent?.id);
    await server.db.db.insert(users).values({ id: "consent_member", organizationId: "org_default", email: "consent-member@example.test", displayName: "Member", role: "member", createdAt: server.ctx.clock.nowIso() });
    const member = { ...server.ctx, actorUserId: "consent_member" };
    await expect(requireAiSharingAuthorization(member)).rejects.toMatchObject({ code: "ai_consent_required" });
    await expect(grantAiDataSharingConsent({ ...server.ctx, organizationId: "other" }, policy().version)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("refuses a stale disclosure and retains the prior grant snapshot", async () => {
    const first = await grantAiDataSharingConsent(server.ctx, policy().version);
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({ mode: "external", providers: [
      { id: "new", name: "New recipient", privacy_url: "https://new.example.com/privacy" },
    ] });
    await expect(requireAiSharingAuthorization(server.ctx)).rejects.toMatchObject({ code: "ai_consent_required" });
    await expect(grantAiDataSharingConsent(server.ctx, policy().version)).rejects.toMatchObject({ code: "conflict" });
    const second = await grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version);
    expect(second.consent?.id).not.toBe(first.consent?.id);
    const original = (await server.db.db.select().from(aiDataSharingConsents).where(eq(aiDataSharingConsents.id, first.consent!.id)))[0]!;
    expect(original.revokedAt).not.toBeNull();
    expect(original.policySnapshot).toEqual(policy());
  });

  it("re-consenting never reauthorizes a withdrawn queued request", async () => {
    await grantAiDataSharingConsent(server.ctx, policy().version);
    const queued = await requireAiSharingAuthorization(server.ctx);
    await revokeAiDataSharingConsent(server.ctx);
    expect((await aiDataSharingState(server.ctx)).consent).toBeNull();
    await expect(requireAiSharingAuthorization(server.ctx, server.db.db, queued)).rejects.toMatchObject({ code: "ai_consent_required" });
    await grantAiDataSharingConsent(server.ctx, policy().version);
    expect((await requireAiSharingAuthorization(server.ctx)).consentId).not.toBe(queued.consentId);
    await expect(requireAiSharingAuthorization(server.ctx, server.db.db, queued)).rejects.toMatchObject({ code: "ai_consent_required" });
    await expect(requireAiSharingAuthorization(server.ctx, server.db.db, { consentId: null, policyVersion: null })).rejects.toMatchObject({ code: "ai_consent_required" });
  });

  it("serializes duplicate grants and permits withdrawal even after configuration is removed", async () => {
    const grants = await Promise.all([grantAiDataSharingConsent(server.ctx, policy().version), grantAiDataSharingConsent(server.ctx, policy().version)]);
    expect(grants[0].consent?.id).toBe(grants[1].consent?.id);
    expect(await server.db.db.select().from(aiDataSharingConsents)).toHaveLength(1);
    server.ctx.aiDataSharingPolicy = null;
    await revokeAiDataSharingConsent(server.ctx);
    await expect(requireAiSharingAuthorization(server.ctx)).rejects.toMatchObject({ code: "ai_sharing_unconfigured" });
    expect((await server.db.db.select().from(aiDataSharingConsents))[0]?.revokedAt).not.toBeNull();
  });

  it("only an explicit local declaration avoids external consent", async () => {
    server.ctx.aiDataSharingPolicy = null;
    await expect(requireAiSharingAuthorization(server.ctx)).rejects.toMatchObject({ code: "ai_sharing_unconfigured" });
    server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({ mode: "local", providers: [] });
    expect((await requireAiSharingAuthorization(server.ctx)).consentId).toBeNull();
    await expect(grantAiDataSharingConsent(server.ctx, server.ctx.aiDataSharingPolicy.version)).rejects.toMatchObject({ code: "invalid_state" });
  });
});
