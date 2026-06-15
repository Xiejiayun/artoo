import { agentInstances, contextPacks } from "@artoo/db";
import type { RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const PROJECT = "proj_artoo";

async function proposeMemory(
  server: TestServer,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await server.app.inject({
    method: "POST",
    url: "/api/v1/memories",
    payload: { scope: "project", project_id: PROJECT, ...body },
  });
  return res.json().memory.id as string;
}

async function acceptMemory(server: TestServer, body: Record<string, unknown>): Promise<string> {
  const id = await proposeMemory(server, body);
  await server.app.inject({ method: "POST", url: `/api/v1/memories/${id}/accept`, payload: {} });
  return id;
}

/** Create a plain task (real id for FK refs), without assigning it. */
async function createTask(server: TestServer): Promise<string> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: PROJECT, title: "other", acceptance_criteria: ["done"] },
  });
  return created.json().task.id as string;
}

/** Drive a task through ready -> assign and return the assign response body. */
async function assign(
  server: TestServer,
  capabilities: string[] = ["code.modify"],
  writePaths?: string[],
): Promise<{ run: { id: string; context_pack_id: string | null } }> {
  const created = await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: PROJECT, title: "t", acceptance_criteria: ["done"], required_capabilities: capabilities },
  });
  const taskId = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
  const assigned = await server.app.inject({
    method: "POST",
    url: `/api/v1/tasks/${taskId}/assign`,
    payload: { mode: "auto", ...(writePaths ? { write_paths: writePaths } : {}) },
  });
  return assigned.json();
}

async function packFor(server: TestServer, contextPackId: string) {
  const [pack] = await server.db.db
    .select()
    .from(contextPacks)
    .where(eq(contextPacks.id, contextPackId));
  return pack;
}

describe("ContextPack memory injection at run-start (#21 Part D)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("persists a pack with selected source_memory_ids and links runs.context_pack_id", async () => {
    server = await buildTestServer();
    const memId = await acceptMemory(server, { text: "prefer async/await" });

    const body = await assign(server, ["code.modify"], ["Src/Foo", "src/foo"]);
    const contextPackId = body.run.context_pack_id;
    expect(contextPackId).toBeTruthy();

    const pack = await packFor(server, contextPackId as string);
    expect(pack?.runId).toBe(body.run.id);
    expect(pack?.sourceMemoryIds).toEqual([memId]);
    expect((pack?.payload as { memory: { project_notes: string[] } }).memory.project_notes).toContain(
      "prefer async/await",
    );
    expect(
      (pack?.payload as { policy: { filesystem_write_scope: string[] } }).policy.filesystem_write_scope,
    ).toEqual(["Src/Foo"]);
  });

  it("does not inject proposed, rejected, or non-matching memories", async () => {
    server = await buildTestServer();
    // proposed (never accepted) + rejected — excluded by status
    await proposeMemory(server, { text: "unconfirmed" });
    const rejected = await proposeMemory(server, { text: "bad idea" });
    await server.app.inject({ method: "POST", url: `/api/v1/memories/${rejected}/reject`, payload: {} });
    // accepted, but task-scoped to a DIFFERENT task — non-matching context
    const otherTask = await createTask(server);
    await acceptMemory(server, { scope: "task", task_id: otherTask, text: "other task only" });

    const body = await assign(server);
    const pack = await packFor(server, body.run.context_pack_id as string);
    expect(pack?.sourceMemoryIds).toEqual([]);
  });

  it("still creates a valid pack with empty source ids when nothing is eligible", async () => {
    server = await buildTestServer();
    const body = await assign(server);
    expect(body.run.context_pack_id).toBeTruthy();
    const pack = await packFor(server, body.run.context_pack_id as string);
    expect(pack?.sourceMemoryIds).toEqual([]);
    // payload still parses to the ContextPack shape (task/project/memory present)
    expect((pack?.payload as { project: { id: string } }).project.id).toBe(PROJECT);
  });

  it("node-binding dispatch sends the persisted context_pack_id, not a fresh one", async () => {
    server = await buildTestServer();
    const channel = createInProcessChannel();
    const binding = attachNodeBinding(server.ctx, channel.serverTransport);
    const sent: ServerToNodeMessage[] = [];
    channel.node.subscribe((msg) => {
      sent.push(msg);
    });

    const body = await assign(server);
    await server.db.db
      .update(agentInstances)
      .set({ workspaceRoot: "C:/workspace/drifted-instance" })
      .where(eq(agentInstances.id, "instance_mock_coder"));
    await binding.dispatchRunStart(body.run.id);
    binding.close();

    const runStart = sent.find((m) => m.kind === "command") as RunStartCommand | undefined;
    expect(runStart?.type).toBe("run.start");
    expect(runStart?.payload.context_pack.id).toBe(body.run.context_pack_id);
    expect(runStart?.payload.workspace.root).toBe("C:/workspace/artoo");
  });
});
