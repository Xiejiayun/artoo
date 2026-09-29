import { once } from "node:events";
import { eventLog, organizations, users } from "@artoo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { testDeviceAuthConfig } from "../config/device-auth.js";
import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { createDeviceConnectionRegistry } from "../ws/device-connections.js";
import { collectCatchUp } from "../ws/event-publisher.js";
import { createSession } from "./auth-service.js";

describe("live authorization and organization isolation", () => {
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    sockets.length = 0;
    await server?.close();
    server = undefined;
  });

  async function authenticatedSocket() {
    let authenticated!: () => void;
    const ready = new Promise<void>((resolve) => { authenticated = resolve; });
    server = await buildTestServer({
      authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devControlEscape: false }),
      clientWsHooks: { revalidateIntervalMs: 20, onAuthenticated: () => authenticated() },
    });
    const session = await createSession(server.ctx, { ttlMs: 1000 }, { userId: "user_owner" });
    const url = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const socket = new WebSocket(`${url.replace("http:", "ws:")}/api/v1/ws`, {
      headers: { authorization: `Bearer ${session.raw}` },
    });
    sockets.push(socket);
    await once(socket, "open");
    await ready;
    return { socket, session, server };
  }

  it("accepts user-session bearer WS and closes an existing connection after logout", async () => {
    const { socket, session, server: s } = await authenticatedSocket();
    const closed = once(socket, "close");
    const response = await s.app.inject({ method: "POST", url: "/auth/logout",
      headers: { authorization: `Bearer ${session.raw}` } });
    expect(response.statusCode).toBe(204);
    expect((await closed)[0]).toBe(1008);
  });

  it("closes an existing connection when its session expires", async () => {
    const { socket, server: s } = await authenticatedSocket();
    const closed = once(socket, "close");
    s.ctx.clock = fixedClock("2026-06-13T00:00:02.000Z");
    expect((await closed)[0]).toBe(1008);
  });

  it("authenticates browser subprotocol credentials without echoing tokens and rejects ambiguous credentials", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devControlEscape: false }) });
    const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${address.replace("http:", "ws:")}/api/v1/ws`;
    const valid = new WebSocket(url, ["artoo", `artoo-auth.${session.raw}`]);
    sockets.push(valid);
    const upgrade = once(valid, "upgrade");
    await once(valid, "open");
    expect((await upgrade)[0].headers["sec-websocket-protocol"]).toBe("artoo");
    expect(valid.protocol).toBe("artoo");
    for (const protocols of [["artoo", "artoo-auth.invalid"], ["artoo", "artoo-auth."],
      ["artoo", `artoo-auth.${session.raw}`, "artoo-auth.second"], [`artoo-auth.${session.raw}`, "artoo"]]) {
      const invalid = new WebSocket(url, protocols, { headers: { cookie: `artoo_session=${session.raw}` } });
      sockets.push(invalid);
      expect((await once(invalid, "close"))[0]).toBe(1008);
    }
    const ambiguous = new WebSocket(url, ["artoo", `artoo-auth.${session.raw}`],
      { headers: { authorization: `Bearer ${session.raw}` } });
    sockets.push(ambiguous);
    expect((await once(ambiguous, "close"))[0]).toBe(1008);
  });

  it("native logout closes control sockets without interrupting its compute socket", () => {
    const offline = vi.fn();
    const registry = createDeviceConnectionRegistry({ onDeviceOffline: offline });
    const node = { close: vi.fn() };
    const control = { close: vi.fn() };
    const releaseNode = registry.add("device_1", node);
    registry.add("device_1", control, "control");
    expect(registry.closeForDevice("device_1", 1008, "signed out", "control")).toBe(1);
    expect(control.close).toHaveBeenCalledWith(1008, "signed out");
    expect(node.close).not.toHaveBeenCalled();
    expect(registry.countForDevice("device_1")).toBe(1);
    expect(offline).not.toHaveBeenCalled();
    releaseNode();
    expect(offline).toHaveBeenCalledOnce();
  });

  it("never publishes or replays another organization's events and delivers member inbox updates", async () => {
    server = await buildTestServer();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(organizations).values({ id: "org_other", name: "Other", createdAt: now });
    await server.db.db.insert(users).values({ id: "user_member", organizationId: "org_default",
      email: "member@example.com", displayName: "Member", role: "member", createdAt: now });
    const row = { type: "review.completed", schemaVersion: "1", actorType: "user", actorId: "user_owner",
      correlationId: "correlation_test", occurredAt: now, payload: {} };
    await server.db.db.insert(eventLog).values([
      { ...row, id: "evt_ours", organizationId: "org_default" },
      { ...row, id: "evt_theirs", organizationId: "org_other" },
    ]);
    const received: string[] = [];
    const socket = { send: (data: string) => received.push(JSON.parse(data).event.id as string) };
    server.wsHub.add(socket);
    server.wsHub.subscribe(socket, ["inbox:user_member"]);
    await server.publisher.pumpOnce();
    expect(received).toEqual(["evt_ours"]);
    const replay = await collectCatchUp({ ...server.ctx, actorUserId: "user_member" }, 0, ["inbox:user_member"]);
    expect(replay.map((frame) => frame.event.id)).toEqual(["evt_ours"]);
  });
});
