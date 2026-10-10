import { requireAiSharingAuthorization } from "./ai-data-sharing-service.js";
import { appendEvent, approvals, assistantTurns, discussions, goals, messages, rooms, runs, tasks, users } from "@artoo/db";
import { AssistantTurnSchema, ID_PREFIXES, type AssistantTurn, type SendAssistantTurnRequest } from "@artoo/domain";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { buildEvent } from "../events.js";
import { mapMessage } from "../mappers.js";
import { assignTask, markReady, retryTask, reviewTask } from "./lifecycle-service.js";
import { cancelRun } from "./run-service.js";
import { EXECUTION_GATE_CURRENT } from "./approval-service.js";
import { resolveExecutionPolicyTask } from "./task-execution-policy.js";

type TurnRow = typeof assistantTurns.$inferSelect;
type Tx = ServerContext["db"]["db"];
const pendingStatuses = ["queued", "waiting", "running"];
export function mapAssistantTurn(row: TurnRow): AssistantTurn {
  return AssistantTurnSchema.parse({ id: row.id, room_id: row.roomId, task_id: row.taskId, run_id: row.runId,
    thread_root_id: row.threadRootId,
    user_message_id: row.userMessageId, response_message_id: row.responseMessageId,
    status: row.status, error: row.error, created_at: row.createdAt, updated_at: row.updatedAt });
}
async function requireTurn(ctx: ServerContext, id: string): Promise<TurnRow> {
  const row = (await ctx.db.db.select().from(assistantTurns).where(and(eq(assistantTurns.id, id), eq(assistantTurns.organizationId, ctx.organizationId))))[0];
  if (!row) throw AppError.notFound("Assistant turn not found");
  return row;
}
async function turnEvent(ctx: ServerContext, tx: Tx, turn: TurnRow): Promise<void> {
  const room = (await tx.select().from(rooms).where(eq(rooms.id, turn.roomId)))[0];
  await appendEvent(tx, buildEvent(ctx, { type: "assistant.turn.updated", actorType: "user", actorId: ctx.actorUserId,
    correlationId: turn.id, roomId: turn.roomId, taskId: turn.taskId, projectId: room?.projectId,
    payload: { turn_id: turn.id, status: turn.status, run_id: turn.runId } }));
}

export async function listAssistantTurns(ctx: ServerContext, roomId: string, threadRootId?: string): Promise<AssistantTurn[]> {
  const room = (await ctx.db.db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.organizationId, ctx.organizationId))))[0];
  if (!room) throw AppError.notFound("Room not found");
  await requireThreadRoot(ctx, ctx.db.db, roomId, threadRootId);
  const scope = threadRootId ? eq(assistantTurns.threadRootId, threadRootId) : isNull(assistantTurns.threadRootId);
  // Preserve every pending turn even when a room has a long completed history.
  const recent = await ctx.db.db.select().from(assistantTurns).where(and(eq(assistantTurns.roomId, roomId), eq(assistantTurns.organizationId, ctx.organizationId), scope)).orderBy(desc(assistantTurns.position)).limit(50);
  const pending = await ctx.db.db.select().from(assistantTurns).where(and(eq(assistantTurns.roomId, roomId), eq(assistantTurns.organizationId, ctx.organizationId), scope, inArray(assistantTurns.status, pendingStatuses))).orderBy(asc(assistantTurns.position));
  return [...new Map([...recent, ...pending].map((t) => [t.id, t])).values()].sort((a, b) => a.position - b.position).map(mapAssistantTurn);
}

async function requireThreadRoot(ctx: ServerContext, tx: Tx, roomId: string, rootId?: string) {
  if (!rootId) return undefined;
  const root = (await tx.select().from(messages).where(and(eq(messages.id, rootId), eq(messages.roomId, roomId), eq(messages.organizationId, ctx.organizationId))))[0];
  if (!root || root.threadRootId !== null) throw AppError.validation("Assistant thread root must be a top-level message in this room");
  return root;
}

