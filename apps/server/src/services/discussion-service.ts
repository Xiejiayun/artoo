import { agentInstances, appendEvent, assistantTurns, discussions, goals, messages, plans, rooms, runs, tasks } from "@artoo/db";
import { canProposePlan, DiscussionSchema, ID_PREFIXES, StartDiscussionRequestSchema, TaskSpecSchema, type Discussion, type GoalStatus, type StartDiscussionRequest } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { cancelAssistantTurn } from "./assistant-service.js";
import { mapPlan, proposePlanInTx } from "./plan-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";
import { failRunDaemonDisconnect } from "./run-service.js";

type Row = typeof discussions.$inferSelect;
type StopProcess = (ctx: ServerContext, runId: string) => Promise<void>;
const activeStatuses = ["running", "stopping"];
function participants(row: Row) { return StartDiscussionRequestSchema.shape.participants.parse(row.participants); }
export function mapDiscussion(row: Row): Discussion {
  return DiscussionSchema.parse({ id: row.id, goal_id: row.goalId, room_id: row.roomId, thread_root_id: row.threadRootId,
    participants: row.participants, rounds: row.rounds, max_minutes: row.maxMinutes, status: row.status,
    current_step: row.currentStep, total_steps: participants(row).length * row.rounds + 1,
    active_turn_id: row.activeTurnId, plan_id: row.planId, error: row.error,
    created_at: new Date(row.createdAt).toISOString(), updated_at: new Date(row.updatedAt).toISOString(), deadline_at: new Date(row.deadlineAt).toISOString() });
}
async function requireDiscussion(ctx: ServerContext, tx: DrizzleDb, id: string, lock = false) {
  const query = tx.select().from(discussions).where(and(eq(discussions.id, id), eq(discussions.organizationId, ctx.organizationId)));
  const row = (await (lock ? query.for("update") : query))[0];
  if (!row) throw AppError.notFound("Discussion not found");
  return row;
}
async function changed(ctx: ServerContext, tx: DrizzleDb, row: Row) {
  await appendEvent(tx, buildEvent(ctx, { type: "discussion.updated", actorType: "system", actorId: "discussion-coordinator",
    correlationId: row.id, roomId: row.roomId, goalId: row.goalId, taskId: row.taskId,
    payload: { discussion_id: row.id, status: row.status, current_step: row.currentStep, active_turn_id: row.activeTurnId } }));
}
async function update(ctx: ServerContext, tx: DrizzleDb, row: Row, patch: Partial<typeof discussions.$inferInsert>): Promise<Row> {
  const [next] = await tx.update(discussions).set({ ...patch, updatedAt: ctx.clock.nowIso() }).where(eq(discussions.id, row.id)).returning();
  await changed(ctx, tx, next!);
  return next!;
}
export async function getDiscussion(ctx: ServerContext, id: string) { return mapDiscussion(await requireDiscussion(ctx, ctx.db.db, id)); }
export async function listDiscussions(ctx: ServerContext, goalId: string) {
  const goal = (await ctx.db.db.select({ id: goals.id }).from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))))[0];
  if (!goal) throw AppError.notFound("Goal not found");
  const rows = await ctx.db.db.select().from(discussions).where(and(eq(discussions.goalId, goalId), eq(discussions.organizationId, ctx.organizationId))).orderBy(desc(discussions.createdAt), desc(discussions.id)).limit(30);
  return rows.map(mapDiscussion);
}
export async function startDiscussion(ctx: ServerContext, goalId: string, request: StartDiscussionRequest) {
  const input = StartDiscussionRequestSchema.parse(request);
  return ctx.db.transaction(async (tx) => {
    const goal = (await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
    if (!goal) throw AppError.notFound("Goal not found");
    if (!canProposePlan(goal.status as GoalStatus, goal.currentPlanId !== null)) throw AppError.invalidState("Pause the goal before discussing a replacement plan");
    const ongoing = await tx.select({ id: discussions.id }).from(discussions).where(and(eq(discussions.goalId, goalId), inArray(discussions.status, activeStatuses)));
    if (ongoing.length) throw AppError.conflict("This goal already has an active discussion");
    const roomId = input.room_id ?? goal.roomId;
    const room = roomId ? (await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.projectId, goal.projectId), eq(rooms.organizationId, ctx.organizationId))))[0] : undefined;
    if (!room || (room.id !== goal.roomId && room.type !== "project")) throw AppError.validation("Choose this goal's room or a channel in the same project");
    const selected = await tx.select().from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId), inArray(agentInstances.id, input.participants.map((p) => p.agent_instance_id))));
    if (selected.length !== input.participants.length) throw AppError.validation("Every participant must be an agent instance in this team");
    const allowed = (goal.budgets as { allowed_runtimes?: string[] | null }).allowed_runtimes;
    if (allowed && selected.some((instance) => !allowed.includes(instance.runtime))) throw AppError.validation("A selected agent runtime is outside this goal's allowed runtimes");
    const now = ctx.clock.nowIso(), id = ctx.idGen.generate("discussion"), taskId = ctx.idGen.generate(ID_PREFIXES.task), rootId = ctx.idGen.generate(ID_PREFIXES.message);
    // Planning is a separate, read-only run. It must not count as accepted execution
    // work or force a draft goal into running merely to produce its first plan.
    await tx.insert(tasks).values({ id: taskId, organizationId: ctx.organizationId, projectId: goal.projectId, roomId: room.id,
      title: `Planning discussion: ${goal.title}`.slice(0, 300), description: goal.objective,
      status: "backlog", priority: goal.priority, requiredCapabilities: [],
      acceptanceCriteria: ["Discuss the objective and produce a reviewable plan; do not implement it."],
      createdByType: "user", createdById: ctx.actorUserId, createdAt: now, updatedAt: now });
    await tx.insert(messages).values({ id: rootId, organizationId: ctx.organizationId, roomId: room.id, taskId,
      actorType: "user", actorId: ctx.actorUserId, kind: "text",
      body: `Discuss and break down: ${goal.title}\n\n${goal.objective}\n\nAcceptance criteria:\n${(goal.acceptanceCriteria as string[]).map((criterion) => `- ${criterion}`).join("\n")}`,
      payload: { discussion_id: id, participants: input.participants }, createdAt: now });
    const [row] = await tx.insert(discussions).values({ id, organizationId: ctx.organizationId, goalId, roomId: room.id, threadRootId: rootId, taskId,
      actorUserId: ctx.actorUserId, participants: input.participants, rounds: input.rounds, maxMinutes: input.max_minutes,
      status: "running", createdAt: now, updatedAt: now, deadlineAt: new Date(ctx.clock.now().getTime() + input.max_minutes * 60000).toISOString() }).returning();
    await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "user", actorId: ctx.actorUserId, correlationId: id,
      projectId: goal.projectId, roomId: room.id, taskId, goalId, payload: { message_id: rootId, kind: "text" } }));
    await changed(ctx, tx, row!);
    return mapDiscussion(row!);
  });
}

