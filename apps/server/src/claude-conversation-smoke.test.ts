import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { claudeCodeRuntime, createNodeClient } from "@artoo/artood";
import { agentInstances, agentRuntimes, contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, type AssistantTurn, type Message } from "@artoo/domain";
import { createInProcessChannel } from "@artoo/testkit";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

// Explicit opt-in: uses this machine's Claude login and model allowance.
// No mocked provider output. Auth/transport fixtures remain distinct from a
// publicly deployed server. The existing task-writing smoke is a separate gate.
const enabled = process.env.ARTOO_CLAUDE_CHAT_SMOKE === "1";

describe.skipIf(!enabled)("gated real Claude conversation", () => {
  let server: TestServer | undefined;
  let node: ReturnType<typeof createNodeClient> | undefined;
  let binding: ReturnType<typeof attachNodeBinding> | undefined;
  let dispatcher: ReturnType<typeof createAssistantDispatcher> | undefined;
  let workspace: string | undefined;

  afterEach(async () => {
    await dispatcher?.stop();
    // A timeout/failure must stop the real CLI before closing storage or cleanup.
    await node?.stop(true);
    await binding?.drain();
    binding?.close();
    await server?.close();
    if (workspace) {
      const target = realpathSync(workspace);
      const parent = realpathSync(tmpdir());
      if (!target.startsWith(`${parent}${sep}artoo-claude-chat-`)) throw new Error("Refusing cleanup outside the isolated chat workspace");
      rmSync(target, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it("persists a real answer, passes it to a second CLI turn and records provider usage", async () => {
    const output = resolve("artifacts/live");
    mkdirSync(output, { recursive: true });
    const evidence = { checked_at: new Date().toISOString(), runtime: "claude-code",
      requested_model: process.env.ANTHROPIC_MODEL ?? "CLI configuration", transport: "in-process fixture" };
    // Never leave a previous success report behind after a failed live attempt.
    writeFileSync(join(output, "claude-conversation.json"), `${JSON.stringify({ ...evidence, passed: false }, null, 2)}\n`);
    workspace = mkdtempSync(join(tmpdir(), "artoo-claude-chat-"));
    // Disable inherited customizations for this isolated verification. Keep the
    // production preset's unattended permission denial; never enable bypass.
    vi.stubEnv("CLAUDE_CODE_SAFE_MODE", "1");
    server = await buildTestServer({ workspaceRoot: workspace });
    await server.db.db.update(agentInstances).set({ runtime: "claude-code" }).where(eq(agentInstances.id, "instance_mock_coder"));
    await server.db.db.update(agentRuntimes).set({ runtime: "claude-code" }).where(eq(agentRuntimes.id, "runtime_mock"));
    const channel = createInProcessChannel();
    binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock");
    server.ctx.onRunQueued = (runId) => binding!.dispatchRunStart(runId);
    const registration = claudeCodeRuntime({ allowedRoots: [workspace] });
    node = createNodeClient({ nodeId: "computer_local_mock", transport: channel.node, adapter: registration.adapter });
    node.start();
    dispatcher = createAssistantDispatcher(server.ctx, (error) => { throw error; });

    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Read-only live conversation verification",
      description: "Answer the conversation request using only its supplied context. Do not modify files, run shell commands or access external tools.",
      acceptance_criteria: ["A follow-up uses the prior assistant answer"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const roomId = created.json().room.id as string;
    const marker = `ARTOO_CHAT_${randomUUID().replaceAll("-", "")}`;

    async function send(body: string): Promise<AssistantTurn> {
      const response = await server!.app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/assistant-turns`, payload: {
        body, client_request_id: randomUUID(), agent_instance_id: "instance_mock_coder",
      } });
      expect(response.statusCode).toBe(201);
      const id = response.json().turn.id as string;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await binding!.drain();
        await dispatcher!.pump();
        const result = await server!.app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/assistant-turns` });
        expect(result.statusCode).toBe(200);
        const turn = (result.json().turns as AssistantTurn[]).find((item) => item.id === id)!;
        if (["completed", "failed", "cancelled"].includes(turn.status)) {
          expect(turn.status, turn.error ?? "Real provider turn must complete").toBe("completed");
          expect(turn.response_message_id).toBeTruthy();
          return turn;
        }
        if (turn.status === "waiting" && turn.error) throw new Error(`Real provider dispatch is waiting: ${turn.error}`);
        await new Promise((done) => setTimeout(done, 250));
      }
      throw new Error("Real Claude conversation exceeded the two-minute turn limit");
    }

    const first = await send(`Reply with exactly this verification marker: ${marker}. Do not change files or call external tools.`);
    const second = await send("Repeat the verification marker from your previous answer, followed by the word FOLLOWUP. Use the supplied conversation history. Do not change files or call external tools.");
    const history = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${roomId}/messages` });
    expect(history.statusCode).toBe(200);
    const messages = history.json().messages as Message[];
    const answers = [first, second].map((turn) => messages.find((message) => message.id === turn.response_message_id)!);
    expect(answers[0]?.body).toContain(marker);
    expect(answers[1]?.body).toContain(marker);
    expect(answers[1]?.body).toContain("FOLLOWUP");
    expect(answers.every((message) => message.actor_type === "agent" && message.thread_root_id === null)).toBe(true);
    expect(messages.filter((message) => message.actor_type === "agent" && message.kind === "text")).toHaveLength(2);
    const [secondRun] = await server.db.db.select().from(runs).where(eq(runs.id, second.run_id!));
    // run.runtimeId stores the runtime name, not agent_runtimes.id.
    expect(secondRun?.runtimeId).toBe("claude-code");
    const [runtime] = await server.db.db.select().from(agentRuntimes).where(and(
      eq(agentRuntimes.computerId, secondRun!.computerId), eq(agentRuntimes.runtime, secondRun!.runtimeId),
    ));
    expect(runtime?.runtime).toBe("claude-code");
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, secondRun!.contextPackId!));
    expect(ContextPackSchema.parse(pack!.payload).conversation?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", body: answers[0]!.body }),
    ]));

    const measurements = [];
    for (const turn of [first, second]) {
      const response = await server.app.inject({ method: "GET", url: `/api/v1/runs/${turn.run_id}/usage` });
      expect(response.statusCode).toBe(200);
      const usage = response.json().usage;
      expect(usage?.output_tokens).toBeGreaterThan(0);
      measurements.push({ run_id: turn.run_id, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_input_tokens, cost_usd: usage.cost_usd, currency: usage.currency });
    }
    expect(readdirSync(workspace).filter((name) => name !== "context_pack.md")).toEqual([]);
    const report = { ...evidence, passed: true,
      checks: ["Two real CLI answers persisted once", "Prior answer present in follow-up context and result", "Provider usage recorded", "No model-written files"], measurements };
    writeFileSync(join(output, "claude-conversation.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log("CLAUDE_CHAT_EVIDENCE " + JSON.stringify(report));
  }, 270_000);
});
