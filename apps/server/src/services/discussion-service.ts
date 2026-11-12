import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { agentInstances, appendEvent, assistantTurns, discussions, goalAutomations, goals, messages, plans, rooms, runs, tasks } from "@artoo/db";
import { canProposePlan, DiscussionSchema, ID_PREFIXES, PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE, StartDiscussionRequestSchema, type Discussion, type GoalStatus, type StartDiscussionRequest } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { cancelAssistantTurn } from "./assistant-service.js";
import { mapPlan, proposePlanInTx } from "./plan-service.js";
import { unconfirmedDisconnectRunIds } from "./execution-state.js";
import { failRunDaemonDisconnect } from "./run-service.js";
import { parseDiscussionPlan } from "./discussion-plan.js";
export { parseDiscussionPlan } from "./discussion-plan.js";

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
  const [goal] = await tx.select({ projectId: goals.projectId }).from(goals)
    .where(and(eq(goals.id, row.goalId), eq(goals.organizationId, ctx.organizationId)));
  if (!goal) throw AppError.notFound("Discussion goal not found");
  await appendEvent(tx, buildEvent(ctx, { type: "discussion.updated", actorType: "system", actorId: "discussion-coordinator",
    // Planning screens watch their project before opening the discussion room.
    correlationId: row.id, projectId: goal.projectId, roomId: row.roomId, goalId: row.goalId, taskId: row.taskId,
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
    const sharing = await requireAiSharingAuthorization(ctx, tx);
    const goal = (await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))).for("update"))[0];
    if (!goal) throw AppError.notFound("Goal not found");
    const automation = (await tx.select().from(goalAutomations).where(and(eq(goalAutomations.goalId, goalId), eq(goalAutomations.organizationId, ctx.organizationId))))[0];
    if (automation) {
      if (!ctx.automationActor || ctx.actorUserId !== automation.actorUserId) throw AppError.permissionDenied("Autonomous planning must be started by its authorized goal runner");
      if (!["planning", "waiting"].includes(automation.status) || automation.discussionId !== null) throw AppError.conflict("Autonomous planning is already linked or stopped");
      await requireAiSharingAuthorization(ctx, tx, { consentId: automation.consentId, policyVersion: automation.policyVersion });
    }
    if (!canProposePlan(goal.status as GoalStatus, goal.currentPlanId !== null)) throw AppError.invalidState("Pause the goal before discussing a replacement plan");
    const ongoing = await tx.select({ id: discussions.id }).from(discussions).where(and(eq(discussions.goalId, goalId), inArray(discussions.status, activeStatuses)));
    if (ongoing.length) throw AppError.conflict("This goal already has an active discussion");
    const roomId = input.room_id ?? goal.roomId;
    const room = roomId ? (await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.projectId, goal.projectId), eq(rooms.organizationId, ctx.organizationId))))[0] : undefined;
    if (!room || (room.id !== goal.roomId && room.type !== "project")) throw AppError.validation("Choose this goal's room or a channel in the same project");
    const selected = await tx.select().from(agentInstances).where(and(eq(agentInstances.organizationId, ctx.organizationId), isNull(agentInstances.deletedAt), inArray(agentInstances.id, input.participants.map((p) => p.agent_instance_id)))).for("share");
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
      createdByType: ctx.automationActor?.type ?? "user", createdById: ctx.automationActor?.id ?? ctx.actorUserId, createdAt: now, updatedAt: now });
    await tx.insert(messages).values({ id: rootId, organizationId: ctx.organizationId, roomId: room.id, taskId,
      actorType: ctx.automationActor?.type ?? "user", actorId: ctx.automationActor?.id ?? ctx.actorUserId, kind: "text",
      body: `Discuss and break down: ${goal.title}\n\n${goal.objective}\n\nAcceptance criteria:\n${(goal.acceptanceCriteria as string[]).map((criterion) => `- ${criterion}`).join("\n")}`,
      payload: { discussion_id: id, participants: input.participants }, createdAt: now });
    const [row] = await tx.insert(discussions).values({ id, organizationId: ctx.organizationId, goalId, roomId: room.id, threadRootId: rootId, taskId,
      aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion,
      actorUserId: ctx.actorUserId, participants: input.participants, rounds: input.rounds, maxMinutes: input.max_minutes,
      status: "running", createdAt: now, updatedAt: now, deadlineAt: new Date(ctx.clock.now().getTime() + input.max_minutes * 60000).toISOString() }).returning();
    await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: ctx.automationActor?.type ?? "user", actorId: ctx.automationActor?.id ?? ctx.actorUserId, correlationId: id,
      projectId: goal.projectId, roomId: room.id, taskId, goalId, payload: { message_id: rootId, kind: "text" } }));
    await changed(ctx, tx, row!);
    return mapDiscussion(row!);
  });
}