function prompt(row: Row): string {
  const team = participants(row), debateSteps = row.rounds * team.length;
  const participant = team[row.currentStep < debateSteps ? row.currentStep % team.length : 0]!;
  const common = `You are participating in planning discussion ${row.id}. Your agent instance is ${participant.agent_instance_id}; your role is ${participant.role}.\n` +
    `Participants and roles: ${team.map((p) => `${p.agent_instance_id}: ${p.role}`).join("; ")}.\n` +
    "Read the objective and the preceding agents' replies in conversation.messages. Address their concrete proposals, disagreements, dependencies and acceptance criteria. Human replies may add constraints. This is discussion only: do not change files, run commands or implement tasks. Do not claim another agent agrees unless its reply supports that.\n";
  if (row.currentStep < debateSteps) return common + `Round ${Math.floor(row.currentStep / team.length) + 1} of ${row.rounds}. Give a concise contribution from your role, refer to earlier agents by their identifiers, and identify unresolved decisions. The final synthesis is a later step.`;
  return common + "Synthesize the discussion into a practical task breakdown. Preserve unresolved choices in rationale. Return ONLY one JSON object (no prose outside it) matching: " +
    '{"rationale":"reasoning and unresolved risks","task_specs":[{"title":"specific task","description":"scope and suggested owner role","acceptance_criteria":["observable check"],"required_capabilities":[],"dependencies":[{"ref":"0","type":"blocks"}],"approval_gates":[],"write_scopes":[],"expected_artifacts":[]}]}. ' +
    "Use 1 to 50 tasks. Dependency ref is the zero-based index of another task; the graph must be acyclic, no self dependencies. Omit dependencies for root tasks. Use only blocks dependency type. Keep approval_gates and write_scopes empty; describe any needed approval/scope in task description. A human will review the proposed plan before execution.";
}

