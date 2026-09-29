import { z } from "zod";

export const AssistantTurnStatusSchema = z.enum(["queued", "waiting", "running", "completed", "failed", "cancelled"]);
export const AssistantTurnSchema = z.object({
  id: z.string(), room_id: z.string(), thread_root_id: z.string().nullable().optional(), task_id: z.string(), run_id: z.string().nullable(),
  user_message_id: z.string(), response_message_id: z.string().nullable(),
  status: AssistantTurnStatusSchema, error: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(),
});
export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;
export const SendAssistantTurnRequestSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  client_request_id: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  agent_instance_id: z.string().min(1).optional(),
  thread_root_id: z.string().min(1).optional(),
});
export type SendAssistantTurnRequest = z.infer<typeof SendAssistantTurnRequestSchema>;
