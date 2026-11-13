import { z } from "zod";

/** Observations only: tool-reported success is never node verification evidence. */
export const RunOperationSchema = z.object({
  call_id: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  phase: z.enum(["started", "updated", "completed", "failed"]),
  request: z.string().max(16_000).optional(),
  response: z.string().max(32_000).optional(),
  request_truncated: z.boolean().optional(),
  response_truncated: z.boolean().optional(),
  exit_code: z.number().int().nullable().optional(),
}).strict();
export const RunActivityPayloadSchema = z.object({
  version: z.literal(1),
  operations: z.array(RunOperationSchema).min(1).max(64),
  omitted_operations: z.number().int().nonnegative().optional(),
}).strict();
export type RunOperation = z.infer<typeof RunOperationSchema>;
export type RunActivityPayload = z.infer<typeof RunActivityPayloadSchema>;
