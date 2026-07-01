import { createNodeClient, createWebSocketTransport } from "@artoo/artood";
import { agentInstances, computers, devices, deviceTokens } from "@artoo/db";
import type { NodeHello, ServerToNodeMessage } from "@artoo/protocol";
import { createMockAdapter } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { testDeviceAuthConfig } from "./config/device-auth.js";
import { generateDeviceToken } from "./services/device-credential.js";
import { ingestRunEvent } from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import type { GraceWindowManager } from "./ws/grace-window.js";

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

async function createRunningRun(server: TestServer, title: string): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: {
      project_id: "proj_artoo",
      title,
      acceptance_criteria: ["ok"],
      required_capabilities: ["code.modify"],
    },
  });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto" },
  });
  const runId = assigned.json().run.id as string;
  await ingestRunEvent(server.ctx, {
    runId,
    nodeId: NODE_ID,
    sequence: 0,
    event: { kind: "lifecycle", phase: "started" },
  });
  return runId;
}

async function computerStatus(server: TestServer): Promise<string> {
  const row = (
    await server.ctx.db.db.select().from(computers).where(eq(computers.id, NODE_ID))
  )[0];
  return row?.status ?? "missing";
}

async function addComputer(server: TestServer, id: string): Promise<void> {
  await server.db.db.insert(computers).values({
    id,
    organizationId: "org_default",
    displayName: id,
    hostname: id,
    os: "windows",
    arch: "x64",
    status: "online",
    createdAt: "2026-06-13T00:00:00.000Z",
  });
}

async function advertisedRuntimeIds(server: TestServer, computerId: string): Promise<string[]> {
  const res = await server.app.inject({
    method: "GET",
    url: `/api/v1/computers/${computerId}/runtimes`,
  });
  return (res.json().runtimes as Array<{ runtime: string }>).map((runtime) => runtime.runtime);
}

async function setMockInstanceConcurrency(server: TestServer, concurrencyLimit: number): Promise<void> {
  await server.db.db
    .update(agentInstances)
    .set({ config: { concurrency_limit: concurrencyLimit } })
    .where(eq(agentInstances.id, "instance_mock_coder"));
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

  it("persists heartbeat runtimes under the accepted hello session id", async () => {
    server = await buildTestServer();
    const spoofedNodeId = "computer_spoofed";
    await addComputer(server, spoofedNodeId);
    const port = await listen(server);

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(hello(NODE_ID)));
        resolve();
      });
    });
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "node registered");

    socket.send(
      JSON.stringify({
        kind: "node.heartbeat",
        node_id: spoofedNodeId,
        sequence: 0,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
        runtimes: [{ runtime: "codex", status: "available", capabilities: ["code.modify"] }],
        running_instances: [],
      }),
    );

    await waitFor(
      async () => (await advertisedRuntimeIds(server!, NODE_ID)).includes("codex"),
      "runtime persisted under session node",
    );
    expect(await advertisedRuntimeIds(server, spoofedNodeId)).toEqual([]);
    socket.close();
  });

  it("resumes only the disconnect snapshot on reconnect", async () => {
    let snapshotRunIds: string[] = [];
    const graceWindow: GraceWindowManager = {
      arm: () => {},
      disarm: (computerId) => (computerId === NODE_ID ? [...snapshotRunIds] : []),
      isArmed: (computerId) => computerId === NODE_ID && snapshotRunIds.length > 0,
    };
    server = await buildTestServer({ graceWindow });
    await setMockInstanceConcurrency(server, 4);
    const snapshotRunId = await createRunningRun(server, "snapshot run");
    const newRunId = await createRunningRun(server, "new active run");
    snapshotRunIds = [snapshotRunId];
    const port = await listen(server);

    const commands: ServerToNodeMessage[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    try {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          commands.push(JSON.parse(event.data) as ServerToNodeMessage);
        }
      });
      await new Promise<void>((resolve) => {
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify(hello(NODE_ID)));
          resolve();
        });
      });
      await waitFor(
        () => commands.some((command) => command.type === "run.resume"),
        "resume command sent",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const resumeRunIds = commands.flatMap((command) =>
        command.type === "run.resume" ? [command.payload.run_id] : [],
      );
      expect(resumeRunIds).toEqual([snapshotRunId]);
      expect(resumeRunIds).not.toContain(newRunId);
    } finally {
      socket.close();
    }
  });
});

