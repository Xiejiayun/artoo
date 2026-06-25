import { z } from "zod";

import { ActorTypeSchema } from "./events.js";

/**
 * V3 #114 — agent communication / team-discussion records (PURE domain). Decision
 * records, handoffs, and blockers are first-class, auditable objects so a user can
 * see what the agent team decided, who is waiting on whom, and what evidence backs
 * a decision — without scraping the raw room thread. NO secrets in any shape.
 *
 * Boundary: this module does NOT define Goal/Plan (that is #115/#128). `goal_id`/
 * `plan_id` are nullable, non-authoritative FK placeholders that align with the
 * canonical `goal_`/`plan_` ids once #115 lands. See docs/v3-product-plan.md.
 */

// --------------------------------------------------------------------------- enums

export const DecisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "superseded"]);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const HandoffStatusSchema = z.enum(["open", "accepted", "completed", "cancelled", "expired"]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const BlockerStatusSchema = z.enum(["open", "mitigated", "accepted_risk", "resolved"]);
export type BlockerStatus = z.infer<typeof BlockerStatusSchema>;

export const BlockerTypeSchema = z.enum([
  "approval",
  "dependency",
  "lease_conflict",
  "offline_agent",
  "stale_runtime",
  "policy",
  "budget",
  "failed_run",
  "missing_artifact",
  "human_input",
]);
export type BlockerType = z.infer<typeof BlockerTypeSchema>;

/** Source a blocker is linked to (so deterministic source-resolution can auto
 *  mitigate/resolve it without duplicating that source's state). */
export const BlockerSourceKindSchema = z.enum(["approval", "dag", "lease", "run", "presence", "manual"]);
export type BlockerSourceKind = z.infer<typeof BlockerSourceKindSchema>;

// --------------------------------------------------------------------------- mention / assignment (message payload)

export const MentionSchema = z.object({ actor_type: ActorTypeSchema, actor_id: z.string() });
export type Mention = z.infer<typeof MentionSchema>;

export const AssignmentSchema = z.object({
  assignee_type: ActorTypeSchema,
  assignee_id: z.string(),
  action: z.string().optional(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

// --------------------------------------------------------------------------- records

const baseLinks = {
  room_id: z.string(),
  task_id: z.string().nullable(),
  run_id: z.string().nullable(),
  goal_id: z.string().nullable(),
  plan_id: z.string().nullable(),
};

export const DecisionRecordSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  ...baseLinks,
  /** Idempotent promotion source: the message a decision was promoted from. */
  source_message_id: z.string().nullable(),
  status: DecisionStatusSchema,
  actor_type: ActorTypeSchema,
  actor_id: z.string(),
  summary: z.string(),
  rationale: z.string().nullable(),
  alternatives: z.array(z.string()),
  /** Evidence refs (message/artifact/run ids) — ids only, never raw content. */
  evidence_refs: z.array(z.string()),
  impact_summary: z.string().nullable(),
  superseded_by_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const HandoffRecordSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  ...baseLinks,
  sender_type: ActorTypeSchema,
  sender_id: z.string(),
  recipient_type: ActorTypeSchema,
  recipient_id: z.string(),
  expected_action: z.string(),
  blocking_condition: z.string().nullable(),
  priority: z.enum(["low", "normal", "high"]).nullable(),
  due_at: z.string().nullable(),
  status: HandoffStatusSchema,
  next_action: z.string().nullable(),
  latest_status: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type HandoffRecord = z.infer<typeof HandoffRecordSchema>;

export const BlockerRecordSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  ...baseLinks,
  type: BlockerTypeSchema,
  owner_type: ActorTypeSchema,
  owner_id: z.string(),
  /** Linked source for deterministic auto-resolution. */
  source_kind: BlockerSourceKindSchema.nullable(),
  source_id: z.string().nullable(),
  summary: z.string(),
  mitigation: z.string().nullable(),
  next_action: z.string().nullable(),
  status: BlockerStatusSchema,
  created_at: z.string(),
  updated_at: z.string(),
});
export type BlockerRecord = z.infer<typeof BlockerRecordSchema>;

// --------------------------------------------------------------------------- pure helpers

/** Blocker types that require a human decision to clear (vs. those that can clear
 *  deterministically from their linked source). Drives the goal/room overview's
 *  "needs human decision" vs "safe to resume" distinction. */
const HUMAN_BLOCKER_TYPES = new Set<BlockerType>(["approval", "human_input", "policy", "budget"]);
export function blockerNeedsHuman(type: BlockerType): boolean {
  return HUMAN_BLOCKER_TYPES.has(type);
}

/** Whether a blocker is still active (counts toward "who waits"/can't progress). */
export function isActiveBlocker(status: BlockerStatus): boolean {
  return status === "open" || status === "mitigated";
}

/** Whether a handoff is still an open wait-state (who-waits-on-whom). */
export function isOpenHandoff(status: HandoffStatus): boolean {
  return status === "open" || status === "accepted";
}

export type ResumeState = "safe_to_resume" | "needs_human_decision" | "no_active_blockers";

/** Classify a set of active blockers for the room/goal overview without scraping
 *  the thread: any human-gated active blocker => needs_human_decision; otherwise
 *  any active blocker => safe_to_resume (deterministic clears possible); none =>
 *  no_active_blockers. */
export function resumeStateFromBlockers(blockers: Array<{ type: BlockerType; status: BlockerStatus }>): ResumeState {
  const active = blockers.filter((b) => isActiveBlocker(b.status));
  if (active.length === 0) return "no_active_blockers";
  return active.some((b) => blockerNeedsHuman(b.type)) ? "needs_human_decision" : "safe_to_resume";
}

/** "Who waits on whom" edge derived from an open handoff (records, not threads). */
export interface WaitEdge {
  waiter_type: string;
  waiter_id: string;
  blocked_on_type: string;
  blocked_on_id: string;
  expected_action: string;
  handoff_id: string;
}
export function waitEdgesFromHandoffs(
  handoffs: Array<Pick<HandoffRecord, "id" | "sender_type" | "sender_id" | "recipient_type" | "recipient_id" | "expected_action" | "status">>,
): WaitEdge[] {
  return handoffs
    .filter((h) => isOpenHandoff(h.status))
    .map((h) => ({
      waiter_type: h.sender_type,
      waiter_id: h.sender_id,
      blocked_on_type: h.recipient_type,
      blocked_on_id: h.recipient_id,
      expected_action: h.expected_action,
      handoff_id: h.id,
    }));
}
