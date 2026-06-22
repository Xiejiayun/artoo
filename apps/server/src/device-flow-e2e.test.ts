import { createNodeClient, createWebSocketTransport } from "@artoo/artood";
import { computers } from "@artoo/db";
import type { NodeHello } from "@artoo/protocol";
import { createMockAdapter } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #28 v2-C slice 4b — end-to-end device smoke over the REAL HTTP flow:
 * create pairing → claim (issues node token) → enroll (links computer) → a real
 * node connects with that issued token → computer goes online → revoke → a fresh
 * connection with the same token is refused. No seeded device/token rows: every
 * credential is minted through the public API, which is what makes this a
 * production-path smoke rather than a unit shortcut.
 */
function hello(nodeId: string): NodeHello {
  return {
    kind: "node.hello",
    node_id: nodeId,
    protocol_version: "2026-06-11",
    artood_version: "0.1.0",
    machine: { hostname: "localhost", os: "windows", arch: "x64" },
  };
}

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

async function computerStatus(server: TestServer, computerId: string): Promise<string> {
  const row = (await server.ctx.db.db.select().from(computers).where(eq(computers.id, computerId)))[0];
  return row?.status ?? "missing";
}

/** Open a raw node WS with a token; resolve the close code (or -1 if it stays open). */
function closeCodeFor(port: string, token: string, helloNodeId: string): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${token}`);
  return new Promise<number>((resolve) => {
    socket.addEventListener("open", () => socket.send(JSON.stringify(hello(helloNodeId))));
    socket.addEventListener("close", (event) => resolve(event.code));
    setTimeout(() => resolve(-1), 2500);
  });
}

describe("device flow e2e (pairing → claim → enroll → node connect → revoke → refused)", () => {
  let server: TestServer | undefined;
  let node: ReturnType<typeof createNodeClient> | undefined;
  let transport: ReturnType<typeof createWebSocketTransport> | undefined;

  afterEach(async () => {
    await transport?.close();
    await node?.stop();
    await server?.close();
    server = undefined;
    node = undefined;
    transport = undefined;
  });

  it("issues a node token through the API, binds a real node, then refuses it after revoke", async () => {
    server = await buildTestServer();
    const port = await listen(server);

    // 1. Create pairing + claim a desktop device → real control + node tokens.
    const code = (
      await server.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: {} })
    ).json().code as string;
    const claimed = (
      await server.app.inject({
        method: "POST",
        url: "/api/v1/devices/claim",
        payload: { code, platform: "windows", app_version: "2.0.0", display_name: "Jeremy's ThinkPad" },
      })
    ).json();
    const deviceId = claimed.device.id as string;
    const nodeToken = claimed.node_token as string;

    // 2. Enroll → links a computer (starts `enrolling`).
    const enrolled = (
      await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/enroll`, payload: {} })
    ).json();
    const computerId = enrolled.computer_id as string;
    expect(await computerStatus(server, computerId)).toBe("enrolling");

    // 3. A real node connects with the ISSUED node token and binds its computer.
    transport = createWebSocketTransport({
      url: `ws://127.0.0.1:${port}/api/v1/node?token=${nodeToken}`,
      hello: hello(computerId),
    });
    node = createNodeClient({ nodeId: computerId, transport, adapter: createMockAdapter() });
    node.start();
    await transport.ready;
    await waitFor(() => server?.nodeRegistry.get(computerId) !== undefined, "node bound via issued token");
    // hello/heartbeat persisted: the enrolled computer is now online.
    await waitFor(async () => (await computerStatus(server!, computerId)) === "online", "computer online");

    // 4. Tear the node down and revoke the device through the API.
    await transport.close();
    await node.stop();
    transport = undefined;
    node = undefined;
    const revoke = (
      await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} })
    ).json();
    expect(revoke.revoked).toBe(true);

    // 5. The same node token is now refused at the node plane (close 1008).
    expect(await closeCodeFor(port, nodeToken, computerId)).toBe(1008);
    expect(server.nodeRegistry.get(computerId)).toBeUndefined();
  });
});
