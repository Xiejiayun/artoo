import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { codexRuntime, createNodeClient } from "@artoo/artood";
import { agentRuntimes, contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, DiscussionSchema, GoalAuditBundleSchema, GoalSchema, PlanSchema,
  type AssistantTurn, type Message, type TaskDependency } from "@artoo/domain";
import { createInProcessChannel } from "@artoo/testkit";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { createAssistantDispatcher } from "./services/assistant-service.js";
import { createDiscussionDispatcher } from "./services/discussion-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

// Separate explicit opt-in: three real provider turns, two distinct instances.
// Shares ARTOO_CODEX_CHAT_BINARY / MODEL / PROVIDER_URL / PROVIDER_KEY with the
// conversation gate. Auth and node transport are fixtures, model answers are not.
const enabled = process.env.ARTOO_CODEX_DISCUSSION_SMOKE === "1";

function discussionCommand(): string[] {
  const command = [process.env.ARTOO_CODEX_CHAT_BINARY ?? "codex", "exec", "--json",
    "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "{{workspace_root}}"];
  if (process.env.ARTOO_CODEX_CHAT_MODEL) command.push("-c", `model=${JSON.stringify(process.env.ARTOO_CODEX_CHAT_MODEL)}`);
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
    "message history and task context. Only read the supplied context; do not modify files, implement " +
    "tasks or access the network. Follow the assigned discussion role and requested JSON synthesis format. " +
    "Give an explicit final user-facing answer.");
  return command;
}