describe("node WS auth gate (#28 slice 3a)", () => {
  const NOW = "2026-06-13T00:00:00.000Z";
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  /** Open a node WS with the given token (and optional first hello); resolve the
   *  close code, or -1 if the socket stays open past the timeout. */
  function closeCodeFor(port: string, token: string, helloNodeId?: string): Promise<number> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${token}`);
    return new Promise<number>((resolve) => {
      socket.addEventListener("open", () => {
        if (helloNodeId !== undefined) {
          socket.send(JSON.stringify(hello(helloNodeId)));
        }
      });
      socket.addEventListener("close", (event) => resolve(event.code));
      setTimeout(() => resolve(-1), 2500);
    });
  }

  /** Insert a device + its node credential, optionally linked to a computer.
   *  Returns the raw node token (`sk_device_<lookup>_<secret>`). */
  async function seedNodeToken(
    s: TestServer,
    name: string,
    opts: { computerId: string | null },
  ): Promise<string> {
    const tok = generateDeviceToken();
    if (opts.computerId !== null) {
      await addComputer(s, opts.computerId);
    }
    await s.db.db.insert(devices).values({
      id: `device_${name}`,
      organizationId: "org_default",
      displayName: name,
      platform: "windows",
      appVersion: "2.0.0",
      computerId: opts.computerId,
      enrolledByUserId: "user_owner",
      trust: "active",
      lastSeenAt: null,
      createdAt: NOW,
      revokedAt: null,
    });
    await s.db.db.insert(deviceTokens).values({
      id: `dtok_${name}`,
      organizationId: "org_default",
      deviceId: `device_${name}`,
      kind: "node",
      tokenLookup: tok.lookup,
      tokenHash: tok.secretHash,
      status: "active",
      createdAt: NOW,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    return tok.raw;
  }

  it("rejects token=dev when the dev escape is disabled (production path)", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devNodeToken: null }) });
    const port = await listen(server);
    await expect(closeCodeFor(port, "dev")).resolves.toBe(1008);
  });

  it("accepts a device node token whose linked computer matches node.hello", async () => {
    server = await buildTestServer();
    const raw = await seedNodeToken(server, "linked", { computerId: "computer_linked" });
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=${raw}`);
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify(hello("computer_linked")));
        resolve();
      });
    });
    await waitFor(
      () => server?.nodeRegistry.get("computer_linked") !== undefined,
      "device node registered",
    );
    expect(server.nodeRegistry.get("computer_linked")).toBeDefined();
    socket.close();
  });

  it("rejects a device node token when node.hello node_id != linked computer", async () => {
    server = await buildTestServer();
    const raw = await seedNodeToken(server, "mismatch", { computerId: "computer_mismatch" });
    const port = await listen(server);
    await expect(closeCodeFor(port, raw, "computer_other")).resolves.toBe(1008);
    expect(server.nodeRegistry.get("computer_mismatch")).toBeUndefined();
  });

  it("rejects an unlinked device node token (no computer) — fail closed", async () => {
    server = await buildTestServer();
    const raw = await seedNodeToken(server, "unlinked", { computerId: null });
    const port = await listen(server);
    await expect(closeCodeFor(port, raw, "computer_whatever")).resolves.toBe(1008);
  });

  it("rejects an unknown device token", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    await expect(closeCodeFor(port, "sk_device_deadbeef_unknownsecret")).resolves.toBe(1008);
  });
});
