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
import { collectCatchUp, createEventPublisher, type EventFrame } from "../ws/event-publisher.js";
import { createWsHub } from "../ws/ws-hub.js";
import { getMessage, listMessagePage, postMessage } from "./message-service.js";

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
    // The native planning screen subscribes to its project, before the human
    // opens the discussion room. Its final progress must reach that subscriber.
    const frames: EventFrame[] = [];
    const hub = createWsHub();
    const client = { send(data: string) { frames.push(JSON.parse(data) as EventFrame); } };
    hub.subscribe(client, ["project:proj_artoo"]);
    const publisher = createEventPublisher(server.ctx, hub);
    await publisher.pumpOnce();
    frames.length = 0;
    await finishTurn(current.active_turn_id!, output);
    const [finalTurn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, current.active_turn_id!));
    // The message is fetched before the dispatcher marks the discussion ready.
    // A cursor-only client must receive its preview on this first delivery.
    expect((await getDiscussion(server.ctx, discussion.id)).current_step).toBe(2);
    const finalReply = await getMessage(server.ctx, discussion.room_id, finalTurn!.responseMessageId!);
    expect(finalReply.body).toBe(output);
    expect(finalReply.payload.discussion_plan).toMatchObject({ version: 1, discussion_id: discussion.id, goal_id: goal.id,
      rationale: "Separate implementation from verification", task_specs: [
        { title: "Implement API", description: "", dependencies: [], required_capabilities: [], approval_gates: [], write_scopes: [], expected_artifacts: [] },
        { title: "Verify API", dependencies: [{ ref: "0", type: "blocks" }] },
      ] });
    await restarted.pump(); await restarted.pump();
    expect(await getDiscussion(server.ctx, discussion.id)).toMatchObject({ status: "ready", current_step: 3, total_steps: 3 });
    await publisher.pumpOnce();
    const finalUpdates = frames.filter((frame) => frame.event.type === "discussion.updated" && frame.event.payload.status === "ready");
    expect(finalUpdates).toHaveLength(1);
    expect(finalUpdates[0]).toMatchObject({ topic: "project:proj_artoo", event: { project_id: "proj_artoo",
      payload: { discussion_id: discussion.id, status: "ready", current_step: 3 } } });
    const replay = await collectCatchUp(server.ctx, 0, ["project:proj_artoo"]);
    expect(replay.find((frame) => frame.event.id === finalUpdates[0]!.event.id)).toEqual(finalUpdates[0]);
    expect(frames.filter((frame) => frame.event.type === "message.created").every((frame) => !frame.event.payload.discussion_plan)).toBe(true);
    // Existing history receives the same projection through both bounded pages
    // and exact deep links, without rewriting its original body or DB payload.
    const { discussion_plan: ignoredPreview, ...legacyPayload } = finalReply.payload;
    await server.db.db.update(messages).set({ payload: legacyPayload }).where(eq(messages.id, finalReply.id));
    const historical = await listMessagePage(server.ctx, discussion.room_id, { thread_root_id: discussion.thread_root_id });
    expect(historical.messages.find((message) => message.id === finalReply.id)?.payload.discussion_plan).toEqual(finalReply.payload.discussion_plan);
    expect((await getMessage(server.ctx, discussion.room_id, finalReply.id)).payload.discussion_plan).toEqual(finalReply.payload.discussion_plan);
    await expect(getMessage({ ...server.ctx, organizationId: "foreign" }, discussion.room_id, finalReply.id)).rejects.toThrow("room not found");
    expect((await server.db.db.select().from(messages).where(eq(messages.id, finalReply.id)))[0]?.payload).toEqual(legacyPayload);
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
  it("never presents an earlier JSON-shaped reply or invalid final controls as a plan suggestion", async () => {
    const { discussion, goal } = await begin();
    const worker = createDiscussionDispatcher(server.ctx, stop);
    await worker.pump();
    let current = await getDiscussion(server.ctx, discussion.id);
    const earlier = await finishTurn(current.active_turn_id!, output);
    const [earlierTurn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, earlier.id));
    expect((await getMessage(server.ctx, discussion.room_id, earlierTurn!.responseMessageId!)).payload).not.toHaveProperty("discussion_plan");
    await worker.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    await finishTurn(current.active_turn_id!, "Review complete");
    await worker.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    const invalid = JSON.stringify({ task_specs: [{ title: "Unsafe task", acceptance_criteria: ["done"], approval_gates: ["unsupported"] }] });
    await finishTurn(current.active_turn_id!, invalid);
    await worker.pump();
    const page = await listMessagePage(server.ctx, discussion.room_id, { thread_root_id: discussion.thread_root_id });
    const answer = page.messages.find((message) => message.body === invalid)!;
    expect(answer.body).toBe(invalid);
    expect(answer.payload).not.toHaveProperty("discussion_plan");
    await expect(proposeDiscussionPlan(server.ctx, discussion.id)).rejects.toThrow("approval_gates");
    expect(await server.db.db.select().from(tasks).where(eq(tasks.goalId, goal.id))).toHaveLength(0);
    await worker.stop();
  });
  it("does not infer a preview from user-supplied planning identifiers or a user message linked as the final reply", async () => {
    const { discussion, goal } = await begin();
    const userReply = await postMessage(server.ctx, discussion.room_id, { kind: "text", body: output, thread_root_id: discussion.thread_root_id,
      payload: { discussion_id: discussion.id, assistant_turn_id: "fake" }, mentions: [], assignments: [] });
    await server.db.db.update(discussions).set({ status: "ready", currentStep: 3, finalMessageId: userReply.id }).where(eq(discussions.id, discussion.id));
    expect((await getMessage(server.ctx, discussion.room_id, userReply.id)).payload).not.toHaveProperty("discussion_plan");
    expect(await server.db.db.select().from(plans).where(eq(plans.goalId, goal.id))).toHaveLength(0);
  });
  it("enriches a historical agent final reply only when its run, thread and task still match the completed turn", async () => {
    const { discussion } = await begin();
    const worker = createDiscussionDispatcher(server.ctx, stop);
    await worker.pump();
    let current = await getDiscussion(server.ctx, discussion.id);
    const first = await finishTurn(current.active_turn_id!, "Implement the API first.");
    await worker.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    await finishTurn(current.active_turn_id!, "Verify the contract after implementation.");
    await worker.pump();
    current = await getDiscussion(server.ctx, discussion.id);
    await finishTurn(current.active_turn_id!, output);
    const [turn] = await server.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, current.active_turn_id!));
    expect(turn?.status).toBe("completed");
    await worker.pump(); await worker.stop();
    expect((await getDiscussion(server.ctx, discussion.id)).status).toBe("ready");
    const finalReply = await getMessage(server.ctx, discussion.room_id, turn!.responseMessageId!);
    expect(finalReply.actor_type).toBe("agent");
    expect(finalReply.payload.discussion_plan).toBeDefined();
    const { discussion_plan: ignoredPreview, ...legacyPayload } = finalReply.payload;
    await server.db.db.update(messages).set({ payload: legacyPayload }).where(eq(messages.id, finalReply.id));
    const [legacyRow] = await server.db.db.select().from(messages).where(eq(messages.id, finalReply.id));
    const otherRoot = await postMessage(server.ctx, discussion.room_id, { kind: "text", body: "Unrelated thread", payload: {}, mentions: [], assignments: [] });
    const [task] = await server.db.db.select().from(tasks).where(eq(tasks.id, turn!.taskId));
    const otherTaskId = "task_unrelated_history";
    await server.db.db.insert(tasks).values({ ...task!, id: otherTaskId });
    const messageBinding = { runId: legacyRow!.runId, threadRootId: legacyRow!.threadRootId, taskId: legacyRow!.taskId };
    const turnBinding = { runId: turn!.runId, threadRootId: turn!.threadRootId, taskId: turn!.taskId };
    const mismatches = [
      { name: "message run", change: () => server.db.db.update(messages).set({ runId: first.runId }).where(eq(messages.id, finalReply.id)) },
      { name: "message thread", threadRootId: otherRoot.id, change: () => server.db.db.update(messages).set({ threadRootId: otherRoot.id }).where(eq(messages.id, finalReply.id)) },
      { name: "message task", change: () => server.db.db.update(messages).set({ taskId: otherTaskId }).where(eq(messages.id, finalReply.id)) },
      { name: "turn run", change: () => server.db.db.update(assistantTurns).set({ runId: first.runId }).where(eq(assistantTurns.id, turn!.id)) },
      { name: "turn thread", change: () => server.db.db.update(assistantTurns).set({ threadRootId: otherRoot.id }).where(eq(assistantTurns.id, turn!.id)) },
      { name: "turn task", change: () => server.db.db.update(assistantTurns).set({ taskId: otherTaskId }).where(eq(assistantTurns.id, turn!.id)) },
    ];
    for (const mismatch of mismatches) {
      await mismatch.change();
      const [beforeRead] = await server.db.db.select().from(messages).where(eq(messages.id, finalReply.id));
      const page = await listMessagePage(server.ctx, discussion.room_id, { limit: 10, thread_root_id: mismatch.threadRootId ?? discussion.thread_root_id });
      const pageReply = page.messages.find((message) => message.id === finalReply.id);
      expect(pageReply, mismatch.name).toBeDefined();
      expect(pageReply!.body, mismatch.name).toBe(output);
      expect(pageReply!.payload, mismatch.name).not.toHaveProperty("discussion_plan");
      expect((await getMessage(server.ctx, discussion.room_id, finalReply.id)).payload, mismatch.name).not.toHaveProperty("discussion_plan");
      expect((await server.db.db.select().from(messages).where(eq(messages.id, finalReply.id)))[0], mismatch.name).toEqual(beforeRead);
      await server.db.db.update(messages).set(messageBinding).where(eq(messages.id, finalReply.id));
      await server.db.db.update(assistantTurns).set(turnBinding).where(eq(assistantTurns.id, turn!.id));
    }
    const restoredPage = await listMessagePage(server.ctx, discussion.room_id, { limit: 10, thread_root_id: discussion.thread_root_id });
    expect(restoredPage.messages.find((message) => message.id === finalReply.id)?.payload.discussion_plan).toEqual(finalReply.payload.discussion_plan);
    expect((await getMessage(server.ctx, discussion.room_id, finalReply.id)).payload.discussion_plan).toEqual(finalReply.payload.discussion_plan);
    expect((await server.db.db.select().from(messages).where(eq(messages.id, finalReply.id)))[0]).toEqual(legacyRow);
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
