import { approvals, assistantTurns, contextPacks, fileLeases, messages, plans, runs, tasks } from "@artoo/db";
import { ContextPackSchema } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import { cancelAssistantTurn, createAssistantDispatcher, enqueueAssistantTurn, listAssistantTurns } from "./assistant-service.js";
import { requestExecutionApproval, resolveApproval } from "./approval-service.js";
import { createChannel } from "./channel-service.js";
import { createGoal, transitionGoal } from "./goal-service.js";
import { assignTask, markReady, reviewTask } from "./lifecycle-service.js";
import { acceptPlan, proposePlan } from "./plan-service.js";
import { ingestRunEvent } from "./run-service.js";

const NODE = "computer_local_mock";
describe("durable assistant conversation dispatch", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  async function newTask() {
    const response = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Conversation task", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
    } });
    expect(response.statusCode).toBe(201);
    return response.json().task as { id: string; room_id: string };
  }
  const enqueue = (room: string, body: string, thread_root_id?: string) => enqueueAssistantTurn(server.ctx, room, { body, client_request_id: `request_${body}`, thread_root_id });
  async function turn(id: string) { return (await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, id)))[0]!; }
  async function finish(runId: string, answer?: string) {
    await ingestRunEvent(server.ctx, { runId, nodeId: NODE, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    if (answer) await ingestRunEvent(server.ctx, { runId, nodeId: NODE, sequence: 1, event: { kind: "answer", text: answer } });
    await ingestRunEvent(server.ctx, { runId, nodeId: NODE, sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
  }
  async function pack(runId: string) {
    const row = (await server.db.db.select().from(contextPacks).where(eq(contextPacks.runId, runId)))[0]!;
    return ContextPackSchema.parse(row.payload);
  }
  async function textMessage(roomId: string, body: string, thread_root_id?: string) {
    const result = await server.app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/messages`, payload: { kind: "text", body, thread_root_id } });
    expect(result.statusCode).toBe(201);
    return result.json().message as { id: string };
  }

  it("persists one intent/message for concurrent retries and rejects a reused identity with different content", async () => {
    const task = await newTask();
    const input = { body: "Explain the system", client_request_id: "stable_retry_identity" };
    const results = await Promise.all([enqueueAssistantTurn(server.ctx, task.room_id, input), enqueueAssistantTurn(server.ctx, task.room_id, input)]);
    expect(results[0]).toEqual(results[1]);
    expect(await server.db.db.select().from(assistantTurns)).toHaveLength(1);
    expect(await server.db.db.select().from(messages).where(and(eq(messages.roomId, task.room_id), eq(messages.kind, "text")))).toHaveLength(1);
    await expect(enqueueAssistantTurn(server.ctx, task.room_id, { ...input, body: "Different request" })).rejects.toThrow("different content");
  });

  it("dispatches queued requests once in order and builds context with the actual prior answer but no future request", async () => {
    const task = await newTask();
    const first = await enqueue(task.room_id, "First request");
    const second = await enqueue(task.room_id, "Follow-up question");
    await enqueue(task.room_id, "Future unrelated request");
    const errors = vi.fn();
    const dispatcher = createAssistantDispatcher(server.ctx, errors);
    await Promise.all([dispatcher.pump(), dispatcher.pump()]);
    const firstRun = (await turn(first.turn.id)).runId!;
    expect(await turn(second.turn.id)).toMatchObject({ status: "queued", runId: null });
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
    expect((await pack(firstRun)).conversation?.messages).toEqual([]);
    await finish(firstRun, "The first actual answer");
    await dispatcher.pump();
    await dispatcher.pump();
    const secondRun = (await turn(second.turn.id)).runId!;
    expect(secondRun).not.toBe(firstRun);
    expect(await turn(first.turn.id)).toMatchObject({ status: "completed" });
    expect((await pack(secondRun)).conversation).toMatchObject({ current_request: "Follow-up question", messages: [
      { role: "user", body: "First request" }, { role: "assistant", body: "The first actual answer" },
    ] });
    expect(await pack(secondRun)).not.toHaveProperty("review_feedback");
    await dispatcher.pump();
    expect(await server.db.db.select().from(runs)).toHaveLength(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports completion without a structured answer as failed and never dispatches a cancelled queued turn", async () => {
    const task = await newTask();
    const first = await enqueue(task.room_id, "Need a real answer");
    const cancelled = await enqueue(task.room_id, "Do not start");
    const stop = vi.fn();
    await cancelAssistantTurn(server.ctx, cancelled.turn.id, stop);
    const dispatcher = createAssistantDispatcher(server.ctx);
    await dispatcher.pump();
    await finish((await turn(first.turn.id)).runId!);
    await dispatcher.pump();
    await dispatcher.pump();
    expect(await turn(first.turn.id)).toMatchObject({ status: "failed", error: expect.stringContaining("without a structured answer") });
    expect(await turn(cancelled.turn.id)).toMatchObject({ status: "cancelled", runId: null });
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps thread histories and replies isolated and allows another thread to dispatch while one waits", async () => {
    const channel = await createChannel(server.ctx, { project_id: "proj_artoo", name: "Architecture", description: "" });
    const firstRoot = await textMessage(channel.id, "First topic");
    const secondRoot = await textMessage(channel.id, "Second topic");
    const waiting = await enqueue(channel.id, "Unsupported capability", firstRoot.id);
    const active = await enqueue(channel.id, "Work on second topic", secondRoot.id);
    await server.db.db.update(tasks).set({ requiredCapabilities: ["code.modify"] }).where(eq(tasks.id, active.turn.task_id));
    const dispatcher = createAssistantDispatcher(server.ctx);
    await dispatcher.pump();
    expect(await turn(waiting.turn.id)).toMatchObject({ status: "waiting", runId: null });
    const runId = (await turn(active.turn.id)).runId!;
    expect(runId).toBeTruthy();
    expect((await pack(runId)).conversation?.messages.map((message) => message.body)).toEqual(["Second topic"]);
    await finish(runId, "Answer in second thread");
    const answer = (await server.db.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.kind, "text"))))[0]!;
    expect(answer.threadRootId).toBe(secondRoot.id);
    expect((await server.db.db.select().from(messages).where(eq(messages.id, secondRoot.id)))[0]!.replyCount).toBe(2);
    await enqueue(channel.id, "Work on second topic", secondRoot.id);
    await ingestRunEvent(server.ctx, { runId, nodeId: NODE, sequence: 1, event: { kind: "answer", text: "Answer in second thread" } });
    expect((await server.db.db.select().from(messages).where(eq(messages.id, secondRoot.id)))[0]!.replyCount).toBe(2);
    expect(await listAssistantTurns(server.ctx, channel.id)).toEqual([]);
    expect((await listAssistantTurns(server.ctx, channel.id, firstRoot.id)).map((item) => item.id)).toEqual([waiting.turn.id]);
    const reply = await textMessage(channel.id, "Nested reply", firstRoot.id);
    await expect(enqueue(channel.id, "Invalid nested root", reply.id)).rejects.toThrow("top-level message");
    const other = await newTask();
    await expect(enqueue(other.room_id, "Wrong room", firstRoot.id)).rejects.toThrow("top-level message");
  });

  it("creates a fresh approval and preserves exact write scopes when following up on a closed task", async () => {
    const task = await newTask();
    await markReady(server.ctx, task.id);
    const approval = await requestExecutionApproval(server.ctx, task.id, { summary: "Review source edits", risk: "high" });
    await resolveApproval(server.ctx, approval.id, { decision: "approved" });
    const original = await assignTask(server.ctx, task.id, { mode: "auto", write_paths: ["src/Important.ts"] });
    await finish(original.run.id);
    await reviewTask(server.ctx, task.id, { outcome: "accepted" });
    const followup = await enqueue(task.room_id, "Follow up safely");
    const policy = (await server.db.db.select().from(tasks).where(eq(tasks.id, followup.turn.task_id)))[0]!;
    expect(policy).toMatchObject({ executionPolicyTaskId: task.id, parentTaskId: task.id });
    const gate = (await server.db.db.select().from(approvals).where(eq(approvals.taskId, followup.turn.task_id)))[0]!;
    expect(gate).toMatchObject({ status: "pending", runId: null, risk: "high" });
    const dispatcher = createAssistantDispatcher(server.ctx);
    await dispatcher.pump();
    expect(await turn(followup.turn.id)).toMatchObject({ status: "waiting", runId: null, error: expect.stringContaining("approval") });
    await resolveApproval(server.ctx, gate.id, { decision: "approved" });
    await dispatcher.pump();
    const runId = (await turn(followup.turn.id)).runId!;
    expect((await pack(runId)).policy.filesystem_write_scope).toEqual(["src/Important.ts"]);
    expect(await server.db.db.select().from(fileLeases).where(eq(fileLeases.runId, runId))).toHaveLength(1);
  });

  it("retains a newly introduced approval and scope across the next follow-up generation", async () => {
    const task = await newTask();
    await markReady(server.ctx, task.id);
    const initial = await assignTask(server.ctx, task.id, { mode: "auto" });
    await finish(initial.run.id);
    await reviewTask(server.ctx, task.id, { outcome: "accepted" });
    const middle = await enqueue(task.room_id, "Introduce review requirement");
    await markReady(server.ctx, middle.turn.task_id);
    const gate = await requestExecutionApproval(server.ctx, middle.turn.task_id, { summary: "New restricted work", risk: "medium" });
    await resolveApproval(server.ctx, gate.id, { decision: "approved" });
    const run = await assignTask(server.ctx, middle.turn.task_id, { mode: "auto", write_paths: ["src/NewScope.ts"] }, middle.turn.id);
    await finish(run.run.id, "Reviewed intermediate answer");
    await createAssistantDispatcher(server.ctx).pump();
    await reviewTask(server.ctx, middle.turn.task_id, { outcome: "accepted" });
    const next = await enqueue(task.room_id, "Keep the new restrictions");
    const nextGate = (await server.db.db.select().from(approvals).where(eq(approvals.taskId, next.turn.task_id)))[0]!;
    expect(nextGate).toMatchObject({ status: "pending", risk: "medium" });
    await markReady(server.ctx, next.turn.task_id);
    await resolveApproval(server.ctx, nextGate.id, { decision: "approved" });
    const nextRun = await assignTask(server.ctx, next.turn.task_id, { mode: "auto" }, next.turn.id);
    expect((await pack(nextRun.run.id)).policy.filesystem_write_scope).toEqual(["src/NewScope.ts"]);
  });

  it("retains source-plan validation and superseded-plan fences through closed-task follow-ups", async () => {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Policy fence" });
    const spec = { title: "Implement", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify" as const] };
    const remainingSpec = { ...spec, title: "Other pending work" };
    const plan = await proposePlan(server.ctx, goal.id, { task_specs: [spec, remainingSpec] });
    const originalId = (await acceptPlan(server.ctx, plan.id)).task_ids[0]!;
    const original = (await server.db.db.select().from(tasks).where(eq(tasks.id, originalId)))[0]!;
    await markReady(server.ctx, originalId);
    const first = await assignTask(server.ctx, originalId, { mode: "auto" });
    await finish(first.run.id);
    await reviewTask(server.ctx, originalId, { outcome: "accepted" });
    const followup = await enqueue(original.roomId!, "Respect original plan");
    await markReady(server.ctx, followup.turn.task_id);
    await server.db.db.update(plans).set({ taskSpecs: [{ ...spec, write_scopes: ["src/**"] }, remainingSpec] }).where(eq(plans.id, plan.id));
    await expect(assignTask(server.ctx, followup.turn.task_id, { mode: "auto" }, followup.turn.id)).rejects.toThrow("write_scopes");
    await server.db.db.update(plans).set({ taskSpecs: [spec, remainingSpec] }).where(eq(plans.id, plan.id));
    await transitionGoal(server.ctx, goal.id, "pause");
    const nextPlan = await proposePlan(server.ctx, goal.id, { task_specs: [{ ...spec, title: "Replacement" }] });
    await acceptPlan(server.ctx, nextPlan.id);
    await expect(assignTask(server.ctx, followup.turn.task_id, { mode: "auto" }, followup.turn.id)).rejects.toThrow("superseded plan");
    expect(await server.db.db.select().from(runs)).toHaveLength(1);
  });

  it("fails closed for cyclic and cross-project restored execution-policy references", async () => {
    const first = await newTask();
    const second = await newTask();
    await markReady(server.ctx, first.id);
    await server.db.db.update(tasks).set({ executionPolicyTaskId: second.id }).where(eq(tasks.id, first.id));
    await server.db.db.update(tasks).set({ executionPolicyTaskId: first.id }).where(eq(tasks.id, second.id));
    await expect(assignTask(server.ctx, first.id, { mode: "auto" })).rejects.toThrow("Cyclic");
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Other goal" });
    await server.db.db.update(tasks).set({ executionPolicyTaskId: null, goalId: goal.id }).where(eq(tasks.id, second.id));
    await expect(assignTask(server.ctx, first.id, { mode: "auto" })).rejects.toThrow("same project and goal");
    expect(await server.db.db.select().from(runs)).toHaveLength(0);
  });
});
