import { assistantTurns, discussions } from "@artoo/db";
import { DiscussionPlanOutputSchema, DiscussionPlanPreviewSchema, StartDiscussionRequestSchema, type DiscussionPlanPreview, type Message } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { validatePlanTaskSpecs } from "./plan-service.js";

export function parseDiscussionPlan(body: string) {
  const text = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { return DiscussionPlanOutputSchema.parse(JSON.parse(text)); }
  catch { throw AppError.validation("The final agent reply is not a valid task plan. Review the discussion and create or edit a plan manually."); }
}

function preview(body: string, discussionId: string, goalId: string): DiscussionPlanPreview | undefined {
  try {
    const output = parseDiscussionPlan(body);
    const specs = validatePlanTaskSpecs(output.task_specs);
    // Existing proposal APIs accept numeric refs using Number(). Normalize only
    // this presentation so Swift and JavaScript resolve exactly the same names.
    return DiscussionPlanPreviewSchema.parse({ version: 1, discussion_id: discussionId, goal_id: goalId,
      rationale: output.rationale, task_specs: specs.map((spec) => ({ ...spec,
        dependencies: spec.dependencies.map((dep) => ({ ...dep, ref: String(Number(dep.ref)) })),
      })) });
  } catch (error) {
    // Invalid model content stays visible as the original reply. Do not hide a
    // database/transport failure behind this best-effort presentation path.
    if (error instanceof AppError || (error instanceof Error && error.name === "ZodError")) return undefined;
    throw error;
  }
}

/** Attach before message.created: incremental clients may fetch the reply before
 * the discussion dispatcher advances finalMessageId to its completed state. */
export async function previewForActiveSynthesis(ctx: ServerContext, tx: DrizzleDb,
  turn: typeof assistantTurns.$inferSelect, body: string, agentInstanceId: string): Promise<DiscussionPlanPreview | undefined> {
  const [row] = await tx.select().from(discussions).where(and(eq(discussions.organizationId, ctx.organizationId),
    eq(discussions.activeTurnId, turn.id), eq(discussions.roomId, turn.roomId),
    eq(discussions.threadRootId, turn.threadRootId ?? ""), eq(discussions.taskId, turn.taskId)));
  if (!row || row.status !== "running") return undefined;
  const participants = StartDiscussionRequestSchema.shape.participants.safeParse(row.participants);
  if (!participants.success || row.currentStep !== row.rounds * participants.data.length ||
    participants.data[0]?.agent_instance_id !== agentInstanceId) return undefined;
  return preview(body, row.id, row.goalId);
}

/** Bounded read projection for replies written by older servers. Never infer
 * attribution from a user-supplied payload or from JSON-shaped message text. */
export async function withHistoricalDiscussionPreviews(ctx: ServerContext, items: Message[]): Promise<Message[]> {
  const candidates = items.filter((item) => item.actor_type === "agent" && item.kind === "text" &&
    !DiscussionPlanPreviewSchema.safeParse(item.payload["discussion_plan"]).success);
  if (!candidates.length) return items;
  const rows = await ctx.db.db.select({ discussion: discussions, turn: assistantTurns }).from(discussions)
    .innerJoin(assistantTurns, and(eq(assistantTurns.responseMessageId, discussions.finalMessageId),
      eq(assistantTurns.organizationId, discussions.organizationId)))
    .where(and(eq(discussions.organizationId, ctx.organizationId),
      inArray(discussions.finalMessageId, candidates.map((item) => item.id))));
  const additions = new Map<string, DiscussionPlanPreview>();
  for (const { discussion, turn } of rows) {
    const message = candidates.find((item) => item.id === discussion.finalMessageId)!;
    const participants = StartDiscussionRequestSchema.shape.participants.safeParse(discussion.participants);
    if (!participants.success || discussion.currentStep !== participants.data.length * discussion.rounds + 1 ||
      message.organization_id !== ctx.organizationId || message.room_id !== discussion.roomId ||
      message.thread_root_id !== discussion.threadRootId || message.task_id !== discussion.taskId ||
      message.actor_id !== participants.data[0]?.agent_instance_id || turn.agentInstanceId !== message.actor_id ||
      turn.roomId !== discussion.roomId || turn.threadRootId !== discussion.threadRootId || turn.taskId !== discussion.taskId ||
      turn.status !== "completed" || turn.runId !== message.run_id) continue;
    const value = preview(message.body, discussion.id, discussion.goalId);
    if (value) additions.set(message.id, value);
  }
  return items.map((item) => additions.has(item.id) ? { ...item, payload: { ...item.payload, discussion_plan: additions.get(item.id) } } : item);
}
