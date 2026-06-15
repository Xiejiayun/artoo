/**
 * REST API request/response + error envelope schemas for the v0.1-core surface
 * (design.md §10.6; codex Round 12/18).
 *
 * The retry endpoint and the review `outcome` enum are part of the frozen core
 * contract (accepted gaps gap1/gap2/gap3).
 */
import { z } from "zod";

import { CapabilitySchema } from "./capabilities.js";
import { MemoryScopeSchema } from "./memory.js";
import {
  DependencyTypeSchema,
  EffortSchema,
  LeaseHolderTypeSchema,
  LeaseModeSchema,
  PrioritySchema,
} from "./schemas.js";
import { TaskStatusSchema } from "./state.js";

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

/**
 * Acquire a file lease over a workspace path (#12). `path` is normalized +
 * containment-checked server-side before storage. `holder_type`/`holder_id`
 * default to run/run_id when `run_id` is present, else task/task_id.
 */
export const AcquireLeaseRequestSchema = z.object({
  task_id: z.string(),
  run_id: z.string().nullish(),
  path: z.string(),
  mode: LeaseModeSchema,
  holder_type: LeaseHolderTypeSchema.nullish(),
  holder_id: z.string().nullish(),
  expires_at: z.string().nullish(),
}).superRefine((data, ctx) => {
  const hasHolderType = data.holder_type != null;
  const hasHolderId = data.holder_id != null;
  if (hasHolderType !== hasHolderId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "holder_type and holder_id must be provided together",
      path: hasHolderType ? ["holder_id"] : ["holder_type"],
    });
  }
});
export type AcquireLeaseRequest = z.infer<typeof AcquireLeaseRequestSchema>;

/** A node in a task DAG snapshot. */
export const DagNodeSchema = z.object({
  task_id: z.string(),
  status: TaskStatusSchema,
  parent_task_id: z.string().nullish(),
  title: z.string(),
});
export type DagNode = z.infer<typeof DagNodeSchema>;

/** A DAG snapshot for a task subtree: nodes + dependency edges
 *  (from_task_id = prerequisite, to_task_id = dependent). */
export const DagSnapshotSchema = z.object({
  root_task_id: z.string(),
  nodes: z.array(DagNodeSchema),
  edges: z.array(
    z.object({
      from_task_id: z.string(),
      to_task_id: z.string(),
      type: DependencyTypeSchema,
    }),
  ),
});
export type DagSnapshot = z.infer<typeof DagSnapshotSchema>;

export const AssignRequestSchema = z.object({
  mode: z.enum(["auto", "manual"]).default("auto"),
  agent_instance_id: z.string().nullish(),
  model_profile_id: z.string().nullish(),
  effort: EffortSchema.nullish(),
  /**
   * Paths the run will write (#20). Reserved as `write` file leases (holder=run)
   * inside the assignment transaction; a conflict aborts the whole assign and
   * leaves the task `ready`. Normalized + deduped to canonical lowercase lease
   * keys server-side. Empty/absent is a back-compat no-op.
   */
  write_paths: z.array(z.string()).nullish(),
  /**
   * Branch-backed worktree opt-in (#23). Provide an explicit `workspace_branch`
   * to use that exact branch, OR `branch_backed: true` to have the server
   * generate a deterministic `artoo/run-<runId>` branch. Both absent -> ordinary
   * run (no worktree, `workspace_branch = null`). Providing both is invalid.
   */
  workspace_branch: z.string().nullish(),
  branch_backed: z.boolean().nullish(),
}).superRefine((data, ctx) => {
  const branch = data.workspace_branch;
  const hasExplicitBranch = branch != null;
  if (branch != null && branch.trim() === "") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "workspace_branch must be non-empty when provided",
      path: ["workspace_branch"],
    });
  }
  if (branch != null && branch !== branch.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "workspace_branch must not include leading or trailing whitespace",
      path: ["workspace_branch"],
    });
  }
  if (hasExplicitBranch && data.branch_backed === true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "provide either workspace_branch or branch_backed, not both",
      path: ["workspace_branch"],
    });
  }
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

/**
 * POST /memories — propose a memory (also the body for POST /memories/:id/supersede,
 * whose replacement content must pass the same checks). Mirrors the Phase A
 * MemorySchema content rule: at least one of non-blank text / non-empty payload.
 */
export const ProposeMemoryRequestSchema = z
  .object({
    scope: MemoryScopeSchema,
    project_id: z.string().nullish(),
    task_id: z.string().nullish(),
    source_task_id: z.string().nullish(),
    source_run_id: z.string().nullish(),
    source_message_id: z.string().nullish(),
    source_artifact_id: z.string().nullish(),
    text: z.string().nullish(),
    payload: z.record(z.unknown()).nullish(),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(1),
  })
  .superRefine((req, ctx) => {
    const hasText = req.text != null && req.text.trim().length > 0;
    const hasPayload = req.payload != null && Object.keys(req.payload).length > 0;
    if (!hasText && !hasPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "memory requires text or payload",
      });
    }
    if ((req.scope === "project" || req.scope === "code") && req.project_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_id"],
        message: `${req.scope} memory requires project_id`,
      });
    }
    if (req.scope === "task" && req.task_id == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_id"],
        message: "task memory requires task_id",
      });
    }
  });
export type ProposeMemoryRequest = z.infer<typeof ProposeMemoryRequestSchema>;

/** POST /memories/:id/accept|reject — optional curator comment. */
export const MemoryTransitionRequestSchema = z.object({
  comment: z.string().nullish(),
});
export type MemoryTransitionRequest = z.infer<typeof MemoryTransitionRequestSchema>;
