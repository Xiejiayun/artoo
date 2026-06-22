import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #28 v2-C slice 4b — device pairing/enroll/list/revoke HTTP surface. Drives the
 * real flow that issues device credentials and links a device to a computer,
 * replacing the seeded-row shortcut used by the unit tests.
 */
describe("device HTTP flow (pairing → claim → enroll → list → revoke)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function createPairing(s: TestServer, body: Record<string, unknown> = {}): Promise<string> {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: body });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.pairing.status).toBe("pending");
    expect(typeof json.code).toBe("string");
    expect(JSON.stringify(json.pairing)).not.toContain(json.code); // raw code never in metadata
    return json.code as string;
  }

  async function claim(
    s: TestServer,
    code: string,
    platform = "windows",
  ): Promise<{ deviceId: string; nodeToken: string; controlToken: string }> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code, platform, app_version: "2.0.0", display_name: "Jeremy's ThinkPad" },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.device.trust).toBe("active");
    expect(json.node_token.startsWith("sk_device_")).toBe(true);
    expect(json.control_token.startsWith("sk_device_")).toBe(true);
    return { deviceId: json.device.id, nodeToken: json.node_token, controlToken: json.control_token };
  }

  it("creates a pairing, claims it into a device with two credentials", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);
    expect(deviceId).toMatch(/^device_/);
  });

  it("enrolls the claimed device, links a computer, and lists it", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);

    const enroll = await server.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/enroll`,
      payload: {},
    });
    expect(enroll.statusCode).toBe(200);
    const e = enroll.json();
    expect(e.created).toBe(true);
    expect(e.computer_id).toMatch(/^computer_/);

    const list = await server.app.inject({ method: "GET", url: "/api/v1/devices" });
    expect(list.statusCode).toBe(200);
    const found = list.json().devices.find((d: { id: string }) => d.id === deviceId);
    expect(found).toBeDefined();
    expect(found.computer_id).toBe(e.computer_id);
  });

  it("revokes a device idempotently", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);

    const r1 = await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().revoked).toBe(true);

    const r2 = await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().revoked).toBe(false);
  });

  it("rejects an invalid pairing code uniformly", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code: "WRON-GCOD", platform: "windows", app_version: "1", display_name: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects enrolling a mobile device (remote control surface, not a node host)", async () => {
    server = await buildTestServer();
    const code = await createPairing(server, { intended_platform: "android" });
    const { deviceId } = await claim(server, code, "android");
    const enroll = await server.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/enroll`,
      payload: {},
    });
    expect(enroll.statusCode).toBe(400);
  });
});
