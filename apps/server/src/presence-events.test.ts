// @vitest-environment node
import { devices, eventLog } from "@artoo/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { markDeviceOffline, recordDeviceActivity } from "./services/presence-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #113 slice 4 — agent/computer.presence_changed events on explicit CONNECTION
 * edges. Metadata-only payloads (dimension/from/to/reason/id/source/as_of), no
 * secrets. Emitted only on edges, never on plain reads.
 */
describe("presence_changed events #113 slice 4", () => {
  let srv: TestServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  async function bindDevice(trust: "active" | "revoked", lastSeenAt: string | null): Promise<string> {
    const id = "device_evt";
    await srv!.db.db.insert(devices).values({
      id,
      organizationId: "org_default",
      displayName: "node",
      platform: "windows",
      appVersion: "2.0.0",
      computerId: "computer_local_mock",
      enrolledByUserId: "user_owner",
      trust,
      lastSeenAt,
      createdAt: "2026-06-13T00:00:00.000Z",
      revokedAt: null,
    });
    return id;
  }

  async function presenceEvents(): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const rows = await srv!.db.db
      .select({ type: eventLog.type, payload: eventLog.payload })
      .from(eventLog)
      .where(inArray(eventLog.type, ["agent.presence_changed", "computer.presence_changed"]));
    return rows.map((r) => ({ type: r.type, payload: r.payload as Record<string, unknown> }));
  }

  it("connect edge: emits agent + computer presence_changed (connection -> online), metadata only", async () => {
    srv = await buildTestServer();
    const deviceId = await bindDevice("active", null); // offline -> transitions to online
    await recordDeviceActivity(srv.ctx, deviceId, "node");

    const evts = await presenceEvents();
    const computerEvt = evts.find((e) => e.type === "computer.presence_changed");
    const agentEvt = evts.find((e) => e.type === "agent.presence_changed");
    expect(computerEvt).toBeDefined();
    expect(agentEvt).toBeDefined();
    expect(computerEvt!.payload.dimension).toBe("connection");
    expect(computerEvt!.payload.to).toBe("online");
    expect(computerEvt!.payload.computer_id).toBe("computer_local_mock");
    expect(agentEvt!.payload.agent_instance_id).toBe("instance_mock_coder");
    expect(typeof computerEvt!.payload.as_of).toBe("string");
    // secret-safe: no token/lookup/hash leaks; only metadata keys
    for (const e of evts) {
      expect(JSON.stringify(e.payload)).not.toMatch(/token|secret|hash|lookup|node_token/i);
      expect(e.payload.dimension).toBe("connection");
      expect(e.payload).toHaveProperty("from");
      expect(e.payload).toHaveProperty("to");
      expect(e.payload).toHaveProperty("source");
      expect(e.payload).toHaveProperty("as_of");
    }
  });

  it("revoke edge: emits connection -> revoked with reason device_revoked", async () => {
    srv = await buildTestServer();
    const deviceId = await bindDevice("active", srv.ctx.clock.nowIso()); // online
    await markDeviceOffline(srv.ctx, deviceId, "revoked");

    const evts = await presenceEvents();
    const computerEvt = evts.find((e) => e.type === "computer.presence_changed");
    expect(computerEvt).toBeDefined();
    expect(computerEvt!.payload.to).toBe("revoked");
    expect(computerEvt!.payload.reason).toBe("device_revoked");
  });

  it("plain presence READ does not write any presence_changed event", async () => {
    srv = await buildTestServer();
    await srv.app.inject({ method: "GET", url: "/api/v1/agent-instances/instance_mock_coder/presence" });
    await srv.app.inject({ method: "GET", url: "/api/v1/computers/computer_local_mock/presence" });
    expect((await presenceEvents()).length).toBe(0);
  });
});
