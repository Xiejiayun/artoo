import { eventLog, messages, notifications, organizations, projects, users } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { collectCatchUp, topicsForEvent } from "./ws/event-publisher.js";

describe("channels, threads and personal mentions", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  const create = async (name = "engineering") => {
    const result = await server.app.inject({ method: "POST", url: "/api/v1/channels", payload: { project_id: "proj_artoo", name, description: "Work together" } });
    expect(result.statusCode).toBe(201); return result.json().channel.id as string;
  };
  const post = (room: string, body: Record<string, unknown>) => server.app.inject({ method: "POST", url: `/api/v1/rooms/${room}/messages`, payload: body });

  it("creates project channels and provides isolated paginated threads with authoritative reply counts", async () => {
    server = await buildTestServer();
    const room = await create(); const another = await create("release");
    const listed = (await server.app.inject({ method: "GET", url: "/api/v1/channels?project_id=proj_artoo" })).json().channels;
    expect(listed.map((item: { name: string }) => item.name)).toEqual(["engineering", "release"]);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/channels", payload: { project_id: "proj_artoo", name: "Engineering" } })).statusCode).toBe(409);
    const root = (await post(room, { body: "Design topic" })).json().message;
    const first = (await post(room, { body: "First reply", thread_root_id: root.id })).json().message;
    await post(room, { body: "Second reply", thread_root_id: root.id });
    const roots = (await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages` })).json();
    expect(roots.messages).toHaveLength(1); expect(roots.messages[0].reply_count).toBe(2);
    const thread = (await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages?thread_root_id=${root.id}&limit=1` })).json();
    expect(thread.messages.map((item: { body: string }) => item.body)).toEqual(["Second reply"]); expect(thread.has_more).toBe(true);
    const previous = (await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages?thread_root_id=${root.id}&before=${thread.next_before}` })).json();
    expect(previous.messages[0].id).toBe(first.id);
    expect((await post(another, { body: "Wrong room", thread_root_id: root.id })).statusCode).toBe(404);
    expect((await post(room, { body: "Nested reply", thread_root_id: first.id })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${another}/messages/${root.id}` })).statusCode).toBe(404);
    const linked = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages/${root.id}` });
    expect(linked.json().message.reply_count).toBe(2);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages?before=${thread.next_before}` })).statusCode).toBe(400);
  });

  it("validates real people, creates one durable notification and permits only its recipient to read it", async () => {
    server = await buildTestServer();
    await server.db.db.insert(users).values({ id: "colleague", organizationId: "org_default", email: "colleague@example.test", displayName: "Colleague", role: "member", createdAt: server.ctx.clock.nowIso() });
    await server.db.db.insert(organizations).values({ id: "foreign", name: "Other org", createdAt: server.ctx.clock.nowIso() });
    await server.db.db.insert(users).values({ id: "outsider", organizationId: "foreign", email: "outsider@example.test", displayName: "Outsider", role: "member", createdAt: server.ctx.clock.nowIso() });
    const members = (await server.app.inject({ method: "GET", url: "/api/v1/members" })).json().members;
    expect(members.some((item: { id: string }) => item.id === "colleague")).toBe(true); expect(members.some((item: { id: string }) => item.id === "outsider")).toBe(false);
    const room = await create();
    const root = (await post(room, { body: "Review here" })).json().message;
    const response = await post(room, { body: "Can you review this?", thread_root_id: root.id, client_request_id: "durable-request-01", mentions: [{ actor_type: "user", actor_id: "colleague" }, { actor_type: "user", actor_id: "colleague" }], assignments: [{ assignee_type: "user", assignee_id: "colleague", action: "review" }] });
    expect(response.statusCode).toBe(201);
    const stored = await server.db.db.select().from(notifications); expect(stored).toHaveLength(1);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/notifications" })).json().notifications).toEqual([]);
    expect((await server.app.inject({ method: "POST", url: `/api/v1/notifications/${stored[0]!.id}/read` })).statusCode).toBe(404);
    const invalid = await post(room, { body: "Foreign mention", thread_root_id: root.id, mentions: [{ actor_type: "user", actor_id: "outsider" }] });
    expect(invalid.statusCode).toBe(400);
    server.ctx.actorUserId = "colleague";
    const mine = (await server.app.inject({ method: "GET", url: "/api/v1/notifications" })).json().notifications;
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ thread_root_id: root.id, read_at: null, body_preview: "Can you review this?" });
    expect((await server.app.inject({ method: "POST", url: `/api/v1/notifications/${mine[0].id}/read` })).json().notification.read_at).not.toBeNull();
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages/${root.id}` })).json().message.reply_count).toBe(1);
    const mention = (await server.db.db.select().from(eventLog).where(eq(eventLog.type, "message.mention")))[0]!;
    const frames = await collectCatchUp(server.ctx, 0, ["inbox:colleague"]);
    expect(frames.some((frame) => frame.event.id === mention.id)).toBe(true);
    expect((await collectCatchUp({ ...server.ctx, actorUserId: "user_owner" }, 0, ["inbox:user_owner"])).some((frame) => frame.event.id === mention.id)).toBe(false);
  });

  it("deduplicates a logical message including replies and notifications independently of HTTP headers", async () => {
    server = await buildTestServer(); const room = await create();
    const root = (await post(room, { body: "Root" })).json().message;
    const body = { body: "Please read", thread_root_id: root.id, client_request_id: "persistent-id-01", mentions: [{ actor_type: "user", actor_id: "user_owner" }] };
    const responses = await Promise.all([post(room, body), post(room, body)]);
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    expect(responses[0]!.json().message.id).toBe(responses[1]!.json().message.id);
    expect((await server.db.db.select().from(notifications))).toHaveLength(1);
    expect((await server.db.db.select().from(messages).where(eq(messages.threadRootId, root.id)))).toHaveLength(1);
    expect((await post(room, { ...body, body: "Different payload" })).statusCode).toBe(409);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/messages/${root.id}` })).json().message.reply_count).toBe(1);
  });

  it("serves assistant turn history only for the requested root or thread", async () => {
    server = await buildTestServer(); const room = await create();
    const root = (await post(room, { body: "Thread topic" })).json().message;
    const rootTurn = await server.app.inject({ method: "POST", url: `/api/v1/rooms/${room}/assistant-turns`, payload: { body: "Root request", client_request_id: "root-request-contract" } });
    const threadTurn = await server.app.inject({ method: "POST", url: `/api/v1/rooms/${room}/assistant-turns`, payload: { body: "Thread request", thread_root_id: root.id, client_request_id: "thread-request-contract" } });
    expect(rootTurn.statusCode).toBe(201); expect(threadTurn.statusCode).toBe(201);
    const rootHistory = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/assistant-turns` });
    const threadHistory = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/assistant-turns?thread_root_id=${encodeURIComponent(root.id)}` });
    expect(rootHistory.json().turns.map((turn: { id: string }) => turn.id)).toEqual([rootTurn.json().turn.id]);
    expect(threadHistory.json().turns.map((turn: { id: string }) => turn.id)).toEqual([threadTurn.json().turn.id]);
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${room}/assistant-turns?thread_root_id=missing` })).statusCode).toBe(400);
  });

  it("keeps notification routing targeted while room events remain shared", async () => {
    server = await buildTestServer(); const room = await create();
    await post(room, { body: "Private mention target", mentions: [{ actor_type: "user", actor_id: "user_owner" }] });
    const targeted: string[] = []; const unrelated: string[] = [];
    const own = { send: (text: string) => targeted.push(text) }; const other = { send: (text: string) => unrelated.push(text) };
    server.wsHub.subscribe(own, ["inbox:user_owner"]); server.wsHub.subscribe(other, ["inbox:other"]);
    await Promise.all([server.publisher.pumpOnce(), server.publisher.pumpOnce()]);
    expect(targeted.filter((frame) => JSON.parse(frame).event.type === "message.mention")).toHaveLength(1);
    expect(unrelated).toHaveLength(0);
    const events = await server.db.db.select().from(eventLog).where(and(eq(eventLog.type, "message.mention"), eq(eventLog.roomId, room)));
    expect(JSON.stringify(events[0]!.payload)).not.toContain("Private mention target");
  });

  it("bounds reconnect replay and emits a resync marker without another person's private metadata", async () => {
    server = await buildTestServer();
    await server.db.db.insert(eventLog).values(Array.from({ length: 501 }, (_, index) => ({
      id: `private_${index}`, organizationId: "org_default", type: "notification.read", schemaVersion: "2026-06-11",
      actorType: "user", actorId: "private_actor", correlationId: "private_correlation", roomId: "private_room", taskId: "private_task",
      payload: { user_id: "colleague", secret: "private_content" }, occurredAt: server.ctx.clock.nowIso(),
    })));
    const frames = await collectCatchUp(server.ctx, 0, ["inbox:user_owner"]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toMatchObject({ type: "sync.required", actor: { type: "system", id: "artoo" }, payload: { snapshot_required: true } });
    expect(JSON.stringify(frames)).not.toContain("private_");
    expect(frames[0]!.event.room_id).toBeUndefined();
    expect(frames[0]!.event.task_id).toBeUndefined();
  });
});
