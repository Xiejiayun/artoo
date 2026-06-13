import { createNodeClient, createWebSocketTransport } from "@artoo/artood";
import type { NodeHello } from "@artoo/protocol";
import { createMockAdapter } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

const NODE_ID = "computer_local_mock";

function hello(nodeId: string): NodeHello {
  return {
    kind: "node.hello",
    node_id: nodeId,
    protocol_version: "2026-06-11",
    artood_version: "0.1.0",
    machine: { hostname: "localhost", os: "windows", arch: "x64" },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
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

async function status(server: TestServer, taskId: string): Promise<string> {
  const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
  return snap.json().task.status as string;
}

describe("node WS endpoint (real WebSocket loopback)", () => {
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

  it("drives an assigned run to review over a real WebSocket node connection", async () => {
    server = await buildTestServer();
    const port = await listen(server);

    transport = createWebSocketTransport({
      url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`,
      hello: hello(NODE_ID),
    });
    node = createNodeClient({ nodeId: NODE_ID, transport, adapter: createMockAdapter() });
    node.start();
    await transport.ready;
    // hello must be processed (transport registered) before we assign.
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "node registered");

    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "WS loop task",
        acceptance_criteria: ["ok"],
        required_capabilities: ["code.modify"],
      },
    });
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assign`,
      payload: { mode: "auto" },
    });

    // run.start dispatched over WS -> node MockAdapter streams run.events -> server ingests.
    await waitFor(async () => (await status(server!, taskId)) === "review", "task -> review");
    const snap = (
      await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` })
    ).json();
    expect(snap.runs[0].status).toBe("completed");
    expect(snap.artifacts).toHaveLength(1);
  });

  it("rejects a node connection with no token", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node`);
    const closed = await new Promise<boolean>((resolve) => {
      socket.addEventListener("close", () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    expect(closed).toBe(true);
  });
});
