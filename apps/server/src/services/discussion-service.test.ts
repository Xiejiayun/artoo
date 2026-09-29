import { agentInstances, agents, assistantTurns, contextPacks, discussions, messages, plans, runs, tasks } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestServer, fixedClock, type TestServer } from "../test-support.js";
import { createAssistantDispatcher, enqueueAssistantTurn } from "./assistant-service.js";
import { cancelDiscussion, createDiscussionDispatcher, getDiscussion, parseDiscussionPlan, proposeDiscussionPlan, startDiscussion } from "./discussion-service.js";
import { createGoal } from "./goal-service.js";
import { failRunDaemonDisconnect, ingestRunEvent } from "./run-service.js";
import { AppError } from "../errors.js";
import { acceptPlan } from "./plan-service.js";

const participants = [{ agent_instance_id: "instance_mock_coder", role: "Implementation design" }, { agent_instance_id: "instance_reviewer", role: "Test and risk review" }];
const output = JSON.stringify({ rationale: "Separate implementation from verification", task_specs: [
  { title: "Implement API", acceptance_criteria: ["Authenticated requests return the documented schema"] },
  { title: "Verify API", acceptance_criteria: ["Contract and error cases pass"], dependencies: [{ ref: "0", type: "blocks" }] },
] });
describe("bounded agent discussion and reviewable task decomposition", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await buildTestServer();
    const [agent] = await server.db.db.select().from(agents);
    const [instance] = await server.db.db.select().from(agentInstances);
    await server.db.db.insert(agents).values({ ...agent!, id: "agent_reviewer", displayName: "Reviewer" });
    await server.db.db.insert(agentInstances).values({ ...instance!, id: "instance_reviewer", agentId: "agent_reviewer" });
  });
  afterEach(async () => { await server.close(); });
  const stop = async () => {};
  async function begin() {
    const goal = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Ship the API", objective: "Build an API for the project", acceptance_criteria: ["API is usable"] });
    const discussion = await startDiscussion(server.ctx, goal.id, { participants, rounds: 1, max_minutes: 5 });
    return { goal, discussion };
  }
  async function finishTurn(turnId: string, body: string) {
    const assistant = createAssistantDispatcher(server.ctx);
    await assistant.pump();
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, turnId));
    expect(turn?.status, turn?.error ?? "dispatcher should create an execution").toBe("running");
    await ingestRunEvent(server.ctx, { runId: turn!.runId!, nodeId: "computer_local_mock", sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    await ingestRunEvent(server.ctx, { runId: turn!.runId!, nodeId: "computer_local_mock", sequence: 1, event: { kind: "answer", text: body } });
    await ingestRunEvent(server.ctx, { runId: turn!.runId!, nodeId: "computer_local_mock", sequence: 2, event: { kind: "lifecycle", phase: "completed" } });
    await assistant.pump(); await assistant.stop();
    return turn!;
  }
  it("shares actual prior replies, survives dispatcher recreation, and creates a DAG only after plan acceptance", async () => {
    const { goal, discussion } = await begin();
    const worker = createDiscussionDispatcher(server.ctx, stop);
    await worker.pump();
    let current = await getDiscussion(server.ctx, discussion.id);
    const first = await finishTurn(current.active_turn_id!, "Design proposal: implement the API first.");
    await worker.stop();
    const restarted = createDiscussionDispatcher(server.ctx, stop);
    await restarted.pump(); await restarted.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    expect(current.current_step).toBe(1);
    const second = await finishTurn(current.active_turn_id!, "I reviewed the design proposal. Add contract tests after the API task.");
    expect(second.agentInstanceId).toBe("instance_reviewer");
    const secondRun = (await server.db.db.select().from(runs).where(eq(runs.id, second.runId!)))[0]!;
    const pack = (await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, secondRun.contextPackId!)))[0]!.payload as any;
    expect(pack.policy).toMatchObject({ execution_mode: "discussion", filesystem_write_scope: [] });
    expect(pack.conversation.messages.some((message: any) => message.body === "Design proposal: implement the API first.")).toBe(true);
    expect(pack.conversation.thread_root_id).toBe(discussion.thread_root_id);
    await restarted.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    await finishTurn(current.active_turn_id!, output);
    await restarted.pump(); await restarted.pump();
    expect(await getDiscussion(server.ctx, discussion.id)).toMatchObject({ status: "ready", current_step: 3, total_steps: 3 });
    expect(await server.db.db.select().from(assistantTurns)).toHaveLength(3);
    expect(await server.db.db.select().from(tasks).where(eq(tasks.goalId, goal.id))).toHaveLength(0);
    const proposed = await proposeDiscussionPlan(server.ctx, discussion.id);
    expect(proposed.plan.status).toBe("proposed");
    expect(proposed.plan.task_specs[1]?.dependencies[0]?.ref).toBe("0");
    expect((await proposeDiscussionPlan(server.ctx, discussion.id)).plan.id).toBe(proposed.plan.id);
    expect(await server.db.db.select().from(plans)).toHaveLength(1);
    expect(await server.db.db.select().from(tasks).where(eq(tasks.goalId, goal.id))).toHaveLength(0);
    await acceptPlan(server.ctx, proposed.plan.id);
    expect(await server.db.db.select().from(tasks).where(eq(tasks.goalId, goal.id))).toHaveLength(2);
    const replies = await server.db.db.select().from(messages).where(and(eq(messages.actorType, "agent"), eq(messages.kind, "text")));
    expect(replies.every((message) => message.threadRootId === discussion.thread_root_id)).toBe(true);
    expect(first.agentInstanceId).toBe(participants[0]!.agent_instance_id);
    await restarted.stop();
  });
  it("keeps unrelated channel threads out of the agent context", async () => {
    const { discussion } = await begin();
    await server.db.db.insert(messages).values({ id: "unrelated", organizationId: server.ctx.organizationId, roomId: discussion.room_id,
      actorType: "user", actorId: server.ctx.actorUserId, kind: "text", body: "UNRELATED PRIVATE CONTEXT", payload: {}, createdAt: server.ctx.clock.nowIso() });
    const worker = createDiscussionDispatcher(server.ctx, stop); await worker.pump();
    const current = await getDiscussion(server.ctx, discussion.id);
    await finishTurn(current.active_turn_id!, "First answer");
    const packs = await server.db.db.select().from(contextPacks);
    expect(JSON.stringify(packs[0]!.payload)).not.toContain("UNRELATED PRIVATE CONTEXT");
    await worker.stop();
  });
  it("bounds time across restart and fences cancellation before any later round", async () => {
    const { discussion } = await begin();
    const worker = createDiscussionDispatcher(server.ctx, stop); await worker.pump();
    server.ctx.clock = fixedClock("2026-06-13T00:06:00.000Z");
    await worker.pump();
    expect(await getDiscussion(server.ctx, discussion.id)).toMatchObject({ status: "failed", error: "Discussion time limit reached" });
    expect((await server.db.db.select().from(assistantTurns))[0]?.status).toBe("cancelled");
    await worker.pump();
    expect(await server.db.db.select().from(assistantTurns)).toHaveLength(1);
    await worker.stop();
    const next = await begin();
    const cancelled = await cancelDiscussion(server.ctx, next.discussion.id, stop);
    expect(cancelled.status).toBe("stopping");
    const restarted = createDiscussionDispatcher(server.ctx, stop); await restarted.pump();
    expect((await getDiscussion(server.ctx, next.discussion.id)).status).toBe("cancelled");
    await restarted.stop();
  });
  it("rejects duplicate, foreign, mismatched and overlapping participants/sessions", async () => {
    const { goal } = await begin();
    await expect(startDiscussion(server.ctx, goal.id, { participants, rounds: 1, max_minutes: 5 })).rejects.toThrow("already has an active");
    await expect(startDiscussion(server.ctx, goal.id, { participants: [participants[0]!, participants[0]!], rounds: 1, max_minutes: 5 })).rejects.toThrow("distinct");
    await expect(getDiscussion({ ...server.ctx, organizationId: "foreign" }, "discussion_000001")).rejects.toThrow("not found");
    const other = await createGoal(server.ctx, { project_id: "proj_artoo", title: "Other" });
    await expect(startDiscussion(server.ctx, other.id, { participants: [participants[0]!, { agent_instance_id: "unknown", role: "review" }], rounds: 1, max_minutes: 5 })).rejects.toThrow("Every participant");
    await expect(startDiscussion(server.ctx, other.id, { participants, rounds: 1, max_minutes: 5, room_id: goal.room_id! })).rejects.toThrow("same project");
  });
  it("never accepts malformed or cyclic model output as executable work", async () => {
    expect(() => parseDiscussionPlan("Trust me, the plan is ready")).toThrow("not a valid task plan");
    expect(parseDiscussionPlan(`\`\`\`json\n${output}\n\`\`\``).task_specs).toHaveLength(2);
    const { discussion } = await begin();
    await server.db.db.insert(messages).values({ id: "cycle", organizationId: server.ctx.organizationId, roomId: discussion.room_id, threadRootId: discussion.thread_root_id,
      actorType: "agent", actorId: "agent_reviewer", kind: "text", body: JSON.stringify({ task_specs: [{ title: "cycle", acceptance_criteria: ["done"], dependencies: [{ ref: "0", type: "blocks" }] }] }), createdAt: server.ctx.clock.nowIso() });
    await server.db.db.update(discussions).set({ status: "ready", finalMessageId: "cycle" }).where(eq(discussions.id, discussion.id));
    await expect(proposeDiscussionPlan(server.ctx, discussion.id)).rejects.toThrow("depend on itself");
    expect(await server.db.db.select().from(plans)).toHaveLength(0);
  });
  it("keeps failed disconnected processes stopping until node stop is acknowledged", async () => {
    const { discussion } = await begin();
    let online = false;
    const stoppedRuns: string[] = [];
    const worker = createDiscussionDispatcher(server.ctx, async (_ctx, runId) => {
      if (!online) throw AppError.conflict("Node offline");
      stoppedRuns.push(runId);
    });
    await worker.pump();
    const assistant = createAssistantDispatcher(server.ctx); await assistant.pump();
    const turn = (await server.db.db.select().from(assistantTurns))[0]!;
    await failRunDaemonDisconnect(server.ctx, turn.runId!, "computer_local_mock");
    await assistant.pump(); await worker.pump();
    expect((await getDiscussion(server.ctx, discussion.id)).status).toBe("stopping");
    expect(stoppedRuns).toHaveLength(0);
    online = true; await worker.pump();
    expect(stoppedRuns).toEqual([turn.runId]);
    expect((await getDiscussion(server.ctx, discussion.id)).status).toBe("failed");
    await worker.stop(); await assistant.stop();
  });
  it("allows human messages but refuses unmanaged agent turns in planning threads, even after task closure", async () => {
    const { discussion } = await begin();
    const row = (await server.db.db.select().from(discussions))[0]!;
    await server.db.db.update(tasks).set({ status: "done" }).where(eq(tasks.id, row.taskId));
    await expect(enqueueAssistantTurn(server.ctx, discussion.room_id, { body: "Implement everything now", thread_root_id: discussion.thread_root_id, client_request_id: "planning_bypass_attempt" })).rejects.toThrow(/team discussion/i);
    expect(await server.db.db.select().from(assistantTurns)).toHaveLength(0);
  });
});
