import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { codexRuntime, createNodeClient } from "@artoo/artood";
import { agentInstances, agentRuntimes, contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, type AssistantTurn, type Message } from "@artoo/domain";
import { createInProcessChannel } from "@artoo/testkit";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

// Explicit opt-in: consumes a real provider's allowance. Normally uses the
// externally configured Codex CLI. Optional ARTOO_CODEX_CHAT_BINARY / MODEL /
// PROVIDER_URL / PROVIDER_KEY settings apply only to this test process; the key
// stays in its environment, never in command arguments or evidence. No login or
// persistent CLI configuration is changed. Transport/auth remain test fixtures.
const enabled = process.env.ARTOO_CODEX_CHAT_SMOKE === "1";

function conversationCommand(): string[] {
  const command = [process.env.ARTOO_CODEX_CHAT_BINARY ?? "codex", "exec", "--json",
    "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "{{workspace_root}}"];
  const model = process.env.ARTOO_CODEX_CHAT_MODEL;
  if (model) command.push("-c", `model=${JSON.stringify(model)}`);
  const providerUrl = process.env.ARTOO_CODEX_CHAT_PROVIDER_URL;
  if (providerUrl) {
    const url = new URL(providerUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Live provider URL must be HTTP(S) without embedded credentials, query or fragment");
    }
    if (!process.env.ARTOO_CODEX_CHAT_PROVIDER_KEY) throw new Error("A custom live provider requires ARTOO_CODEX_CHAT_PROVIDER_KEY");
    command.push("-c", 'model_provider="artoo_live_smoke"',
      "-c", 'model_providers.artoo_live_smoke.name="Artoo live smoke"',
      "-c", `model_providers.artoo_live_smoke.base_url=${JSON.stringify(providerUrl)}`,
      "-c", 'model_providers.artoo_live_smoke.env_key="ARTOO_CODEX_CHAT_PROVIDER_KEY"',
      "-c", 'model_providers.artoo_live_smoke.wire_api="responses"');
  }
  command.push("Read the file {{context_pack_path}}. Respond to conversation.current_request using its " +
    "message history and task context. This is a read-only conversation: only read the supplied context, " +
    "do not modify files or access the network, and give an explicit final user-facing answer.");
  return command;
}

describe.skipIf(!enabled)("gated real Codex conversation", () => {
  let server: TestServer | undefined;
  let node: ReturnType<typeof createNodeClient> | undefined;
  let binding: ReturnType<typeof attachNodeBinding> | undefined;
  let dispatcher: ReturnType<typeof createAssistantDispatcher> | undefined;
  let workspace: string | undefined;
  let evidencePath: string | undefined;
  let completedReport: Record<string, unknown> | undefined;

  afterEach(async () => {
    const failures: string[] = [];
    let nodeStopped = node === undefined;
    async function cleanup(stage: string, action: () => unknown | Promise<unknown>) {
      try { await action(); } catch { failures.push(stage); }
    }
    await cleanup("dispatcher", () => dispatcher?.stop());
    await cleanup("node", async () => { await node?.stop(true); nodeStopped = true; });
    // A possibly live CLI can still emit indefinitely or need its context file.
    if (nodeStopped) await cleanup("binding drain", () => binding?.drain());
    await cleanup("binding close", () => binding?.close());
    await cleanup("server", () => server?.close());
    if (workspace && nodeStopped) {
      const isolatedWorkspace = workspace;
      await cleanup("workspace", () => {
        const target = realpathSync(isolatedWorkspace);
        const parent = realpathSync(tmpdir());
        if (!target.startsWith(`${parent}${sep}artoo-codex-chat-`)) throw new Error("Refusing cleanup outside the isolated chat workspace");
        rmSync(target, { recursive: true, force: true });
      });
    }
    if (failures.length) throw new Error(`Live conversation cleanup failed at: ${failures.join(", ")}`);
    // A failed cleanup leaves the initial passed:false report in place.
    if (completedReport && evidencePath) {
      const report = { ...completedReport, cleanup_complete: true };
      writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
      console.log("CODEX_CHAT_EVIDENCE " + JSON.stringify(report));
    }
  });

  it("persists real replies, carries history to a second CLI turn and records provider usage", async () => {
    const output = resolve("artifacts/live");
    mkdirSync(output, { recursive: true });
    const evidence = { checked_at: new Date().toISOString(), runtime: "codex",
      requested_model: process.env.ARTOO_CODEX_CHAT_MODEL ?? "CLI configuration",
      provider_configuration: process.env.ARTOO_CODEX_CHAT_PROVIDER_URL ? "temporary custom provider" : "CLI configuration",
      transport: "in-process fixture" };
    // Invalidate previous success before any live configuration or dispatch.
    evidencePath = join(output, "codex-conversation.json");
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, passed: false }, null, 2)}\n`);
    const command = conversationCommand();
    workspace = mkdtempSync(join(tmpdir(), "artoo-codex-chat-"));
    server = await buildTestServer({ workspaceRoot: workspace });
    await server.db.db.update(agentInstances).set({ runtime: "codex" }).where(eq(agentInstances.id, "instance_mock_coder"));
    await server.db.db.update(agentRuntimes).set({ runtime: "codex" }).where(eq(agentRuntimes.id, "runtime_mock"));
    const channel = createInProcessChannel();
    binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock");
    server.ctx.onRunQueued = (runId) => binding!.dispatchRunStart(runId);
    const registration = codexRuntime({ allowedRoots: [workspace], command, outputFormat: "codex-json" });
    node = createNodeClient({ nodeId: "computer_local_mock", transport: channel.node, adapter: registration.adapter });
    node.start();
    dispatcher = createAssistantDispatcher(server.ctx, () => { throw new Error("Real Codex conversation dispatcher failed"); });

    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Read-only live conversation verification",
      description: "Answer from the supplied context_pack.md. Only read the supplied context; do not modify files or access the network.",
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
          // Do not echo provider diagnostics: they may include private URLs or account details.
          expect(turn.status, "Real Codex provider turn must complete").toBe("completed");
          expect(turn.response_message_id).toBeTruthy();
          return turn;
        }
        if (turn.status === "waiting" && turn.error) throw new Error("Real Codex provider dispatch is waiting with an error");
        await new Promise((done) => setTimeout(done, 250));
      }
      throw new Error("Real Codex conversation exceeded the two-minute turn limit");
    }

    const first = await send(`Reply with exactly this verification marker: ${marker}. Do not change files or access the network.`);
    const second = await send("Repeat the verification marker from your previous answer, followed by the word FOLLOWUP. Use the supplied conversation history. Do not change files or access the network.");
    expect(first.run_id).not.toBe(second.run_id);
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
    expect(secondRun?.runtimeId).toBe("codex");
    const [runtime] = await server.db.db.select().from(agentRuntimes).where(and(
      eq(agentRuntimes.computerId, secondRun!.computerId), eq(agentRuntimes.runtime, secondRun!.runtimeId),
    ));
    expect(runtime?.runtime).toBe("codex");
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, secondRun!.contextPackId!));
    expect(ContextPackSchema.parse(pack!.payload).conversation?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", body: answers[0]!.body }),
    ]));

    const measurements = [];
    for (const turn of [first, second]) {
      const response = await server.app.inject({ method: "GET", url: `/api/v1/runs/${turn.run_id}/usage` });
      expect(response.statusCode).toBe(200);
      const usage = response.json().usage;
      expect(usage?.input_tokens).toBeGreaterThan(0);
      expect(usage?.output_tokens).toBeGreaterThan(0);
      measurements.push({ run_id: turn.run_id, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_input_tokens, cost_usd: usage.cost_usd, currency: usage.currency });
    }
    expect(readdirSync(workspace).filter((name) => name !== "context_pack.md")).toEqual([]);
    completedReport = { ...evidence, passed: true,
      checks: ["Two real CLI answers persisted once", "Prior answer present in follow-up context and result", "Provider usage recorded", "No model-written files"], measurements };
  }, 270_000);
});