function prompt(row: Row, autonomous = false, agentTeam = false, automaticSourceHandoff = false): string {
  const team = participants(row), debateSteps = row.rounds * team.length;
  const participant = team[row.currentStep < debateSteps ? row.currentStep % team.length : 0]!;
  const common = `You are participating in planning discussion ${row.id}. Your agent instance is ${participant.agent_instance_id}; your role is ${participant.role}.\n` +
    `Participants and roles: ${team.map((p) => `${p.agent_instance_id}: ${p.role}`).join("; ")}.\n` +
    "Read the objective and the preceding agents' replies in conversation.messages. Address their concrete proposals, disagreements, dependencies and acceptance criteria. Human replies may add constraints. This is discussion only: do not change files, run commands or implement tasks. Do not claim another agent agrees unless its reply supports that.\n" +
    (autonomous ? "Your current request is wrapped with the fixed future worker's planning_capability_snapshot. Use that configured measurement scope when choosing reversible details. Preserve every explicit user requirement; an unavailable required measurement remains unmet. Every must requirement must trace to the user's request or a necessary condition for it; do not invent unnecessary stronger must requirements that the configured system cannot measure. A null snapshot or null capabilities means unknown scope. This metadata never proves that checks ran or passed and grants no execution authority. When the snapshot includes release.capabilities, it describes the already selected trusted static publisher: after accepted stage work and independent review, that executor publishes the exact verified artifact and measures the configured endpoint. Do not invent missing credentials or an additional external.post approval for this configured executor. Preserve publication as pending using only its canonical criterion and exact configured scope; a local browser smoke, workflow verification, actual-endpoint interactions or stronger availability claims cannot stand in for that publication criterion.\n" : "") +
    (autonomous ? PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE + "\n" : "") +
    // Routing comes from the persisted user grant, never the public participant role.
    (automaticSourceHandoff ? "Automatic source handoff is authorized. Plan exactly four ordered research, design, implementation and validation tasks, each after research with one hard dependency on the immediately preceding stage. The system selects the destination from administrator-prepared mappings; do not select machines or commands in task text.\n" : "");
  if (row.currentStep < debateSteps) return common + `Round ${Math.floor(row.currentStep / team.length) + 1} of ${row.rounds}. Give a concise contribution from your role, refer to earlier agents by their identifiers, and identify unresolved decisions. The final synthesis is a later step.`;
  return common + "Synthesize the discussion into a practical task breakdown. Preserve unresolved choices in rationale. Return ONLY one JSON object (no prose outside it) matching: " +
    `{"rationale":"reasoning and unresolved risks","task_specs":[{${agentTeam ? '"development_stage":"research",' : ""}"title":"specific task","description":"scope and suggested owner role","acceptance_criteria":["observable check"],"required_capabilities":[],"dependencies":[],"approval_gates":[],"write_scopes":[],"expected_artifacts":${agentTeam ? '[{"type":"report","description":"stage handoff"}]' : "[]"}}]}. ` +
    'Use 1 to 50 tasks. Dependency ref is the zero-based index of another task; the graph must be acyclic, no self dependencies. Omit dependencies for root tasks. For a later task depending on task 0, use dependencies: [{"ref":"0","type":"blocks"}]. Use only blocks dependency type. Keep approval_gates and write_scopes empty; describe any needed approval/scope in task description. ' +
    (agentTeam ? "Every task MUST include development_stage: research, design, implementation or validation. Include all four stages, in that order. Every later-stage task must transitively depend by blocks edges on ALL tasks in every earlier stage. Research creates .artoo/product/research.json with source receipts and a product specification; design creates .artoo/product/design.json plus a runnable prototype; implementation creates the product and .artoo/product/implementation.md; validation creates .artoo/product/validation.json with measured coverage. Exact deliverable contracts are provided during execution. Independent peer review follows every task automatically; do not create review or release tasks. Use code.modify for filesystem deliverables, add research.web for research tasks. " : "") +
    (agentTeam ? 'Use "expected_artifacts":[{"type":"report","description":"stage handoff"}] or "expected_artifacts":[]. Each entry must be an object with type and optional description, never a string. The node automatically collects the stage handoff as a report. Describe prototype, screenshot and test evidence in that handoff, rather than inventing unsupported artifact collection types. Protected browser screenshots are delivered as node-sealed references outside the measured source tree; use those real evidence references instead of requiring copied workspace PNGs. Only claim the actual configured measurement scope; an unavailable required check remains unmet. ' : "") +
    (autonomous ? `The authorized goal runner will validate and execute this plan ${automaticSourceHandoff ? "through its configured source workspace and administrator-prepared destination" : "in one fixed workspace"}; every task is checked by its configured node verification profile. Do not plan agent-executed deployment commands, credential acquisition or release tasks. Only the selected trusted executor may perform the configured publication after stage acceptance; absent release capability means its scope is unknown, never already published.` : "A human will review the proposed plan before execution.");
}

