import { WebSocket } from "ws";
import { agentInstances, agents, contentReports, messages, notifications } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSession, provisionUser } from "./auth/auth-service.js";
import { resolveNodeToken } from "./services/device-service.js";
import { REMOVED_MESSAGE } from "./services/content-moderation-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const sockets: WebSocket[] = [];
let authenticatedSockets = 0;
let server: TestServer, owner: string, member: string, memberId: string, roomId: string;
const identity = { subject: "moderation-member", email: "moderation-member@example.test", emailVerified: true, displayName: "Member" };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
beforeEach(async () => {
  authenticatedSockets = 0;
  server = await buildTestServer({ clientWsHooks: { revalidateIntervalMs: 20, onAuthenticated: () => { authenticatedSockets++; } }, authConfig: { enforceApiAuth: true }, deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: "moderation-fixture" } });
  owner = (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" })).raw;
  memberId = (await provisionUser(server.ctx, identity)).userId;
  member = (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: memberId })).raw;
  const channel = await server.app.inject({ method: "POST", url: "/api/v1/channels", headers: auth(owner), payload: { project_id: "proj_artoo", name: "moderation-fixture" } });
  expect(channel.statusCode).toBe(201); roomId = channel.json().channel.id;
});
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await server?.close(); });
const post = (url: string, payload: Record<string, unknown>, token = owner) => server.app.inject({ method: "POST", url, headers: auth(token), payload });
const get = (url: string, token = owner) => server.app.inject({ method: "GET", url, headers: auth(token) });
const message = (body: string, token = member, rest = {}) => post(`/api/v1/rooms/${roomId}/messages`, { kind: "text", body, ...rest }, token);

