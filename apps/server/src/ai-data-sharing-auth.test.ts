import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { createSession, provisionUser } from "./auth/auth-service.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";

let server: TestServer;
afterEach(async () => { await server?.close(); });
it("binds privacy grants and withdrawal to authenticated owner/member sessions", async () => {
  const policy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Fixture recipient", privacy_url: "https://provider.example.com/privacy" }] });
  server = await buildTestServer({ aiDataSharingPolicy: policy, authConfig: { enforceApiAuth: true },
    deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: "fixture" } });
  const member = await provisionUser(server.ctx, { subject: "privacy-member", email: "privacy-member@example.test", emailVerified: true, displayName: "Privacy member" });
  const owner = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" });
  const memberSession = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: member.userId });
  const path = "/api/v1/privacy/ai-sharing";
  for (const method of ["GET", "POST", "DELETE"] as const) {
    const response = await server.app.inject({ method, url: path + (method === "GET" ? "" : "/consent") });
    expect(response.statusCode).toBe(401);
  }
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  const grant = async (token: string, userId: string) => {
    const response = await server.app.inject({ method: "POST", url: `${path}/consent`, headers: headers(token), payload: { policy_version: policy.version, expected_user_id: userId } });
    expect(response.statusCode).toBe(200); return response.json().consent;
  };
  const ownerGrant = await grant(owner.raw, "user_owner");
  expect((await server.app.inject({ method: "GET", url: path, headers: headers(memberSession.raw) })).json().consent).toBeNull();
  for (const [method, payload] of [["POST", { policy_version: policy.version, expected_user_id: "user_owner" }],
    ["DELETE", { stop_my_agent_work: true, expected_user_id: "user_owner" }]] as const) {
    expect((await server.app.inject({ method, url: `${path}/consent`, headers: headers(memberSession.raw), payload })).statusCode).toBe(409);
  }
  expect((await server.app.inject({ method: "GET", url: path, headers: headers(memberSession.raw) })).json().consent).toBeNull();
  const memberGrant = await grant(memberSession.raw, member.userId);
  expect(memberGrant.id).not.toBe(ownerGrant.id);
  expect((await server.app.inject({ method: "DELETE", url: `${path}/consent`, headers: headers(memberSession.raw), payload: { stop_my_agent_work: true, expected_user_id: member.userId } })).statusCode).toBe(200);
  expect((await server.app.inject({ method: "GET", url: path, headers: headers(owner.raw) })).json().consent.id).toBe(ownerGrant.id);
  expect((await server.app.inject({ method: "GET", url: path, headers: headers(memberSession.raw) })).json().consent).toBeNull();
});
