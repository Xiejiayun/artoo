import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #28 v2-C slice 4b review gate 2 — revoke must DROP live sockets, not only
 * reject future reconnects. After an API revoke, an already-connected node socket
 * and an already-connected control-session WS are both closed (1008). Every
 * credential is minted through the public API (no seeded rows).
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

/** Resolve the close code the server sends, or -1 if the socket stays open. */
function closeCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.on("close", (code: number) => resolve(code));
    setTimeout(() => resolve(-1), 3000);
  });
}

interface Issued {
  deviceId: string;
  computerId: string;
  nodeToken: string;
  controlToken: string;
}

/** Mint a fully enrolled desktop device through the public HTTP flow. */
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

describe("revoke closes live device sockets (#28 4b)", () => {
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

  it("closes an active node socket on revoke (not only a future reconnect)", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const { deviceId, computerId, nodeToken } = await issueEnrolledDevice(server);

    const node = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${nodeToken}`);
    sockets.push(node);
    await new Promise<void>((resolve) => node.on("open", () => resolve()));
    node.send(NODE_HELLO(computerId));
    await waitFor(() => server?.nodeRegistry.get(computerId) !== undefined, "node bound");

    // Revoke via the API while the node is connected — the server must close it.
    const closed = closeCode(node);
    const revoke = (
      await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} })
    ).json();
    expect(revoke.revoked).toBe(true);
    expect(revoke.connections_closed).toBeGreaterThanOrEqual(1);
    expect(await closed).toBe(1008);
    await waitFor(() => server?.nodeRegistry.get(computerId) === undefined, "node unregistered after revoke");
  });

  it("closes an active control-session WS on revoke", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 50)); // let async auth + registration settle

    const closed = closeCode(control);
    const revoke = (
      await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} })
    ).json();
    expect(revoke.revoked).toBe(true);
    expect(revoke.connections_closed).toBeGreaterThanOrEqual(1);
    expect(await closed).toBe(1008);
  });
});
