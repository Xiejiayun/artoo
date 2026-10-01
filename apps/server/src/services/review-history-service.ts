import { agents, eventLog, users } from "@artoo/db";
import { TaskReviewSchema, type TaskReview } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, asc, eq } from "drizzle-orm";

import type { ServerContext } from "../context.js";

/** Read durable decisions without inferring their source, reviewed run or artifacts. */
export async function listTaskReviews(
  ctx: ServerContext,
  db: DrizzleDb,
  taskId: string,
  projectId: string,
): Promise<TaskReview[]> {
  const rows = await db.select({ event: eventLog, userName: users.displayName, agentName: agents.displayName })
    .from(eventLog)
    .leftJoin(users, and(eq(eventLog.actorType, "user"), eq(users.id, eventLog.actorId), eq(users.organizationId, ctx.organizationId)))
    .leftJoin(agents, and(eq(eventLog.actorType, "agent"), eq(agents.id, eventLog.actorId), eq(agents.organizationId, ctx.organizationId)))
    .where(and(eq(eventLog.organizationId, ctx.organizationId), eq(eventLog.projectId, projectId),
      eq(eventLog.taskId, taskId), eq(eventLog.type, "review.completed")))
    .orderBy(asc(eventLog.position));
  return rows.flatMap(({ event, userName, agentName }) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.outcome !== "accepted" && payload.outcome !== "changes_requested") return [];
    const inventory = TaskReviewSchema.shape.artifact_ids.safeParse(payload.artifact_ids ?? null);
    const artifactIds = inventory.success && (inventory.data === null || new Set(inventory.data).size === inventory.data.length)
      ? inventory.data : null;
    return [TaskReviewSchema.parse({
      event_id: event.id, position: event.position, task_id: event.taskId,
      outcome: payload.outcome, comment: payload.comment ?? null,
      actor: { type: event.actorType, id: event.actorId },
      // This is the current org-scoped display name, not a historical name claim.
      actor_name: event.actorType === "user" ? userName : event.actorType === "agent" ? agentName : null,
      occurred_at: event.occurredAt,
      artifact_ids: artifactIds,
    })];
  });
}
