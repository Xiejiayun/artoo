import { createNodeClient, createWebSocketTransport } from "@artoo/artood";
import { agentInstances, computers, devices, deviceTokens } from "@artoo/db";
import type { NodeHello, ServerToNodeMessage } from "@artoo/protocol";
import { createMockAdapter } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { testDeviceAuthConfig } from "./config/device-auth.js";
import { generateDeviceToken } from "./services/device-credential.js";
import { ingestRunEvent } from "./services/run-service.js";
import * as runService from "./services/run-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import type { GraceWindowManager } from "./ws/grace-window.js";
import { parseNodeToServer } from "./ws/ws-node-transport.js";

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

  it("exposes workspace suggestions only from the current authenticated node session", async () => {
    server = await buildTestServer();
    const port = await listen(server);
    transport = createWebSocketTransport({ url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`,
      hello: { ...hello(NODE_ID), workspace_roots: { version: 1, paths: ["C:/ArtooWorkspaces"] } } });
    await transport.ready;
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "workspace hello registered");
    const online = await server.app.inject({ method: "GET", url: "/api/v1/daemons" });
    expect(online.statusCode).toBe(200);
    expect(online.json().daemons.find((item: { computer_id: string }) => item.computer_id === NODE_ID).workspace_roots).toEqual({ version: 1, paths: ["C:/ArtooWorkspaces"] });
    await transport.close();
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) === undefined, "node disconnected");
    const offline = await server.app.inject({ method: "GET", url: "/api/v1/daemons" });
    expect(offline.json().daemons.find((item: { computer_id: string }) => item.computer_id === NODE_ID)).not.toHaveProperty("workspace_roots");
  });

  it("requires the first persisted runtime advertisement before registering an agent workspace", async () => {
    server = await buildTestServer();
    const computerId = "computer_first_heartbeat";
    await addComputer(server, computerId);
    const port = await listen(server);
    // A connected hello is deliberately observable before the first heartbeat.
    // Drive that boundary over the real socket instead of sleeping until a timer.
    transport = createWebSocketTransport({
      url: `ws://127.0.0.1:${port}/api/v1/node?token=dev`, hello: hello(computerId),
    });
    await transport.ready;
    await waitFor(() => server?.nodeRegistry.get(computerId) !== undefined, "hello registered");
    const url = `/api/v1/computers/${computerId}/instances`;
    const payload = { runtime: "codex", workspace_root: "C:/first-heartbeat", display_name: "First heartbeat" };
    expect(await advertisedRuntimeIds(server, computerId)).toEqual([]);
    expect((await server.app.inject({ method: "POST", url, payload })).statusCode).toBe(409);

    await transport.send({ kind: "node.heartbeat", node_id: computerId, sequence: 0,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 }, running_instances: [],
      runtimes: [{ runtime: "codex", status: "available", capabilities: ["code.modify"] }] });
    await waitFor(async () => (await advertisedRuntimeIds(server!, computerId)).includes("codex"), "runtime persisted");
    const created = await server.app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().agent_instance).toMatchObject({ computer_id: computerId, runtime: "codex", workspace_root: payload.workspace_root });
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
        first.send(JSON.stringify({ ...hello(NODE_ID), execution_features: ["run-verification.v1"],
          verification_profiles: [{ profile_id: "default", project_id: "proj_artoo", workspace_root: "/work/product" }] }));
        resolve();
      });
    });
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "first node registered");
    const firstBinding = server.nodeRegistry.get(NODE_ID);
    expect(server.ctx.supportsVerificationProfile?.(NODE_ID, "default", "proj_artoo", "/work/product")).toBe(true);

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
    expect(firstBinding?.supportsVerificationProfile("default", "proj_artoo", "/work/product")).toBe(false);
    expect(server.ctx.supportsVerificationProfile?.(NODE_ID, "default", "proj_artoo", "/work/product")).toBe(false);

    const heartbeat = { kind: "node.heartbeat", node_id: NODE_ID, sequence: 0,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 }, running_instances: [],
      runtimes: [{ runtime: "codex", status: "available", capabilities: ["code.modify"] }] };
    second.send(JSON.stringify(heartbeat));
    await waitFor(async () => (await advertisedRuntimeIds(server!, NODE_ID)).includes("codex"), "current runtime snapshot persisted");
    let replacedCloseCode: number | undefined;
    first.addEventListener("close", (event) => { replacedCloseCode = event.code; });
    first.send(JSON.stringify({ ...heartbeat, sequence: 1, runtimes: [] }));
    await waitFor(() => replacedCloseCode !== undefined, "replaced heartbeat sender closed");
    expect(replacedCloseCode).toBe(1008);
    const runtimeRows = (await server.app.inject({ method: "GET", url: `/api/v1/computers/${NODE_ID}/runtimes` })).json().runtimes;
    expect(runtimeRows.find((runtime: { runtime: string }) => runtime.runtime === "codex").status).toBe("available");
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

  it("reconciles a fast reconnect while its disconnect snapshot database read is still pending", async () => {
    const arm = vi.fn();
    server = await buildTestServer({ graceWindow: { arm, disarm: () => [], isArmed: () => false } });
    const port = await listen(server);
    const first = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
    await new Promise<void>((resolve) => first.addEventListener("open", () => { first.send(JSON.stringify(hello(NODE_ID))); resolve(); }));
    await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "initial connection");
    const runId = await createRunningRun(server, "pending snapshot");
    let release!: () => void;
    let snapshotStarted = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = runService.activeRunIdsForComputer;
    const read = vi.spyOn(runService, "activeRunIdsForComputer").mockImplementationOnce(async (ctx, id) => {
      snapshotStarted = true; await gate; return original(ctx, id);
    });
    let second: WebSocket | undefined;
    try {
      first.close();
      await waitFor(() => snapshotStarted, "snapshot query started");
      const commands: ServerToNodeMessage[] = [];
      second = new WebSocket(`ws://127.0.0.1:${port}/api/v1/node?token=dev`);
      second.addEventListener("message", (event) => { commands.push(JSON.parse(String(event.data)) as ServerToNodeMessage); });
      await new Promise<void>((resolve) => second!.addEventListener("open", () => { second!.send(JSON.stringify(hello(NODE_ID))); resolve(); }));
      await waitFor(() => server?.nodeRegistry.get(NODE_ID) !== undefined, "reconnected before snapshot resolved");
      release();
      await waitFor(() => commands.some((command) => command.type === "run.resume" && command.payload.run_id === runId), "pending snapshot resumed");
      expect(arm).not.toHaveBeenCalled();
      expect(commands.some((command) => command.type === "run.start")).toBe(false);
    } finally { release(); read.mockRestore(); first.close(); second?.close(); }
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

describe("H6 server WebSocket envelope routing", () => {
  // Inert protocol fixtures: these do not establish native closure, receipt possession or review acceptance.
  const digest = `sha256:${"a".repeat(64)}`;
  const review = { version: 1, review_id: "h6-review", request_digest: digest } as const;
  const repair = { version: 1, repair_id: "h6-repair", request_digest: digest, run_id: "repair-run" } as const;
  const envelopes = [
    { kind: "product.source.execution-review.ack.v1", node_id: "node-B", command_id: "review-command", payload: review, status: "accepted" },
    { kind: "product.source.execution-review.result.v1", node_id: "node-B", command_id: "review-command",
      payload: { ...review, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Controlled cancellation" } },
    { kind: "product.source.execution-repair.ack.v1", node_id: "node-B", command_id: "repair-command", payload: repair, status: "accepted" },
    { kind: "product.source.execution-repair.result.v1", node_id: "node-B", command_id: "repair-command",
      payload: { ...repair, outcome: "cancelled_before_start", closed: true } },
  ] as const;

  it.each(envelopes)("parses $kind from actual text and byte wire input", envelope => {
    const wire = JSON.stringify(envelope);
    expect(parseNodeToServer(wire)).toEqual(envelope);
    expect(parseNodeToServer(new TextEncoder().encode(wire))).toEqual(envelope);
  });

  it.each(envelopes)("keeps strict envelope and nested payload validation for $kind", envelope => {
    expect(parseNodeToServer(JSON.stringify({ ...envelope, node_id: "" }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelope, command_id: "" }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelope, unexpected: true }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelope, payload: { ...envelope.payload, request_digest: "not-a-digest" } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelope, payload: { ...envelope.payload, unexpected: true } }))).toBeNull();
    const otherKind = envelope.kind.includes("execution-review")
      ? envelope.kind.replace("execution-review", "execution-repair") : envelope.kind.replace("execution-repair", "execution-review");
    expect(parseNodeToServer(JSON.stringify({ ...envelope, kind: otherKind }))).toBeNull();
  });

  it("does not promote transport fields into execution or closure authority", () => {
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[0], status: "reviewed" }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[2], status: "finished" }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[1], payload: { ...envelopes[1].payload, execution_authorized: true } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[1], payload: { ...review, execution_authorized: false, outcome: "uncertain", closed: true, reason: "Unknown closure" } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[3], payload: { ...repair, outcome: "uncertain", closed: true, reason: "Unknown closure" } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[3], payload: { ...envelopes[3].payload, verified_repair: {} } }))).toBeNull();
  });
});

