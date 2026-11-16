import { randomUUID } from "node:crypto";
import { agentInstances, agents, artifacts, computers, devices, deviceTokens, runs, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { blobChecksum } from "./content-addressed-blob.js";
import { generateDeviceToken } from "./services/device-credential.js";
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";
import { buildTestServer, type TestServer } from "./test-support.js";

let server: TestServer;
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.close();
});

/** Real DB/auth/blob boundaries with controlled node inventory; no physical
 * second computer, CLI or Provider runs in this suite. */
async function setup() {
  const store = new MemoryArtifactStore();
  server = await buildTestServer({ artifactStore: store });
  const [computer] = await server.db.db.select().from(computers).where(eq(computers.id, "computer_local_mock"));
  const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
  const [instance] = await server.db.db
    .select()
    .from(agentInstances)
    .where(eq(agentInstances.id, "instance_mock_coder"));
  if (!computer || !agent || !instance) throw new Error("Missing controlled inventory");
  await server.db.db
    .insert(computers)
    .values({ ...computer, id: "computer_peer", displayName: "Controlled peer computer" });
  await server.db.db.insert(agents).values({ ...agent, id: "agent_peer", displayName: "Controlled peer Agent" });
  await server.db.db
    .insert(agentInstances)
    .values({ ...instance, id: "instance_peer", computerId: "computer_peer", agentId: "agent_peer" });
  const token = generateDeviceToken(),
    sessionId = randomUUID();
  await server.db.db.insert(devices).values({
    id: "device_peer",
    organizationId: server.ctx.organizationId,
    displayName: "Controlled peer device",
    platform: "linux",
    appVersion: "fixture",
    computerId: "computer_peer",
    enrolledByUserId: "user_owner",
    trust: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  await server.db.db.insert(deviceTokens).values({
    id: "peer_token",
    organizationId: server.ctx.organizationId,
    deviceId: "device_peer",
    kind: "node",
    tokenLookup: token.lookup,
    tokenHash: token.secretHash,
    status: "active",
    createdAt: server.ctx.clock.nowIso(),
  });
  server.ctx.getPairedNodeSession = (computerId) =>
    computerId === "computer_peer"
      ? {
          computerId,
          deviceId: "device_peer",
          tokenLookup: token.lookup,
          sessionId,
        }
      : undefined;
  const create = async (title: string) => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title,
        acceptance_criteria: ["Preserve pinned input bytes"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().task.id as string;
  };
  const assign = async (id: string, instanceId: string) => {
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` })).statusCode).toBe(200);
    const response = await server.app.inject({
      method: "POST",
      url: `/api/v1/tasks/${id}/assign`,
      payload: { mode: "manual", agent_instance_id: instanceId },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().run;
  };
  const sourceTask = await create("Produce a shared contract"),
    source = await assign(sourceTask, "instance_mock_coder");
  const bytes = Buffer.from("A versioned contract shared across computers.\n"),
    checksum = blobChecksum(bytes);
  const upload = await server.app.inject({
    method: "PUT",
    url: `/api/v1/node/runs/${source.id}/artifacts?type=contract&path=contract.txt`,
    headers: {
      authorization: "Bearer dev",
      "x-artoo-node-id": "computer_local_mock",
      "content-type": "application/octet-stream",
      "x-artoo-checksum": checksum,
    },
    payload: bytes,
  });
  expect(upload.statusCode, upload.body).toBe(201);
  expect(
    (await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${source.id}/mock-execute` })).statusCode,
  ).toBe(200);
  expect(
    (
      await server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${sourceTask}/review`,
        payload: { outcome: "accepted" },
      })
    ).statusCode,
  ).toBe(200);
  const targetTask = await create("Consume the accepted contract");
  expect(
    (
      await server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${targetTask}/dependencies`,
        payload: { depends_on_task_id: sourceTask, type: "contract_required" },
      })
    ).statusCode,
  ).toBe(201);
  const target = await assign(targetTask, "instance_peer");
  const [artifact] = await server.db.db.select().from(artifacts).where(eq(artifacts.checksum, checksum));
  if (!artifact) throw new Error("Uploaded contract missing");
  const url = `/api/v1/node/runs/${target.id}/dependency-artifacts/${artifact.id}/content`;
  const headers = { authorization: `Bearer ${token.raw}`, "x-artoo-session-id": sessionId };
  return { store, bytes, checksum, artifact, source, sourceTask, target, url, headers, tokenLookup: token.lookup };
}

it("delivers only the frozen upstream artifact to the current target computer session", async () => {
  const f = await setup();
  const response = await server.app.inject({ method: "GET", url: f.url, headers: f.headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.rawPayload).toEqual(f.bytes);
  expect(response.headers["x-artoo-checksum"]).toBe(f.checksum);
  expect(response.headers["x-artoo-artifact-id"]).toBe(f.artifact.id);
  expect(response.headers["x-artoo-source-run-id"]).toBe(f.source.id);
  expect(response.headers["cache-control"]).toBe("private, no-store");
  for (const headers of [
    {},
    { ...f.headers, authorization: "Bearer dev" },
    { ...f.headers, "x-artoo-session-id": randomUUID() },
  ]) {
    expect((await server.app.inject({ method: "GET", url: f.url, headers })).statusCode).toBe(403);
  }
  expect(
    (await server.app.inject({ method: "GET", url: f.url.replace(f.target.id, f.source.id), headers: f.headers }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await server.app.inject({
        method: "GET",
        url: f.url.replace(f.artifact.id, "unrelated_artifact"),
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(404);
});

it("rejects obsolete dependency state, terminal recipients and changed blob identity", async () => {
  const f = await setup();
  await server.db.db.update(tasks).set({ status: "ready" }).where(eq(tasks.id, f.sourceTask));
  expect((await server.app.inject({ method: "GET", url: f.url, headers: f.headers })).statusCode).toBe(409);
  await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, f.sourceTask));
  await server.db.db
    .update(artifacts)
    .set({ checksum: `sha256:${"a".repeat(64)}` })
    .where(eq(artifacts.id, f.artifact.id));
  expect((await server.app.inject({ method: "GET", url: f.url, headers: f.headers })).statusCode).toBe(409);
  await server.db.db.update(artifacts).set({ checksum: f.checksum }).where(eq(artifacts.id, f.artifact.id));
  await server.db.db.update(runs).set({ status: "cancelled" }).where(eq(runs.id, f.target.id));
  expect((await server.app.inject({ method: "GET", url: f.url, headers: f.headers })).statusCode).toBe(409);
});

it("checks current session again after object-store IO and distinguishes missing content", async () => {
  const f = await setup(),
    read = f.store.read.bind(f.store);
  vi.spyOn(f.store, "read").mockImplementation(async (checksum, size) => {
    const bytes = await read(checksum, size);
    server.ctx.getPairedNodeSession = () => undefined;
    return bytes;
  });
  expect((await server.app.inject({ method: "GET", url: f.url, headers: f.headers })).statusCode).toBe(403);
  vi.restoreAllMocks();
  // Restore exactly the original controlled session, then remove its object.
  server.ctx.getPairedNodeSession = () => ({
    computerId: "computer_peer",
    deviceId: "device_peer",
    tokenLookup: f.tokenLookup,
    sessionId: f.headers["x-artoo-session-id"],
  });
  f.store.objects.clear();
  expect((await server.app.inject({ method: "GET", url: f.url, headers: f.headers })).statusCode).toBe(404);
});