/** Each next intent and its cursor commit together under the discussion row lock. */
async function advance(ctx: ServerContext, id: string): Promise<Row> {
  return ctx.db.transaction(async (tx) => {
    let row = await requireDiscussion(ctx, tx, id, true);
    if (!activeStatuses.includes(row.status)) return row;
    const goal = (await tx.select().from(goals).where(eq(goals.id, row.goalId)))[0]!;
    if (row.status === "running" && (ctx.clock.now().getTime() >= Date.parse(row.deadlineAt) || ["completed", "cancelled", "archived", "running", "awaiting_approval"].includes(goal.status))) {
      row = await update(ctx, tx, row, { status: "stopping", error: ctx.clock.now().getTime() >= Date.parse(row.deadlineAt) ? "Discussion time limit reached" : "Goal state changed; this planning discussion has stopped" });
    }
    if (row.status === "stopping") {
      if (!row.activeTurnId) return update(ctx, tx, row, { status: row.error ? "failed" : "cancelled" });
      return row;
    }
    if (row.activeTurnId) {
      const turn = (await tx.select().from(assistantTurns).where(eq(assistantTurns.id, row.activeTurnId)))[0];
      if (turn && ["queued", "waiting", "running"].includes(turn.status)) return row;
      if (!turn || turn.status !== "completed" || !turn.responseMessageId) return update(ctx, tx, row, { status: "stopping", error: turn?.error ?? "An agent did not finish with a usable answer" });
      const currentStep = row.currentStep + 1;
      const done = currentStep === participants(row).length * row.rounds + 1;
      row = await update(ctx, tx, row, { activeTurnId: null, currentStep,
        ...(done ? { status: "ready", finalMessageId: turn.responseMessageId } : {}) });
      if (done) return row;
    }
    const team = participants(row), participant = team[row.currentStep < row.rounds * team.length ? row.currentStep % team.length : 0]!;
    const now = ctx.clock.nowIso(), turnId = ctx.idGen.generate("turn"), messageId = ctx.idGen.generate(ID_PREFIXES.message);
    await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      actorType: "system", actorId: "discussion-coordinator", kind: "text", body: prompt(row),
      payload: { discussion_id: row.id, discussion_step: row.currentStep, assistant_turn_id: turnId, intent: "discussion" }, createdAt: now });
    await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, row.threadRootId));
    await tx.insert(assistantTurns).values({ id: turnId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      actorUserId: row.actorUserId, clientRequestId: `${row.id}_step_${row.currentStep}`, agentInstanceId: participant.agent_instance_id,
      userMessageId: messageId, status: "queued", createdAt: now, updatedAt: now });
    await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "system", actorId: "discussion-coordinator", correlationId: row.id,
      roomId: row.roomId, goalId: row.goalId, taskId: row.taskId, payload: { message_id: messageId, thread_root_id: row.threadRootId, kind: "text" } }));
    return update(ctx, tx, row, { activeTurnId: turnId });
  });
}