describe("team content filtering and private reports", () => {
  it("allows only staff to configure bounded rules and rejects blocked posts before mutation", async () => {
    const initial = (await get("/api/v1/moderation/rules")).json();
    expect((await get("/api/v1/moderation/rules", member)).statusCode).toBe(403);
    const update = { method: "PUT" as const, url: "/api/v1/moderation/rules", payload: { version: initial.version, blocked_phrases: ["Test blocked phrase"] } };
    expect((await server.app.inject({ ...update, headers: auth(member) })).statusCode).toBe(403);
    expect((await server.app.inject({ ...update, headers: auth(owner) })).statusCode).toBe(200);
    expect((await server.app.inject({ ...update, headers: auth(owner) })).statusCode).toBe(409);
    expect((await message("TEST\u200b BLOCKED\nPHRASE")).statusCode).toBe(403);
    expect(await server.db.db.select().from(messages).where(eq(messages.roomId, roomId))).toHaveLength(0);
    expect((await message("Ordinary team message")).statusCode).toBe(201);
  });
  it("deduplicates reports, keeps evidence private and removes the message and mention preview", async () => {
    const posted = await message("Reported example", owner, { mentions: [{ actor_type: "user", actor_id: memberId }] });
    expect(posted.statusCode).toBe(201);
    const id = posted.json().message.id as string;
    const reports = await Promise.all([post(`/api/v1/messages/${id}/report`, { reason: "Please review this message" }, member), post(`/api/v1/messages/${id}/report`, { reason: "Duplicate request" }, member)]);
    expect(reports[0]!.statusCode).toBe(200); expect(reports[1]!.json().id).toBe(reports[0]!.json().id);
    expect(reports[0]!.json()).not.toHaveProperty("bodySnapshot");
    expect((await get("/api/v1/moderation/reports", member)).statusCode).toBe(403);
    const queue = (await get("/api/v1/moderation/reports")).json();
    expect(queue.reports).toHaveLength(1); expect(queue.reports[0].body_snapshot).toBe("Reported example");
    expect((await get("/api/v1/moderation/my-reports")).json().reports).toHaveLength(0);
    const reportId = reports[0]!.json().id as string;
    expect((await post(`/api/v1/moderation/reports/${reportId}/resolve`, { action: "remove", note: "Private staff note" }, member)).statusCode).toBe(403);
    expect((await post(`/api/v1/moderation/reports/${reportId}/resolve`, { action: "remove", note: "Private staff note" })).statusCode).toBe(200);
    expect((await server.db.db.select().from(messages).where(eq(messages.id, id)))[0]?.body).toBe(REMOVED_MESSAGE);
    expect((await server.db.db.select().from(notifications).where(eq(notifications.messageId, id)))[0]?.bodyPreview).toBe(REMOVED_MESSAGE);
    const personal = (await get("/api/v1/moderation/my-reports", member)).json();
    expect(personal.reports[0].status).toBe("resolved");
    expect(JSON.stringify(personal)).not.toContain("Private staff note");
    expect(JSON.stringify(personal)).not.toContain("Reported example");
    expect((await post(`/api/v1/moderation/reports/${reportId}/resolve`, { action: "dismiss", note: "stale resolution" })).statusCode).toBe(409);
    expect((await post("/api/v1/messages/foreign-message/report", { reason: "Invalid team target" }, member)).statusCode).toBe(404);
  });
  it("derives removal from protected columns, never user payloads, and scopes visibility lookups to the room", async () => {
    expect((await message("Pretend staff action", member, { payload: { moderation: "removed" } })).statusCode).toBe(400);
    const created = await message("Legacy payload remains ordinary content", owner);
    const id = created.json().message.id as string;
    // Old installations accepted opaque payloads. An upgrade must not treat a
    // legacy key as proof that an administrator removed the message.
    await server.db.db.update(messages).set({ payload: { moderation: "removed", other: "retained" } }).where(eq(messages.id, id));
    const legacy = await get(`/api/v1/rooms/${roomId}/messages/${id}`, member);
    expect(legacy.json().message.body).toBe("Legacy payload remains ordinary content");
    expect(legacy.json().message.payload).toEqual({ other: "retained" });
    expect((await post(`/api/v1/rooms/${roomId}/messages/visibility`, { message_ids: [id] }, member)).json().removed_message_ids).toEqual([]);
    const report = await post(`/api/v1/messages/${id}/report`, { reason: "Review actual content" }, member);
    await post(`/api/v1/moderation/reports/${report.json().id}/resolve`, { action: "remove", note: "Reviewed" });
    expect((await get(`/api/v1/rooms/${roomId}/messages/${id}`, member)).json().message.payload).toEqual({ moderation: "removed" });
    const other = await post("/api/v1/channels", { project_id: "proj_artoo", name: "another-report-room" });
    expect((await post(`/api/v1/rooms/${other.json().channel.id}/messages/visibility`, { message_ids: [id] }, member)).json().removed_message_ids).toEqual([]);
    expect((await post(`/api/v1/rooms/${roomId}/messages/visibility`, { message_ids: [id, "unknown"] }, member)).json().removed_message_ids).toEqual([id]);
    expect((await post(`/api/v1/rooms/${roomId}/messages/visibility`, { message_ids: Array(101).fill(id) }, member)).statusCode).toBe(400);
  });
  it("pages personal and staff reports without losing older reports or exposing staff-only fields", async () => {
    for (let n = 0; n < 55; n++) {
      const messageId = `report_fixture_message_${n}`;
      await server.db.db.insert(messages).values({ id: messageId, organizationId: server.ctx.organizationId, roomId, actorType: "user", actorId: "user_owner", kind: "text", body: `Reported ${n}`, createdAt: server.ctx.clock.nowIso() });
      await server.db.db.insert(contentReports).values({ id: `report_${String(n).padStart(6, "0")}`, organizationId: server.ctx.organizationId,
        messageId, reporterUserId: memberId, reason: `Reason ${n}`, bodySnapshot: `Reported ${n}`, status: "open", createdAt: server.ctx.clock.nowIso() });
    }
    const own = (await get("/api/v1/moderation/my-reports", member)).json();
    expect(own.reports).toHaveLength(50); expect(own.next_before).toBeTruthy();
    expect(own.reports.every((item: Record<string, unknown>) => !("body_snapshot" in item) && !("reporter_user_id" in item))).toBe(true);
    const older = (await get(`/api/v1/moderation/my-reports?before=${own.next_before}`, member)).json();
    expect(older.reports).toHaveLength(5); expect(older.next_before).toBeNull();
    expect(new Set([...own.reports, ...older.reports].map((item: { id: string }) => item.id)).size).toBe(55);
    const staff = (await get("/api/v1/moderation/reports")).json();
    expect(staff.reports[0]).toMatchObject({ actor_id: "user_owner", actor_type: "user", room_id: roomId });
    expect(staff.reports).toHaveLength(50);
    expect((await get(`/api/v1/moderation/reports?before=${staff.next_before}`)).json().reports).toHaveLength(5);
    expect((await get("/api/v1/moderation/my-reports", owner)).json().reports).toHaveLength(0);
    for (const route of ["reports", "my-reports"]) expect((await get(`/api/v1/moderation/${route}?before=bad&before=cursor`)).statusCode).toBe(400);
  });
  it("retains a moderated planning root's real discussion identity instead of untrusted payload metadata", async () => {
    const [agent] = await server.db.db.select().from(agents);
    const [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...agent!, id: "moderation_reviewer", displayName: "Reviewer" });
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "moderation_reviewer_instance", agentId: "moderation_reviewer" });
    const goal = (await post("/api/v1/goals", { project_id: "proj_artoo", title: "Moderated planning", objective: "Keep planning controls consistent", acceptance_criteria: ["Retain coordinator control"] })).json().goal;
    const started = await post(`/api/v1/goals/${goal.id}/discussions`, { room_id: roomId,
      participants: [{ agent_instance_id: instance!.id, role: "Author" }, { agent_instance_id: "moderation_reviewer_instance", role: "Review" }], rounds: 1, max_minutes: 5 });
    expect(started.statusCode).toBeLessThan(300);
    const discussion = started.json().discussion;
    await server.db.db.update(messages).set({ payload: { discussion_id: "untrusted", private_content: "do not copy" } }).where(eq(messages.id, discussion.thread_root_id));
    const report = await post(`/api/v1/messages/${discussion.thread_root_id}/report`, { reason: "Review planning root" }, member);
    expect((await post(`/api/v1/moderation/reports/${report.json().id}/resolve`, { action: "remove", note: "Remove content, keep structure" })).statusCode).toBe(200);
    const message = (await get(`/api/v1/rooms/${roomId}/messages/${discussion.thread_root_id}`)).json().message;
    expect(message.body).toBe(REMOVED_MESSAGE);
    expect(message.payload).toEqual({ moderation: "removed", discussion_id: discussion.id });
    expect((await post(`/api/v1/rooms/${roomId}/assistant-turns`, { body: "Bypass coordinator", client_request_id: "wrong-direct-request", thread_root_id: discussion.thread_root_id })).statusCode).toBe(400);
  });
  it("suspends the account across sessions, old/new pairings and OAuth; reinstatement cannot revive old credentials", async () => {
    const code = (await post("/api/v1/devices/pairings", { intended_platform: "macos" }, member)).json().code;
    const claimed = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: { code, platform: "macos", display_name: "Member computer", app_version: "1" } });
    expect(claimed.statusCode).toBe(201);
    const credentials = claimed.json();
    expect(await resolveNodeToken(server.ctx, credentials.node_token)).not.toBeNull();
    const pending = (await post("/api/v1/devices/pairings", { intended_platform: "ios" }, member)).json().code;
    expect((await post(`/api/v1/moderation/members/${memberId}/suspension`, { suspended: true, reason: "Reviewed abusive conduct" }, member)).statusCode).toBe(403);
    expect((await post("/api/v1/moderation/members/user_owner/suspension", { suspended: true, reason: "Privilege escalation attempt" }, member)).statusCode).toBe(403);
    const banned = await post(`/api/v1/moderation/members/${memberId}/suspension`, { suspended: true, reason: "Reviewed abusive conduct" });
    expect(banned.statusCode).toBe(200);
    expect(banned.json().revoked_device_ids).toContain(credentials.device.id);
    expect((await get("/api/v1/bootstrap", member)).statusCode).toBe(401);
    expect((await get("/api/v1/bootstrap", credentials.control_token)).statusCode).toBe(401);
    expect(await resolveNodeToken(server.ctx, credentials.node_token)).toBeNull();
    expect((await post("/api/v1/devices/pairings", { intended_platform: "ios" }, member)).statusCode).toBe(401);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: { code: pending, platform: "ios", display_name: "Bypass attempt", app_version: "1" } })).statusCode).toBe(400);
    await expect(provisionUser(server.ctx, identity)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(createSession(server.ctx, { ttlMs: 3600000 }, { userId: memberId })).rejects.toMatchObject({ code: "permission_denied" });
    expect((await post(`/api/v1/moderation/members/${memberId}/suspension`, { suspended: false, reason: "Reviewed appeal" })).statusCode).toBe(200);
    expect((await get("/api/v1/bootstrap", member)).statusCode).toBe(401);
    expect((await get("/api/v1/bootstrap", credentials.control_token)).statusCode).toBe(401);
    expect((await provisionUser(server.ctx, identity)).userId).toBe(memberId);
    const renewed = (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: memberId })).raw;
    expect((await get("/api/v1/bootstrap", renewed)).statusCode).toBe(200);
    expect((await post("/api/v1/moderation/members/user_owner/suspension", { suspended: true, reason: "Self lockout" })).statusCode).toBe(403);
  });
  it("closes an existing browser session and paired control socket when the member is suspended", async () => {
    const code = (await post("/api/v1/devices/pairings", { intended_platform: "ios" }, member)).json().code;
    const claimed = await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: { code, platform: "ios", display_name: "Member phone", app_version: "1" } });
    const origin = await server.app.listen({ host: "127.0.0.1", port: 0 });
    const url = origin.replace("http:", "ws:") + "/api/v1/ws";
    for (const headers of [{ cookie: `artoo_session=${member}` }, auth(claimed.json().control_token)]) {
      const socket = new WebSocket(url, { headers }); sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    }
    await expect.poll(() => authenticatedSockets, { timeout: 3000 }).toBe(2);
    const closed = sockets.map((socket) => new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(-1), 3000);
      socket.once("close", (code) => { clearTimeout(timer); resolve(code); });
    }));
    expect((await post(`/api/v1/moderation/members/${memberId}/suspension`, { suspended: true, reason: "Reviewed abusive conduct" })).statusCode).toBe(200);
    expect(await Promise.all(closed)).toEqual([1008, 1008]);
  });

});
