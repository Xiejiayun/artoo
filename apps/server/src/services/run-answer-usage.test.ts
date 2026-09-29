import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeClient, createProcessAdapter } from "@artoo/artood";
import { assistantTurns, eventLog, messages, runUsage } from "@artoo/db";
import { createInProcessChannel } from "@artoo/testkit";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachNodeBinding, type NodeBinding } from "../node-binding.js";
import { buildTestServer, type TestServer } from "../test-support.js";
import { enqueueAssistantTurn } from "./assistant-service.js";
import { assignTask, markReady } from "./lifecycle-service.js";
import { getRunUsage, ingestRunEvent } from "./run-service.js";

const NODE = "computer_local_mock";
describe("assistant answer and provider usage ingestion", () => {
  let server: TestServer;
  let workspace: string;
  let binding: NodeBinding | undefined;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "artoo-answer-usage-"));
    server = await buildTestServer({ workspaceRoot: workspace });
  });
  afterEach(async () => { binding?.close(); binding = undefined; await server.close(); await rm(workspace, { recursive: true, force: true }); });

  async function prepare() {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Explain this project", acceptance_criteria: ["Clear answer"], required_capabilities: ["code.modify"],
    } });
    const task = created.json().task as { id: string; room_id: string };
    const result = await enqueueAssistantTurn(server.ctx, task.room_id, { body: "请解释一下", client_request_id: "reply_usage_test" });
    await markReady(server.ctx, task.id);
    return { task, turn: result.turn };
  }

  it("delivers a real subprocess's final answer into room chat and links the originating turn", async () => {
    const { task, turn } = await prepare();
    const channel = createInProcessChannel();
    binding = attachNodeBinding(server.ctx, channel.serverTransport, NODE);
    server.ctx.onRunQueued = (runId) => binding!.dispatchRunStart(runId);
    const adapter = createProcessAdapter({ allowedRoots: [workspace], outputFormat: "codex-json",
      command: [process.execPath, fileURLToPath(new URL("../../../artood/test-fixtures/structured-agent.mjs", import.meta.url)), "codex"] });
    const node = createNodeClient({ nodeId: NODE, transport: channel.node, adapter });
    node.start();
    const assigned = await assignTask(server.ctx, task.id, { mode: "auto" }, turn.id);
    await node.stop(); await binding.drain();
    const replies = await server.db.db.select().from(messages).where(and(eq(messages.roomId, task.room_id), eq(messages.actorType, "agent"), eq(messages.kind, "text")));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ body: "已完成你的请求，测试通过。", runId: assigned.run.id,
      payload: { assistant_turn_id: turn.id, intent: "assistant" } });
    const stored = (await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, turn.id)))[0]!;
    expect(stored.responseMessageId).toBe(replies[0]!.id);
    expect(await getRunUsage(server.ctx, assigned.run.id)).toMatchObject({ input_tokens: 101, output_tokens: 22,
      cached_input_tokens: 30, cost_usd: null, currency: null, provider_session_id: "fixture_codex" });
    expect(await server.db.db.select().from(eventLog).where(and(eq(eventLog.runId, assigned.run.id), eq(eventLog.type, "message.created")))).toHaveLength(1);
  });

  it("deduplicates replayed final answers and stores unknown cost separately from reported zero", async () => {
    const { task, turn } = await prepare();
    const { run } = await assignTask(server.ctx, task.id, { mode: "auto" }, turn.id);
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: NODE, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    const answer = { runId: run.id, nodeId: NODE, sequence: 1, event: { kind: "answer" as const, text: "The result" } };
    expect((await ingestRunEvent(server.ctx, answer)).deduped).toBe(false);
    expect((await ingestRunEvent(server.ctx, answer)).deduped).toBe(true);
    await ingestRunEvent(server.ctx, { ...answer, sequence: 2 });
    const replies = await server.db.db.select().from(messages).where(and(eq(messages.runId, run.id), eq(messages.kind, "text")));
    expect(replies).toHaveLength(1);
    const usage = { runId: run.id, nodeId: NODE, sequence: 3, event: { kind: "usage" as const, usage: { input_tokens: 200, output_tokens: 50 } } };
    await ingestRunEvent(server.ctx, usage);
    expect((await ingestRunEvent(server.ctx, usage)).deduped).toBe(true);
    expect(await getRunUsage(server.ctx, run.id)).toMatchObject({ input_tokens: 200, cost_usd: null });
    await ingestRunEvent(server.ctx, { ...usage, sequence: 4, event: { kind: "usage", usage: { cost_usd: 0, currency: "USD" } } });
    expect(await getRunUsage(server.ctx, run.id)).toMatchObject({ input_tokens: 200, output_tokens: 50, cost_usd: 0, currency: "USD" });
    expect(await server.db.db.select().from(runUsage).where(eq(runUsage.runId, run.id))).toHaveLength(1);
  });

  it("rejects invalid usage and discards successful-looking answers after cancellation", async () => {
    const { task, turn } = await prepare();
    const { run } = await assignTask(server.ctx, task.id, { mode: "auto" }, turn.id);
    expect(await getRunUsage(server.ctx, run.id)).toBeNull();
    await expect(ingestRunEvent(server.ctx, { runId: run.id, nodeId: NODE, sequence: 0,
      event: { kind: "usage", usage: { cost_usd: -1 } } })).rejects.toThrow("invalid provider usage");
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: NODE, sequence: 0, event: { kind: "lifecycle", phase: "cancelled" } });
    await ingestRunEvent(server.ctx, { runId: run.id, nodeId: NODE, sequence: 1, event: { kind: "answer", text: "Late reply" } });
    expect(await server.db.db.select().from(messages).where(and(eq(messages.runId, run.id), eq(messages.kind, "text")))).toEqual([]);
    expect((await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, turn.id)))[0]?.responseMessageId).toBeNull();
    await expect(getRunUsage({ ...server.ctx, organizationId: "org_other" }, run.id)).rejects.toThrow("run not found");
  });
});