/** Durable intent and user message commit together. Client identity survives a lost HTTP response. */
export async function enqueueAssistantTurn(ctx: ServerContext, roomId: string, request: SendAssistantTurnRequest) {
  return ctx.db.transaction(async (tx) => {
    const room = (await tx.select().from(rooms).where(and(eq(rooms.id, roomId), eq(rooms.organizationId, ctx.organizationId))).for("update"))[0];
    if (!room || !room.projectId) throw AppError.notFound("Project room not found");
    const root = await requireThreadRoot(ctx, tx, roomId, request.thread_root_id);
    if (root && (await tx.select({ id: discussions.id }).from(discussions).where(and(eq(discussions.threadRootId, root.id), eq(discussions.organizationId, ctx.organizationId))).limit(1)).length) {
      throw AppError.validation("Use team discussion to add input to this planning thread; the coordinator chooses the next agent.");
    }
    const duplicate = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.roomId, roomId), eq(assistantTurns.actorUserId, ctx.actorUserId), eq(assistantTurns.clientRequestId, request.client_request_id))))[0];
    if (duplicate) {
      const message = (await tx.select().from(messages).where(eq(messages.id, duplicate.userMessageId)))[0]!;
      if (message.body !== request.body || duplicate.agentInstanceId !== (request.agent_instance_id ?? null) || duplicate.threadRootId !== (request.thread_root_id ?? null)) throw AppError.conflict("This assistant request identity was already used for different content");
      return { turn: mapAssistantTurn(duplicate), message: mapMessage(message) };
    }
    const sharing = await requireAiSharingAuthorization(ctx, tx);
    const pending = await tx.select({ id: assistantTurns.id }).from(assistantTurns).where(and(eq(assistantTurns.roomId, roomId), inArray(assistantTurns.status, pendingStatuses))).limit(20);
    if (pending.length >= 20) throw AppError.rateLimited("This conversation already has 20 pending turns; wait or cancel a queued turn");
    const scope = request.thread_root_id ? eq(assistantTurns.threadRootId, request.thread_root_id) : isNull(assistantTurns.threadRootId);
    const previous = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.roomId, roomId), scope)).orderBy(desc(assistantTurns.position)).limit(1))[0];
    const existingTaskId = previous?.taskId ?? root?.taskId ?? room.taskId;
    const original = existingTaskId ? (await tx.select().from(tasks).where(and(eq(tasks.id, existingTaskId), eq(tasks.organizationId, ctx.organizationId))))[0] : undefined;
    let task = original;
    const now = ctx.clock.nowIso();
    if (!task || ["done", "cancelled"].includes(task.status)) {
      const policyTask = original ? await resolveExecutionPolicyTask(ctx, tx, original) : undefined;
      const goalId = room.goalId ?? original?.goalId ?? null;
      const goal = goalId ? (await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.organizationId, ctx.organizationId))))[0] : undefined;
      if (goal && ["completed", "cancelled", "archived"].includes(goal.status)) throw AppError.invalidState("This goal is closed. Create a follow-up goal to run more work; team discussion remains available.");
      const taskId = ctx.idGen.generate(ID_PREFIXES.task);
      [task] = await tx.insert(tasks).values({ id: taskId, organizationId: ctx.organizationId, projectId: room.projectId,
        roomId, goalId, parentTaskId: original?.id ?? null,
        executionPolicyTaskId: policyTask?.id ?? null,
        title: original ? `Follow-up: ${original.title}`.slice(0, 300) : `Conversation: ${room.name}`.slice(0, 300),
        description: original?.description ?? goal?.objective ?? room.name,
        status: "backlog", priority: original?.priority ?? "p2",
        acceptanceCriteria: original?.acceptanceCriteria ?? ["Answer the conversation request and explain any work performed."],
        requiredCapabilities: original?.requiredCapabilities ?? ["code.read"],
        preferredModelProfileId: original?.preferredModelProfileId ?? null, preferredEffort: original?.preferredEffort ?? null,
        createdByType: "user", createdById: ctx.actorUserId, createdAt: now, updatedAt: now,
      }).returning();
      await appendEvent(tx, buildEvent(ctx, { type: "task.created", actorType: "user", actorId: ctx.actorUserId,
        correlationId: taskId, projectId: room.projectId, taskId, roomId, payload: { task_id: taskId, source: "assistant_conversation" } }));
      const priorGate = policyTask ? (await tx.select().from(approvals).where(and(inArray(approvals.taskId, [...new Set([original!.id, policyTask.id])]),
        eq(approvals.organizationId, ctx.organizationId), eq(approvals.action, "execution.start"))).orderBy(desc(approvals.createdAt), desc(approvals.id)).limit(1))[0] : undefined;
      if (priorGate) {
        const approvalId = ctx.idGen.generate(ID_PREFIXES.approval);
        const summary = `Review follow-up execution: ${request.body}`.slice(0, 4000);
        await tx.insert(approvals).values({ id: approvalId, organizationId: ctx.organizationId, taskId,
          action: "execution.start", risk: priorGate.risk, summary, status: "pending", payloadRef: EXECUTION_GATE_CURRENT,
          requestedByType: "user", requestedById: ctx.actorUserId, createdAt: now });
        await appendEvent(tx, buildEvent(ctx, { type: "approval.requested", actorType: "user", actorId: ctx.actorUserId,
          correlationId: taskId, projectId: room.projectId, taskId, roomId,
          payload: { approval_id: approvalId, action: "execution.start", summary, inherited_from_task_id: priorGate.taskId } }));
      }
    }
    if (!task) throw new Error("Conversation task was not created");
    const id = ctx.idGen.generate("turn");
    const messageId = ctx.idGen.generate(ID_PREFIXES.message);
    const [message] = await tx.insert(messages).values({ id: messageId, organizationId: ctx.organizationId, roomId,
      threadRootId: request.thread_root_id ?? null,
      taskId: task.id, actorType: "user", actorId: ctx.actorUserId, kind: "text", body: request.body,
      payload: { assistant_turn_id: id, intent: "assistant" }, createdAt: now }).returning();
    const updatedRoot = root ? (await tx.update(messages).set({ replyCount: sql`${messages.replyCount} + 1` }).where(eq(messages.id, root.id)).returning({ replyCount: messages.replyCount }))[0] : undefined;
    const [turn] = await tx.insert(assistantTurns).values({ id, organizationId: ctx.organizationId, roomId, taskId: task.id,
      threadRootId: request.thread_root_id ?? null,
      actorUserId: ctx.actorUserId, clientRequestId: request.client_request_id, agentInstanceId: request.agent_instance_id ?? null,
      aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion,
      userMessageId: messageId, status: "queued", createdAt: now, updatedAt: now }).returning();
    await appendEvent(tx, buildEvent(ctx, { type: "message.created", actorType: "user", actorId: ctx.actorUserId,
      correlationId: id, projectId: room.projectId, taskId: task.id, roomId, payload: { message_id: messageId, kind: "text", ...(root ? { thread_root_id: root.id, root_reply_count: updatedRoot!.replyCount } : {}) } }));
    await turnEvent(ctx, tx, turn!);
    return { turn: mapAssistantTurn(turn!), message: mapMessage(message!) };
  });
}

