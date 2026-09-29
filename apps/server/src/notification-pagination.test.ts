import { goals, messages, notifications, organizations, projects, rooms, users } from "@artoo/db";
import { NotificationPageSchema, type NotificationPage } from "@artoo/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "./auth/auth-service.js";
import { listNotifications } from "./services/channel-service.js";
import { buildTestServer, fixedClock, type TestServer } from "./test-support.js";

describe("personal notification history", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });

  async function authenticate(userId = "user_owner"): Promise<{ authorization: string }> {
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId });
    return { authorization: `Bearer ${session.raw}` };
  }

  async function channel(id = "channel_main", projectId = "proj_artoo", organizationId = "org_default"): Promise<string> {
    await server.db.db.insert(rooms).values({ id, projectId, organizationId, type: "project", name: id, createdAt: server.ctx.clock.nowIso() });
    return id;
  }

  async function seedNotifications(items: Array<{
    id: string; roomId: string; createdAt?: string; readAt?: string | null;
    userId?: string; organizationId?: string; threadRootId?: string;
  }>): Promise<void> {
    await server.db.db.insert(messages).values(items.map((item) => ({
      id: `message_${item.id}`, organizationId: item.organizationId ?? "org_default", roomId: item.roomId,
      actorType: "user", actorId: "user_owner", kind: "text", body: item.id,
      createdAt: item.createdAt ?? server.ctx.clock.nowIso(),
    })));
    await server.db.db.insert(notifications).values(items.map((item) => ({
      ...item, organizationId: item.organizationId ?? "org_default", userId: item.userId ?? "user_owner",
      messageId: `message_${item.id}`, actorId: "user_owner", bodyPreview: item.id,
      createdAt: item.createdAt ?? server.ctx.clock.nowIso(),
    })));
  }

  async function page(headers: { authorization: string }, query = ""): Promise<NotificationPage> {
    const response = await server.app.inject({ method: "GET", url: `/api/v1/notifications${query}`, headers });
    expect(response.statusCode).toBe(200);
    return NotificationPageSchema.parse(response.json());
  }

  it("pages beyond 100 notifications while counting old unread items and preserving cursors across new arrivals", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const headers = await authenticate();
    const roomId = await channel();
    const ids = Array.from({ length: 125 }, (_, index) => `notice_${String(index).padStart(3, "0")}`);
    await seedNotifications(ids.map((id, index) => ({
      id, roomId,
      createdAt: new Date(Date.parse("2026-06-12T00:00:00.000Z") + Math.floor(index / 5) * 1_000).toISOString(),
      readAt: index < 2 ? null : server.ctx.clock.nowIso(),
    })));

    const latest = await page(headers);
    expect(latest.notifications).toHaveLength(50);
    expect(latest.notifications.every((item) => item.read_at !== null)).toBe(true);
    expect(latest.unread_count).toBe(2);
    expect(latest.has_more).toBe(true);
    await seedNotifications([{ id: "notice_new", roomId, readAt: server.ctx.clock.nowIso() }]);

    const second = await page(headers, `?before=${latest.next_before}`);
    const oldest = await page(headers, `?before=${second.next_before}`);
    expect(second.notifications).toHaveLength(50);
    expect(oldest.notifications).toHaveLength(25);
    expect(oldest.has_more).toBe(false);
    expect([...latest.notifications, ...second.notifications, ...oldest.notifications].map((item) => item.id)).toEqual([...ids].reverse());
    expect(await page(headers, `?before=${oldest.next_before}`)).toEqual({ notifications: [], next_before: null, has_more: false, unread_count: 2 });
    expect((await page(headers, "?limit=100")).notifications).toHaveLength(100);

    const read = await server.app.inject({ method: "POST", url: `/api/v1/notifications/${ids[0]}/read`, headers });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ unread_count: 1, notification: { id: ids[0], read_at: expect.any(String) } });
    server.ctx.clock = fixedClock("2026-06-13T00:01:00.000Z");
    const repeated = await server.app.inject({ method: "POST", url: `/api/v1/notifications/${ids[0]}/read`, headers });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(read.json());
    expect((await page(headers)).unread_count).toBe(1);
  });

  it("retains database microsecond precision and uses descending ids to resolve timestamp ties", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const headers = await authenticate();
    const roomId = await channel();
    await seedNotifications([
      { id: "micro_c", roomId, createdAt: "2026-06-12T00:00:00.123900Z" },
      { id: "micro_a", roomId, createdAt: "2026-06-12T00:00:00.123900Z" },
      { id: "micro_b", roomId, createdAt: "2026-06-12T00:00:00.123900Z" },
      { id: "middle", roomId, createdAt: "2026-06-12T00:00:00.123500Z" },
      { id: "oldest", roomId, createdAt: "2026-06-12T00:00:00.123100Z" },
    ]);
    let result = await page(headers, "?limit=2");
    const seen = result.notifications.map((item) => item.id);
    while (result.has_more) {
      result = await page(headers, `?limit=2&before=${result.next_before}`);
      seen.push(...result.notifications.map((item) => item.id));
    }
    expect(seen).toEqual(["micro_c", "micro_b", "micro_a", "middle", "oldest"]);
  });

  it("scopes history, cursors and unread counts to the authenticated recipient and organization", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other organization", createdAt: now });
    await server.db.db.insert(users).values([
      { id: "colleague", organizationId: "org_default", email: "colleague@example.test", displayName: "Colleague", role: "member", createdAt: now },
      { id: "outsider", organizationId: "org_other", email: "outsider@example.test", displayName: "Outsider", role: "member", createdAt: now },
    ]);
    await server.db.db.insert(projects).values({ id: "proj_other", organizationId: "org_other", name: "Other project", createdAt: now });
    const roomId = await channel();
    const foreignRoom = await channel("channel_other", "proj_other", "org_other");
    await seedNotifications([
      { id: "mine", roomId },
      { id: "colleague", roomId, userId: "colleague" },
      { id: "foreign", roomId: foreignRoom, userId: "outsider", organizationId: "org_other" },
      // Legacy inconsistent rows must not leak another organization's room.
      { id: "foreign_org", roomId: foreignRoom, organizationId: "org_other" },
      { id: "foreign_room", roomId: foreignRoom },
    ]);
    const ownerHeaders = await authenticate();
    const colleagueHeaders = await authenticate("colleague");
    const owner = await page(ownerHeaders);
    const colleague = await page(colleagueHeaders);
    expect(owner.notifications.map((item) => item.id)).toEqual(["mine"]);
    expect(owner.unread_count).toBe(1);
    expect(colleague.notifications.map((item) => item.id)).toEqual(["colleague"]);
    expect(colleague.unread_count).toBe(1);
    const foreign = await listNotifications({ ...server.ctx, organizationId: "org_other", actorUserId: "outsider" });
    expect(foreign.notifications.map((item) => item.id)).toEqual(["foreign"]);
    expect(foreign.unread_count).toBe(1);
    for (const before of [colleague.next_before, foreign.next_before]) {
      expect((await server.app.inject({ method: "GET", url: `/api/v1/notifications?before=${before}`, headers: ownerHeaders })).statusCode).toBe(400);
    }
    for (const id of ["colleague", "foreign", "foreign_org", "foreign_room"]) {
      expect((await server.app.inject({ method: "POST", url: `/api/v1/notifications/${id}/read`, headers: ownerHeaders })).statusCode).toBe(404);
    }
    expect((await server.app.inject({ method: "GET", url: "/api/v1/notifications" })).statusCode).toBe(401);
    expect((await page(ownerHeaders)).unread_count).toBe(1);
    expect((await page(colleagueHeaders)).unread_count).toBe(1);
  });

  it("returns routing context for channels in another project and for task, goal and direct rooms", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const headers = await authenticate();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(projects).values({ id: "proj_release", organizationId: "org_default", name: "Release", createdAt: now });
    const channelId = await channel("channel_release", "proj_release");
    const taskResponse = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers, payload: { project_id: "proj_artoo", title: "Review", acceptance_criteria: ["Review done"] } });
    expect(taskResponse.statusCode).toBe(201);
    const { task, room } = taskResponse.json();
    await server.db.db.insert(goals).values({ id: "goal_release", organizationId: "org_default", projectId: "proj_release", ownerUserId: "user_owner", title: "Ship release", createdAt: now, updatedAt: now });
    await server.db.db.insert(rooms).values([
      { id: "room_goal", organizationId: "org_default", projectId: "proj_release", goalId: "goal_release", type: "goal", name: "Ship release", createdAt: now },
      { id: "room_dm", organizationId: "org_default", type: "dm", name: "Direct conversation", createdAt: now },
    ]);
    const root = await server.app.inject({ method: "POST", url: `/api/v1/rooms/${channelId}/messages`, headers, payload: { body: "Release thread" } });
    expect(root.statusCode).toBe(201);
    await seedNotifications([
      { id: "channel_notice", roomId: channelId, threadRootId: root.json().message.id },
      { id: "task_notice", roomId: room.id },
      { id: "goal_notice", roomId: "room_goal" },
      { id: "dm_notice", roomId: "room_dm" },
    ]);
    const result = await page(headers);
    const byId = Object.fromEntries(result.notifications.map((item) => [item.id, item]));
    expect(byId.channel_notice).toMatchObject({ project_id: "proj_release", room_type: "project", room_name: channelId, channel_id: channelId, task_id: null, goal_id: null, thread_root_id: root.json().message.id });
    expect(byId.task_notice).toMatchObject({ project_id: "proj_artoo", room_type: "task", channel_id: null, task_id: task.id, goal_id: null });
    expect(byId.goal_notice).toMatchObject({ project_id: "proj_release", room_type: "goal", room_name: "Ship release", channel_id: null, task_id: null, goal_id: "goal_release" });
    expect(byId.dm_notice).toMatchObject({ project_id: null, room_type: "dm", channel_id: null, task_id: null, goal_id: null });
  });

  it("rejects invalid bounds and malformed cursor versions, timestamps and identifiers", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const headers = await authenticate();
    const cursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
    const valid = [1, "org_default", "user_owner", server.ctx.clock.nowIso(), "notice"];
    const invalidCursors = [
      "", "bad", "!", "a".repeat(1025), cursor(null), cursor([...valid, "extra"]),
      cursor([2, ...valid.slice(1)]), cursor([...valid.slice(0, 3), "2026-02-30T00:00:00.000Z", "notice"]),
      cursor([...valid.slice(0, 3), "2026-99-13T00:00:00.000Z", "notice"]),
      cursor([...valid.slice(0, 3), "0000-01-01T00:00:00.000Z", "notice"]),
      cursor([...valid.slice(0, 3), "2026-06-13T00:00:00.000+16:00", "notice"]),
      cursor([...valid.slice(0, 3), "today", "notice"]), cursor([...valid.slice(0, 4), ""]),
      cursor([...valid.slice(0, 4), "a".repeat(257)]), cursor([...valid.slice(0, 4), "notice\0"]),
    ];
    for (const query of ["limit=0", "limit=101", "limit=NaN", "limit=1.5", "limit=-1", "limit=1&limit=2", ...invalidCursors.map((before) => `before=${encodeURIComponent(before)}`)]) {
      const response = await server.app.inject({ method: "GET", url: `/api/v1/notifications?${query}`, headers });
      expect(response.statusCode, query).toBe(400);
    }
    expect(await page(headers)).toEqual({ notifications: [], next_before: null, has_more: false, unread_count: 0 });
  });
});
