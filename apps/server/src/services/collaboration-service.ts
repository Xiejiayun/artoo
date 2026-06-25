import { blockers, decisionRecords, handoffs, appendEvent } from "@artoo/db";
import {
  type Assignment,
  type BlockerRecord,
  type BlockerStatus,
  type DecisionRecord,
  type DecisionStatus,
  type HandoffRecord,
  type HandoffStatus,
  type Mention,
  type WaitEdge,
  ID_PREFIXES,
  waitEdgesFromHandoffs,
} from "@artoo/domain";
import { and, desc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { buildEvent } from "../events.js";

/**
 * V3 #114 — team discussion records service. Decision/handoff/blocker CRUD with
 * metadata-only, org-scoped event-log transitions, so a user can see what the
 * agent team decided, who is waiting on whom, and the linked evidence WITHOUT
 * scraping the raw room thread. Every query is org-scoped; event payloads carry
 * only ids/metadata — never a secret.
 */

// ----------------------------------------------------------------- row -> api mappers

export function mapDecision(r: typeof decisionRecords.$inferSelect): DecisionRecord {
  return {
    id: r.id,
    organization_id: r.organizationId,
    room_id: r.roomId,
    task_id: r.taskId,
    run_id: r.runId,
    goal_id: r.goalId,
    plan_id: r.planId,
    source_message_id: r.sourceMessageId,
    status: r.status as DecisionStatus,
    actor_type: r.actorType as DecisionRecord["actor_type"],
    actor_id: r.actorId,
    summary: r.summary,
    rationale: r.rationale,
    alternatives: (r.alternatives as string[] | null) ?? [],
    evidence_refs: (r.evidenceRefs as string[] | null) ?? [],
    impact_summary: r.impactSummary,
    superseded_by_id: r.supersededById,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export function mapHandoff(r: typeof handoffs.$inferSelect): HandoffRecord {
  return {
    id: r.id,
    organization_id: r.organizationId,
    room_id: r.roomId,
    task_id: r.taskId,
    run_id: r.runId,
    goal_id: r.goalId,
    plan_id: r.planId,
    sender_type: r.senderType as HandoffRecord["sender_type"],
    sender_id: r.senderId,
    recipient_type: r.recipientType as HandoffRecord["recipient_type"],
    recipient_id: r.recipientId,
    expected_action: r.expectedAction,
    blocking_condition: r.blockingCondition,
    priority: r.priority as HandoffRecord["priority"],
    due_at: r.dueAt,
    status: r.status as HandoffStatus,
    next_action: r.nextAction,
    latest_status: r.latestStatus,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export function mapBlocker(r: typeof blockers.$inferSelect): BlockerRecord {
  return {
    id: r.id,
    organization_id: r.organizationId,
    room_id: r.roomId,
    task_id: r.taskId,
    run_id: r.runId,
    goal_id: r.goalId,
    plan_id: r.planId,
    type: r.type as BlockerRecord["type"],
    owner_type: r.ownerType as BlockerRecord["owner_type"],
    owner_id: r.ownerId,
    source_kind: r.sourceKind as BlockerRecord["source_kind"],
    source_id: r.sourceId,
    summary: r.summary,
    mitigation: r.mitigation,
    next_action: r.nextAction,
    status: r.status as BlockerStatus,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

async function emit(
  ctx: ServerContext,
  type: string,
  correlationId: string,
  roomId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    await appendEvent(tx, buildEvent(ctx, { type, actorType: "system", actorId: "system", correlationId, roomId, payload }));
  });
}

interface RecordLinks {
  room_id: string;
  task_id?: string | null;
  run_id?: string | null;
  goal_id?: string | null;
  plan_id?: string | null;
}

// ------------------------------------------------------------------------- decisions

export interface CreateDecisionInput extends RecordLinks {
  source_message_id?: string | null;
  actor_type: DecisionRecord["actor_type"];
  actor_id: string;
  summary: string;
  rationale?: string | null;
  alternatives?: string[];
  evidence_refs?: string[];
  impact_summary?: string | null;
}

/** Create a decision, or — when promoting a message — return the existing record
 *  for that source message (idempotent: a message can't make duplicate records). */
export async function createDecision(ctx: ServerContext, input: CreateDecisionInput): Promise<DecisionRecord> {
  if (input.source_message_id != null && input.source_message_id !== "") {
    const existing = (
      await ctx.db.db
        .select()
        .from(decisionRecords)
        .where(
          and(
            eq(decisionRecords.organizationId, ctx.organizationId),
            eq(decisionRecords.sourceMessageId, input.source_message_id),
          ),
        )
    )[0];
    if (existing !== undefined) return mapDecision(existing);
  }
  const now = ctx.clock.nowIso();
  const id = ctx.idGen.generate(ID_PREFIXES.decision);
  await ctx.db.db.insert(decisionRecords).values({
    id,
    organizationId: ctx.organizationId,
    roomId: input.room_id,
    taskId: input.task_id ?? null,
    runId: input.run_id ?? null,
    goalId: input.goal_id ?? null,
    planId: input.plan_id ?? null,
    sourceMessageId: input.source_message_id ?? null,
    status: "proposed",
    actorType: input.actor_type,
    actorId: input.actor_id,
    summary: input.summary,
    rationale: input.rationale ?? null,
    alternatives: input.alternatives ?? [],
    evidenceRefs: input.evidence_refs ?? [],
    impactSummary: input.impact_summary ?? null,
    supersededById: null,
    createdAt: now,
    updatedAt: now,
  });
  await emit(ctx, "decision.proposed", id, input.room_id, {
    decision_id: id,
    status: "proposed",
    actor_type: input.actor_type,
    actor_id: input.actor_id,
  });
  return getDecision(ctx, id) as Promise<DecisionRecord>;
}

export async function setDecisionStatus(
  ctx: ServerContext,
  id: string,
  status: DecisionStatus,
  opts: { superseded_by_id?: string | null } = {},
): Promise<DecisionRecord | null> {
  const existing = await getDecision(ctx, id);
  if (existing === null) return null;
  const now = ctx.clock.nowIso();
  await ctx.db.db
    .update(decisionRecords)
    .set({ status, supersededById: opts.superseded_by_id ?? existing.superseded_by_id, updatedAt: now })
    .where(and(eq(decisionRecords.id, id), eq(decisionRecords.organizationId, ctx.organizationId)));
  await emit(ctx, `decision.${status}`, id, existing.room_id, { decision_id: id, from: existing.status, to: status });
  return getDecision(ctx, id);
}

export async function getDecision(ctx: ServerContext, id: string): Promise<DecisionRecord | null> {
  const r = (
    await ctx.db.db
      .select()
      .from(decisionRecords)
      .where(and(eq(decisionRecords.id, id), eq(decisionRecords.organizationId, ctx.organizationId)))
  )[0];
  return r === undefined ? null : mapDecision(r);
}

export async function listDecisions(ctx: ServerContext, roomId: string): Promise<DecisionRecord[]> {
  const rows = await ctx.db.db
    .select()
    .from(decisionRecords)
    .where(and(eq(decisionRecords.organizationId, ctx.organizationId), eq(decisionRecords.roomId, roomId)))
    .orderBy(desc(decisionRecords.createdAt));
  return rows.map(mapDecision);
}

// -------------------------------------------------------------------------- handoffs

export interface CreateHandoffInput extends RecordLinks {
  sender_type: HandoffRecord["sender_type"];
  sender_id: string;
  recipient_type: HandoffRecord["recipient_type"];
  recipient_id: string;
  expected_action: string;
  blocking_condition?: string | null;
  priority?: HandoffRecord["priority"];
  due_at?: string | null;
}

export async function createHandoff(ctx: ServerContext, input: CreateHandoffInput): Promise<HandoffRecord> {
  const now = ctx.clock.nowIso();
  const id = ctx.idGen.generate(ID_PREFIXES.handoff);
  await ctx.db.db.insert(handoffs).values({
    id,
    organizationId: ctx.organizationId,
    roomId: input.room_id,
    taskId: input.task_id ?? null,
    runId: input.run_id ?? null,
    goalId: input.goal_id ?? null,
    planId: input.plan_id ?? null,
    senderType: input.sender_type,
    senderId: input.sender_id,
    recipientType: input.recipient_type,
    recipientId: input.recipient_id,
    expectedAction: input.expected_action,
    blockingCondition: input.blocking_condition ?? null,
    priority: input.priority ?? null,
    dueAt: input.due_at ?? null,
    status: "open",
    nextAction: null,
    latestStatus: null,
    createdAt: now,
    updatedAt: now,
  });
  await emit(ctx, "handoff.opened", id, input.room_id, {
    handoff_id: id,
    sender_type: input.sender_type,
    sender_id: input.sender_id,
    recipient_type: input.recipient_type,
    recipient_id: input.recipient_id,
  });
  return getHandoff(ctx, id) as Promise<HandoffRecord>;
}

export async function setHandoffStatus(
  ctx: ServerContext,
  id: string,
  status: HandoffStatus,
  opts: { next_action?: string | null; latest_status?: string | null } = {},
): Promise<HandoffRecord | null> {
  const existing = await getHandoff(ctx, id);
  if (existing === null) return null;
  const now = ctx.clock.nowIso();
  await ctx.db.db
    .update(handoffs)
    .set({
      status,
      nextAction: opts.next_action ?? existing.next_action,
      latestStatus: opts.latest_status ?? existing.latest_status,
      updatedAt: now,
    })
    .where(and(eq(handoffs.id, id), eq(handoffs.organizationId, ctx.organizationId)));
  await emit(ctx, `handoff.${status === "open" ? "opened" : status}`, id, existing.room_id, {
    handoff_id: id,
    from: existing.status,
    to: status,
  });
  return getHandoff(ctx, id);
}

export async function getHandoff(ctx: ServerContext, id: string): Promise<HandoffRecord | null> {
  const r = (
    await ctx.db.db
      .select()
      .from(handoffs)
      .where(and(eq(handoffs.id, id), eq(handoffs.organizationId, ctx.organizationId)))
  )[0];
  return r === undefined ? null : mapHandoff(r);
}

export async function listHandoffs(ctx: ServerContext, roomId: string): Promise<HandoffRecord[]> {
  const rows = await ctx.db.db
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.organizationId, ctx.organizationId), eq(handoffs.roomId, roomId)))
    .orderBy(desc(handoffs.createdAt));
  return rows.map(mapHandoff);
}

/** Who-waits-on-whom from open handoff RECORDS (not thread scraping). Org-scoped;
 *  optionally narrowed to one room. */
export async function whoWaitsOnWhom(ctx: ServerContext, roomId?: string): Promise<WaitEdge[]> {
  const where =
    roomId === undefined
      ? eq(handoffs.organizationId, ctx.organizationId)
      : and(eq(handoffs.organizationId, ctx.organizationId), eq(handoffs.roomId, roomId));
  const rows = await ctx.db.db.select().from(handoffs).where(where);
  return waitEdgesFromHandoffs(rows.map(mapHandoff));
}

// -------------------------------------------------------------------------- blockers

export interface CreateBlockerInput extends RecordLinks {
  type: BlockerRecord["type"];
  owner_type: BlockerRecord["owner_type"];
  owner_id: string;
  source_kind?: BlockerRecord["source_kind"];
  source_id?: string | null;
  summary: string;
  mitigation?: string | null;
  next_action?: string | null;
}

export async function createBlocker(ctx: ServerContext, input: CreateBlockerInput): Promise<BlockerRecord> {
  const now = ctx.clock.nowIso();
  const id = ctx.idGen.generate(ID_PREFIXES.blocker);
  await ctx.db.db.insert(blockers).values({
    id,
    organizationId: ctx.organizationId,
    roomId: input.room_id,
    taskId: input.task_id ?? null,
    runId: input.run_id ?? null,
    goalId: input.goal_id ?? null,
    planId: input.plan_id ?? null,
    type: input.type,
    ownerType: input.owner_type,
    ownerId: input.owner_id,
    sourceKind: input.source_kind ?? null,
    sourceId: input.source_id ?? null,
    summary: input.summary,
    mitigation: input.mitigation ?? null,
    nextAction: input.next_action ?? null,
    status: "open",
    createdAt: now,
    updatedAt: now,
  });
  await emit(ctx, "blocker.opened", id, input.room_id, {
    blocker_id: id,
    type: input.type,
    owner_type: input.owner_type,
    owner_id: input.owner_id,
    source_kind: input.source_kind ?? null,
  });
  return getBlocker(ctx, id) as Promise<BlockerRecord>;
}

export async function setBlockerStatus(
  ctx: ServerContext,
  id: string,
  status: BlockerStatus,
  opts: { mitigation?: string | null; next_action?: string | null } = {},
): Promise<BlockerRecord | null> {
  const existing = await getBlocker(ctx, id);
  if (existing === null) return null;
  const now = ctx.clock.nowIso();
  await ctx.db.db
    .update(blockers)
    .set({
      status,
      mitigation: opts.mitigation ?? existing.mitigation,
      nextAction: opts.next_action ?? existing.next_action,
      updatedAt: now,
    })
    .where(and(eq(blockers.id, id), eq(blockers.organizationId, ctx.organizationId)));
  const eventType = status === "mitigated" ? "blocker.mitigated" : status === "resolved" ? "blocker.resolved" : "blocker.opened";
  await emit(ctx, eventType, id, existing.room_id, { blocker_id: id, from: existing.status, to: status });
  return getBlocker(ctx, id);
}

/** Deterministic auto-resolution: when a linked source (approval/dag/lease/run)
 *  is resolved, resolve its still-active blocker(s) without duplicating that
 *  source's state. Returns the resolved blocker ids. */
export async function resolveBlockersForSource(
  ctx: ServerContext,
  sourceKind: NonNullable<BlockerRecord["source_kind"]>,
  sourceId: string,
): Promise<string[]> {
  const rows = await ctx.db.db
    .select()
    .from(blockers)
    .where(
      and(
        eq(blockers.organizationId, ctx.organizationId),
        eq(blockers.sourceKind, sourceKind),
        eq(blockers.sourceId, sourceId),
      ),
    );
  const resolved: string[] = [];
  for (const r of rows) {
    if (r.status === "open" || r.status === "mitigated") {
      await setBlockerStatus(ctx, r.id, "resolved", { mitigation: `auto-resolved by ${sourceKind} ${sourceId}` });
      resolved.push(r.id);
    }
  }
  return resolved;
}

export async function getBlocker(ctx: ServerContext, id: string): Promise<BlockerRecord | null> {
  const r = (
    await ctx.db.db
      .select()
      .from(blockers)
      .where(and(eq(blockers.id, id), eq(blockers.organizationId, ctx.organizationId)))
  )[0];
  return r === undefined ? null : mapBlocker(r);
}

export async function listBlockers(ctx: ServerContext, roomId: string): Promise<BlockerRecord[]> {
  const rows = await ctx.db.db
    .select()
    .from(blockers)
    .where(and(eq(blockers.organizationId, ctx.organizationId), eq(blockers.roomId, roomId)))
    .orderBy(desc(blockers.createdAt));
  return rows.map(mapBlocker);
}

// Re-export the mention/assignment payload types for route validation (slice 4).
export type { Assignment, Mention };
