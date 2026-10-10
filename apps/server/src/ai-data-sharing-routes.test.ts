import { runs, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { requireRunAiSharingAuthorization } from "./services/ai-data-sharing-service.js";

const disclosure = buildAiDataSharingPolicy({ mode: "external", providers: [
  { id: "fixture", name: "Fixture AI recipient", privacy_url: "https://provider.example.com/privacy" },
] });
let server: TestServer;
beforeEach(async () => { server = await buildTestServer({ aiDataSharingPolicy: disclosure, enableDevRoutes: false }); });
afterEach(async () => { await server?.close(); });
async function readyTask() {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title: "Consent-protected work", acceptance_criteria: ["Keep the fixture private until permission"], required_capabilities: ["code.modify"],
  } });
  expect(response.statusCode).toBe(201);
  const id = response.json().task.id as string;
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
  return id;
}
async function allow() {
  const response = await server.app.inject({ method: "POST", url: "/api/v1/privacy/ai-sharing/consent", payload: { policy_version: disclosure.version, expected_user_id: "user_owner" } });
  expect(response.statusCode).toBe(200); return response.json();
}

describe("AI consent HTTP boundary", () => {
  it("rejects assignment without mutation, then permits the same idempotent request after explicit agreement", async () => {
    const id = await readyTask();
    const request = { method: "POST" as const, url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" }, headers: { "idempotency-key": "same-private-request" } };
    const denied = await server.app.inject(request);
    expect(denied.statusCode).toBe(428);
    expect(denied.json().error.code).toBe("ai_consent_required");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
    expect((await server.db.db.select().from(tasks).where(eq(tasks.id, id)))[0]?.status).toBe("ready");
    const granted = await allow();
    const accepted = await server.app.inject(request);
    expect(accepted.statusCode).toBe(200);
    const stored = (await server.db.db.select().from(runs))[0]!;
    expect(stored.requestedByUserId).toBe("user_owner");
    expect(stored.aiDataSharingConsentId).toBe(granted.consent.id);
    expect(stored.aiDataSharingPolicyVersion).toBe(disclosure.version);
  });

  it("withdraws permission despite an offline computer and never claims its process stopped", async () => {
    const id = await readyTask(); await allow();
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } })).statusCode).toBe(200);
    const original = (await server.db.db.select().from(runs))[0]!;
    expect((await server.app.inject({ method: "DELETE", url: "/api/v1/privacy/ai-sharing/consent", payload: {} })).statusCode).toBe(400);
    const withdrawn = await server.app.inject({ method: "DELETE", url: "/api/v1/privacy/ai-sharing/consent", payload: { stop_my_agent_work: true, expected_user_id: "user_owner" } });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().consent).toBeNull();
    expect(withdrawn.json().unconfirmed_stops).toContainEqual({ kind: "run", id: original.id });
    expect((await server.db.db.select().from(runs))[0]?.status).toBe("queued");
    await expect(requireRunAiSharingAuthorization(server.ctx, original)).rejects.toMatchObject({ code: "ai_consent_required" });
    await allow();
    await expect(requireRunAiSharingAuthorization(server.ctx, original)).rejects.toMatchObject({ code: "ai_consent_required" });
  });

  it("refuses stale policy versions and cannot grant permission to another account through a body field", async () => {
    for (const payload of [{ policy_version: "stale", expected_user_id: "user_owner" }, { policy_version: disclosure.version, user_id: "user_member" }]) {
      const result = await server.app.inject({ method: "POST", url: "/api/v1/privacy/ai-sharing/consent", payload });
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect((await server.app.inject({ method: "GET", url: "/api/v1/privacy/ai-sharing" })).json().consent).toBeNull();
  });

  it("keeps workspace reading available when recipients are unconfigured but fails AI work closed", async () => {
    server.ctx.aiDataSharingPolicy = null;
    const id = await readyTask();
    expect((await server.app.inject({ method: "GET", url: "/api/v1/bootstrap" })).statusCode).toBe(200);
    const response = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } });
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe("ai_sharing_unconfigured");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });
});
