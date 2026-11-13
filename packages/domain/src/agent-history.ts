import { z } from "zod";
import { ContextPackSchema } from "./context-pack.js";
import { RunSchema } from "./schemas.js";
import { RunStatusSchema } from "./state.js";

const identifier = z.string().min(1).max(256);
export const AgentHistoryQuerySchema = z.object({
  instance_id: identifier.optional(),
  project_id: identifier.optional(),
  status: RunStatusSchema.optional(),
  before_run_id: identifier.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type AgentHistoryQuery = z.infer<typeof AgentHistoryQuerySchema>;

export const AgentHistoryEventsQuerySchema = z.object({
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export type AgentHistoryEventsQuery = z.infer<typeof AgentHistoryEventsQuerySchema>;

export const AgentHistoryRunSchema = z.object({
  run: RunSchema,
  project_id: z.string(),
  task_title: z.string(),
});
export const AgentHistoryPageSchema = z.object({
  version: z.literal(1), agent_id: z.string(), agent_name: z.string(),
  runs: z.array(AgentHistoryRunSchema), next_before_run_id: z.string().nullable(),
});
export type AgentHistoryPage = z.infer<typeof AgentHistoryPageSchema>;

export const AgentHistoryEventSchema = z.object({
  id: z.string(), position: z.number().int().positive(), type: z.string(),
  actor: z.object({ type: z.string(), id: z.string() }),
  sequence: z.number().int().nullable(), occurred_at: z.string(),
  payload: z.record(z.string(), z.unknown()),
  response_text: z.string().nullable(),
});
export type AgentHistoryEvent = z.infer<typeof AgentHistoryEventSchema>;
export const AgentHistoryDetailSchema = z.object({
  version: z.literal(1), agent_id: z.string(),
  execution: AgentHistoryRunSchema,
  // Only the immutable task request is exposed, never the full context/policy pack.
  request: ContextPackSchema.shape.task.nullable(),
  events: z.array(AgentHistoryEventSchema), next_before: z.number().nullable(),
});
export type AgentHistoryDetail = z.infer<typeof AgentHistoryDetailSchema>;