async function changeTurn(ctx: ServerContext, id: string, status: string, error: string | null, expectedRunId: string | null = null): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const row = (await tx.select().from(assistantTurns).where(and(eq(assistantTurns.id, id), eq(assistantTurns.organizationId, ctx.organizationId))).for("update"))[0];
    if (!row || !pendingStatuses.includes(row.status)) return;
    if (row.runId !== expectedRunId) return;
    if (status === "completed" && !row.responseMessageId) {
      status = "failed"; error = "The runtime finished without a structured answer. Inspect its run output.";
    }
    if (row.status === status && row.error === error) return;
    const [updated] = await tx.update(assistantTurns).set({ status, error, updatedAt: ctx.clock.nowIso() }).where(eq(assistantTurns.id, id)).returning();
    await turnEvent(ctx, tx, updated!);
  });
}

/** One serial pump per server. Every assignment still uses the normal policy/approval/scheduler gates. */
export function createAssistantDispatcher(ctx: ServerContext, onError: (error: unknown) => void = () => {}): { pump(): Promise<void>; start(): void; stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const pump = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return inFlight ??= drain().catch(onError).finally(() => { inFlight = undefined; });
  };
  async function drain(): Promise<void> {
    const pending = await ctx.db.db.select().from(assistantTurns).where(and(eq(assistantTurns.organizationId, ctx.organizationId), inArray(assistantTurns.status, pendingStatuses))).orderBy(asc(assistantTurns.position)).limit(100);
    const seenConversations = new Set<string>();
    for (const snapshot of pending) {
      const item = await requireTurn(ctx, snapshot.id);
      const scope = `${item.roomId}:${item.threadRootId ?? ""}`;
      if (stopped || !pendingStatuses.includes(item.status) || seenConversations.has(scope)) continue;
      seenConversations.add(scope);
      const actorCtx = { ...ctx, actorUserId: item.actorUserId };
      try {
        if (item.runId) {
          const run = (await ctx.db.db.select().from(runs).where(eq(runs.id, item.runId)))[0];
          if (!run || ["completed", "failed", "cancelled"].includes(run.status)) {
            const state = !run ? "failed" : run.status;
            await changeTurn(actorCtx, item.id, state,
              state === "failed" ? run?.failureReason ?? "Execution record is unavailable" : null, item.runId);
          }
          continue;
        }
        const actor = (await ctx.db.db.select().from(users).where(and(eq(users.id, item.actorUserId), eq(users.organizationId, ctx.organizationId))))[0];
        if (!actor || (ctx.authConfig.allowedEmails && !ctx.authConfig.allowedEmails.includes(actor.email.toLowerCase())) ||
          (ctx.authConfig.hostedDomain && !actor.email.toLowerCase().endsWith(`@${ctx.authConfig.hostedDomain}`))) {
          await changeTurn(actorCtx, item.id, "cancelled", "The requesting user is no longer admitted to this team"); continue;
        }
        const task = (await ctx.db.db.select().from(tasks).where(eq(tasks.id, item.taskId)))[0];
        if (!task) { await changeTurn(actorCtx, item.id, "failed", "Conversation task is unavailable"); continue; }
        if (["assigned", "running", "awaiting_approval"].includes(task.status)) { await changeTurn(actorCtx, item.id, "waiting", "Waiting for the current execution or approval to finish"); continue; }
        if (["done", "cancelled"].includes(task.status)) { await changeTurn(actorCtx, item.id, "cancelled", "The task was closed before this queued turn started; send a new follow-up if needed"); continue; }
        if (task.status === "backlog") await markReady(actorCtx, task.id);
        if (task.status === "blocked") await retryTask(actorCtx, task.id);
        if (task.status === "review") {
          const prompt = (await ctx.db.db.select({ body: messages.body }).from(messages).where(eq(messages.id, item.userMessageId)))[0];
          await reviewTask(actorCtx, task.id, { outcome: "changes_requested", comment: prompt?.body ?? "Assistant follow-up" });
        }
        await assignTask(actorCtx, task.id, { mode: item.agentInstanceId ? "manual" : "auto", agent_instance_id: item.agentInstanceId }, item.id);
      } catch (error) {
        // Assignment may have committed before node transport failed. Never clear its run link or dispatch twice.
        const current = await requireTurn(actorCtx, item.id);
        if (current.runId) continue;
        await changeTurn(actorCtx, item.id, error instanceof AppError && error.httpStatus < 500 ? "waiting" : "failed", error instanceof Error ? error.message : "Assistant dispatch failed");
      }
    }
  }
  return { pump, start() { stopped = false; timer ??= setInterval(() => { void pump(); }, 1500); timer.unref(); void pump(); },
    async stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; await inFlight; } };
}

