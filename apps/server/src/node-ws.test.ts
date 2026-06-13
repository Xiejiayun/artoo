import { createNodeClient, createWebSocketTransport } from "@artoo/artood";
import { computers } from "@artoo/db";
import type { NodeHello } from "@artoo/protocol";
import { createMockAdapter } from "@artoo/testkit";
import { eq } from "drizzle-orm";
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

async function computerStatus(server: TestServer): Promise<string> {
  const row = (
    await server.ctx.db.db.select().from(computers).where(eq(computers.id, NODE_ID))
  )[0];
  return row?.status ?? "missing";
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

  it("rejects a node connection whose first app frame is not node.hello", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    const closeCode = new Promise<number>((resolve) => {
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            kind: "node.heartbeat",
            node_id: NODE_ID,
            sequence: 0,
            resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
            runtimes: [],
            running_instances: [],
          }),
        );
      });
      socket.addEventListener("close", (event) => resolve(event.code));
    });

    await expect(closeCode).resolves.toBe(1008);
    expect(server.nodeRegistry.get(NODE_ID)).toBeUndefined();
  });

  it("does not let an older duplicate connection unregister a newer binding", async () => {
    server = await buildTestServer();
    const port = await listen(server);

    const first = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    await new Promise<void>((resolve) => {
      first.addEventListener("open", () => {
        first.send(JSON.stringify(hello(NODE_ID)));
        resolve();
      });
    });
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "first node registered");
    const firstBinding = server.nodeRegistry.get(NODE_ID);

    const second = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    await new Promise<void>((resolve) => {
      second.addEventListener("open", () => {
        second.send(JSON.stringify(hello(NODE_ID)));
        resolve();
      });
    });
    await waitFor(
      () => server?.nodeRegistry.get(NODE_ID) !== undefined && server.nodeRegistry.get(NODE_ID) !== firstBinding,
      "second node registered",
    );
    const secondBinding = server.nodeRegistry.get(NODE_ID);

    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.nodeRegistry.get(NODE_ID)).toBe(secondBinding);
    expect(await computerStatus(server)).toBe("online");

    second.close();
    await waitFor(async () => (await computerStatus(server!)) === "offline", "second node offline");
  });
});
