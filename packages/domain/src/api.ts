/**
 * REST API request/response + error envelope schemas for the v0.1-core surface
 * (design.md §10.6; codex Round 12/18).
 *
 * The retry endpoint and the review `outcome` enum are part of the frozen core
 * contract (accepted gaps gap1/gap2/gap3).
 */
import { z } from "zod";

import { CapabilitySchema } from "./capabilities.js";
import { DependencyTypeSchema, EffortSchema, PrioritySchema } from "./schemas.js";

export const ApiErrorCodeSchema = z.enum([
  "validation_error",
  "not_found",
  "permission_denied",
  "conflict",
  "invalid_state",
  "runtime_unavailable",
  "computer_offline",
  "approval_required",
  "internal_error",
]);
export const API_ERROR_CODES = ApiErrorCodeSchema.options;
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(
  code: ApiErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ApiError {
  return { error: { code, message, details } };
}

export const CreateTaskRequestSchema = z.object({
  project_id: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  priority: PrioritySchema.default("p2"),
  acceptance_criteria: z.array(z.string()).default([]),
  required_capabilities: z.array(CapabilitySchema).default([]),
  preferred_model_profile_id: z.string().nullish(),
  preferred_effort: EffortSchema.nullish(),
  parent_task_id: z.string().nullish(),
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const CreateDependencyRequestSchema = z.object({
  depends_on_task_id: z.string(),
  type: DependencyTypeSchema,
});
export type CreateDependencyRequest = z.infer<typeof CreateDependencyRequestSchema>;

export const AssignRequestSchema = z.object({
  mode: z.enum(["auto", "manual"]).default("auto"),
  agent_instance_id: z.string().nullish(),
  model_profile_id: z.string().nullish(),
  effort: EffortSchema.nullish(),
});
export type AssignRequest = z.infer<typeof AssignRequestSchema>;

/** POST /tasks/:id/retry — recovers blocked/failed tasks by creating a new run. */
export const RetryRequestSchema = z.object({
  reason: z.string().nullish(),
});
export type RetryRequest = z.infer<typeof RetryRequestSchema>;

export const ReviewRequestSchema = z.object({
  outcome: z.enum(["accepted", "changes_requested"]),
  comment: z.string().nullish(),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const ResolveApprovalRequestSchema = z.object({
  decision: z.enum(["approved", "rejected", "needs_more_info"]),
  comment: z.string().nullish(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequestSchema>;

export const SendMessageRequestSchema = z.object({
  kind: z.string().default("text"),
  body: z.string().default(""),
  payload: z.record(z.unknown()).default({}),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