export async function cancelAssistantTurn(ctx: ServerContext, id: string, stopProcess: (runId: string) => Promise<void>): Promise<AssistantTurn> {
  const turn = await requireTurn(ctx, id);
  if (turn.status === "cancelled") return mapAssistantTurn(turn);
  if (!pendingStatuses.includes(turn.status)) throw AppError.invalidState("This assistant turn has already finished");
  if (turn.runId) await cancelRun(ctx, turn.runId, () => stopProcess(turn.runId!));
  // Serialize with assignment: assignment locks task then turn and checks pending status.
  await ctx.db.transaction(async (tx) => {
    await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, turn.taskId)).for("update");
    const current = (await tx.select().from(assistantTurns).where(eq(assistantTurns.id, id)).for("update"))[0]!;
    if (current.runId && !turn.runId) throw AppError.conflict("This turn just started; retry cancellation to stop its execution");
    if (!pendingStatuses.includes(current.status)) return;
    const [updated] = await tx.update(assistantTurns).set({ status: "cancelled", error: null, updatedAt: ctx.clock.nowIso() }).where(eq(assistantTurns.id, id)).returning();
    await turnEvent(ctx, tx, updated!);
  });
  return mapAssistantTurn(await requireTurn(ctx, id));
}

export async function retryAssistantTurn(ctx: ServerContext, id: string): Promise<AssistantTurn> {
  const original = await requireTurn(ctx, id);
  await ctx.db.transaction(async (tx) => {
    const sharing = await requireAiSharingAuthorization(ctx, tx);
    await tx.select().from(tasks).where(eq(tasks.id, original.taskId)).for("update");
    const row = (await tx.select().from(assistantTurns).where(eq(assistantTurns.id, id)).for("update"))[0]!;
    if (!["waiting", "failed"].includes(row.status)) throw AppError.invalidState("Only a waiting or failed assistant turn can be retried");
    if (row.runId) {
      const run = (await tx.select().from(runs).where(eq(runs.id, row.runId)))[0];
      if (run && !["failed", "cancelled", "completed"].includes(run.status)) throw AppError.conflict("The previous execution has not stopped");
    }
    const later = (await tx.select({ id: assistantTurns.id }).from(assistantTurns).where(and(eq(assistantTurns.roomId, row.roomId),
      row.threadRootId ? eq(assistantTurns.threadRootId, row.threadRootId) : isNull(assistantTurns.threadRootId),
      lt(assistantTurns.position, row.position), inArray(assistantTurns.status, pendingStatuses))).limit(1))[0];
    if (later) throw AppError.conflict("An earlier turn is still pending");
    const [updated] = await tx.update(assistantTurns).set({ aiDataSharingConsentId: sharing.consentId, aiDataSharingPolicyVersion: sharing.policyVersion, status: "queued", runId: null, responseMessageId: null, error: null, updatedAt: ctx.clock.nowIso() }).where(eq(assistantTurns.id, id)).returning();
    await turnEvent(ctx, tx, updated!);
  });
  return mapAssistantTurn(await requireTurn(ctx, id));
}
