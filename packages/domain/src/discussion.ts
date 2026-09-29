import { z } from "zod";

export const DiscussionParticipantSchema = z.object({
  agent_instance_id: z.string().min(1),
  role: z.string().trim().min(1).max(200),
});
export const StartDiscussionRequestSchema = z.object({
  participants: z.array(DiscussionParticipantSchema).min(2).max(6)
    .refine((items) => new Set(items.map((item) => item.agent_instance_id)).size === items.length, "Choose distinct agent instances"),
  rounds: z.number().int().min(1).max(3).default(2),
  max_minutes: z.number().int().min(2).max(60).default(15),
  room_id: z.string().min(1).optional(),
});
export type StartDiscussionRequest = z.infer<typeof StartDiscussionRequestSchema>;
export const DiscussionSchema = z.object({
  id: z.string(), goal_id: z.string(), room_id: z.string(), thread_root_id: z.string(),
  participants: z.array(DiscussionParticipantSchema), rounds: z.number().int(), max_minutes: z.number().int(),
  status: z.enum(["running", "stopping", "ready", "failed", "cancelled"]),
  current_step: z.number().int(), total_steps: z.number().int(),
  active_turn_id: z.string().nullable(), plan_id: z.string().nullable(), error: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), deadline_at: z.string(),
});
export type Discussion = z.infer<typeof DiscussionSchema>;