describe.skipIf(!enabled)("gated real Codex multi-agent discussion", () => {
  let server: TestServer | undefined;
  let node: ReturnType<typeof createNodeClient> | undefined;
  let binding: ReturnType<typeof attachNodeBinding> | undefined;
  let assistant: ReturnType<typeof createAssistantDispatcher> | undefined;
  let coordinator: ReturnType<typeof createDiscussionDispatcher> | undefined;
  let workspace: string | undefined;
  let evidencePath: string | undefined;
  let completedReport: Record<string, unknown> | undefined;

  afterEach(async () => {
    const failures: string[] = [];
    let nodeStopped = node === undefined;
    async function cleanup(stage: string, action: () => unknown | Promise<unknown>) {
      try { await action(); } catch { failures.push(stage); }
    }
    await cleanup("coordinator", () => coordinator?.stop());
    await cleanup("assistant", () => assistant?.stop());
    await cleanup("node", async () => { await node?.stop(true); nodeStopped = true; });
    // A possibly live CLI can still emit indefinitely or need its context file.
    if (nodeStopped) await cleanup("binding drain", () => binding?.drain());
    await cleanup("binding close", () => binding?.close());
    await cleanup("server", () => server?.close());
    if (workspace && nodeStopped) {
      const isolatedWorkspace = workspace;
      await cleanup("workspace", () => {
        const target = realpathSync(isolatedWorkspace), parent = realpathSync(tmpdir());
        if (!target.startsWith(`${parent}${sep}artoo-codex-discussion-`)) throw new Error("Refusing cleanup outside the isolated discussion workspace");
        rmSync(target, { recursive: true, force: true });
      });
    }
    if (failures.length) throw new Error(`Live discussion cleanup failed at: ${failures.join(", ")}`);
    // Cleanup failure must not leave evidence claiming this live gate passed.
    if (completedReport && evidencePath) {
      const report = { ...completedReport, cleanup_complete: true };
      writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
      console.log("CODEX_DISCUSSION_EVIDENCE " + JSON.stringify(report));
    }
  });

  it("shares actual agent answers and materializes the proposed DAG only after acceptance", async () => {
    const output = resolve("artifacts/live");
    mkdirSync(output, { recursive: true });
    evidencePath = join(output, "codex-discussion.json");
    const evidence = { checked_at: new Date().toISOString(), runtime: "codex",
      requested_model: process.env.ARTOO_CODEX_CHAT_MODEL ?? "CLI configuration",
      provider_configuration: process.env.ARTOO_CODEX_CHAT_PROVIDER_URL ? "temporary custom provider" : "CLI configuration",
      transport: "in-process fixture" };
    writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, passed: false }, null, 2)}\n`);
    const command = discussionCommand();
    workspace = mkdtempSync(join(tmpdir(), "artoo-codex-discussion-"));
    server = await buildTestServer({ workspaceRoot: workspace });
    await server.db.db.update(agentRuntimes).set({ runtime: "codex", capabilities: ["code.read"] }).where(eq(agentRuntimes.id, "runtime_mock"));
    const channel = createInProcessChannel();
    binding = attachNodeBinding(server.ctx, channel.serverTransport, "computer_local_mock");
    server.ctx.onRunQueued = (runId) => binding!.dispatchRunStart(runId);
    const registration = codexRuntime({ allowedRoots: [workspace], command, discussionCommand: command,
      outputFormat: "codex-json", capabilities: ["code.read"] });
    node = createNodeClient({ nodeId: "computer_local_mock", transport: channel.node, adapter: registration.adapter });
    node.start();
    assistant = createAssistantDispatcher(server.ctx, () => { throw new Error("Live discussion assistant dispatch failed"); });
    coordinator = createDiscussionDispatcher(server.ctx, (_ctx, runId) => binding!.dispatchRunStop(runId),
      () => { throw new Error("Live discussion coordination failed"); });

    const instanceIds: string[] = [];
    for (const displayName of ["Live planner", "Live reviewer"]) {
      const response = await server.app.inject({ method: "POST", url: "/api/v1/computers/computer_local_mock/instances", payload: {
        runtime: "codex", workspace_root: workspace, display_name: displayName, capabilities: ["code.read"],
      } });
      expect(response.statusCode).toBe(201);
      instanceIds.push(response.json().agent_instance.id as string);
    }
    expect(new Set(instanceIds).size).toBe(2);
    const titles = ["Specify chat response contract", "Verify chat response contract"];
    const criteria = ["Success and error response schemas are documented.",
      "Tests cover success and error responses against the documented schema."];
    const created = await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: {
      project_id: "proj_artoo", title: "Plan a verifiable chat response contract",
      objective: "Discuss a plan only; do not implement it. Produce exactly two tasks in this order. " +
        `Task 0 title must be exactly '${titles[0]}', with exactly one acceptance criterion '${criteria[0]}'. ` +
        `Task 1 title must be exactly '${titles[1]}', with exactly one acceptance criterion '${criteria[1]}'. ` +
        "Task 1 must depend on task 0 using ref '0' and type 'blocks'. Task 0 has no dependencies. " +
        "Keep required_capabilities, approval_gates, write_scopes and expected_artifacts empty. " +
        "The reviewer must quote the code invented in the planner's first answer, and the final JSON rationale must retain that same code.",
      acceptance_criteria: ["The plan preserves the requested criteria and dependent verification task"],
    } });
    expect(created.statusCode).toBe(201);
    const goal = GoalSchema.parse(created.json().goal);
    async function audit() {
      const response = await server!.app.inject({ method: "GET", url: `/api/v1/goals/${goal.id}/audit-bundle` });
      expect(response.statusCode).toBe(200);
      return GoalAuditBundleSchema.parse(response.json().bundle);
    }
    expect((await audit()).tasks).toHaveLength(0);
    const started = await server.app.inject({ method: "POST", url: `/api/v1/goals/${goal.id}/discussions`, payload: {
      participants: [
        { agent_instance_id: instanceIds[0], role: "Implementation design. Only in your initial contribution invent one code matching REVIEW_ plus 6 uppercase letters/digits. In synthesis reuse the original code; never invent another." },
        { agent_instance_id: instanceIds[1], role: "Test and risk review. Quote the exact REVIEW_ code from the first agent's answer and assess task order, dependency and both acceptance criteria." },
      ], rounds: 1, max_minutes: 5,
    } });
    expect(started.statusCode).toBe(201);
    let discussion = DiscussionSchema.parse(started.json().discussion);
    const threadQuery = `thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`;
    const turnsUrl = `/api/v1/rooms/${discussion.room_id}/assistant-turns?${threadQuery}`;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && discussion.status !== "ready") {
      await binding.drain();
      await assistant.pump();
      await coordinator.pump();
      const response = await server.app.inject({ method: "GET", url: `/api/v1/discussions/${discussion.id}` });
      expect(response.statusCode).toBe(200);
      discussion = DiscussionSchema.parse(response.json().discussion);
      if (["failed", "cancelled", "stopping"].includes(discussion.status)) throw new Error("Real provider discussion did not finish successfully");
      const pending = await server.app.inject({ method: "GET", url: turnsUrl });
      expect(pending.statusCode).toBe(200);
      if ((pending.json().turns as AssistantTurn[]).some((turn) => turn.status === "waiting" && turn.error)) {
        throw new Error("Real discussion dispatch is waiting with an error");
      }
      if (discussion.status !== "ready") await new Promise((done) => setTimeout(done, 250));
    }
    expect(discussion).toMatchObject({ status: "ready", current_step: 3, total_steps: 3 });
    const listed = await server.app.inject({ method: "GET", url: turnsUrl });
    expect(listed.statusCode).toBe(200);
    const turns = listed.json().turns as AssistantTurn[];
    expect(turns).toHaveLength(3);
    const history = await server.app.inject({ method: "GET", url: `/api/v1/rooms/${discussion.room_id}/messages?${threadQuery}` });
    expect(history.statusCode).toBe(200);
    const messages = history.json().messages as Message[];
    const answers = turns.map((turn) => messages.find((message) => message.id === turn.response_message_id)!);
    expect(messages.filter((message) => message.actor_type === "agent" && message.kind === "text")).toHaveLength(3);
    const expectedHistory = [discussion.thread_root_id];
    const measurements = [];
    const providerSessions = new Set<string>();
    for (const [index, turn] of turns.entries()) {
      expect(turn.status).toBe("completed");
      const instanceId = instanceIds[index === 1 ? 1 : 0];
      expect(answers[index]).toMatchObject({ actor_type: "agent", actor_id: instanceId, thread_root_id: discussion.thread_root_id });
      const [run] = await server.db.db.select().from(runs).where(eq(runs.id, turn.run_id!));
      expect(run).toMatchObject({ runtimeId: "codex", agentInstanceId: instanceId, status: "completed" });
      const [row] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run!.contextPackId!));
      const pack = ContextPackSchema.parse(row!.payload);
      expect(pack.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
      expect(pack.conversation?.thread_root_id).toBe(discussion.thread_root_id);
      expect(pack.conversation?.history_truncated).toBe(false);
      expect(pack.conversation?.messages.map((message) => message.id)).toEqual(expectedHistory);
      expect(pack.conversation?.messages.filter((message) => message.role === "assistant").map((message) => message.body))
        .toEqual(answers.slice(0, index).map((message) => message.body));
      expect(pack.conversation?.current_request).toBe(messages.find((message) => message.id === turn.user_message_id)?.body);
      expectedHistory.push(turn.response_message_id!);
      const usageResponse = await server.app.inject({ method: "GET", url: `/api/v1/runs/${turn.run_id}/usage` });
      expect(usageResponse.statusCode).toBe(200);
      const usage = usageResponse.json().usage;
      expect(usage?.input_tokens).toBeGreaterThan(0);
      expect(usage?.output_tokens).toBeGreaterThan(0);
      expect(typeof usage?.provider_session_id === "string" && usage.provider_session_id.length > 0).toBe(true);
      providerSessions.add(usage.provider_session_id as string);
      measurements.push({ run_id: turn.run_id, agent_instance_id: instanceId, input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens, cached_input_tokens: usage.cached_input_tokens,
        cost_usd: usage.cost_usd, currency: usage.currency });
    }
    expect(providerSessions.size).toBe(3);
    const reviewCode = answers[0]!.body.match(/\bREVIEW_[A-Z0-9]{6}\b/)?.[0];
    expect(Boolean(reviewCode), "Planner must invent a review code for the next agent").toBe(true);
    expect(answers[1]!.body.includes(reviewCode!)).toBe(true);
    const beforeProposal = await audit();
    expect(beforeProposal.tasks).toHaveLength(0);
    expect(beforeProposal.plans).toHaveLength(0);
    const proposed = await server.app.inject({ method: "POST", url: `/api/v1/discussions/${discussion.id}/propose-plan` });
    expect(proposed.statusCode).toBe(200);
    const plan = PlanSchema.parse(proposed.json().plan);
    expect(plan.status).toBe("proposed");
    // The production proposal parser also accepts fenced JSON from real CLIs.
    expect(plan.rationale.includes(reviewCode!)).toBe(true);
    expect(plan.task_specs.map((spec) => spec.title)).toEqual(titles);
    expect(plan.task_specs.map((spec) => spec.acceptance_criteria)).toEqual(criteria.map((criterion) => [criterion]));
    expect(plan.task_specs[0]?.dependencies).toEqual([]);
    expect(plan.task_specs[1]?.dependencies).toEqual([{ ref: "0", type: "blocks" }]);
    expect((await audit()).tasks).toHaveLength(0);
    const accepted = await server.app.inject({ method: "POST", url: `/api/v1/plans/${plan.id}/accept` });
    expect(accepted.statusCode).toBe(200);
    const afterAcceptance = await audit();
    expect(afterAcceptance.tasks).toHaveLength(2);
    expect(afterAcceptance.plans).toHaveLength(1);
    expect(afterAcceptance.plans[0]?.status).toBe("accepted");
    const materialized = titles.map((title) => afterAcceptance.tasks.find(({ task }) => task.title === title)!.task);
    expect(materialized.map((task) => task.acceptance_criteria)).toEqual(criteria.map((criterion) => [criterion]));
    const dependencies = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${materialized[1]!.id}/dependencies` });
    expect(dependencies.statusCode).toBe(200);
    expect((dependencies.json().dependencies as TaskDependency[]).map((edge) => ({ from: edge.from_task_id, to: edge.to_task_id, type: edge.type })))
      .toEqual([{ from: materialized[0]!.id, to: materialized[1]!.id, type: "blocks" }]);
    expect(await server.db.db.select().from(runs)).toHaveLength(3);
    expect(readdirSync(workspace).filter((name) => name !== "context_pack.md")).toEqual([]);
    completedReport = { ...evidence, passed: true, participant_count: 2, provider_turns: 3, provider_session_count: providerSessions.size,
      checks: ["Two distinct instances contribute and synthesize", "Actual prior answers reach each next context",
        "Reviewer and synthesis reuse a code invented by the first model turn", "Three real answers and usage persisted",
        "Zero goal tasks before proposal and before acceptance", "Acceptance preserves two tasks, criteria and dependency", "No model-written files"],
      measurements, tasks_before_proposal: 0, tasks_before_acceptance: 0, tasks_after_acceptance: 2 };
  }, 300_000);
});
