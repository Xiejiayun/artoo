import { z } from "zod";

/** Durable task-level review; artifact attribution is unknown for legacy events. */
export const TaskReviewSchema = z.object({
  event_id: z.string().min(1),
  position: z.number().int().positive(),
  task_id: z.string().min(1),
  outcome: z.enum(["accepted", "changes_requested"]),
  comment: z.string().nullable(),
  actor: z.object({ type: z.enum(["user", "agent", "system"]), id: z.string().min(1) }),
  actor_name: z.string().nullable(),
  occurred_at: z.string().min(1),
  artifact_ids: z.array(z.string().min(1)).nullable(),
});

export type TaskReview = z.infer<typeof TaskReviewSchema>;
