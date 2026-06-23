import { eventLog } from "@artoo/db";
import { eq } from "drizzle-orm";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #28 v2-C slice 4c — device presence end to end over the real transports. An
 * authenticated device node/control connection drives `last_seen_at` + a
 * presence transition event; the identity source is explicitly an authenticated
 * device token (never the dev escape); revoke emits an offline transition.
 */
const NODE_HELLO = (nodeId: string): string =>
  JSON.stringify({
    kind: "node.hello",
    node_id: nodeId,
    protocol_version: "2026-06-11",
    artood_version: "0.1.0",
    machine: { hostname: "localhost", os: "windows", arch: "x64" },
  });

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function listen(server: TestServer): Promise<string> {
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  return new URL(address).port;
}

async function presenceEvents(server: TestServer): Promise<Array<Record<string, unknown>>> {
  const rows = await server.db.db.select().from(eventLog).where(eq(eventLog.type, "device.presence_changed"));
  return rows.map((r) => r.payload as Record<string, unknown>);
}

async function presence(server: TestServer, deviceId: string): Promise<string> {
  const res = await server.app.inject({ method: "GET", url: `/api/v1/devices/${deviceId}/presence` });
  return res.json().presence.state as string;
}

interface Issued {
  deviceId: string;
  computerId: string;
  nodeToken: string;
  controlToken: string;
}

async function issueEnrolledDevice(server: TestServer): Promise<Issued> {
  const code = (await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: {} })).json()
    .code as string;
  const claimed = (
    await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code, platform: "windows", app_version: "2.0.0", display_name: "ThinkPad" },
    })
  ).json();
  const deviceId = claimed.device.id as string;
  const enrolled = (
    await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/enroll`, payload: {} })
  ).json();
  return {
    deviceId,
    computerId: enrolled.computer_id as string,
    nodeToken: claimed.node_token as string,
    controlToken: claimed.control_token as string,
  };
}

describe("device presence e2e (#28 4c)", () => {
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const s of sockets) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
    await server?.close();
    server = undefined;
  });

  it("an authenticated node connection brings the device online and emits source=node", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const { deviceId, computerId, nodeToken } = await issueEnrolledDevice(server);
    expect(await presence(server, deviceId)).toBe("offline"); // never seen yet

    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${nodeToken}`);
    sockets.push(node);
    await new Promise<void>((resolve) => node.on("open", () => resolve()));
    node.send(NODE_HELLO(computerId));

    await waitFor(async () => (await presence(server!, deviceId)) === "online", "device online");
    const events = await presenceEvents(server);
    const online = events.find((e) => e.device_id === deviceId && e.to === "online");
    expect(online).toMatchObject({ from: "offline", to: "online", source: "node" });
  });

  it("an authenticated control connection brings the device online and emits source=control", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const { deviceId, controlToken } = await issueEnrolledDevice(server);

    const control = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
      headers: { Authorization: `Bearer ${controlToken}` },
    });
    sockets.push(control);
    await new Promise<void>((resolve, reject) => {
      control.on("open", () => resolve());
      control.on("close", (code: number) => reject(new Error(`closed ${code} before open`)));
    });
    control.send(JSON.stringify({ type: "subscribe", topics: ["task:any"] }));

    await waitFor(async () => (await presence(server!, deviceId)) === "online", "device online via control");
    const events = await presenceEvents(server);
    expect(events.find((e) => e.device_id === deviceId)).toMatchObject({ to: "online", source: "control" });
  });

  it("the dev-escape node connection emits NO device presence event (identity is explicit)", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    // token=dev binds the seeded computer with NO device identity.
    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    sockets.push(node);
    await new Promise<void>((resolve) => node.on("open", () => resolve()));
    node.send(NODE_HELLO("computer_local_mock"));
    await waitFor(() => server?.nodeRegistry.get("computer_local_mock") !== undefined, "dev node registered");
    // Give any async presence write a chance, then assert none was emitted.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await presenceEvents(server)).toHaveLength(0);
  });

  it("revoke emits an offline presence transition", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const { deviceId, computerId, nodeToken } = await issueEnrolledDevice(server);

    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${nodeToken}`);
    sockets.push(node);
    await new Promise<void>((resolve) => node.on("open", () => resolve()));
    node.send(NODE_HELLO(computerId));
    await waitFor(async () => (await presence(server!, deviceId)) === "online", "online before revoke");

    await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} });
    await waitFor(
      async () => (await presenceEvents(server!)).some((e) => e.device_id === deviceId && e.to === "offline"),
      "offline transition emitted",
    );
    const offline = (await presenceEvents(server)).find((e) => e.device_id === deviceId && e.to === "offline");
    expect(offline).toMatchObject({ to: "offline", reason: "revoked" });
  });
});
