import { memories, messages, organizations, projects, rooms, tasks } from "@artoo/db";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "./auth/auth-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("literal server search", () => {
  let server: TestServer;
  afterEach(async () => {
    await server?.close();
  });
  const get = (url: string, token?: string) =>
    server.app.inject({ method: "GET", url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
  const post = (url: string, payload: Record<string, unknown>) => server.app.inject({ method: "POST", url, payload });
  async function task(title: string, description = "") {
    const result = await post("/api/v1/tasks", {
      project_id: "proj_artoo",
      title,
      description,
      acceptance_criteria: ["search"],
    });
    expect(result.statusCode).toBe(201);
    return result.json();
  }
  async function page(roomId: string, query: Record<string, string>) {
    const result = await get(`/api/v1/rooms/${roomId}/messages?${new URLSearchParams(query)}`);
    expect(result.statusCode, result.body).toBe(200);
    return result.json();
  }

  it("searches task title/description before limiting and preserves literal Unicode/wildcard text", async () => {
    server = await buildTestServer();
    const noise = await task("unrelated");
    const first = await task("Alpha 中文 100%_\\");
    const second = await task("Description hit", "ALPHA 中文");
    const ids = async (q: string, suffix = "") => {
      const result = await get(`/api/v1/tasks?project_id=proj_artoo&q=${encodeURIComponent(q)}${suffix}`);
      expect(result.statusCode).toBe(200);
      return result.json().tasks.map((item: { id: string }) => item.id);
    };
    expect(await ids(" alpha ")).toEqual([first.task.id, second.task.id]);
    expect(await ids("ALPHA", "&limit=1")).toEqual([first.task.id]);
    expect(await ids("中文")).toEqual([first.task.id, second.task.id]);
    for (const q of ["%", "_", "\\", "%_\\"]) expect(await ids(q)).toEqual([first.task.id]);
    expect(await ids("%' OR 1=1 --")).toEqual([]);
    const all = await get("/api/v1/tasks?project_id=proj_artoo");
    expect(all.json().tasks.map((item: { id: string }) => item.id)).toEqual([
      noise.task.id,
      first.task.id,
      second.task.id,
    ]);
  });

  it("binds message pagination to the search, room and thread, includes replies and excludes removed content", async () => {
    server = await buildTestServer();
    const { room } = await task("Search conversation");
    const other = (await task("Other conversation")).room;
    const root = (await post(`/api/v1/rooms/${room.id}/messages`, { body: "Needle root" })).json().message;
    const reply = (
      await post(`/api/v1/rooms/${room.id}/messages`, { body: "NEEDLE reply", thread_root_id: root.id })
    ).json().message;
    const tail = (await post(`/api/v1/rooms/${room.id}/messages`, { body: "needle 中文 100%_\\" })).json().message;
    const removed = (await post(`/api/v1/rooms/${room.id}/messages`, { body: "needle removed" })).json().message;
    const report = await post(`/api/v1/messages/${removed.id}/report`, { reason: "Remove fixture" });
    expect(
      (await post(`/api/v1/moderation/reports/${report.json().id}/resolve`, { action: "remove", note: "Reviewed" }))
        .statusCode,
    ).toBe(200);
    await post(`/api/v1/rooms/${other.id}/messages`, { body: "needle private other room" });
    const latest = await page(room.id, { q: "needle", limit: "2" });
    expect(latest.messages.map((item: { id: string }) => item.id)).toEqual([reply.id, tail.id]);
    expect(latest.has_more).toBe(true);
    const oldest = await page(room.id, { q: " needle ", limit: "2", before: latest.next_before });
    expect(oldest.messages.map((item: { id: string }) => item.id)).toEqual([root.id]);
    expect(oldest.has_more).toBe(false);
    const forward = await page(room.id, { q: "needle", after: oldest.next_after, limit: "1" });
    expect(forward.messages.map((item: { id: string }) => item.id)).toEqual([reply.id]);
    expect(forward.has_more).toBe(true);
    const thread = await page(room.id, { q: "needle", thread_root_id: root.id });
    expect(thread.messages.map((item: { id: string }) => item.id)).toEqual([reply.id]);
    expect((await page(room.id, { q: "100%_\\" })).messages.map((item: { id: string }) => item.id)).toEqual([tail.id]);
    expect((await page(room.id, { q: "[Message removed]" })).messages).toEqual([]);
    const ordinary = await page(room.id, {});
    expect(ordinary.messages.some((item: { id: string }) => item.id === reply.id)).toBe(false);
    for (const [id, query] of [
      [room.id, { q: "different", before: latest.next_before }],
      [other.id, { q: "needle", before: latest.next_before }],
      [room.id, { before: latest.next_before }],
      [room.id, { q: "needle", before: ordinary.next_before }],
      [room.id, { q: "needle", thread_root_id: root.id, before: latest.next_before }],
      [room.id, { q: "needle", before: thread.next_before }],
    ] as const)
      expect((await get(`/api/v1/rooms/${id}/messages?${new URLSearchParams(query)}`)).statusCode).toBe(400);
    expect((await page(room.id, { q: "needle" })).messages.map((item: { id: string }) => item.id)).toEqual([
      root.id,
      reply.id,
      tail.id,
    ]);
  });

  it("searches memory text, JSON and tags before limit while retaining status/scope/project/tag filters", async () => {
    server = await buildTestServer();
    const create = async (body: Record<string, unknown>) => {
      const result = await post("/api/v1/memories", { scope: "project", project_id: "proj_artoo", ...body });
      expect(result.statusCode, result.body).toBe(201);
      return result.json().memory.id as string;
    };
    const noise = await create({ text: "noise" });
    const text = await create({ text: "NEEDLE 中文 100%_\\", tags: ["exact"] });
    const json = await create({ payload: { rule: "needle" }, tags: ["exact-prefix"] });
    const tag = await create({ text: "different", tags: ["Needle"] });
    const org = await create({ scope: "organization", project_id: null, text: "needle" });
    expect((await post(`/api/v1/memories/${text}/accept`, {})).statusCode).toBe(200);
    const ids = async (q: string, rest: Record<string, string> = {}) => {
      const result = await get(`/api/v1/memories?${new URLSearchParams({ q, ...rest })}`);
      expect(result.statusCode, result.body).toBe(200);
      return result.json().memories.map((item: { id: string }) => item.id);
    };
    expect(await ids("needle")).toEqual([text, json, tag, org]);
    expect(await ids("needle", { limit: "1" })).toEqual([text]);
    expect(await ids("needle", { status: "proposed", scope: "project", project_id: "proj_artoo" })).toEqual([
      json,
      tag,
    ]);
    expect(await ids("needle", { tag: "exact" })).toEqual([text]);
    expect(await ids("rule")).toEqual([json]);
    expect(await ids("%_\\")).toEqual([text]);
    expect(await ids("%' OR 1=1 --")).toEqual([]);
    expect((await get("/api/v1/memories")).json().memories.map((item: { id: string }) => item.id)).toContain(noise);
  });

  it("retains trusted organization boundaries and authenticated access on all search endpoints", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const token = (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" })).raw;
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_foreign", name: "Foreign", createdAt: now });
    await server.db.db.insert(projects).values([
      { id: "project_foreign", organizationId: "org_foreign", name: "Foreign", createdAt: now },
      { id: "project_other", organizationId: "org_default", name: "Other", createdAt: now },
    ]);
    await server.db.db.insert(rooms).values({
      id: "room_foreign",
      organizationId: "org_foreign",
      projectId: "project_foreign",
      type: "project",
      name: "Foreign",
      createdAt: now,
    });
    await server.db.db.insert(tasks).values([
      {
        id: "task_foreign",
        organizationId: "org_foreign",
        projectId: "project_foreign",
        title: "secret needle",
        status: "backlog",
        createdByType: "user",
        createdById: "foreign",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "task_other",
        organizationId: "org_default",
        projectId: "project_other",
        title: "other needle",
        status: "backlog",
        createdByType: "user",
        createdById: "user_owner",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await server.db.db.insert(memories).values({
      id: "memory_foreign",
      organizationId: "org_foreign",
      scope: "organization",
      status: "accepted",
      authorType: "user",
      authorId: "foreign",
      text: "secret needle",
      createdAt: now,
    });
    await server.db.db.insert(messages).values({
      id: "message_foreign",
      organizationId: "org_foreign",
      roomId: "room_foreign",
      actorType: "user",
      actorId: "foreign",
      kind: "text",
      body: "secret needle",
      createdAt: now,
    });
    for (const url of [
      "/api/v1/tasks?project_id=proj_artoo&q=needle",
      "/api/v1/tasks?project_id=project_foreign&q=needle",
      "/api/v1/memories?q=needle",
    ]) {
      expect((await get(url)).statusCode).toBe(401);
      const result = await get(url, token);
      expect(result.statusCode).toBe(200);
      expect(result.json()[url.includes("/tasks") ? "tasks" : "memories"]).toEqual([]);
    }
    expect((await get("/api/v1/rooms/room_foreign/messages?q=needle", token)).statusCode).toBe(404);
    expect((await get("/api/v1/memories?project_id=project_foreign&q=needle", token)).json().memories).toEqual([]);
  });

  it("rejects blank, oversized, duplicate and NUL queries consistently", async () => {
    server = await buildTestServer();
    const { room } = await task("validation");
    for (const prefix of [
      "/api/v1/tasks?project_id=proj_artoo&",
      "/api/v1/memories?",
      `/api/v1/rooms/${room.id}/messages?`,
    ]) {
      for (const query of ["q=", "q=%20%20", `q=${"a".repeat(201)}`, "q=first&q=second", "q=a%00b"]) {
        const result = await get(prefix + query);
        expect(result.statusCode, `${prefix}${query}: ${result.body}`).toBe(400);
      }
    }
  });
});