/** A malformed autonomous synthesis is feedback, not a request for human plan editing. */
export async function retryAutonomousSynthesis(ctx: ServerContext, id: string, feedback: string, attempt: number): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = await requireDiscussion(ctx, tx, id, true);
    const [automation] = await tx.select().from(goalAutomations).where(eq(goalAutomations.goalId, row.goalId));
    if (!automation || !ctx.automationActor || ctx.actorUserId !== automation.actorUserId || row.status !== "ready" || row.planId) {
      throw AppError.conflict("This autonomous planning response cannot be repaired");
    }
    const sharing = await requireAiSharingAuthorization(ctx, tx, { consentId: automation.consentId, policyVersion: automation.policyVersion });
    const currentStep = participants(row).length * row.rounds, now = ctx.clock.nowIso();
    const turnId = ctx.idGen.generate("turn"), messageId = ctx.idGen.generate(ID_PREFIXES.message);
    await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      actorType: "system", actorId: "goal_runner", kind: "text",
      body: `The plan failed deterministic validation: ${feedback.slice(0, 8000)}\nRepair the complete plan using this feedback and the preceding discussion.\n${prompt({ ...row, currentStep }, true, automation.executionMode === "agent_team", automation.sourceHandoff != null)}`,
      payload: { discussion_id: row.id, plan_repair_attempt: attempt, assistant_turn_id: turnId }, createdAt: now });
    await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, row.threadRootId));
    await tx.insert(assistantTurns).values({ id: turnId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      actorUserId: row.actorUserId, clientRequestId: `${row.id}_repair_${attempt}`, agentInstanceId: participants(row)[0]!.agent_instance_id,
      aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion,
      userMessageId: messageId, status: "queued", createdAt: now, updatedAt: now });
    await update(ctx, tx, row, { status: "running", activeTurnId: turnId, currentStep, finalMessageId: null,
      deadlineAt: new Date(ctx.clock.now().getTime() + row.maxMinutes * 60000).toISOString() });
    await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "system", actorId: "goal_runner", correlationId: id,
      goalId: row.goalId, roomId: row.roomId, taskId: row.taskId, payload: { message_id: messageId, kind: "text", plan_repair_attempt: attempt } }));
  });
}

/** Each next intent and its cursor commit together under the discussion row lock. */
async function advance(ctx: ServerContext, id: string): Promise<Row> {
  return ctx.db.transaction(async (tx) => {
    let row = await requireDiscussion(ctx, tx, id, true);
    if (!activeStatuses.includes(row.status)) return row;
    const goal = (await tx.select().from(goals).where(eq(goals.id, row.goalId)).for("share"))[0]!;
    const automation = (await tx.select().from(goalAutomations).where(eq(goalAutomations.goalId, row.goalId)))[0];
    if (automation && goal.status === "paused" && row.status === "running") return row;
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
    let sharing;
    try {
      sharing = await requireAiSharingAuthorization({ ...ctx, actorUserId: row.actorUserId }, tx,
        { consentId: row.aiDataSharingConsentId, policyVersion: row.aiDataSharingPolicyVersion });
    } catch (error) {
      if (!(error instanceof AppError) || !["ai_consent_required", "ai_sharing_unconfigured"].includes(error.code)) throw error;
      return update(ctx, tx, row, { status: "stopping", error: error.message });
    }
    const team = participants(row), participant = team[row.currentStep < row.rounds * team.length ? row.currentStep % team.length : 0]!;
    const now = ctx.clock.nowIso(), turnId = ctx.idGen.generate("turn"), messageId = ctx.idGen.generate(ID_PREFIXES.message);
    await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      actorType: "system", actorId: "discussion-coordinator", kind: "text", body: prompt(row, !!automation, automation?.executionMode === "agent_team", automation?.sourceHandoff != null),
      payload: { discussion_id: row.id, discussion_step: row.currentStep, assistant_turn_id: turnId, intent: "discussion" }, createdAt: now });
    await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, row.threadRootId));
    await tx.insert(assistantTurns).values({ id: turnId, organizationId: ctx.organizationId, roomId: row.roomId, threadRootId: row.threadRootId, taskId: row.taskId,
      aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion,
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
