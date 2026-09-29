import { messages } from "@artoo/db";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("room history and incremental synchronization", () => {
  let server: TestServer;
  afterEach(async () => { await server?.close(); });
  async function room(): Promise<string> {
    const result = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Conversation", acceptance_criteria: ["reply"],
    } });
    expect(result.statusCode).toBe(201);
    return result.json().room.id as string;
  }
  async function page(id: string, query = ""): Promise<any> {
    const result = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${id}/messages${query}` });
    expect(result.statusCode).toBe(200);
    return result.json();
  }
  it("pages latest/older/newer messages without gaps when timestamps or ids go backwards", async () => {
    server = await buildTestServer();
    const id = await room();
    const before = await page(id);
    for (let n = 0; n < 7; n++) await server.db.db.insert(messages).values({
      id: `reverse_${7 - n}`, organizationId: "org_default", roomId: id,
      actorType: "user", actorId: "user_owner", kind: "text", body: `line ${n}`,
      createdAt: n === 6 ? "2020-01-01T00:00:00.000Z" : server.ctx.clock.nowIso(),
    });
    const latest = await page(id, "?limit=3");
    expect(latest.messages.map((m: any) => m.body)).toEqual(["line 4", "line 5", "line 6"]);
    expect(latest.has_more).toBe(true);
    const older = await page(id, `?limit=3&before=${latest.next_before}`);
    expect(older.messages.map((m: any) => m.body)).toEqual(["line 1", "line 2", "line 3"]);
    const first = await page(id, `?limit=100&before=${older.next_before}`);
    expect(first.messages.map((m: any) => m.body)).toEqual([...before.messages.map((m: any) => m.body), "line 0"]);
    expect(first.has_more).toBe(false);
    const newer = await page(id, `?limit=2&after=${older.next_after}`);
    expect(newer.messages.map((m: any) => m.body)).toEqual(["line 4", "line 5"]);
    expect(newer.has_more).toBe(true);
    const tail = await page(id, `?limit=2&after=${newer.next_after}`);
    expect(tail.messages.map((m: any) => m.body)).toEqual(["line 6"]);
    expect(tail.has_more).toBe(false);
    expect(await page(id, `?after=${tail.next_after}`)).toEqual({ messages: [], next_before: null, next_after: null, has_more: false });
  });
  it("validates bounds and room-bound cursors instead of silently losing history", async () => {
    server = await buildTestServer();
    const first = await room(); const second = await room();
    await server.app.inject({ method: "POST", url: `/api/v1/rooms/${first}/messages`, payload: { body: "hello" } });
    const result = await page(first);
    for (const query of ["limit=0", "limit=101", "limit=NaN", "limit=2.5", "before=bad", `before=${result.next_before}&after=${result.next_after}`]) {
      expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${first}/messages?${query}` })).statusCode).toBe(400);
    }
    expect((await server.app.inject({ method: "GET", url: `/api/v1/rooms/${second}/messages?after=${result.next_after}` })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "GET", url: "/api/v1/rooms/missing/messages" })).statusCode).toBe(404);
  });
});