describe("H7 server WebSocket envelope routing", () => {
  const digest = `sha256:${"b".repeat(64)}`;
  const author = { version: 1, validation_id: "validation", request_digest: digest, run_id: "validation-run" } as const;
  const review = { version: 1, review_id: "validation-review", request_digest: digest } as const;
  const envelopes = [
    { kind: "product.source.validation.ack.v1", node_id: "node-B", command_id: "author-command", payload: author, status: "accepted" },
    { kind: "product.source.validation.result.v1", node_id: "node-B", command_id: "author-command", payload: { ...author, outcome: "cancelled_before_start", closed: true } },
    { kind: "product.source.validation-review.ack.v1", node_id: "node-B", command_id: "review-command", payload: review, status: "accepted" },
    { kind: "product.source.validation-review.result.v1", node_id: "node-B", command_id: "review-command",
      payload: { ...review, execution_authorized: false, outcome: "cancelled_before_start", closed: true, reason: "Controlled cancellation" } },
  ] as const;
  it.each(envelopes)("routes actual text/byte $kind and rejects broken identities", envelope => {
    const wire = JSON.stringify(envelope);
    expect(parseNodeToServer(wire)).toEqual(envelope);
    expect(parseNodeToServer(new TextEncoder().encode(wire))).toEqual(envelope);
    expect(parseNodeToServer(JSON.stringify({ ...envelope, command_id: "" }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelope, payload: { ...envelope.payload, request_digest: "unbound" } }))).toBeNull();
  });
  it("cannot turn unknown H7 closure or reviewer metadata into execution authority", () => {
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[1], payload: { ...author, outcome: "uncertain", closed: true, reason: "Unknown native closure" } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[3], payload: { ...envelopes[3].payload, execution_authorized: true } }))).toBeNull();
    expect(parseNodeToServer(JSON.stringify({ ...envelopes[1], payload: { ...envelopes[1].payload, closed_failure: {} } }))).toBeNull();
  });
});