async function finishStopping(ctx: ServerContext, row: Row, stop: StopProcess): Promise<void> {
  if (row.status !== "stopping" || !row.activeTurnId) return;
  // A failed DB run after disconnect can still own a live OS process. Require
  // explicit node stop acknowledgement and retain stopping across server restart.
  for (const runId of await unconfirmedDisconnectRunIds(ctx, ctx.db.db, { taskId: row.taskId })) {
    const run = (await ctx.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
    await stop(ctx, runId);
    await failRunDaemonDisconnect(ctx, runId, run.computerId, true);
  }
  const turn = (await ctx.db.db.select().from(assistantTurns).where(eq(assistantTurns.id, row.activeTurnId)))[0];
  const execution = turn?.runId ? (await ctx.db.db.select({ status: runs.status }).from(runs).where(eq(runs.id, turn.runId)))[0] : undefined;
  if (turn && ["queued", "waiting", "running"].includes(turn.status) && (!execution || !["completed", "failed", "cancelled"].includes(execution.status))) {
    await cancelAssistantTurn({ ...ctx, actorUserId: row.actorUserId }, turn.id, (runId) => stop(ctx, runId));
  }
  await ctx.db.transaction(async (tx) => {
    const current = await requireDiscussion(ctx, tx, row.id, true);
    if (current.status === "stopping") await update(ctx, tx, current, { status: current.error ? "failed" : "cancelled" });
  });
}
export async function cancelDiscussion(ctx: ServerContext, id: string, stop: StopProcess) {
  const row = await ctx.db.transaction(async (tx) => {
    const current = await requireDiscussion(ctx, tx, id, true);
    return current.status === "running" ? update(ctx, tx, current, { status: "stopping", error: null }) : current;
  });
  // Persist the fence first. An offline daemon leaves the discussion visibly
  // stopping, and the worker retries until the actual process exit is confirmed.
  try { await finishStopping(ctx, row, stop); } catch (error) { if (!(error instanceof AppError && error.httpStatus < 500)) throw error; }
  return getDiscussion(ctx, id);
}
export function createDiscussionDispatcher(ctx: ServerContext, stop: StopProcess, onError: (error: unknown) => void = () => {}) {
  let timer: ReturnType<typeof setInterval> | undefined, inFlight: Promise<void> | undefined, stopped = false;
  async function drain() {
    const rows = await ctx.db.db.select({ id: discussions.id }).from(discussions).where(and(eq(discussions.organizationId, ctx.organizationId), inArray(discussions.status, activeStatuses)));
    for (const item of rows) {
      if (stopped) break;
      try { await finishStopping(ctx, await advance(ctx, item.id), stop); } catch (error) { onError(error); }
    }
  }
  const pump = () => stopped ? Promise.resolve() : inFlight ??= drain().finally(() => { inFlight = undefined; });
  return { pump, start() { stopped = false; timer ??= setInterval(() => { void pump().catch(onError); }, 1500); timer.unref(); void pump().catch(onError); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await inFlight; } };
}

const PlanOutputSchema = z.object({ rationale: z.string().max(20000).default(""), task_specs: z.array(TaskSpecSchema).min(1).max(50) });
export function parseDiscussionPlan(body: string) {
  const text = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { return PlanOutputSchema.parse(JSON.parse(text)); }
  catch { throw AppError.validation("The final agent reply is not a valid task plan. Review the discussion and create or edit a plan manually."); }
}
export async function proposeDiscussionPlan(ctx: ServerContext, id: string) {
  return ctx.db.transaction(async (tx) => {
    const row = await requireDiscussion(ctx, tx, id, true);
    if (row.planId) {
      const existing = (await tx.select().from(plans).where(eq(plans.id, row.planId)))[0]!;
      return { discussion: mapDiscussion(row), plan: mapPlan(existing) };
    }
    if (row.status !== "ready" || !row.finalMessageId) throw AppError.invalidState("Wait for the discussion's final synthesis before proposing a plan");
    const answer = (await tx.select().from(messages).where(eq(messages.id, row.finalMessageId)))[0]!;
    const proposal = parseDiscussionPlan(answer.body);
    const plan = await proposePlanInTx(ctx, tx, row.goalId, { ...proposal, author_type: "agent", author_id: answer.actorId });
    const updated = await update(ctx, tx, row, { planId: plan.id });
    return { discussion: mapDiscussion(updated), plan };
  });
}
